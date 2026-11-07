// SPDX-License-Identifier: LGPL-3.0-or-later
/** DSH domain persistence and owner-only raw mail storage. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { v1InboxDecoder, v1RecordDecoder, v1CursorSchema, decodeV1Cursor } from './storage-v1.ts'
import { inboxSchema, mailRecordSchema, mailboxCursorSchema, notificationStateSchema, MailError, type InboxRecord, type MailRecord, type MailboxCursor, type NotificationState, type MailStore, type MailId, type TaskId } from './types.ts'

const metadataSchema = z.strictObject({ migrationComplete: z.boolean(), notifications: notificationStateSchema.optional() })
const initialMetadata: z.output<typeof metadataSchema> = { migrationComplete: false }

/** Current records admit released version-one rows only through their isolated decoders. */
export const mailDomain = defineDomain({
  name: 'dsh_mail', version: 2, compatibleVersions: [1],
  global: { schema: metadataSchema, initial: initialMetadata },
  tables: {
    inbox: domainTable(z.union([inboxSchema, v1InboxDecoder])),
    tasks: domainTable(z.union([mailRecordSchema, v1RecordDecoder])),
    cursors: domainTable(v1CursorSchema),
    mailboxes: domainTable(mailboxCursorSchema),
  },
})

/** KV adapter; record settlement and outgoing content remain one durable write. */
export class DomainMailStore implements MailStore {
  private constructor(private readonly domain: Domain<typeof mailDomain>) {}
  /** Normalize released rows before exposing the store to mail receivers or execution.
   * @param facility DSH facility owning the backend route.
   * @returns An open version-two store with completed, resumable migration.
   */
  static async open(facility: DomainFacility): Promise<DomainMailStore> {
    const domain = await facility.open(mailDomain)
    try {
      if (!domain.global.get().migrationComplete) {
        for (const [key, value] of domain.table('inbox').entries()) {
          if (key !== value.id) throw new MailError('legacy-mail-id-requires-review')
          await domain.table('inbox').put(key, value)
        }
        for (const [key, value] of domain.table('tasks').entries()) {
          if (key !== value.id) throw new MailError('legacy-task-id-requires-review')
          await domain.table('tasks').put(key, value)
        }
        let notifications = domain.global.get().notifications
        for (const [key, value] of domain.table('cursors').entries()) {
          const decoded = decodeV1Cursor(key, value)
          if (decoded.kind === 'notification') {
            if (notifications && !isDeepStrictEqual(notifications, decoded.value)) throw new MailError('notification-migration-conflict')
            notifications = decoded.value
            continue
          }
          const existing = domain.table('mailboxes').get(key)
          if (existing && !isDeepStrictEqual(existing, decoded.value)) throw new MailError('mailbox-migration-conflict')
          if (!existing) await domain.table('mailboxes').put(key, decoded.value)
          await domain.table('cursors').delete(key)
        }
        // The epoch stays in its old row until this durable marker also stores its replacement.
        await domain.global.set({ migrationComplete: true, ...(notifications ? { notifications } : {}) })
      }
      for (const key of domain.table('cursors').keys()) await domain.table('cursors').delete(key)
      return new DomainMailStore(domain)
    } catch (error) { await domain.close(); throw error }
  }
  getInbox(id: MailId): InboxRecord | undefined { return this.domain.table('inbox').get(id) }
  getRecord(id: TaskId): MailRecord | undefined { return this.domain.table('tasks').get(id) }
  get inboxCount(): number { return this.domain.table('inbox').size }
  get recordCount(): number { return this.domain.table('tasks').size }
  inbox(): readonly InboxRecord[] { return [...this.domain.table('inbox').entries()].map(([, value]) => value) }
  records(): readonly MailRecord[] { return [...this.domain.table('tasks').entries()].map(([, value]) => value) }
  putInbox(record: InboxRecord): Promise<void> { return this.domain.table('inbox').put(record.id, record) }
  putRecord(record: MailRecord): Promise<void> { return this.domain.table('tasks').put(record.id, record) }
  updateRecord(id: TaskId, update: (record: MailRecord) => MailRecord): Promise<MailRecord> { return this.domain.table('tasks').update(id, update) }
  cursor(key: string): MailboxCursor | undefined { return this.domain.table('mailboxes').get(key) }
  putCursor(key: string, value: MailboxCursor): Promise<void> { return this.domain.table('mailboxes').put(key, value) }
  notificationState(): NotificationState | undefined { return this.domain.global.get().notifications }
  putNotificationState(value: NotificationState): Promise<void> { return this.domain.global.set({ ...this.domain.global.get(), notifications: value }) }
  close(): Promise<void> { return this.domain.close() }
}

/** Content-addressed raw MIME spool, locked for one local host. */
export class Spool {
  private release: (() => Promise<void>) | undefined
  private failure: Error | undefined
  constructor(readonly directory: string) {}
  /** Acquire an exclusive local lease before starting any mailbox work. */
  async open(staleMs: number): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await mkdir(join(this.directory, 'raw'), { recursive: true, mode: 0o700 })
    this.release = await lockfile.lock(this.directory, { realpath: true, stale: staleMs, retries: 0,
      onCompromised: error => { this.failure = error },
    })
  }
  /** Fail before any new action if exclusive ownership was lost. */
  assertOwned(): void { if (!this.release || this.failure) throw new Error('mail-state-lock-lost', { cause: this.failure }) }
  /** Persist bytes before a record can point at their hash. */
  async write(raw: Buffer): Promise<string> {
    this.assertOwned()
    const hash = createHash('sha256').update(raw).digest('hex')
    const target = this.path(hash)
    const temporary = `${target}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(raw); await handle.sync() } finally { await handle.close() }
    try { await rename(temporary, target) } finally { await rm(temporary, { force: true }) }
    // Directory synchronization makes the published name durable on local POSIX filesystems.
    if (process.platform !== 'win32') {
      const directory = await open(join(this.directory, 'raw'), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
    return hash
  }
  /** Verify stored content rather than executing silently corrupted mail. */
  async read(hash: string): Promise<Buffer> {
    this.assertOwned()
    const raw = await readFile(this.path(hash))
    if (createHash('sha256').update(raw).digest('hex') !== hash) throw new Error('mail-content-corrupt')
    return raw
  }
  private path(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid-mail-content-hash')
    return join(this.directory, 'raw', `${hash}.eml`)
  }
  /** Release only after the runtime and domain have stopped. */
  async close(): Promise<void> { const release = this.release; this.release = undefined; await release?.() }
}
