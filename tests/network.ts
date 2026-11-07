// SPDX-License-Identifier: LGPL-3.0-or-later
/** Real TLS mail servers with OS-assigned ports and test-owned certificates. */
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import hoodiecrow from 'hoodiecrow-imap'
import selfsigned from 'selfsigned'
import { SMTPServer } from 'smtp-server'
import type { Socket } from 'node:net'

/** Wait for an observable condition; the deadline bounds failure, not readiness. */
export async function waitFor(condition: () => boolean | Promise<boolean>, describe: () => string, timeoutMs = 20_000): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs)
  while (!await condition()) {
    if (signal.aborted) throw new Error(`Timed out waiting for ${describe()}`)
    await delay(10)
  }
}

type Login = { user: string; password: string }
type Submission = 'accept' | 'reject' | 'drop'

async function certificate() {
  return selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }],
  })
}

type Certificate = Awaited<ReturnType<typeof certificate>>

async function incoming(t: AsyncDisposableStack, certificate: Certificate, login: Login) {
  const imap = hoodiecrow({ secureConnection: true, credentials: { key: certificate.private, cert: certificate.cert }, users: { [login.user]: { password: login.password } },
    plugins: ['IDLE', 'ID', 'SASL-IR', 'AUTH-PLAIN'], storage: { INBOX: { messages: [] } } })
  const sockets = new Set<Socket>()
  imap.server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  t.defer(async () => {
    const closed = [...sockets].map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())))
    for (const socket of sockets) socket.destroy()
    await Promise.all([...closed, imap.server.listening ? new Promise<void>(resolve => imap.close(resolve)) : Promise.resolve()])
  })
  await new Promise<void>((resolve, reject) => {
    imap.server.once('error', reject)
    imap.listen(0, '127.0.0.1', () => { imap.server.removeListener('error', reject); resolve() })
  })
  const address = imap.server.address()
  assert.ok(address && typeof address !== 'string')
  return { imap, imapPort: address.port }
}

async function outgoing(t: AsyncDisposableStack, certificate: Certificate, submission: Submission, login: Login) {
  const received: Buffer[] = []
  const smtpSockets = new Set<Socket>()
  const smtp = new SMTPServer({ secure: true, key: certificate.private, cert: certificate.cert,
    disabledCommands: ['STARTTLS'], authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, _session, callback) { callback(null, auth.username === login.user && auth.password === login.password ? { user: login.user } : undefined) },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
      stream.on('end', () => {
        received.push(Buffer.concat(chunks))
        if (submission === 'reject') { callback(Object.assign(new Error('Temporary test rejection'), { responseCode: 450 })); return }
        if (submission === 'drop') { for (const socket of smtpSockets) socket.destroy(); return }
        callback()
      })
    },
  })
  smtp.server.on('connection', socket => { smtpSockets.add(socket); socket.once('close', () => smtpSockets.delete(socket)) })
  t.defer(async () => {
    const closed = [...smtpSockets].map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())))
    for (const socket of smtpSockets) socket.destroy()
    await Promise.all([...closed, smtp.server.listening ? new Promise<void>(resolve => smtp.close(() => resolve())) : Promise.resolve()])
  })
  await new Promise<void>((resolve, reject) => {
    smtp.server.once('error', reject)
    smtp.listen(0, '127.0.0.1', () => { smtp.server.removeListener('error', reject); resolve() })
  })
  const address = smtp.server.address()
  assert.ok(address && typeof address !== 'string')
  return { smtp, received, smtpPort: address.port }
}

/** Start both real TLS servers with one test-owned certificate and login. */
export async function mailServers(t: AsyncDisposableStack, submission: Submission = 'accept', login = { user: 'testuser', password: 'testpass' }) {
  const tls = await certificate()
  const imap = await incoming(t, tls, login)
  const smtp = await outgoing(t, tls, submission, login)
  return { ...imap, ...smtp, ca: tls.cert }
}

/** Start only the SMTP fixture when no IMAP connection participates in the test. */
export async function smtpServer(t: AsyncDisposableStack, submission: Submission = 'accept', login = { user: 'testuser', password: 'testpass' }) {
  const tls = await certificate()
  return { ...await outgoing(t, tls, submission, login), ca: tls.cert }
}

/** Start only the IMAP fixture when the test does not submit mail. */
export async function imapServer(t: AsyncDisposableStack, login = { user: 'testuser', password: 'testpass' }) {
  const tls = await certificate()
  return { ...await incoming(t, tls, login), ca: tls.cert }
}
