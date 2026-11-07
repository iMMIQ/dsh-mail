// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { configuration, fixture, message } from './helpers.ts'
import { parseMail, replyInput } from '../src/mail.ts'
import { verifySender } from '../src/auth.ts'
import { MailError, type ExecutionResult, type SendOutcome } from '../src/types.ts'

const signal = new AbortController().signal

test('DKIM remains the default while exact trusted internal addresses can skip it', async () => {
  const raw = message()
  const mail = await parseMail(raw, configuration('/tmp/mail-parser-input').runtime)
  await assert.rejects(verifySender(raw, mail, { evidence: 'local-signature' }, signal, 100), /signature-invalid/)
  await verifySender(raw, mail, { evidence: 'local-signature', trustedSenders: ['owner@example.com'] }, signal, 100)
  await assert.rejects(verifySender(raw, mail, { evidence: 'local-signature', trustedSenders: ['other@example.com'] }, signal, 100), /signature-invalid/)
})

test('reply content removes English and Chinese quoted history and rejects quote-only mail', async () => {
  await using resources = new AsyncDisposableStack()
  const f = await fixture(resources)
  for (const quote of ['On Monday, DSH wrote:', '在 2026年11月7日，DSH 写道：']) {
    const mail = await parseMail(message('Re: task', `Please continue.\n\n${quote}\n> OLD COMMAND`), f.config.runtime)
    assert.equal(replyInput(mail).body, 'Please continue.')
  }
  const mail = await parseMail(message('Re: task', '> OLD COMMAND'), f.config.runtime)
  assert.throws(() => replyInput(mail), /reply-has-no-new-text/)
})

test('a known thread bypasses new-task subject matching and preserves its workspace and Session', async () => {
  await using resources = new AsyncDisposableStack()
  const f = await fixture(resources)
  await f.runtime.admit(f.delivery()); await f.finish()
  const first = f.store.tasks()[0]!
  const raw = message('回复：changed title', 'Continue.\n\nOn Monday, DSH wrote:\n> OLD COMMAND', [`In-Reply-To: ${first.outbox.messageId}`]).toString().replace('<fixture@example.com>', '<followup@example.com>')
  await f.runtime.admit(f.delivery(2, Buffer.from(raw))); await f.finish()
  assert.equal(f.executed.length, 2)
  assert.equal(f.executed[1]!.sessionId, first.sessionId)
  assert.equal(f.executed[1]!.continuation, true)
  assert.equal(f.executed[1]!.workspacePath, first.workspacePath)
  assert.doesNotMatch(f.executed[1]!.prompt, /OLD COMMAND/)
  f.config.rules[0]!.authorization.allowedSenders.push('other@example.com')
  const other = raw.replace('<followup@example.com>', '<imposter@example.com>').replace('From: owner@example.com', 'From: other@example.com')
  await f.runtime.admit(f.delivery(3, Buffer.from(other))); await f.finish()
  assert.equal(f.executed.length, 2)
})

test('duplicate Message-IDs across UIDs never create another execution', async () => {
  await using resources = new AsyncDisposableStack()
  const f = await fixture(resources)
  const raw = Buffer.from(message().toString().replace('<fixture@example.com>', '<stable@example.com>'))
  await f.runtime.admit(f.delivery(1, raw)); await f.finish()
  await f.runtime.admit(f.delivery(2, raw)); await f.finish()
  await f.runtime.admit(f.delivery(3, Buffer.from(raw.toString().replace('Summarize the repository.', 'Changed instruction.')))); await f.finish()
  assert.equal(f.executed.length, 1)
  assert.equal(f.store.inbox()[1]!.reason, 'duplicate-message')
  assert.equal(f.store.inbox()[2]!.reason, 'message-id-collision')
})

test('receipt submission cannot overwrite a concurrently completed turn', async () => {
  await using resources = new AsyncDisposableStack()
  const execution = Promise.withResolvers<ExecutionResult>()
  const sending = Promise.withResolvers<void>()
  const sent = Promise.withResolvers<SendOutcome>()
  const f = await fixture(resources, { executor: { async validate() {}, execute: () => execution.promise }, send: () => { sending.resolve(); return sent.promise } })
  resources.defer(() => { execution.resolve({ state: 'cancelled', summary: 'Fixture stopped', reason: '' }); sent.resolve({ state: 'failed', retryable: false, reason: 'fixture-stopped' }) })
  f.config.notifications.receipts = true
  await f.runtime.admit(f.delivery())
  const tick = f.runtime.tick()
  await sending.promise
  execution.resolve({ state: 'succeeded', summary: 'Done', reason: '', lastOutput: 'Final output' })
  await f.runtime.whenSettled()
  sent.resolve({ state: 'accepted' })
  await tick
  const task = f.store.tasks()[0]!
  assert.equal(task.state, 'succeeded')
  assert.equal(task.receipt?.state, 'accepted')
  assert.equal(task.outbox.state, 'pending')
  assert.match(task.outbox.text, /Final output/)
})

test('unknown receipt submission does not block the result or retry the task', async () => {
  await using resources = new AsyncDisposableStack()
  let sends = 0
  const f = await fixture(resources, { async send() { return ++sends === 1 ? { state: 'unknown', reason: 'smtp-acknowledgement-unknown' } : { state: 'accepted' } } })
  f.config.notifications.receipts = true
  await f.runtime.admit(f.delivery()); await f.finish()
  f.advance(); await f.runtime.tick()
  const task = f.store.tasks()[0]!
  assert.equal(task.receipt?.state, 'unknown')
  assert.equal(task.outbox.state, 'accepted')
  assert.equal(f.executed.length, 1)
  assert.equal(sends, 2)
})

test('queued follow-ups are held for review when the preceding turn was interrupted', async () => {
  await using resources = new AsyncDisposableStack()
  const f = await fixture(resources)
  await f.runtime.admit(f.delivery()); await f.finish()
  const original = f.store.tasks()[0]!
  const raw = message('Re: task', 'Continue.', [`In-Reply-To: ${original.outbox.messageId}`]).toString().replace('<fixture@example.com>', '<next@example.com>')
  f.deps.executor.ready = () => false
  await f.runtime.admit(f.delivery(2, Buffer.from(raw))); await f.runtime.tick()
  await f.store.putTask({ ...original, state: 'running' })
  await f.runtime.initialize()
  assert.equal(f.store.tasks()[1]!.state, 'needs_attention')
  assert.equal(f.store.tasks()[1]!.reason, 'previous-turn-interrupted')
})

test('global notifications join their existing mail thread and retain its sender and routing', async () => {
  await using resources = new AsyncDisposableStack()
  const f = await fixture(resources)
  await f.runtime.admit(f.delivery()); await f.finish()
  const original = f.store.tasks()[0]!
  f.config.notifications.enabled = true
  const input = { sessionId: brandString<SessionId>(original.sessionId), turn: 2, title: 'Continued from DSH', workspacePath: original.workspacePath!, state: 'succeeded' as const, lastOutput: 'A later DSH turn.', reason: '' }
  await f.runtime.notifySession(input)
  await f.runtime.notifySession(input)
  assert.equal(f.store.tasks().length, 2)
  const notice = f.store.tasks()[1]!
  assert.equal(notice.originalMessageId, original.outbox.messageId)
  assert.equal(notice.authorization.sender, original.authorization.sender)
  assert.equal(notice.rule.reply.to, original.rule.reply.to)
  assert.equal(f.executed.length, 1)
})

test('retrying a follow-up retains its conversation and gets a fresh input identity', async () => {
  await using resources = new AsyncDisposableStack()
  const f = await fixture(resources)
  await f.runtime.admit(f.delivery()); await f.finish()
  const root = f.store.tasks()[0]!
  const raw = message('Re: task', 'Continue.', [`In-Reply-To: ${root.outbox.messageId}`]).toString().replace('<fixture@example.com>', '<retry-followup@example.com>')
  await f.runtime.admit(f.delivery(2, Buffer.from(raw))); await f.finish()
  const turn = f.store.tasks()[1]!
  await f.store.putTask({ ...turn, state: 'failed' })
  await f.runtime.retryTask(turn.id)
  const retry = f.store.tasks()[2]!
  assert.equal(retry.sessionId, root.sessionId)
  assert.equal(retry.continuation, true)
  assert.notEqual(retry.messageId, turn.messageId)
  assert.equal(retry.receipt, undefined)
})

test('a Session claimed by another entry point is queued again without sending a failure result', async () => {
  await using resources = new AsyncDisposableStack()
  let calls = 0
  const f = await fixture(resources, { executor: { async validate() {}, async execute() {
    if (++calls === 1) throw new MailError('session-busy', true)
    return { state: 'succeeded', summary: 'Continued after the other entry point.', reason: '' }
  } } })
  await f.runtime.admit(f.delivery())
  await f.runtime.tick(); await f.runtime.whenSettled()
  assert.equal(f.store.tasks()[0]!.state, 'queued')
  assert.equal(f.sent.length, 0)
  await f.finish()
  assert.equal(f.store.tasks()[0]!.state, 'succeeded')
  assert.equal(f.store.tasks().length, 1)
  assert.equal(f.sent.length, 1)
})
