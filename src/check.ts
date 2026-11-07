// SPDX-License-Identifier: LGPL-3.0-or-later
/** Read-only mailbox login checks; SMTP verification never sends a message. */
import { Pop3Connection } from './pop3.ts'
import type { Account } from './config.ts'
import type { ResolveSecret } from './transports.ts'
import { createImapConnection, createSmtpTransport } from './connections.ts'
import type { ConnectionCheck } from './ui-types.ts'

export type { ConnectionCheck } from './ui-types.ts'

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
    let client: ReturnType<typeof createImapConnection> | undefined
    const abort = (): void => client?.close()
    signal.addEventListener('abort', abort, { once: true })
    try {
      const password = await secret(receive.auth.credentialRef)
      signal.throwIfAborted()
      client = createImapConnection(receive, password, timeoutMs, timeoutMs)
      client.on('error', () => { /* The awaited connect operation owns the result. */ })
      await client.connect()
      result.imap = 'ok'
    } catch (_error) { result.imap = 'failed' }
    finally { signal.removeEventListener('abort', abort); client?.close() }
  }
  if (account.send && !signal.aborted) {
    const send = account.send
    let transport: ReturnType<typeof createSmtpTransport> | undefined
    const abort = (): void => transport?.close()
    signal.addEventListener('abort', abort, { once: true })
    try {
      const password = await secret(send.auth.credentialRef)
      signal.throwIfAborted()
      transport = createSmtpTransport(send, password, timeoutMs)
      await transport.verify()
      result.smtp = 'ok'
    } catch (_error) { result.smtp = 'failed' }
    finally { signal.removeEventListener('abort', abort); transport?.close() }
  }
  signal.throwIfAborted()
  return result
}
