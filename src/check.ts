// SPDX-License-Identifier: LGPL-3.0-or-later
/** Read-only mailbox login checks; SMTP verification never sends a message. */
import { Pop3Connection } from './pop3.ts'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import type { Account } from './config.ts'
import type { ResolveSecret } from './transports.ts'

/** Only fixed result codes cross the UI boundary; transport errors and secrets do not. */
export interface ConnectionCheck { imap: 'ok' | 'failed' | 'absent'; smtp: 'ok' | 'failed' | 'absent'; pop3?: 'ok' | 'failed' }

/** Check the configured account using current credentials and trusted TLS.
 * @param account Saved account to verify.
 * @param secret Current DSH credential resolver.
 * @param timeoutMs Per-connection deadline.
 * @param signal Owning UI call or plugin cancellation.
 * @returns A result for each configured protocol.
 */
export async function checkConnection(account: Account, secret: ResolveSecret, timeoutMs: number, signal: AbortSignal): Promise<ConnectionCheck> {
  const result: ConnectionCheck = { imap: 'absent', smtp: 'absent' }
  if (account.receive?.protocol === 'pop3') {
    let client: Pop3Connection | undefined
    try {
      const password = await secret(account.receive.auth.credentialRef)
      client = await Pop3Connection.open(account.receive, password, timeoutMs, signal)
      await client.quit()
      result.pop3 = 'ok'
    } catch (_error) { result.pop3 = 'failed' }
    finally { await client?.close() }
  }
  if (account.receive?.protocol === 'imap') {
    const receive = account.receive
    let client: ImapFlow | undefined
    const abort = (): void => client?.close()
    signal.addEventListener('abort', abort, { once: true })
    try {
      const password = await secret(receive.auth.credentialRef)
      signal.throwIfAborted()
      client = new ImapFlow({ host: receive.host, port: receive.port, secure: receive.tls === 'direct',
        ...(receive.tls === 'starttls' ? { doSTARTTLS: true } : {}),
        auth: { user: receive.auth.user, pass: password }, logger: false,
        tls: { rejectUnauthorized: true, ...(receive.ca ? { ca: receive.ca } : {}) },
        connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs,
      })
      client.on('error', () => { /* The awaited connect operation owns the result. */ })
      await client.connect()
      result.imap = 'ok'
    } catch (_error) { result.imap = 'failed' }
    finally { signal.removeEventListener('abort', abort); client?.close() }
  }
  if (account.send && !signal.aborted) {
    const send = account.send
    let transport: ReturnType<typeof nodemailer.createTransport> | undefined
    const abort = (): void => transport?.close()
    signal.addEventListener('abort', abort, { once: true })
    try {
      const password = await secret(send.auth.credentialRef)
      signal.throwIfAborted()
      transport = nodemailer.createTransport({ host: send.host, port: send.port, secure: send.tls === 'direct',
        requireTLS: send.tls === 'starttls', auth: { user: send.auth.user, pass: password },
        tls: { rejectUnauthorized: true, ...(send.ca ? { ca: send.ca } : {}) },
        connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs,
      })
      await transport.verify()
      result.smtp = 'ok'
    } catch (_error) { result.smtp = 'failed' }
    finally { signal.removeEventListener('abort', abort); transport?.close() }
  }
  signal.throwIfAborted()
  return result
}
