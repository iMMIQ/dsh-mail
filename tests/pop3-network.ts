// SPDX-License-Identifier: LGPL-3.0-or-later
/** Test-owned POP3 server with real TLS, STLS and mutable session-local numbering. */
import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { createSecureContext, TLSSocket } from 'node:tls'
import selfsigned from 'selfsigned'

/** Allocate a loopback server and close all accepted sockets before returning ownership.
 * @param resources Test cleanup stack.
 * @param mode Direct TLS or mandatory STLS.
 * @returns Mutable mailbox and observable protocol traffic, with no saved passwords.
 */
export async function pop3Server(resources: AsyncDisposableStack, mode: 'direct' | 'starttls' = 'direct') {
  const certificate = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }],
  })
  const context = createSecureContext({ key: certificate.private, cert: certificate.cert })
  const messages: { uid: string; raw: Buffer; advertisedSize?: number }[] = []
  const commands: { name: string; argument: string; secure: boolean }[] = []
  const sockets = new Set<Socket>()
  let scans = 0
  const behavior = { uidl: true, stls: true, stall: '', drop: '', duplicate: false, fragment: false }
  const own = (socket: Socket): void => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)) }
  const bind = (socket: Socket, secure: boolean, greeting: boolean): void => {
    own(socket)
    if (greeting) socket.write('+OK test mailbox\r\n')
    let input = ''
    let user = ''
    let authenticated = false
    const onData = (chunk: Buffer): void => {
      input += chunk.toString()
      for (;;) {
        const end = input.indexOf('\r\n')
        if (end < 0) return
        const line = input.slice(0, end)
        input = input.slice(end + 2)
        const space = line.indexOf(' ')
        const name = (space < 0 ? line : line.slice(0, space)).toUpperCase()
        const argument = space < 0 ? '' : line.slice(space + 1)
        commands.push({ name, argument: name === 'PASS' ? '[redacted]' : argument, secure })
        if (behavior.stall === name) return
        if (behavior.drop === name) { socket.destroy(); return }
        if (name === 'STLS' && !secure) {
          if (!behavior.stls) { socket.write('-ERR STLS unavailable\r\n'); continue }
          socket.removeListener('data', onData)
          socket.write('+OK Begin TLS\r\n', () => bind(new TLSSocket(socket, { isServer: true, secureContext: context }), true, false))
          return
        }
        if (name === 'QUIT') { socket.end('+OK Bye\r\n'); return }
        if (!secure) { socket.write('-ERR TLS required\r\n'); continue }
        if (name === 'USER') { user = argument; socket.write('+OK Password required\r\n'); continue }
        if (name === 'PASS') { authenticated = user === 'testuser' && argument === 'testpass'; socket.write(authenticated ? '+OK Logged in\r\n' : '-ERR Login failed\r\n'); continue }
        if (!authenticated) { socket.write('-ERR Authenticate first\r\n'); continue }
        if (name === 'UIDL') {
          scans++
          socket.write(behavior.uidl ? `+OK UIDs\r\n${messages.map((message, i) => `${i + 1} ${behavior.duplicate ? 'same' : message.uid}\r\n`).join('')}.\r\n` : '-ERR UIDL unavailable\r\n')
        } else if (name === 'LIST') {
          socket.write(`+OK Sizes\r\n${messages.map((message, i) => `${i + 1} ${message.advertisedSize ?? message.raw.length}\r\n`).join('')}.\r\n`)
        } else if (name === 'RETR') {
          const message = messages[Number(argument) - 1]
          if (!message) { socket.write('-ERR No such message\r\n'); continue }
          const stuffed = Buffer.from(message.raw.toString('latin1').replace(/(^|\r\n)\./g, '$1..'), 'latin1')
          const body = Buffer.concat([stuffed, Buffer.from(stuffed.subarray(-2).equals(Buffer.from('\r\n')) ? '.\r\n' : '\r\n.\r\n')])
          socket.write('+OK Message follows\r\n')
          if (behavior.fragment) {
            // Every octet is a separate write; terminators and UTF-8 can cross packets.
            for (const byte of body) socket.write(Buffer.from([byte]))
          } else socket.write(body)
        } else socket.write('-ERR Unsupported command\r\n')
      }
    }
    socket.on('data', onData)
  }
  const server = createServer(socket => {
    if (mode === 'direct') { own(socket); bind(new TLSSocket(socket, { isServer: true, secureContext: context }), true, true) }
    else bind(socket, false, true)
  })
  resources.defer(async () => {
    const closed = [...sockets].map(socket => new Promise<void>(resolve => socket.once('close', () => resolve())))
    for (const socket of sockets) socket.destroy()
    await Promise.all([...closed, new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))])
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { port: address.port, ca: certificate.cert, messages, commands, behavior, sockets, scans: () => scans, mode }
}
