// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { Config } from '../src/config.ts'
import { checkConnection } from '../src/check.ts'
import { Pop3Connection } from '../src/pop3.ts'
import { Pop3Receiver } from '../src/pop3-receiver.ts'
import { MailRuntime } from '../src/runtime.ts'
import { identity } from '../src/identity.ts'
import { smtpSender } from '../src/transports.ts'
import { parseMail } from '../src/mail.ts'
import { configuration, fixture, message } from './helpers.ts'
import { smtpServer, waitFor } from './network.ts'
import { pop3Server } from './pop3-network.ts'

function reception(server: Awaited<ReturnType<typeof pop3Server>>) {
  return { protocol: 'pop3' as const, host: '127.0.0.1', port: server.port, tls: server.mode, ca: server.ca,
    auth: { user: 'testuser', credentialRef: 'MAIL_PASSWORD' }, initialSync: 'new-only' as const, rescanIntervalMs: 10, maxMessageAgeMs: 172_800_000 }
}

for (const mode of ['direct', 'starttls'] as const) {
  test(`POP3 ${mode} receives a task and submits its threaded SMTP result without deleting mail`, async () => {
    await using resources = new AsyncDisposableStack()
    const server = await pop3Server(resources, mode)
    const smtp = await smtpServer(resources)
    const f = await fixture(resources)
    const account = f.config.accounts[0]!
    account.receive = reception(server)
    Object.assign(account.send!, { host: '127.0.0.1', port: smtp.smtpPort, ca: smtp.ca, auth: { user: 'testuser', credentialRef: 'MAIL_PASSWORD' } })
    const runtime = new MailRuntime(f.config, f.spool, { ...f.deps, send: smtpSender(f.config, async () => 'testpass') })
    await runtime.initialize()
    f.cleanup.defer(() => runtime.close())
    server.messages.push({ uid: 'history', raw: message('[DSH] history') })
    const receiver = new Pop3Receiver(account, f.config, runtime, async () => 'testpass')
    f.cleanup.defer(() => receiver.close())
    receiver.start()
    await waitFor(() => runtime.health.get('work:POP3') === 'healthy', () => 'POP3 baseline')
    assert.equal(f.store.inbox().length, 0)
    const source = identity('pop3', account.receive.host, account.receive.port, account.receive.auth.user)
    const key = identity(account.id, source)
    assert.deepEqual(runtime.cursor(key), { kind: 'pop3', seen: ['history'] })
    server.messages.push({ uid: 'task', raw: message() })
    await waitFor(() => { const cursor = runtime.cursor(key); return f.store.inbox().length === 1 && cursor?.kind === 'pop3' && cursor.seen.includes('task') }, () => JSON.stringify(runtime.status()))
    assert.equal(f.store.inbox()[0]!.id, identity(account.id, 'INBOX', identity(source, 'task'), 0))
    await runtime.tick(); await runtime.whenSettled(); await runtime.tick()
    assert.equal(f.executed.length, 1)
    assert.equal(smtp.received.length, 1)
    assert.equal(f.store.records()[0]?.outbox.state, 'accepted')
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
    f.cleanup.defer(() => receiver.close()); receiver.start(); return receiver
  }
  const first = start()
  await waitFor(() => f.store.inbox().length === 2 && f.runtime.health.get('work:POP3') === 'healthy', () => 'both POP3 messages admitted')
  await first.close()
  const source = identity('pop3', account.receive.host, account.receive.port, account.receive.auth.user)
  const key = identity(account.id, source)
  assert.deepEqual(f.runtime.cursor(key), { kind: 'pop3', seen: ['first', 'second'] })
  server.messages.shift()
  server.messages.push({ uid: 'third', raw: f.delivery(3).raw })
  const before = server.scans()
  start()
  await waitFor(() => { const cursor = f.runtime.cursor(key); return server.scans() > before && f.store.inbox().length === 3 && cursor?.kind === 'pop3' && cursor.seen.includes('third') }, () => 'only new UIDL admitted after renumbering')
  assert.deepEqual(f.runtime.cursor(key), { kind: 'pop3', seen: ['second', 'third'] })
  for (let i = 0; i < 3; i++) await f.finish()
  assert.equal(f.executed.length, 3)
  assert.deepEqual(server.commands.filter(command => command.name === 'RETR').map(command => command.argument), ['1', '2', '2'])
})

test('POP3 preserves UTF-8, non-UTF-8 MIME octets and dot-prefixed lines used by DKIM', async () => {
  await using resources = new AsyncDisposableStack()
  const server = await pop3Server(resources, 'starttls')
  server.behavior.fragment = true
  const raw = Buffer.concat([message('[DSH] 原始邮件', '.first\r\n..second\r\n你好，世界。'), Buffer.from('\r\n')])
  const legacy = Buffer.concat([
    Buffer.from(message('[DSH] legacy encoding', '8-bit body: ', ['Content-Transfer-Encoding: 8bit']).toString().replace('charset=utf-8', 'charset=iso-8859-1')),
    Buffer.from([0xe9, 0xff, 0x80, 13, 10]),
  ])
  server.messages.push({ uid: 'raw', raw })
  server.messages.push({ uid: 'legacy', raw: legacy })
  const client = await Pop3Connection.open(reception(server), 'testpass', 2_000, new AbortController().signal)
  resources.defer(() => client.close())
  assert.deepEqual(await client.retrieve(1, raw.length), raw)
  assert.deepEqual(await client.retrieve(2, legacy.length), legacy)
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

for (const mode of ['direct', 'starttls'] as const) {
  test(`POP3 ${mode} owner cancellation closes an idle authenticated connection`, async () => {
    await using resources = new AsyncDisposableStack()
    const server = await pop3Server(resources, mode)
    const controller = new AbortController()
    const client = await Pop3Connection.open(reception(server), 'testpass', 2_000, controller.signal)
    resources.defer(() => client.close())
    controller.abort()
    await waitFor(() => server.sockets.size === 0, () => 'cancelled POP3 socket drained')
    await assert.rejects(client.list(4096))
  })
}

for (const greeting of ['+OKAY invalid\r\n', `+OK ${'x'.repeat(513)}`]) {
  test('POP3 rejects malformed or oversized greetings before authentication', async () => {
    await using resources = new AsyncDisposableStack()
    const server = await pop3Server(resources)
    server.behavior.greeting = greeting
    await assert.rejects(Pop3Connection.open(reception(server), 'testpass', 2_000, new AbortController().signal),
      { code: greeting.startsWith('+OKAY') ? 'pop3-invalid-response' : 'pop3-response-too-large' })
    assert.equal(server.commands.length, 0)
  })
}

test('POP3 refuses extra plaintext after STLS acceptance and never sends credentials', async () => {
  await using resources = new AsyncDisposableStack()
  const server = await pop3Server(resources, 'starttls')
  server.behavior.responses.STLS = Buffer.from('+OK Begin TLS\r\nunexpected plaintext')
  await assert.rejects(Pop3Connection.open(reception(server), 'testpass', 2_000, new AbortController().signal), { code: 'pop3-unexpected-data-before-tls' })
  assert.deepEqual(server.commands.map(command => command.name), ['STLS'])
})

test('POP3 rejects multiline credential injection without exposing the password', async () => {
  await using resources = new AsyncDisposableStack()
  const server = await pop3Server(resources)
  await assert.rejects(Pop3Connection.open(reception(server), 'secret\r\nDELE 1', 2_000, new AbortController().signal), error => {
    assert.ok(error instanceof Error)
    assert.ok(!error.message.includes('secret'))
    assert.equal('code' in error && error.code, 'pop3-invalid-command')
    return true
  })
  assert.ok(!server.commands.some(command => ['PASS', 'DELE'].includes(command.name)))
})

for (const cancel of [false, true]) {
  test(`POP3 STLS handshake ${cancel ? 'cancellation' : 'timeout'} settles open and drains the socket`, async () => {
    await using resources = new AsyncDisposableStack()
    const server = await pop3Server(resources, 'starttls')
    server.behavior.stallHandshake = true
    const controller = new AbortController()
    const opening = assert.rejects(Pop3Connection.open(reception(server), 'testpass', cancel ? 5_000 : 1_000, controller.signal),
      { code: cancel ? 'pop3-cancelled' : 'pop3-timeout' })
    await waitFor(() => server.handshakeSeen(), () => 'TLS ClientHello received')
    if (cancel) controller.abort()
    await opening
    await waitFor(() => server.sockets.size === 0, () => 'failed TLS handshake drained')
    assert.ok(!server.commands.some(command => ['USER', 'PASS'].includes(command.name)))
  })
}

for (const end of [false, true]) {
  test(`POP3 ${end ? 'disconnect' : 'timeout'} during RETR rejects incomplete MIME and drains the socket`, async () => {
    await using resources = new AsyncDisposableStack()
    const server = await pop3Server(resources)
    server.behavior.responses.RETR = Buffer.from('+OK message follows\r\npartial MIME\r\n')
    server.behavior.endResponse = end ? 'RETR' : ''
    const client = await Pop3Connection.open(reception(server), 'testpass', 1_000, new AbortController().signal)
    resources.defer(() => client.close())
    await assert.rejects(client.retrieve(1, 4096), { code: end ? 'pop3-disconnected' : 'pop3-timeout' })
    await client.close()
    await waitFor(() => server.sockets.size === 0, () => 'incomplete POP3 socket drained')
  })
}

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
  f.cleanup.defer(() => receiver.close())
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
    f.cleanup.defer(() => receiver.close()); receiver.start()
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
    f.cleanup.defer(() => receiver.close()); receiver.start()
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


test('a POP3 receiver refuses an IMAP cursor without overwriting it or downloading mail', async () => {
  await using resources = new AsyncDisposableStack()
  const server = await pop3Server(resources)
  const f = await fixture(resources)
  const account = f.config.accounts[0]!
  account.receive = { ...reception(server), initialSync: 'all' }
  const source = identity('pop3', account.receive.host, account.receive.port, account.receive.auth.user)
  const key = identity(account.id, source)
  await f.runtime.checkpoint(key, { kind: 'imap', uidValidity: '77', high: 3 })
  server.messages.push({ uid: 'task', raw: message() })
  const receiver = new Pop3Receiver(account, f.config, f.runtime, async () => 'testpass')
  f.cleanup.defer(() => receiver.close()); receiver.start()
  await waitFor(() => f.runtime.health.get('work:POP3') === 'mailbox-cursor-protocol-mismatch', () => 'POP3 cursor mismatch reported')
  assert.deepEqual(f.runtime.cursor(key), { kind: 'imap', uidValidity: '77', high: 3 })
  assert.equal(f.store.inbox().length, 0)
  assert.ok(!server.commands.some(command => command.name === 'RETR'))
})
