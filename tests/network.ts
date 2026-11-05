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

/** Both servers require TLS and actual password authentication. */
export async function mailServers(t: AsyncDisposableStack, submission: 'accept' | 'reject' | 'drop' = 'accept', login = { user: 'testuser', password: 'testpass' }) {
  const certificate = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }],
  })
  const imap = hoodiecrow({ secureConnection: true, credentials: { key: certificate.private, cert: certificate.cert }, users: { [login.user]: { password: login.password } },
    plugins: ['IDLE', 'ID', 'SASL-IR', 'AUTH-PLAIN'], storage: { INBOX: { messages: [] } } })
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
    for (const connection of imap.connections) connection.socket.destroy()
    for (const socket of smtpSockets) socket.destroy()
    await Promise.all([new Promise<void>(resolve => imap.close(resolve)), new Promise<void>(resolve => smtp.close(() => resolve()))])
  })
  await new Promise<void>(resolve => imap.listen(0, '127.0.0.1', resolve))
  await new Promise<void>(resolve => smtp.listen(0, '127.0.0.1', resolve))
  const imapAddress = imap.server.address()
  const smtpAddress = smtp.server.address()
  assert.ok(imapAddress && typeof imapAddress !== 'string')
  assert.ok(smtpAddress && typeof smtpAddress !== 'string')
  return { imap, smtp, received, ca: certificate.cert, imapPort: imapAddress.port, smtpPort: smtpAddress.port }
}
