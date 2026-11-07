// SPDX-License-Identifier: LGPL-3.0-or-later
/** Shared TLS and login options for saved-connection checks and active transports. */
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import type { Account } from './config.ts'

type ImapSettings = Extract<NonNullable<Account['receive']>, { protocol: 'imap' }>

/** Create an unconnected IMAP client with explicit connection and idle deadlines.
 * @param receive Validated incoming server settings.
 * @param password Current credential, resolved for this connection only.
 * @param timeoutMs Connection and greeting deadline.
 * @param socketTimeoutMs Idle socket deadline, longer for receiving than for login checks.
 * @returns Unconnected client owned by its caller through close().
 */
export function createImapConnection(receive: ImapSettings, password: string, timeoutMs: number, socketTimeoutMs: number): ImapFlow {
  return new ImapFlow({ host: receive.host, port: receive.port, secure: receive.tls === 'direct',
    ...(receive.tls === 'starttls' ? { doSTARTTLS: true } : {}),
    auth: { user: receive.auth.user, pass: password }, logger: false,
    tls: { rejectUnauthorized: true, ...(receive.ca ? { ca: receive.ca } : {}) },
    connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: socketTimeoutMs,
  })
}

/** Create one SMTP transport without background pooling or automatic resubmission.
 * @param send Validated outgoing server settings.
 * @param password Current credential, resolved for this attempt only.
 * @param timeoutMs Connection, greeting and socket deadline.
 * @returns Transport owned by its caller through close().
 */
export function createSmtpTransport(send: NonNullable<Account['send']>, password: string, timeoutMs: number) {
  return nodemailer.createTransport({ host: send.host, port: send.port, secure: send.tls === 'direct',
    requireTLS: send.tls === 'starttls', auth: { user: send.auth.user, pass: password },
    tls: { rejectUnauthorized: true, ...(send.ca ? { ca: send.ca } : {}) },
    connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs, logger: false, debug: false,
  })
}
