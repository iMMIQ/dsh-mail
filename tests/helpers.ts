// SPDX-License-Identifier: LGPL-3.0-or-later
/** Isolated real SQLite/domain fixtures shared by runtime and transport tests. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { Config } from '../src/config.ts'
import { DomainMailStore, Spool } from '../src/store.ts'
import { MailRuntime } from '../src/runtime.ts'
import type { RuntimeDependencies, Delivery, TaskRecord, OutboundMessage } from '../src/types.ts'

/** A syntactically real message whose MTA assertion is accepted only by explicit policy. */
export function message(subject = '[DSH] report', body = 'Summarize the repository.', headers: string[] = []): Buffer {
  return Buffer.from([
    'From: owner@example.com', 'To: bot@example.com', `Subject: ${subject}`,
    'Message-ID: <fixture@example.com>',
    'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com',
    'Content-Type: text/plain; charset=utf-8', ...headers, '', body,
  ].join('\r\n'))
}

/** Full validated config; literal endpoints here are parser inputs, not acquired ports. */
export function configuration(directory: string): Config {
  return Config.parse({ stateDirectory: directory, notifications: { receipts: false },
    accounts: [{ id: 'work', address: 'bot@example.com',
      receive: { protocol: 'imap', host: 'localhost', port: 993, tls: 'direct', auth: { user: 'bot', credentialRef: 'MAIL_PASSWORD' } },
      send: { protocol: 'smtp', host: 'localhost', port: 465, tls: 'direct', auth: { user: 'bot', credentialRef: 'MAIL_PASSWORD' } } }],
    senderPolicies: { trusted: { evidence: 'trusted-mta', authservIds: ['mx.example.com'], stripsUntrustedHeaders: true } },
    templates: { report: 'Task subject: {{subject}}\nExternal email body:\n{{body}}' },
    rules: [{ id: 'report', account: 'work', authorization: { policy: 'trusted', allowedSenders: ['owner@example.com'] },
      match: { subjectPrefix: '[DSH]' }, task: { workspacePath: directory, agentPreset: 'mail-reader', permissionPreset: 'restricted', template: 'report' },
      reply: { account: 'work', to: 'owner@example.com' } }],
    runtime: { retryDelayMs: 1, minSendIntervalMs: 1 },
  })
}

/** Owned resource stack closes sockets/workers before storage and directories. */
export async function fixture(t: AsyncDisposableStack, override: Partial<RuntimeDependencies> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-'))
  const cleanup: (() => Promise<unknown>)[] = [() => rm(directory, { recursive: true, force: true })]
  t.defer(async () => { for (const close of cleanup.reverse()) await close() })
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: join(directory, 'state.sqlite'), journalMode: 'wal' })
  ctx.storage.backend.register('sqlite', backend)
  cleanup.push(() => backend.close())
  const facility = new DomainFacility(ctx, { backend: 'sqlite' })
  const store = await DomainMailStore.open(facility)
  cleanup.push(() => store.close())
  const spool = new Spool(join(directory, 'spool'))
  await spool.open(60_000)
  cleanup.push(() => spool.close())
  const config = configuration(directory)
  let now = Date.now()
  const executed: TaskRecord[] = []
  const sent: OutboundMessage[] = []
  const reports: string[] = []
  const deps: RuntimeDependencies = { store, executor: { async validate() {}, async execute(task) {
    executed.push(task); return { state: 'succeeded', summary: 'Repository summarized.', reason: '' }
  } }, async verify() {}, async send(task) { sent.push(task); return { state: 'accepted' } },
  report: code => reports.push(code), now: () => now, ...override }
  const runtime = new MailRuntime(config, spool, deps)
  cleanup.push(() => runtime.close())
  await runtime.initialize()
  const delivery = (uid = 1, raw = message()): Delivery => ({ account: 'work', folder: 'INBOX', uidValidity: '1', uid, receivedAt: now, raw: Buffer.from(raw.toString().replace('Message-ID: <fixture@example.com>', `Message-ID: <fixture-${uid}@example.com>`)) })
  const finish = async (): Promise<void> => { await runtime.tick(); await runtime.whenSettled(); now += 10; await runtime.tick() }
  return { directory, config, store, facility, spool, runtime, deps, executed, sent, reports, cleanup, delivery, finish, advance: () => { now += 10_000 } }
}
