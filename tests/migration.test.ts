// SPDX-License-Identifier: LGPL-3.0-or-later
/** Released SQLite and JSON state survive one-way migration and interrupted recovery. */
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import Storage, { StorageError, type KvUnit, type StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility, descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { z } from 'zod'
import { DomainMailStore, mailDomain, Spool } from '../src/store.ts'
import { v1MailDomain, v1TaskSchema, v1InboxSchema, v1CursorSchema } from '../src/storage-v1.ts'
import { MailRuntime } from '../src/runtime.ts'
import { mailIdentity } from '../src/identity.ts'
import type { OutboundMessage, TaskRecord } from '../src/types.ts'
import { configuration } from './helpers.ts'

type LegacyTask = z.output<typeof v1TaskSchema>
type LegacyInbox = z.output<typeof v1InboxSchema>
type LegacyCursor = z.output<typeof v1CursorSchema>
type BackendName = 'sqlite' | 'json'
type Mutation = { kind: 'put' | 'delete'; table: string; key: string; value?: unknown } | { kind: 'global'; value: unknown }
const epoch = 1_800_000_000_000

// This formula and the literals below describe v1, independently of current writers.
function legacyId(...parts: (string | number)[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex') }
function legacyOutbox(label: string, state: LegacyTask['outbox']['state'] = 'accepted'): LegacyTask['outbox'] {
  return { state, messageId: `<old-${label}@example.com>`, attempts: 2, nextAt: 0,
    subject: `Frozen subject ${label}`, text: `Frozen text ${label}\r\n**old result**\r\n`,
    html: `<p>Frozen HTML ${label} &amp; unchanged</p>`, reason: '' }
}
function legacyTask(directory: string, label: string, patch: Record<string, unknown> = {}): LegacyTask {
  return v1TaskSchema.parse({ id: legacyId('task', label), mailId: legacyId('mail', label), account: 'work',
    rule: { id: 'report', account: 'work', authorization: { policy: 'trusted', allowedSenders: ['owner@example.com'] },
      match: { subjectPrefix: '[DSH]' }, task: { workspacePath: directory, agentPreset: 'mail-reader', permissionPreset: 'restricted', template: 'report' },
      reply: { account: 'work', to: 'owner@example.com' } },
    createdAt: epoch, prompt: `Old input ${label}`, title: `Old task ${label}`, sessionId: `old-session-${label}`, messageId: `old-input-${label}`,
    workspacePath: directory, originalMessageId: `<input-${label}@example.com>`, references: ['<ancestor@example.com>'],
    state: 'succeeded', summary: 'Old summary', reason: '', attempt: 1, lastOutput: '**Old final output**',
    report: { startedAt: epoch - 100, finishedAt: epoch, steps: 3, provider: 'old-provider', model: 'old-model' },
    authorization: { sender: 'owner@example.com', policy: { evidence: 'trusted-mta', authservIds: ['mx.example.com'], stripsUntrustedHeaders: true } },
    operations: [{ kind: 'operator-released-reply', at: epoch - 50 }], outbox: legacyOutbox(label), ...patch })
}

async function root(t: AsyncDisposableStack) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-migration-'))
  t.defer(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** Each phase opens the same medium through a new backend and fully drains it on close. */
async function storage(t: AsyncDisposableStack, directory: string, before?: (mutation: Mutation) => void, name: BackendName = 'sqlite') {
  const cleanup = t.use(new AsyncDisposableStack())
  const ctx = new Context()
  cleanup.defer(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  const medium = name === 'sqlite' ? new SqliteStorageBackend({ path: join(directory, 'state.sqlite'), journalMode: 'wal' })
    : new JsonStorageBackend(join(directory, 'json'))
  cleanup.defer(() => medium.close())
  const backend: StorageBackend = before ? {
    kv: { async open(descriptor) {
      const unit = await medium.kv.open(descriptor)
      const wrapped: KvUnit = {
        loadAll: () => unit.loadAll(),
        async putRecord(table, key, value) { before({ kind: 'put', table, key, value }); await unit.putRecord(table, key, value) },
        async deleteRecord(table, key) { before({ kind: 'delete', table, key }); await unit.deleteRecord(table, key) },
        deleteRecords: (table, keys) => unit.deleteRecords(table, keys),
        async setGlobal(value) { before({ kind: 'global', value }); await unit.setGlobal(value) },
        close: () => unit.close(),
      }
      return wrapped
    } }, close: () => medium.close(),
  } : medium
  ctx.storage.backend.register(name, backend)
  return { facility: new DomainFacility(ctx, { backend: name }), backend, cleanup, close: () => cleanup.disposeAsync() }
}

async function seed(t: AsyncDisposableStack, directory: string, values: { tasks?: LegacyTask[]; inbox?: LegacyInbox[]; cursors?: [string, LegacyCursor][] }, name: BackendName = 'sqlite') {
  const phase = await storage(t, directory, undefined, name)
  const domain = await phase.facility.open(v1MailDomain)
  phase.cleanup.defer(() => domain.close())
  for (const value of values.tasks ?? []) await domain.table('tasks').put(value.id, value)
  for (const value of values.inbox ?? []) await domain.table('inbox').put(value.id, value)
  for (const [key, value] of values.cursors ?? []) await domain.table('cursors').put(key, value)
  await phase.close()
}

async function open(t: AsyncDisposableStack, directory: string, name: BackendName = 'sqlite') {
  const phase = await storage(t, directory, undefined, name)
  const store = await DomainMailStore.open(phase.facility)
  phase.cleanup.defer(() => store.close())
  return { ...phase, store }
}

async function snapshot(t: AsyncDisposableStack, directory: string, name: BackendName = 'sqlite') {
  const phase = await storage(t, directory, undefined, name)
  const unit = await phase.backend.kv!.open(descriptorOf(mailDomain))
  phase.cleanup.defer(() => unit.close())
  const value = await unit.loadAll()
  await phase.close()
  return value
}

async function application(t: AsyncDisposableStack, directory: string, name: BackendName = 'sqlite') {
  const phase = await open(t, directory, name)
  const spool = new Spool(join(directory, 'spool'))
  await spool.open(60_000)
  phase.cleanup.defer(() => spool.close())
  const executed: TaskRecord[] = []
  const sent: OutboundMessage[] = []
  const reports: string[] = []
  let now = epoch + 1_000
  const runtime = new MailRuntime(configuration(directory), spool, { store: phase.store,
    executor: { async validate() {}, async execute(task) { executed.push(task); return { state: 'succeeded', summary: 'New result', reason: '' } } },
    async verify() {}, async send(message) { sent.push(message); return { state: 'accepted' } }, report: code => reports.push(code), now: () => now })
  phase.cleanup.defer(() => runtime.close())
  await runtime.initialize()
  const tick = async () => { now += 10; await runtime.tick(); await runtime.whenSettled() }
  return { ...phase, spool, runtime, executed, sent, reports, tick }
}

for (const name of ['sqlite', 'json'] as const) test(`v1 ${name} preserves record identities, raw bytes, frozen outbox and protocol positions across repeated opens`, async () => {
  await using t = new AsyncDisposableStack()
  const directory = await root(t)
  const source = legacyId('pop3', 'mail.internal', 995, 'bot')
  const validity = legacyId(source, 'uidl-2')
  const imapKey = legacyId('work', 'INBOX')
  const popKey = legacyId('work', source)
  const raw = Buffer.from('From: owner@example.com\r\nSubject: old bytes\r\n\r\n\x80\xff', 'latin1')
  const rawHash = createHash('sha256').update(raw).digest('hex')
  await mkdir(join(directory, 'spool', 'raw'), { recursive: true })
  await writeFile(join(directory, 'spool', 'raw', `${rawHash}.eml`), raw, { mode: 0o600 })
  const inbox = [v1InboxSchema.parse({ id: legacyId('work', 'INBOX', '123', 7), account: 'work', folder: 'INBOX', uidValidity: '123', uid: 7,
    receivedAt: epoch, rawHash, state: 'matched', reason: 'report', attempts: 0, nextAt: 0 }),
  v1InboxSchema.parse({ id: legacyId('work', 'INBOX', validity, 0), account: 'work', folder: 'INBOX', uidValidity: validity, uid: 0,
    receivedAt: epoch, rawHash, state: 'ignored', reason: 'no-authorized-rule', attempts: 0, nextAt: 0 })]
  const notice = legacyTask(directory, 'notice', { id: legacyId('session-notification', 'external-session', 4), origin: 'session', turn: 4, sessionId: 'external-session' })
  const tasks = [legacyTask(directory, 'new'), legacyTask(directory, 'reply', { continuation: true, turn: 2, sequence: 1 }),
    legacyTask(directory, 'external-reply', { origin: 'session', continuation: true, turn: 5, sessionId: 'external-session' }), notice]
  await seed(t, directory, { tasks, inbox, cursors: [[imapKey, { validity: '123', high: 7 }],
    [popKey, { validity: JSON.stringify(['uidl-1', 'uidl-2']), high: 0 }], ['notification-epoch', { validity: 'turn-v1', high: epoch }]] }, name)
  const first = await application(t, directory, name)
  expect(first.store.recordCount).toBe(4)
  expect(first.store.inboxCount).toBe(2)
  expect(first.store.cursor(imapKey)).toEqual({ kind: 'imap', uidValidity: '123', high: 7 })
  expect(first.store.cursor(popKey)).toEqual({ kind: 'pop3', seen: ['uidl-1', 'uidl-2'] })
  expect(first.store.notificationState()).toEqual({ state: 'observing', since: epoch })
  for (const old of tasks) {
    const current = first.store.getRecord(old.id)!
    expect(current.id).toBe(old.id)
    expect(current.outbox).toEqual(old.outbox)
    expect(current.authorization).toEqual(old.authorization)
    expect(current.rule).toEqual(old.rule)
    expect(current.operations).toEqual(old.operations)
    expect(current).not.toHaveProperty('origin')
    expect(current).not.toHaveProperty('continuation')
    if (old === notice) {
      expect(current.kind).toBe('notification')
      expect(current).toHaveProperty('turn', 4)
      for (const field of ['mailId', 'prompt', 'messageId', 'attempt', 'sequence', 'inputHash', 'receipt']) expect(current).not.toHaveProperty(field)
    } else {
      expect(current.kind).toBe('task')
      expect(current).toHaveProperty('mode', old.continuation ? 'followup' : 'new')
      expect(current).toHaveProperty('prompt', old.prompt)
    }
    if (old.turn !== undefined) expect(current.report?.turn).toBe(old.turn)
  }
  expect(await first.spool.read(rawHash)).toEqual(raw)
  expect(mailIdentity('work', 'INBOX', '123', 7)).toBe(inbox[0]!.id)
  expect(mailIdentity('work', 'INBOX', validity, 0)).toBe(inbox[1]!.id)
  for (const old of inbox) {
    expect(first.store.getInbox(old.id)).toEqual({ id: old.id, account: old.account, receivedAt: epoch, rawHash,
      state: old.state, reason: old.reason, attempts: 0, nextAt: 0 })
    await first.runtime.admit({ id: mailIdentity('work', 'INBOX', old.uidValidity, old.uid), account: 'work', receivedAt: epoch, raw })
  }
  expect(first.store.inboxCount).toBe(2)
  expect(first.store.recordCount).toBe(4)
  await first.store.putCursor(imapKey, { kind: 'imap', uidValidity: '123', high: 9 })
  await first.store.putNotificationState({ state: 'paused', since: epoch + 10 })
  await first.close()
  for (let index = 0; index < 2; index++) {
    const next = await open(t, directory, name)
    expect(next.store.recordCount).toBe(4)
    expect(next.store.cursor(imapKey)).toEqual({ kind: 'imap', uidValidity: '123', high: 9 })
    expect(next.store.notificationState()).toEqual({ state: 'paused', since: epoch + 10 })
    expect(next.store.getRecord(notice.id)?.outbox).toEqual(notice.outbox)
    await next.close()
  }
  const saved = await snapshot(t, directory, name)
  expect(saved.tables.cursors).toEqual({})
  expect(saved.global).toEqual({ migrationComplete: true, notifications: { state: 'paused', since: epoch + 10 } })
  const old = await storage(t, directory, undefined, name)
  await expect(old.facility.open(v1MailDomain)).rejects.toMatchObject({ code: 'version-mismatch' })
})

for (const failure of ['rejected-write', 'unknown-state'] as const) test(`interrupted v1 migration reopens mixed SQLite rows after ${failure}`, async () => {
  await using t = new AsyncDisposableStack()
  const directory = await root(t)
  const tasks = [legacyTask(directory, 'first'), legacyTask(directory, 'second')]
  await seed(t, directory, { tasks })
  let writes = 0
  const interrupted = await storage(t, directory, mutation => {
    if (mutation.kind === 'put' && mutation.table === 'tasks' && ++writes === 2) {
      if (failure === 'unknown-state') throw new StorageError('unknown-state', 'injected-before-second-row')
      throw new Error('injected-before-second-row')
    }
  })
  await expect(DomainMailStore.open(interrupted.facility)).rejects.toThrow('injected-before-second-row')
  await interrupted.close()
  const partial = await snapshot(t, directory)
  const discriminator = z.object({ kind: z.literal('task') })
  expect(Object.values(partial.tables.tasks!).filter(value => discriminator.safeParse(value).success)).toHaveLength(1)
  expect(Object.values(partial.tables.tasks!).filter(value => v1TaskSchema.safeParse(value).success)).toHaveLength(1)
  expect(partial.global).toBeNull()
  const resumed = await open(t, directory)
  expect(resumed.store.recordCount).toBe(2)
  for (const task of tasks) expect(resumed.store.getRecord(task.id)?.outbox).toEqual(task.outbox)
  await resumed.close()
  const complete = await snapshot(t, directory)
  expect(Object.values(complete.tables.tasks!).every(value => discriminator.safeParse(value).success)).toBe(true)
  expect(complete.global).toEqual({ migrationComplete: true })
})

for (const conflict of [false, true]) test(`mailbox migration ${conflict ? 'refuses a conflicting replacement' : 'resumes after its replacement committed'}`, async () => {
  await using t = new AsyncDisposableStack()
  const directory = await root(t)
  const key = legacyId('work', 'INBOX')
  await seed(t, directory, { cursors: [[key, { validity: '55', high: 8 }]] })
  const interrupted = await storage(t, directory, mutation => {
    if (mutation.kind === 'delete' && mutation.key === key) throw new Error('injected-before-cursor-delete')
  })
  await expect(DomainMailStore.open(interrupted.facility)).rejects.toThrow('injected-before-cursor-delete')
  await interrupted.close()
  const partial = await snapshot(t, directory)
  expect(partial.tables.cursors?.[key]).toEqual({ validity: '55', high: 8 })
  expect(partial.tables.mailboxes?.[key]).toEqual({ kind: 'imap', uidValidity: '55', high: 8 })
  if (conflict) {
    const changed = await storage(t, directory)
    const domain = await changed.facility.open(mailDomain)
    changed.cleanup.defer(() => domain.close())
    await domain.table('mailboxes').put(key, { kind: 'imap', uidValidity: '55', high: 9 })
    await changed.close()
  }
  const resumed = await storage(t, directory, mutation => {
    if (mutation.kind === 'put' && mutation.table === 'mailboxes') throw new Error('unexpected-mailbox-rewrite')
  })
  if (conflict) {
    await expect(DomainMailStore.open(resumed.facility)).rejects.toMatchObject({ code: 'mailbox-migration-conflict' })
    await resumed.close()
    const saved = await snapshot(t, directory)
    expect(saved.tables.mailboxes?.[key]).toEqual({ kind: 'imap', uidValidity: '55', high: 9 })
    expect(saved.tables.cursors?.[key]).toEqual({ validity: '55', high: 8 })
    expect(saved.global).toBeNull()
  } else {
    const store = await DomainMailStore.open(resumed.facility)
    resumed.cleanup.defer(() => store.close())
    expect(store.cursor(key)).toEqual({ kind: 'imap', uidValidity: '55', high: 8 })
    await resumed.close()
    expect((await snapshot(t, directory)).tables.cursors).toEqual({})
  }
})

for (const name of ['sqlite', 'json'] as const) for (const stage of ['before-marker', 'after-marker'] as const) test(`${name} notification epoch survives migration interruption ${stage}`, async () => {
  await using t = new AsyncDisposableStack()
  const directory = await root(t)
  const key = legacyId('work', 'INBOX')
  await seed(t, directory, { cursors: [[key, { validity: '55', high: 8 }], ['notification-epoch', { validity: 'paused', high: epoch }]] }, name)
  let injected = false
  const interrupted = await storage(t, directory, mutation => {
    if (stage === 'before-marker' ? mutation.kind === 'global' : mutation.kind === 'delete' && mutation.key === 'notification-epoch') {
      injected = true; throw new Error('injected-marker-interruption')
    }
  }, name)
  await expect(DomainMailStore.open(interrupted.facility)).rejects.toThrow('injected-marker-interruption')
  expect(injected).toBe(true)
  await interrupted.close()
  const partial = await snapshot(t, directory, name)
  expect(partial.tables.mailboxes?.[key]).toEqual({ kind: 'imap', uidValidity: '55', high: 8 })
  expect(partial.tables.cursors?.['notification-epoch']).toEqual({ validity: 'paused', high: epoch })
  if (stage === 'after-marker') {
    expect(partial.global).toEqual({ migrationComplete: true, notifications: { state: 'paused', since: epoch } })
    const direct = await storage(t, directory, undefined, name)
    const domain = await direct.facility.open(mailDomain)
    direct.cleanup.defer(() => domain.close())
    await domain.global.set({ migrationComplete: true, notifications: { state: 'observing', since: epoch + 50 } })
    await direct.close()
  } else expect(partial.global).toBeNull()
  const resumed = await open(t, directory, name)
  expect(resumed.store.notificationState()).toEqual(stage === 'after-marker' ? { state: 'observing', since: epoch + 50 } : { state: 'paused', since: epoch })
  expect(resumed.store.cursor(key)).toEqual({ kind: 'imap', uidValidity: '55', high: 8 })
  await resumed.close()
  expect((await snapshot(t, directory, name)).tables.cursors).toEqual({})
})

test('legacy pending sends once while uncertain sends and interrupted work are never repeated automatically', async () => {
  await using t = new AsyncDisposableStack()
  const directory = await root(t)
  const pending = legacyTask(directory, 'pending', { outbox: legacyOutbox('pending', 'pending') })
  const sending = legacyTask(directory, 'sending', { outbox: legacyOutbox('sending', 'sending') })
  const unknown = legacyTask(directory, 'unknown', { outbox: legacyOutbox('unknown', 'unknown') })
  const accepted = legacyTask(directory, 'accepted')
  const receipt = legacyTask(directory, 'receipt', { receipt: legacyOutbox('receipt', 'sending') })
  const pendingReceipt = legacyTask(directory, 'pending-receipt', { receipt: legacyOutbox('pending-receipt', 'pending') })
  const running = legacyTask(directory, 'running', { state: 'starting', outbox: legacyOutbox('running', 'none') })
  const active = legacyTask(directory, 'active', { state: 'running', outbox: legacyOutbox('active', 'none') })
  const queued = legacyTask(directory, 'queued-followup', { state: 'queued', continuation: true, sessionId: running.sessionId, outbox: legacyOutbox('queued', 'none') })
  await seed(t, directory, { tasks: [pending, sending, unknown, accepted, receipt, pendingReceipt, running, active, queued] })
  const first = await application(t, directory)
  expect(first.store.getRecord(running.id)).toMatchObject({ kind: 'task', state: 'needs_attention', reason: 'restart-during-execution' })
  expect(first.store.getRecord(active.id)).toMatchObject({ kind: 'task', state: 'needs_attention', reason: 'restart-during-execution' })
  expect(first.store.getRecord(queued.id)).toMatchObject({ kind: 'task', mode: 'followup', state: 'needs_attention', reason: 'previous-turn-interrupted' })
  expect(first.store.getRecord(sending.id)?.outbox).toEqual({ ...sending.outbox, state: 'unknown', reason: 'restart-during-send' })
  expect(first.store.getRecord(receipt.id)).toMatchObject({ receipt: { ...receipt.receipt, state: 'unknown', reason: 'restart-during-send' } })
  for (let index = 0; index < 8; index++) await first.tick()
  expect(first.executed).toEqual([])
  expect(first.sent.filter(message => message.taskId === pending.id)).toHaveLength(1)
  expect(first.sent.find(message => message.taskId === pending.id)).toMatchObject({ messageId: pending.outbox.messageId, subject: pending.outbox.subject, text: pending.outbox.text, html: pending.outbox.html })
  expect(first.sent.filter(message => message.taskId === pendingReceipt.id)).toHaveLength(1)
  expect(first.sent.find(message => message.taskId === pendingReceipt.id)).toMatchObject({ messageId: pendingReceipt.receipt!.messageId,
    subject: pendingReceipt.receipt!.subject, text: pendingReceipt.receipt!.text, html: pendingReceipt.receipt!.html })
  for (const task of [sending, unknown, accepted, receipt]) expect(first.sent.some(message => message.taskId === task.id)).toBe(false)
  expect(first.reports).toEqual([])
  await first.close()
  const second = await application(t, directory)
  for (let index = 0; index < 3; index++) await second.tick()
  expect(second.executed).toEqual([])
  expect(second.sent).toEqual([])
  expect(second.store.getRecord(pending.id)?.outbox.state).toBe('accepted')
  expect(second.store.getRecord(unknown.id)?.outbox).toEqual(unknown.outbox)
})

test('an old external Session notice deduplicates and its reply continues the original Session', async () => {
  await using t = new AsyncDisposableStack()
  const directory = await root(t)
  const sessionId = brandString<SessionId>('external-session')
  const old = legacyTask(directory, 'external-notice', { id: legacyId('session-notification', sessionId, 4), sessionId, turn: 4, origin: 'session' })
  await seed(t, directory, { tasks: [old] })
  const app = await application(t, directory)
  await app.runtime.notifySession({ sessionId, turn: 4, title: 'Observed again', workspacePath: directory, state: 'succeeded', lastOutput: 'Observed again', reason: '' })
  expect(app.store.recordCount).toBe(1)
  expect(app.store.getRecord(old.id)?.outbox).toEqual(old.outbox)
  const raw = Buffer.from(['From: owner@example.com', 'To: bot@example.com', 'Subject: Re: old external result',
    'Message-ID: <new-external-reply@example.com>', `In-Reply-To: ${old.outbox.messageId}`, `References: ${old.outbox.messageId}`,
    'Content-Type: text/plain; charset=utf-8', '', 'Continue with more details.'].join('\r\n'))
  const id = mailIdentity('work', 'INBOX', '123', 9)
  await app.runtime.admit({ id, account: 'work', receivedAt: epoch, raw })
  await app.tick()
  expect(app.executed).toHaveLength(1)
  expect(app.executed[0]).toMatchObject({ kind: 'task', mode: 'followup', sessionId, workspacePath: directory,
    authorization: old.authorization, rule: old.rule })
  expect(app.executed[0]).not.toHaveProperty('origin')
  await app.runtime.admit({ id, account: 'work', receivedAt: epoch, raw })
  await app.tick()
  expect(app.store.recordCount).toBe(2)
  expect(app.executed).toHaveLength(1)
  expect(app.reports).toEqual([])
})

for (const [label, key, cursor] of [
  ['unknown mailbox encoding', 'mailbox', { validity: 'unrecognized-position', high: 0 }],
  ['POP3 list with a watermark', 'mailbox', { validity: '["uidl-1"]', high: 3 }],
  ['non-string POP3 UIDL', 'mailbox', { validity: '[7]', high: 0 }],
  ['unknown notification epoch', 'notification-epoch', { validity: 'unrecognized-epoch', high: epoch }],
] as const) test(`migration refuses ${label} without resetting old state`, async () => {
  await using t = new AsyncDisposableStack()
  const directory = await root(t)
  await seed(t, directory, { cursors: [[key, cursor]] })
  const phase = await storage(t, directory)
  await expect(DomainMailStore.open(phase.facility)).rejects.toThrow()
  await phase.close()
  const unchanged = await storage(t, directory)
  const domain = await unchanged.facility.open(v1MailDomain)
  unchanged.cleanup.defer(() => domain.close())
  expect(domain.table('cursors').get(key)).toEqual(cursor)
})

test('a legacy Session notification without an observed turn fails closed', async () => {
  await using t = new AsyncDisposableStack()
  const directory = await root(t)
  const old = legacyTask(directory, 'missing-turn', { origin: 'session' })
  await seed(t, directory, { tasks: [old] })
  const phase = await storage(t, directory)
  await expect(DomainMailStore.open(phase.facility)).rejects.toThrow()
  await phase.close()
  const unchanged = await storage(t, directory)
  const domain = await unchanged.facility.open(v1MailDomain)
  unchanged.cleanup.defer(() => domain.close())
  expect(domain.table('tasks').get(old.id)).toEqual(old)
})
