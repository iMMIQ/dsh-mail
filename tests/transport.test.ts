// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { simpleParser } from 'mailparser'
import { MailRuntime } from '../src/runtime.ts'
import { ImapReceiver, smtpSender } from '../src/transports.ts'
import { verifySender } from '../src/auth.ts'
import { parseMail } from '../src/mail.ts'
import { fixture, message } from './helpers.ts'
import { mailServers, waitFor } from './network.ts'

test('real TLS IMAP reception executes and submits a threaded SMTP result', async () => {
  await using t = new AsyncDisposableStack()
  const servers = await mailServers(t)
  const f = await fixture(t)
  const account = f.config.accounts[0]!
  Object.assign(account.receive!, { host: '127.0.0.1', port: servers.imapPort, ca: servers.ca, auth: { user: 'testuser', credentialRef: 'MAIL_PASSWORD' }, rescanIntervalMs: 30 })
  Object.assign(account.send!, { host: '127.0.0.1', port: servers.smtpPort, ca: servers.ca, auth: { user: 'testuser', credentialRef: 'MAIL_PASSWORD' } })
  const secret = async (): Promise<string> => 'testpass'
  const runtime = new MailRuntime(f.config, f.spool, { ...f.deps, verify: (raw, mail, policy, signal) => verifySender(raw, mail, policy, signal, 1_000), send: smtpSender(f.config, secret) })
  await runtime.initialize()
  const receiver = new ImapReceiver(account, f.config, runtime, secret)
  f.cleanup.push(() => runtime.close(), () => receiver.close())
  servers.imap.appendMessage('INBOX', [], new Date(), message('[DSH] historical').toString())
  receiver.start()
  await waitFor(() => [...runtime.health.values()].includes('healthy'), () => JSON.stringify(runtime.status()))
  assert.equal(f.store.inbox().length, 0)
  servers.imap.appendMessage('INBOX', [], new Date(), message().toString())
  await waitFor(() => f.store.inbox().length === 1, () => JSON.stringify(runtime.status()))
  await runtime.tick(); await runtime.whenSettled(); await runtime.tick()
  assert.equal(f.executed.length, 1)
  assert.equal(servers.received.length, 1)
  const mime = await simpleParser(servers.received[0]!)
  assert.equal(typeof mime.html, 'string')
  assert.match(String(mime.html), /任务执行报告/)
  assert.ok(mime.headerLines.some(header => header.key === 'content-type' && header.line.includes('multipart/alternative')))
  const response = await parseMail(servers.received[0]!, f.config.runtime)
  assert.equal(response.to[0], 'owner@example.com')
  assert.match(response.body, /Status: succeeded/)
  assert.equal(response.references[0], '<fixture@example.com>')
  assert.ok(response.headers.some(h => h.key === 'auto-submitted' && h.line.includes('auto-replied')))
  assert.equal(f.store.tasks()[0]?.outbox.state, 'accepted')
})

for (const behavior of ['reject', 'drop'] as const) {
  test(`real SMTP ${behavior} preserves rejection versus unknown submission`, async () => {
    await using t = new AsyncDisposableStack()
    const servers = await mailServers(t, behavior)
    const f = await fixture(t)
    await f.runtime.admit(f.delivery()); await f.finish()
    Object.assign(f.config.accounts[0]!.send!, { host: '127.0.0.1', port: servers.smtpPort, ca: servers.ca, auth: { user: 'testuser', credentialRef: 'MAIL_PASSWORD' } })
    const outcome = await smtpSender(f.config, async () => 'testpass')(f.store.tasks()[0]!, new AbortController().signal)
    assert.equal(servers.received.length, 1)
    assert.equal(outcome.state, behavior === 'reject' ? 'failed' : 'unknown')
    if (outcome.state === 'failed') assert.equal(outcome.retryable, true)
  })
}

test('an untrusted TLS certificate fails before IMAP can admit messages', async () => {
  await using t = new AsyncDisposableStack()
  const servers = await mailServers(t)
  const f = await fixture(t)
  const account = f.config.accounts[0]!
  Object.assign(account.receive!, { host: '127.0.0.1', port: servers.imapPort, rescanIntervalMs: 30 })
  const receiver = new ImapReceiver(account, f.config, f.runtime, async () => 'testpass')
  f.cleanup.push(() => receiver.close())
  receiver.start()
  await waitFor(() => [...f.runtime.health.values()].includes('imap-connection-failed'), () => 'TLS certificate rejection')
  assert.equal(f.store.inbox().length, 0)
})
