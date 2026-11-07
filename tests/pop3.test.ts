// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Config } from '../src/config.ts'
import { checkConnection } from '../src/check.ts'
import { Pop3Connection } from '../src/pop3.ts'
import { Pop3Receiver } from '../src/pop3-receiver.ts'
import { MailRuntime } from '../src/runtime.ts'
import { smtpSender } from '../src/transports.ts'
import { parseMail } from '../src/mail.ts'
import { configuration, fixture, message } from './helpers.ts'
import { mailServers, waitFor } from './network.ts'
import { pop3Server } from './pop3-network.ts'

function reception(server: Awaited<ReturnType<typeof pop3Server>>) {
  return { protocol: 'pop3' as const, host: '127.0.0.1', port: server.port, tls: server.mode, ca: server.ca,
    auth: { user: 'testuser', credentialRef: 'MAIL_PASSWORD' }, initialSync: 'new-only' as const, rescanIntervalMs: 10, maxMessageAgeMs: 172_800_000 }
}

for (const mode of ['direct', 'starttls'] as const) {
  test(`POP3 ${mode} receives a task and submits its threaded SMTP result without deleting mail`, async () => {
    await using resources = new AsyncDisposableStack()
    const server = await pop3Server(resources, mode)
    const smtp = await mailServers(resources)
    const f = await fixture(resources)
    const account = f.config.accounts[0]!
    account.receive = reception(server)
    Object.assign(account.send!, { host: '127.0.0.1', port: smtp.smtpPort, ca: smtp.ca, auth: { user: 'testuser', credentialRef: 'MAIL_PASSWORD' } })
    const runtime = new MailRuntime(f.config, f.spool, { ...f.deps, send: smtpSender(f.config, async () => 'testpass') })
    await runtime.initialize()
    f.cleanup.push(() => runtime.close())
    server.messages.push({ uid: 'history', raw: message('[DSH] history') })
    const receiver = new Pop3Receiver(account, f.config, runtime, async () => 'testpass')
    f.cleanup.push(() => receiver.close())
    receiver.start()
    await waitFor(() => runtime.health.get('work:POP3') === 'healthy', () => 'POP3 baseline')
    assert.equal(f.store.inbox().length, 0)
    server.messages.push({ uid: 'task', raw: message() })
    await waitFor(() => f.store.inbox().length === 1, () => JSON.stringify(runtime.status()))
    await runtime.tick(); await runtime.whenSettled(); await runtime.tick()
    assert.equal(f.executed.length, 1)
    assert.equal(smtp.received.length, 1)
    assert.equal(f.store.tasks()[0]?.outbox.state, 'accepted')
    const reply = await parseMail(smtp.received[0]!, f.config.runtime)
    assert.match(reply.body, /Status: succeeded/)
    assert.deepEqual(reply.references, ['<fixture@example.com>'])
    assert.ok(server.commands.filter(command => ['USER', 'PASS', 'RETR'].includes(command.name)).every(command => command.secure))
    assert.ok(!server.commands.some(command => command.name === 'DELE'))
    assert.equal(server.messages.length, 2)
    if (mode === 'starttls') assert.ok(server.commands.some(command => command.name === 'STLS' && !command.secure))
  })
}

test('POP3 UIDLs survive receiver restart, deletions and message renumbering', async () => {
  await using resources = new AsyncDisposableStack()
  const server = await pop3Server(resources)
  const f = await fixture(resources)
  const account = f.config.accounts[0]!
  account.receive = { ...reception(server), initialSync: 'all' }
  server.messages.push({ uid: 'first', raw: message() }, { uid: 'second', raw: f.delivery(2).raw })
  const start = (): Pop3Receiver => {
    const receiver = new Pop3Receiver(account, f.config, f.runtime, async () => 'testpass')
    f.cleanup.push(() => receiver.close()); receiver.start(); return receiver
  }
  const first = start()
  await waitFor(() => f.store.inbox().length === 2 && f.runtime.health.get('work:POP3') === 'healthy', () => 'both POP3 messages admitted')
  await first.close()
  server.messages.shift()
  server.messages.push({ uid: 'third', raw: f.delivery(3).raw })
  const before = server.scans()
  start()
  await waitFor(() => server.scans() > before && f.store.inbox().length === 3, () => 'only new UIDL admitted after renumbering')
  for (let i = 0; i < 3; i++) await f.finish()
  assert.equal(f.executed.length, 3)
  assert.deepEqual(server.commands.filter(command => command.name === 'RETR').map(command => command.argument), ['1', '2', '2'])
})

test('POP3 preserves UTF-8, raw MIME and dot-prefixed lines used by DKIM', async () => {
  await using resources = new AsyncDisposableStack()
  const server = await pop3Server(resources, 'starttls')
  server.behavior.fragment = true
  const raw = Buffer.concat([message('[DSH] 原始邮件', '.first\r\n..second\r\n你好，世界。'), Buffer.from('\r\n')])
  server.messages.push({ uid: 'raw', raw })
  const client = await Pop3Connection.open(reception(server), 'testpass', 2_000, new AbortController().signal)
  resources.defer(() => client.close())
  assert.deepEqual(await client.retrieve(1, raw.length), raw)
  await client.quit()
})

test('POP3 login checks do not retrieve mail and report failed credentials separately from SMTP', async () => {
  await using resources = new AsyncDisposableStack()
  const server = await pop3Server(resources)
  const account = { ...configuration('/tmp/pop3-check').accounts[0]!, receive: reception(server) }
  delete account.send
  assert.deepEqual(await checkConnection(account, async () => 'testpass', 2_000, new AbortController().signal), { imap: 'absent', pop3: 'ok', smtp: 'absent' })
  assert.deepEqual(await checkConnection(account, async () => 'wrong', 2_000, new AbortController().signal), { imap: 'absent', pop3: 'failed', smtp: 'absent' })
  assert.ok(!server.commands.some(command => ['UIDL', 'LIST', 'RETR', 'DELE'].includes(command.name)))
})

test('POP3 never sends credentials after STLS rejection or an untrusted certificate', async () => {
  await using resources = new AsyncDisposableStack()
  const server = await pop3Server(resources, 'starttls')
  server.behavior.stls = false
  await assert.rejects(Pop3Connection.open(reception(server), 'testpass', 2_000, new AbortController().signal), { code: 'pop3-command-rejected' })
  server.behavior.stls = true
  const { ca: _ca, ...untrusted } = reception(server)
  await assert.rejects(Pop3Connection.open(untrusted, 'testpass', 2_000, new AbortController().signal))
  assert.ok(!server.commands.some(command => ['USER', 'PASS'].includes(command.name)))
})

for (const behavior of ['stall', 'drop'] as const) {
  test(`POP3 ${behavior} during a command terminates within its deadline`, async () => {
    await using resources = new AsyncDisposableStack()
    const server = await pop3Server(resources)
    server.behavior[behavior] = 'UIDL'
    const client = await Pop3Connection.open(reception(server), 'testpass', 1_000, new AbortController().signal)
    resources.defer(() => client.close())
    await assert.rejects(client.list(4096))
  })
}

test('closing a POP3 receiver aborts an active scan and drains its socket', async () => {
  await using resources = new AsyncDisposableStack()
  const server = await pop3Server(resources)
  server.behavior.stall = 'UIDL'
  const f = await fixture(resources)
  const account = f.config.accounts[0]!
  account.receive = reception(server)
  const receiver = new Pop3Receiver(account, f.config, f.runtime, async () => 'testpass')
  f.cleanup.push(() => receiver.close())
  receiver.start()
  await waitFor(() => server.commands.some(command => command.name === 'UIDL'), () => 'POP3 scan entered')
  await receiver.close()
  await waitFor(() => server.sockets.size === 0, () => 'POP3 socket closed')
  assert.equal(f.store.inbox().length, 0)
})

for (const behavior of ['missing', 'duplicate'] as const) {
  test(`POP3 ${behavior} UIDL blocks admission without losing the initial baseline`, async () => {
    await using resources = new AsyncDisposableStack()
    const server = await pop3Server(resources)
    server.messages.push({ uid: 'one', raw: message() }, { uid: 'two', raw: message() })
    server.behavior.uidl = behavior !== 'missing'; server.behavior.duplicate = behavior === 'duplicate'
    const f = await fixture(resources)
    f.config.accounts[0]!.receive = { ...reception(server), initialSync: 'all' }
    const receiver = new Pop3Receiver(f.config.accounts[0]!, f.config, f.runtime, async () => 'testpass')
    f.cleanup.push(() => receiver.close()); receiver.start()
    await waitFor(() => f.runtime.health.has('work:POP3'), () => 'POP3 UIDL failure reported')
    assert.notEqual(f.runtime.health.get('work:POP3'), 'healthy')
    assert.equal(f.store.inbox().length, 0)
  })
}

for (const advertised of [true, false]) {
  test(`POP3 quarantines ${advertised ? 'advertised' : 'streamed'} oversized messages and continues with later mail`, async () => {
    await using resources = new AsyncDisposableStack()
    const server = await pop3Server(resources)
    const f = await fixture(resources)
    f.config.runtime.maxMessageBytes = 512
    f.config.accounts[0]!.receive = { ...reception(server), initialSync: 'all' }
    server.messages.push({ uid: 'oversize', raw: message('[DSH] large', 'x'.repeat(1024)), ...!advertised ? { advertisedSize: 1 } : {} }, { uid: 'small', raw: f.delivery(2).raw })
    const receiver = new Pop3Receiver(f.config.accounts[0]!, f.config, f.runtime, async () => 'testpass')
    f.cleanup.push(() => receiver.close()); receiver.start()
    await waitFor(() => f.store.inbox().length === 2, () => JSON.stringify(f.runtime.status()))
    assert.equal(f.store.inbox()[0]?.reason, 'message-too-large')
    await f.finish()
    assert.equal(f.executed.length, 1)
    assert.equal(server.commands.filter(command => command.name === 'RETR' && command.argument === '1').length, advertised ? 0 : 1)
  })
}

test('POP3 configuration rejects folder settings and unencrypted transport', () => {
  const config = configuration('/tmp/pop3-config')
  const receive = { ...config.accounts[0]!.receive!, protocol: 'pop3' }
  assert.equal(Config.safeParse({ ...config, accounts: [{ ...config.accounts[0]!, receive }] }).success, false)
  const { folders: _folders, ...pop3 } = config.accounts[0]!.receive!.protocol === 'imap' ? config.accounts[0]!.receive! : { folders: [] }
  assert.equal(Config.safeParse({ ...config, accounts: [{ ...config.accounts[0]!, receive: { ...pop3, protocol: 'pop3', tls: 'none' } }] }).success, false)
})
