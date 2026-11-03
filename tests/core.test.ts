// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../src/config.ts'
import { parseMail, taskPrompt } from '../src/mail.ts'
import { verifySender } from '../src/auth.ts'
import { MailRuntime } from '../src/runtime.ts'
import { Spool, DomainMailStore } from '../src/store.ts'
import { MailError } from '../src/types.ts'
import nodemailer from 'nodemailer'
import { configuration, fixture, message } from './helpers.ts'
import { readFile as readExample } from 'node:fs/promises'
import { load } from 'js-yaml'
import { z } from 'zod'
import { taskWorkspace } from '../src/workspace.ts'

test('configuration rejects unknown fields, missing references and empty sender lists', () => {
  const config = configuration('/tmp/parser-only')
  assert.throws(() => Config.parse({ ...config, typo: true }))
  assert.throws(() => Config.parse({ ...config, templates: {} }))
  assert.throws(() => Config.parse({ ...config, rules: [...config.rules, ...config.rules] }))
  assert.throws(() => Config.parse({ ...config, rules: config.rules.map(r => ({ ...r, authorization: { ...r.authorization, allowedSenders: [] } })) }))
  assert.throws(() => Config.parse({ ...config, templates: { report: '{{notDefined}}' } }))
})

test('MIME parsing and template replacement preserve external text literally', async () => {
  const config = configuration('/tmp/parser-only')
  const mail = await parseMail(message('[DSH] unicode 邮件', '{{subject}} is data, not another substitution.'), config.runtime)
  assert.equal(mail.from, 'owner@example.com')
  assert.match(taskPrompt(mail, config.rules[0]!, config), /\{\{subject\}\} is data/)
  assert.match(mail.subject, /邮件/)
  await assert.rejects(parseMail(message(), { ...config.runtime, maxMessageBytes: 1 }), /message-too-large/)
})

test('sender verification requires an explicit trusted MTA and an aligned domain', async () => {
  const config = configuration('/tmp/parser-only')
  const raw = message()
  const mail = await parseMail(raw, config.runtime)
  await verifySender(raw, mail, config.senderPolicies.trusted!, new AbortController().signal, 1_000)
  await assert.rejects(verifySender(raw, mail, { evidence: 'trusted-mta', authservIds: ['attacker.invalid'], stripsUntrustedHeaders: true }, new AbortController().signal, 1_000))
  const forged = message().toString().replace('header.from=example.com', 'header.from=evil.example')
  await assert.rejects(verifySender(Buffer.from(forged), await parseMail(Buffer.from(forged), config.runtime), config.senderPolicies.trusted!, new AbortController().signal, 1_000))
})

test('comment text and duplicate From headers cannot supply trusted evidence', async () => {
  const config = configuration('/tmp/parser-only')
  for (const raw of [message().toString().replace('dmarc=pass header.from=example.com', '(dmarc=pass header.from=example.com)'), message().toString().replace('To:', 'From: attacker@invalid.test\r\nTo:')]) {
    await assert.rejects(verifySender(Buffer.from(raw), await parseMail(Buffer.from(raw), config.runtime), config.senderPolicies.trusted!, new AbortController().signal, 1_000))
  }
})

test('unsigned messages fail local signature verification without enabling a From fallback', async () => {
  const config = configuration('/tmp/parser-only')
  const raw = message()
  await assert.rejects(verifySender(raw, await parseMail(raw, config.runtime), { evidence: 'local-signature' }, new AbortController().signal, 1_000), /signature-invalid/)
})

test('concurrent duplicate admission creates one task and one reply', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  await Promise.all([f.runtime.admit(f.delivery()), f.runtime.admit(f.delivery()), f.runtime.admit(f.delivery())])
  await f.finish()
  assert.equal(f.store.inbox().length, 1)
  assert.equal(f.executed.length, 1)
  assert.equal(f.sent.length, 1)
  assert.equal(f.store.tasks()[0]?.outbox.state, 'accepted')
  assert.equal(f.reports.length, 0)
})

test('automatic replies are ignored and authorized follow-ups are held', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  await f.runtime.admit(f.delivery(1, message('[DSH] auto', 'test', ['Auto-Submitted: auto-replied'])))
  await f.runtime.admit(f.delivery(2, message('[DSH] reply', 'test', ['In-Reply-To: <previous@example.com>'])))
  await f.finish()
  assert.deepEqual(f.store.inbox().map(r => r.state), ['ignored', 'held'])
  assert.equal(f.executed.length, 0)
})

test('unallowlisted sender and stale messages never reach an executor', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  await f.runtime.admit(f.delivery(1, Buffer.from(message().toString().replace('owner@example.com', 'attacker@example.com'))))
  await f.runtime.admit({ ...f.delivery(2), receivedAt: Date.now() - 200_000_000 })
  await f.finish()
  assert.equal(f.executed.length, 0)
  assert.equal(f.store.inbox().filter(r => r.state === 'ignored').length, 2)
})

test('temporary verification failure is retried separately while later mail runs', async () => {
  await using t = new AsyncDisposableStack()
  let firstAttempts = 0
  const f = await fixture(t, { async verify(_raw, mail) {
    if (mail.subject.endsWith('first') && firstAttempts++ === 0) throw new MailError('dns-temporary', true)
  } })
  await f.runtime.admit(f.delivery(1, message('[DSH] first')))
  await f.runtime.admit(f.delivery(2, message('[DSH] second')))
  await f.runtime.tick(); await f.runtime.whenSettled()
  assert.equal(f.executed.length, 1)
  assert.equal(f.store.inbox()[0]?.state, 'verification_pending')
  f.advance(); await f.finish()
  assert.equal(f.executed.length, 2)
})

test('verification failure never invokes the task executor or sends a rejection email', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t, { async verify() { throw new MailError('signature-invalid') } })
  await f.runtime.admit(f.delivery()); await f.finish()
  assert.equal(f.store.inbox()[0]?.state, 'quarantined')
  assert.equal(f.executed.length, 0); assert.equal(f.sent.length, 0)
})

test('unknown SMTP acknowledgement is persisted and never automatically retried', async () => {
  await using t = new AsyncDisposableStack()
  let sends = 0
  const f = await fixture(t, { async send() { sends++; return { state: 'unknown', reason: 'connection-lost-after-data' } } })
  await f.runtime.admit(f.delivery()); await f.finish()
  for (let i = 0; i < 3; i++) { f.advance(); await f.runtime.tick() }
  assert.equal(sends, 1)
  const task = f.store.tasks()[0]!
  assert.equal(task.state, 'succeeded'); assert.equal(task.outbox.state, 'unknown')
  await assert.rejects(f.runtime.retryNotification(task.id), /not-retryable/)
  await f.runtime.retryNotification(task.id, true)
  await f.runtime.tick()
  assert.equal(sends, 2); assert.equal(f.executed.length, 1)
})

test('temporary SMTP rejection retries only frozen notification content', async () => {
  await using t = new AsyncDisposableStack()
  const content: string[] = []
  const f = await fixture(t, { async send(task) {
    content.push(JSON.stringify(task.outbox.text))
    return content.length === 1 ? { state: 'failed', retryable: true, reason: 'smtp-450' } : { state: 'accepted' }
  } })
  await f.runtime.admit(f.delivery()); await f.finish()
  f.advance(); await f.runtime.tick()
  assert.equal(content.length, 2); assert.equal(content[0], content[1]); assert.equal(f.executed.length, 1)
})

test('process restart preserves accepted tasks and quarantines interrupted side effects', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  await f.runtime.admit(f.delivery()); await f.finish()
  const task = f.store.tasks()[0]!
  await f.store.putTask({ ...task, state: 'running', outbox: { ...task.outbox, state: 'none' } })
  await f.runtime.close()
  const restarted = new MailRuntime(f.config, f.spool, f.deps)
  f.cleanup.push(() => restarted.close())
  await restarted.initialize(); await restarted.tick()
  assert.equal(f.store.tasks()[0]?.state, 'needs_attention')
  assert.equal(f.executed.length, 1)
})

test('restart during sending produces unknown without resubmitting', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  await f.runtime.admit(f.delivery()); await f.finish()
  const task = f.store.tasks()[0]!
  await f.store.putTask({ ...task, outbox: { ...task.outbox, state: 'sending' } })
  await f.runtime.close()
  const restarted = new MailRuntime(f.config, f.spool, f.deps)
  f.cleanup.push(() => restarted.close())
  await restarted.initialize(); await restarted.tick()
  assert.equal(f.store.tasks()[0]?.outbox.state, 'unknown'); assert.equal(f.sent.length, 1)
})

test('workspace serialization is synchronized by an explicit execution barrier', async () => {
  await using t = new AsyncDisposableStack()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let running = 0; let peak = 0; let executions = 0
  const f = await fixture(t, { executor: { async validate() {}, async execute() {
    peak = Math.max(peak, ++running); executions++; entered.resolve()
    await release.promise; running--; return { state: 'succeeded', summary: 'done', reason: '' }
  } } })
  f.cleanup.push(async () => { release.resolve() })
  await f.runtime.admit(f.delivery(1)); await f.runtime.admit(f.delivery(2))
  await f.runtime.tick(); await entered.promise
  await f.runtime.tick()
  assert.equal(executions, 1)
  release.resolve(); await f.runtime.whenSettled(); await f.runtime.tick(); await f.runtime.whenSettled()
  assert.equal(executions, 2); assert.equal(peak, 1)
})

test('cancellation drains an active executor before close completes', async () => {
  await using t = new AsyncDisposableStack()
  const entered = Promise.withResolvers<void>()
  let drained = false
  const f = await fixture(t, { executor: { async validate() {}, async execute(_task, signal) {
    entered.resolve()
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve() })
    drained = true; return { state: 'cancelled', summary: 'stopped', reason: 'cancelled' }
  } } })
  await f.runtime.admit(f.delivery()); await f.runtime.tick(); await entered.promise
  await f.runtime.close()
  assert.equal(drained, true); assert.equal(f.store.tasks()[0]?.state, 'cancelled')
})

test('spool refuses a second owner and detects corrupted stored bytes', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  const second = new Spool(f.spool.directory)
  await assert.rejects(second.open(60_000))
  const hash = await f.spool.write(message())
  const path = join(f.spool.directory, 'raw', `${hash}.eml`)
  await writeFile(path, 'corrupted')
  await assert.rejects(f.spool.read(hash), /content-corrupt/)
})

test('persistent SQLite state reopens with the same deduplication and outbox records', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  await f.runtime.admit(f.delivery()); await f.finish()
  const before = f.store.tasks()
  assert.equal((await readFile(join(f.directory, 'state.sqlite'))).subarray(0, 6).toString(), 'SQLite')
  await f.store.close()
  const reopened = await DomainMailStore.open(f.facility)
  f.cleanup.push(() => reopened.close())
  assert.deepEqual(reopened.tasks(), before)
  assert.equal(reopened.inbox().length, 1)
})

test('dry-run uses the production decision without writing inbox, spool, tasks or outbox', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  const result = await f.runtime.preview(message(), 'work')
  assert.ok('state' in result && result.state === 'matched')
  assert.equal(f.store.inbox().length, 0); assert.equal(f.store.tasks().length, 0)
  assert.equal(f.executed.length, 0); assert.equal(f.sent.length, 0)
})

test('held replies are re-verified before an operator releases them as independent tasks', async () => {
  await using t = new AsyncDisposableStack()
  let checks = 0
  const f = await fixture(t, { async verify() { checks++ } })
  await f.runtime.admit(f.delivery(1, message('[DSH] reply', 'do more', ['References: <old@example.com>'])))
  await f.finish()
  const record = f.store.inbox()[0]!
  assert.equal(record.state, 'held')
  await f.runtime.releaseReply(record.id)
  await f.finish()
  assert.equal(checks, 2); assert.equal(f.executed.length, 1)
  assert.equal(f.store.tasks()[0]?.operations[0]?.kind, 'operator-released-reply')
  await assert.rejects(f.runtime.releaseReply(record.id), /not-held/)
})

test('operator task retry creates a new Session identity and retains the old failure', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t, { executor: { async validate() {}, async execute() { return { state: 'failed', summary: 'Task failed.', reason: 'business-failure' } } } })
  await f.runtime.admit(f.delivery()); await f.finish()
  const first = f.store.tasks()[0]!
  await f.runtime.retryTask(first.id); await f.finish()
  const tasks = f.store.tasks()
  assert.equal(tasks.length, 2); assert.equal(tasks[0]?.state, 'failed')
  assert.notEqual(tasks[0]?.sessionId, tasks[1]?.sessionId)
  assert.equal(tasks[1]?.attempt, 2)
})

test('timeout aborts the executor and persists timed_out with a final notification', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t, { executor: { async validate() {}, async execute(_task, signal) {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    return { state: 'cancelled', summary: 'Stopped at the deadline.', reason: 'cancelled' }
  } } })
  f.config.rules[0]!.task.timeoutMs = 10
  await f.runtime.admit(f.delivery()); await f.finish()
  assert.equal(f.store.tasks()[0]?.state, 'timed_out')
  assert.equal(f.sent.length, 1)
})

test('queue saturation leaves the unadmitted UID available for later scans', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  f.config.runtime.maxQueuedTasks = 1
  await f.runtime.admit(f.delivery(1))
  await assert.rejects(f.runtime.admit(f.delivery(2)), /queue-full/)
  assert.equal(f.store.inbox().length, 1)
  assert.equal(f.runtime.cursor('uncommitted'), undefined)
  await f.finish(); await f.runtime.admit(f.delivery(2)); await f.finish()
  assert.equal(f.executed.length, 2)
})

test('corrupted spool blocks processing instead of allowing a later task to run', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  await f.runtime.admit(f.delivery())
  const record = f.store.inbox()[0]!
  await writeFile(join(f.spool.directory, 'raw', `${record.rawHash}.eml`), 'broken')
  await f.runtime.tick()
  assert.equal(f.executed.length, 0)
  await assert.rejects(f.runtime.admit(f.delivery(2)), /blocked/)
  assert.deepEqual(f.reports, ['mail-runtime-blocked'])
})

test('explicitly allowed UTF-8 attachments enter the logged task input with no file execution', async () => {
  const config = configuration('/tmp/parser-only')
  const rule = config.rules[0]!
  rule.task.attachmentTypes = ['text/plain']
  config.templates.report = '{{body}}\n{{attachmentText}}'
  const info = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
    from: 'owner@example.com', to: 'bot@example.com', subject: '[DSH] attachment', text: 'Analyze the attached text.',
    attachments: [{ filename: '../../input.txt', contentType: 'text/plain', content: 'attachment content' }],
  })
  assert.ok(Buffer.isBuffer(info.message))
  const raw = info.message
  const mail = await parseMail(raw, config.runtime)
  assert.match(taskPrompt(mail, rule, config), /attachment content/)
  assert.equal(mail.attachments.length, 1)
  await assert.rejects(parseMail(raw, { ...config.runtime, maxAttachments: 0 }), /attachments-too-large/)
})

test('the shipped profile patch passes the actual plugin schema', async () => {
  const patch = z.array(z.object({ config: z.unknown() })).parse(load(await readExample(new URL('../examples/mail.patch.yml', import.meta.url), 'utf8')))
  assert.equal(Config.parse(patch[0]!.config).rules[0]?.id, 'repository-report')
})

test('queued tasks retain snapshots and stop after source policy revocation', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  f.config.runtime.maxConcurrentTasks = 1
  await f.runtime.admit(f.delivery(1)); await f.finish()
  const old = f.store.tasks()[0]!
  await f.store.putTask({ ...old, state: 'queued', outbox: { ...old.outbox, state: 'none' } })
  f.config.senderPolicies.trusted = { evidence: 'local-signature' }
  await f.finish()
  assert.equal(f.store.tasks()[0]?.state, 'needs_attention')
  assert.equal(f.executed.length, 1)
  assert.equal(old.authorization.policy.evidence, 'trusted-mta')
})

test('different accounts and workspaces can execute concurrently without starving an account', async () => {
  await using t = new AsyncDisposableStack()
  const both = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const accounts: string[] = []
  const f = await fixture(t, { executor: { async validate() {}, async execute(task) {
    accounts.push(task.account); if (accounts.length === 2) both.resolve()
    await release.promise
    return { state: 'succeeded', summary: 'done', reason: '' }
  } } })
  f.cleanup.push(async () => { release.resolve() })
  const second = structuredClone(f.config.accounts[0]!)
  second.id = 'other'; f.config.accounts.push(second)
  const secondRule = structuredClone(f.config.rules[0]!)
  secondRule.id = 'other-rule'; secondRule.account = 'other'; secondRule.task.workspacePath = join(f.directory, 'other-parser-only')
  await mkdir(secondRule.task.workspacePath)
  f.config.rules.push(secondRule)
  await f.runtime.admit(f.delivery(1)); await f.runtime.admit(f.delivery(2))
  await f.runtime.admit({ ...f.delivery(1), account: 'other' })
  await f.runtime.tick(); await both.promise
  assert.deepEqual([...accounts].sort(), ['other', 'work'])
  release.resolve(); await f.runtime.whenSettled(); await f.runtime.tick(); await f.runtime.whenSettled()
  assert.equal(accounts.filter(a => a === 'work').length, 2)
})

test('mail tasks default to full access and do not require a configured directory', () => {
  const original = configuration('/tmp/parser-only')
  const { workspacePath: _directory, permissionPreset: _permissions, ...task } = original.rules[0]!.task
  const config = Config.parse({ ...original, rules: [{ ...original.rules[0]!, task }] })
  assert.equal(config.rules[0]!.task.permissionPreset, 'danger-full-access')
  assert.equal(config.rules[0]!.task.workspacePath, undefined)
})

test('authenticated email selects any existing directory without a root allowlist', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  const selected = await mkdtemp(join(tmpdir(), 'dsh-mail-selected-'))
  f.cleanup.splice(1, 0, () => rm(selected, { recursive: true, force: true }))
  await f.runtime.admit(f.delivery(1, message('[DSH] workspace', `---\nworkspace: ${JSON.stringify(selected)}\n---\nAnalyze this directory.`)))
  await f.finish()
  const task = f.executed[0]!
  assert.equal(task.workspacePath, await realpath(selected))
  assert.notEqual(task.workspacePath, f.config.rules[0]!.task.workspacePath)
  assert.match(task.prompt, /Working directory:/)
  assert.match(task.prompt, /External email body:\nAnalyze this directory\.$/)
  assert.doesNotMatch(task.prompt, /workspace:|---/)
})

test('missing, malformed and invalid email directories are quarantined without creating tasks', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  delete f.config.rules[0]!.task.workspacePath
  await writeFile(join(f.directory, 'not-a-directory'), 'file')
  const inputs = [
    ['No metadata.', 'workspace-required'],
    ['---\nworkspace: relative/path\n---\nTask.', 'workspace-metadata-invalid'],
    ['---\nworkspace: /tmp\nworkspace: /\n---\nTask.', 'workspace-metadata-invalid'],
    ['---\nworkspace: /tmp\npermissionPreset: custom\n---\nTask.', 'workspace-metadata-invalid'],
    ['---\nworkspace: /tmp\nTask.', 'workspace-metadata-invalid'],
    [`---\nworkspace: ${JSON.stringify(join(f.directory, 'missing'))}\n---\nTask.`, 'workspace-unavailable'],
    [`---\nworkspace: ${JSON.stringify(join(f.directory, 'not-a-directory'))}\n---\nTask.`, 'workspace-not-directory'],
  ]
  for (const [index, [body, reason]] of inputs.entries()) {
    await f.runtime.admit(f.delivery(index + 1, message('[DSH] invalid directory', body!)))
    await f.runtime.tick()
    assert.equal(f.store.inbox().at(-1)?.reason, reason)
    assert.equal(f.store.inbox().at(-1)?.state, 'quarantined')
  }
  assert.equal(f.store.tasks().length, 0)
  await assert.rejects(realpath(join(f.directory, 'missing')), { code: 'ENOENT' })
})

test('preview resolves the email directory and exposes the effective permissions without writing', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  delete f.config.rules[0]!.task.workspacePath
  f.config.rules[0]!.task.permissionPreset = 'danger-full-access'
  const preview = await f.runtime.preview(message('[DSH] preview', `---\nworkspace: ${JSON.stringify(f.directory)}\n---\nTask.`), 'work')
  const result = z.object({ state: z.literal('matched'), workspacePath: z.string(), permissionPreset: z.string() }).parse(preview)
  assert.equal(result.workspacePath, await realpath(f.directory))
  assert.equal(result.permissionPreset, 'danger-full-access')
  assert.equal(f.store.inbox().length, 0)
  assert.equal(f.store.tasks().length, 0)
})

test.skipIf(process.platform === 'win32')('symlink aliases from email share the canonical workspace serialization key', async () => {
  await using t = new AsyncDisposableStack()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let runs = 0
  const f = await fixture(t, { executor: { async validate() {}, async execute() {
    runs++; entered.resolve(); await release.promise
    return { state: 'succeeded', summary: 'done', reason: '' }
  } } })
  f.cleanup.push(async () => { release.resolve() })
  const actual = join(f.directory, 'actual')
  const alias = join(f.directory, 'alias')
  await mkdir(actual); await symlink(actual, alias, 'dir')
  for (const [index, directory] of [actual, alias].entries()) {
    await f.runtime.admit(f.delivery(index + 1, message('[DSH] alias', `---\nworkspace: ${JSON.stringify(directory)}\n---\nTask.`)))
  }
  await f.runtime.tick(); await entered.promise; await f.runtime.tick()
  assert.equal(runs, 1)
  assert.equal(f.store.tasks()[0]?.workspacePath, f.store.tasks()[1]?.workspacePath)
  release.resolve(); await f.runtime.whenSettled(); await f.runtime.tick(); await f.runtime.whenSettled()
  assert.equal(runs, 2)
})

test('fixed-directory task records without the new selected-directory field still reopen', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t)
  await f.runtime.admit(f.delivery()); await f.finish()
  const { workspacePath: _selected, ...legacy } = f.store.tasks()[0]!
  await f.store.putTask(legacy)
  await f.store.close()
  const reopened = await DomainMailStore.open(f.facility)
  f.cleanup.push(() => reopened.close())
  assert.equal(taskWorkspace(reopened.tasks()[0]!), f.config.rules[0]!.task.workspacePath)
})

test('final notifications persist and include the Agent text independently of the summary', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t, { executor: { async validate() {}, async execute() {
    return { state: 'succeeded', summary: 'Checks completed.', reason: '', lastOutput: '分析完成：已修复两个问题，测试通过。' }
  } } })
  await f.runtime.admit(f.delivery()); await f.finish()
  const task = f.store.tasks()[0]!
  assert.equal(task.lastOutput, '分析完成：已修复两个问题，测试通过。')
  assert.match(f.sent[0]!.outbox.text, /Summary:\nChecks completed\./)
  assert.match(f.sent[0]!.outbox.text, /Agent last output:\n分析完成/)
  assert.ok(f.sent[0]!.outbox.text.includes(task.sessionId))
  assert.ok(f.sent[0]!.outbox.text.includes(f.directory))
})

test('cancelled tasks send final notifications by default', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t, { executor: { async validate() {}, async execute() {
    return { state: 'cancelled', summary: 'Cancelled.', reason: 'cancelled', lastOutput: 'Last completed output.' }
  } } })
  await f.runtime.admit(f.delivery()); await f.finish()
  assert.equal(f.sent.length, 1)
  assert.match(f.sent[0]!.outbox.text, /Status: cancelled/)
  assert.match(f.sent[0]!.outbox.text, /Last completed output\./)
})

test('long Unicode output is explicitly shortened within the configured email byte limit', async () => {
  await using t = new AsyncDisposableStack()
  const output = '最后结果。'.repeat(1_000)
  const f = await fixture(t, { executor: { async validate() {}, async execute() {
    return { state: 'succeeded', summary: 'Completed.', reason: '', lastOutput: output }
  } } })
  f.config.runtime.maxReplyBytes = 1_024
  await f.runtime.admit(f.delivery()); await f.finish()
  const text = f.sent[0]!.outbox.text
  assert.ok(Buffer.byteLength(text) <= 1_024)
  assert.match(text, /Email shortened/)
  assert.doesNotMatch(text, /\uFFFD/)
  assert.equal(f.store.tasks()[0]?.lastOutput, output)
})

test('re-execution clears the previous Agent output before starting a new attempt', async () => {
  await using t = new AsyncDisposableStack()
  const f = await fixture(t, { executor: { async validate() {}, async execute() {
    return { state: 'failed', summary: 'Failed.', reason: 'failed', lastOutput: 'Old attempt output.' }
  } } })
  await f.runtime.admit(f.delivery()); await f.finish()
  await f.runtime.retryTask(f.store.tasks()[0]!.id)
  assert.equal(f.store.tasks()[1]?.lastOutput, '')
})
