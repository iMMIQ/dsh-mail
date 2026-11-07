// SPDX-License-Identifier: LGPL-3.0-or-later
/** POP3 policy over node-pop3: command deadlines, cancellation and validated listings. */
import Pop3 from 'node-pop3'
import type { Account } from './config.ts'
import { MailError } from './types.ts'

type Reception = Extract<NonNullable<Account['receive']>, { protocol: 'pop3' }>

/** One sequential TLS session; close() interrupts reads and awaits socket disposal. */
export class Pop3Connection {
  private readonly client: Pop3
  private readonly abort = (): void => { void this.client.close(new MailError('pop3-cancelled', true)) }
  private constructor(receive: Reception, password: string, private readonly timeoutMs: number, private readonly signal: AbortSignal) {
    this.client = new Pop3({ host: receive.host, port: receive.port, tls: receive.tls === 'direct',
      user: receive.auth.user, password, parseStreamToString: false,
      tlsOptions: { rejectUnauthorized: true, ...receive.ca ? { ca: receive.ca } : {} } })
    // Operations own failure reporting, including failures between command responses.
    this.client.on('error', () => {})
    signal.addEventListener('abort', this.abort, { once: true })
  }
  private async bounded<T>(operation: () => Promise<T>, maxBytes = 512): Promise<T> {
    this.signal.throwIfAborted()
    this.client.maxResponseSize = maxBytes
    let timeout: MailError | undefined
    const timer = setTimeout(() => {
      timeout = new MailError('pop3-timeout', true)
      void this.client.close(timeout)
    }, this.timeoutMs)
    try { return await operation() }
    catch (error) {
      if (timeout) throw timeout
      if (this.signal.aborted) throw new MailError('pop3-cancelled', true)
      if (error instanceof MailError) throw error
      const event = error && typeof error === 'object' && 'eventName' in error ? error.eventName : undefined
      if (event === 'response-too-large') throw new MailError('pop3-response-too-large')
      if (event === 'command-rejected') throw new MailError('pop3-command-rejected')
      if (event === 'invalid-command') throw new MailError('pop3-invalid-command')
      if (event === 'invalid-dot-stuffing') throw new MailError('pop3-invalid-dot-stuffing')
      if (event === 'unexpected-data-before-tls') throw new MailError('pop3-unexpected-data-before-tls')
      if (event === 'bad-server-response') throw new MailError('pop3-invalid-response')
      throw new MailError('pop3-disconnected', true)
    } finally { clearTimeout(timer) }
  }
  /** Establish TLS before credentials; a refused STLS command never falls back to cleartext.
   * @param receive Validated POP3 server settings.
   * @param password Current credential value.
   * @param timeoutMs Deadline for each handshake or command, including its body.
   * @param signal Owner cancellation.
   * @returns Authenticated session, owned by the caller until close().
   */
  static async open(receive: Reception, password: string, timeoutMs: number, signal: AbortSignal): Promise<Pop3Connection> {
    const connection = new Pop3Connection(receive, password, timeoutMs, signal)
    try {
      await connection.bounded(async () => {
        await connection.client.connect()
        if (receive.tls === 'starttls') await connection.client.STLS()
        await connection.client.command('USER', receive.auth.user)
        await connection.client.command('PASS', password)
      })
      return connection
    } catch (error) { await connection.close(); throw error }
  }
  private multiline(command: string, maxBytes: number): Promise<Buffer> {
    return this.bounded(async () => {
      const [, stream] = await this.client.command(command)
      if (!stream) throw new MailError('pop3-invalid-response')
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(chunk)
      return Buffer.concat(chunks)
    }, maxBytes)
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
  /** Retrieve original MIME bytes; exceeding the cap closes this connection.
   * @param number Message number valid only during this session.
   * @param maxBytes Maximum decoded POP3 message size.
   * @returns Dot-unstuffed MIME bytes with original CRLF line endings.
   */
  retrieve(number: number, maxBytes: number): Promise<Buffer> { return this.multiline(`RETR ${number}`, maxBytes) }
  /** End a successful scan without issuing DELE. */
  async quit(): Promise<void> { await this.bounded(async () => { await this.client.command('QUIT') }) }
  /** Interrupt in-flight work and wait for every socket, including a wrapped STLS socket. */
  async close(): Promise<void> {
    this.signal.removeEventListener('abort', this.abort)
    await this.client.close()
  }
}
