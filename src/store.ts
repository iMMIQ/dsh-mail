// SPDX-License-Identifier: LGPL-3.0-or-later
/** DSH domain persistence and owner-only raw mail storage. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { inboxSchema, taskSchema, type InboxRecord, type TaskRecord, type MailStore, type MailId, type TaskId } from './types.ts'

/** Version one is the first released plugin-owned format. */
export const mailDomain = defineDomain({
  name: 'dsh_mail', version: 1,
  tables: {
    inbox: domainTable(inboxSchema), tasks: domainTable(taskSchema),
    cursors: domainTable(z.strictObject({ validity: z.string(), high: z.number().int().nonnegative() })),
  },
})

/** KV adapter; single-record task updates also commit outgoing mail. */
export class DomainMailStore implements MailStore {
  private constructor(private readonly domain: Domain<typeof mailDomain>) {}
  /** Open the declared domain; callers must close after workers drain. */
  static async open(facility: DomainFacility): Promise<DomainMailStore> { return new DomainMailStore(await facility.open(mailDomain)) }
  getInbox(id: MailId): InboxRecord | undefined { return this.domain.table('inbox').get(id) }
  getTask(id: TaskId): TaskRecord | undefined { return this.domain.table('tasks').get(id) }
  get inboxCount(): number { return this.domain.table('inbox').size }
  get taskCount(): number { return this.domain.table('tasks').size }
  inbox(): readonly InboxRecord[] { return [...this.domain.table('inbox').entries()].map(([, v]) => v) }
  tasks(): readonly TaskRecord[] { return [...this.domain.table('tasks').entries()].map(([, v]) => v) }
  putInbox(record: InboxRecord): Promise<void> { return this.domain.table('inbox').put(record.id, record) }
  putTask(record: TaskRecord): Promise<void> { return this.domain.table('tasks').put(record.id, record) }
  updateTask(id: TaskId, update: (record: TaskRecord) => TaskRecord): Promise<TaskRecord> { return this.domain.table('tasks').update(id, update) }
  cursor(key: string): { validity: string; high: number } | undefined { return this.domain.table('cursors').get(key) }
  putCursor(key: string, value: { validity: string; high: number }): Promise<void> { return this.domain.table('cursors').put(key, value) }
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
