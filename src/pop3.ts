// SPDX-License-Identifier: LGPL-3.0-or-later
/** Bounded POP3 wire reads preserve MIME octets for DKIM, including dot unstuffing. */
import { once } from 'node:events'
import { connect, isIP, type Socket } from 'node:net'
import { connect as connectTls, type TLSSocket } from 'node:tls'
import type { Account } from './config.ts'
import { MailError } from './types.ts'

type Reception = Extract<NonNullable<Account['receive']>, { protocol: 'pop3' }>

/** One sequential TLS session; close() interrupts reads and awaits socket disposal. */
export class Pop3Connection {
  private socket: Socket | TLSSocket
  private reader: AsyncIterator<Buffer>
  private buffered: Buffer = Buffer.alloc(0)
  private readonly sockets = new Set<Socket>()
  private readonly closed: Promise<void>[] = []
  private readonly abort = (): void => { this.socket.destroy(new MailError('pop3-cancelled', true)) }
  private constructor(private readonly receive: Reception, private readonly timeoutMs: number, private readonly signal: AbortSignal) {
    this.socket = receive.tls === 'direct' ? connectTls(this.tlsOptions()) : connect({ host: receive.host, port: receive.port })
    this.own(this.socket)
    this.reader = this.socket.iterator({ destroyOnReturn: false })
    signal.addEventListener('abort', this.abort, { once: true })
    if (signal.aborted) this.abort()
  }
  private tlsOptions() {
    return { host: this.receive.host, port: this.receive.port, rejectUnauthorized: true,
      ...!isIP(this.receive.host) ? { servername: this.receive.host } : {}, ...this.receive.ca ? { ca: this.receive.ca } : {} }
  }
  private own(socket: Socket): void {
    this.sockets.add(socket)
    // Reads observe socket errors; this listener also covers gaps between commands.
    socket.on('error', () => {})
    this.closed.push(new Promise<void>(resolve => socket.once('close', () => { this.sockets.delete(socket); resolve() })))
  }
  private async bounded<T>(read: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted()
    const timer = setTimeout(() => this.socket.destroy(new MailError('pop3-timeout', true)), this.timeoutMs)
    try { return await read() } finally { clearTimeout(timer) }
  }
  private async line(limit: number): Promise<Buffer> {
    for (;;) {
      const end = this.buffered.indexOf('\r\n')
      if (end >= 0) {
        if (end > limit) throw new MailError('pop3-response-too-large')
        const line = this.buffered.subarray(0, end)
        this.buffered = this.buffered.subarray(end + 2)
        return line
      }
      if (this.buffered.length > limit + 1) throw new MailError('pop3-response-too-large')
      const next = await this.reader.next()
      if (next.done) throw new MailError('pop3-disconnected', true)
      this.buffered = Buffer.concat([this.buffered, next.value])
    }
  }
  private async status(): Promise<void> {
    const line = (await this.line(512)).toString('latin1')
    if (/^\+OK(?: |$)/.test(line)) return
    if (/^-ERR(?: |$)/.test(line)) throw new MailError('pop3-command-rejected')
    throw new MailError('pop3-invalid-response')
  }
  private async command(command: string): Promise<void> {
    if (/[\r\n\0]/.test(command)) throw new MailError('pop3-invalid-command')
    if (this.socket.destroyed) throw new MailError('pop3-disconnected', true)
    this.socket.write(`${command}\r\n`)
    await this.status()
  }
  /** Establish TLS before credentials; a refused STLS command never falls back to cleartext.
   * @param receive Validated POP3 server settings.
   * @param password Current credential value.
   * @param timeoutMs Deadline for each handshake or command, including its body.
   * @param signal Owner cancellation.
   * @returns Authenticated session, owned by the caller until close().
   */
  static async open(receive: Reception, password: string, timeoutMs: number, signal: AbortSignal): Promise<Pop3Connection> {
    const client = new Pop3Connection(receive, timeoutMs, signal)
    try {
      await client.bounded(async () => {
        await once(client.socket, receive.tls === 'direct' ? 'secureConnect' : 'connect')
        await client.status()
        if (receive.tls === 'starttls') {
          await client.command('STLS')
          if (client.buffered.length) throw new MailError('pop3-unexpected-data-before-tls')
          await client.reader.return?.()
          client.socket = connectTls({ ...client.tlsOptions(), socket: client.socket })
          client.own(client.socket)
          client.reader = client.socket.iterator({ destroyOnReturn: false })
          await once(client.socket, 'secureConnect')
        }
        await client.command(`USER ${receive.auth.user}`)
        await client.command(`PASS ${password}`)
      })
      return client
    } catch (error) { await client.close(); throw error }
  }
  private async multiline(command: string, maxBytes: number): Promise<Buffer> {
    return this.bounded(async () => {
      await this.command(command)
      const chunks: Buffer[] = []
      let size = 0
      for (;;) {
        let line = await this.line(Math.max(1, maxBytes - size + 1))
        if (line.length === 1 && line[0] === 46) return Buffer.concat(chunks, size)
        if (line[0] === 46) {
          if (line[1] !== 46) throw new MailError('pop3-invalid-dot-stuffing')
          line = line.subarray(1)
        }
        size += line.length + 2
        if (size > maxBytes) throw new MailError('pop3-response-too-large')
        chunks.push(line, Buffer.from('\r\n'))
      }
    })
  }
  /** Fetch stable UIDLs and advertised sizes; malformed or duplicate listings stop this scan.
   * @param maxBytes Byte limit applied separately to each server listing.
   * @returns Current message numbers paired with stable ids and sizes.
   */
  async list(maxBytes: number): Promise<{ number: number; uid: string; size: number }[]> {
    const parse = (buffer: Buffer): Map<number, string> => {
      const rows = new Map<number, string>()
      for (const line of buffer.toString('latin1').split('\r\n').filter(Boolean)) {
        const match = /^([1-9][0-9]*)[ \t]+([!-~]{1,70})$/.exec(line)
        const number = Number(match?.[1])
        if (!match || !Number.isSafeInteger(number) || rows.has(number)) throw new MailError('pop3-invalid-listing')
        rows.set(number, match[2]!)
      }
      return rows
    }
    const uids = parse(await this.multiline('UIDL', maxBytes))
    if (new Set(uids.values()).size !== uids.size) throw new MailError('pop3-duplicate-uidl')
    const sizes = parse(await this.multiline('LIST', maxBytes))
    if (uids.size !== sizes.size) throw new MailError('pop3-inconsistent-listing')
    return [...uids].map(([number, uid]) => {
      const value = sizes.get(number)
      const size = Number(value)
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(size)) throw new MailError('pop3-invalid-listing')
      return { number, uid, size }
    }).sort((a, b) => a.number - b.number)
  }
  /** Retrieve original MIME bytes; exceeding the cap requires closing this connection.
   * @param number Message number valid only during this session.
   * @param maxBytes Maximum decoded POP3 message size.
   * @returns Dot-unstuffed MIME bytes with original CRLF line endings.
   */
  retrieve(number: number, maxBytes: number): Promise<Buffer> { return this.multiline(`RETR ${number}`, maxBytes) }
  /** End a successful scan without issuing DELE. */
  async quit(): Promise<void> { await this.bounded(() => this.command('QUIT')) }
  /** Interrupt in-flight work and wait for every socket, including a wrapped STLS socket. */
  async close(): Promise<void> {
    this.signal.removeEventListener('abort', this.abort)
    for (const socket of this.sockets) socket.destroy()
    await Promise.all(this.closed)
  }
}
