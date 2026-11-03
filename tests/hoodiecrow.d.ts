// SPDX-License-Identifier: LGPL-3.0-or-later
/** Minimal typed view of the external IMAP test server's public fixture API. */
declare module 'hoodiecrow-imap' {
  import type { Server as TlsServer } from 'node:tls'
  import type { Socket } from 'node:net'
  interface ImapTestServer {
    server: TlsServer
    connections: Set<{ socket: Socket }>
    listen(port: number, host: string, callback: () => void): void
    close(callback: () => void): void
    appendMessage(mailbox: string, flags: string[], internalDate: Date, raw: string): unknown
  }
  export default function createServer(options: Record<string, unknown>): ImapTestServer
}
