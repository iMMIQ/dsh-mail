// SPDX-License-Identifier: LGPL-3.0-or-later
/** TLS-only IMAP reception and SMTP submission with conservative failure classification. */
import { setTimeout as delay } from 'node:timers/promises'
import type { ImapFlow } from 'imapflow'
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'
import type { Account, Config } from './config.ts'
import { MailRuntime, identity } from './runtime.ts'
import { MailError, type SendOutcome, type OutboundMessage } from './types.ts'
import { createImapConnection, createSmtpTransport } from './connections.ts'

/** Read a current secret without exposing it to task or transport logs. */
export type ResolveSecret = (ref: string) => Promise<string>

/** Each folder owns its connection; IDLE notifications accelerate periodic reconciliation. */
export class ImapReceiver {
  private readonly controller = new AbortController()
  private readonly clients = new Set<ImapFlow>()
  private readonly active: Promise<void>[] = []
  constructor(private readonly account: Account, private readonly config: Config, private readonly runtime: MailRuntime, private readonly secret: ResolveSecret) {}
  /** Start supervised connections. Ready/blocked state is available through runtime status. */
  start(): void {
    for (const folder of this.account.receive?.protocol === 'imap' ? this.account.receive.folders : []) this.active.push(this.watch(folder))
  }
  private async watch(folder: string): Promise<void> {
    const receive = this.account.receive
    if (receive?.protocol !== 'imap') return
    const signal = this.controller.signal
    const healthKey = `${this.account.id}:${folder}`
    while (!signal.aborted) {
      let client: ImapFlow | undefined
      try {
        const password = await this.secret(receive.auth.credentialRef)
        signal.throwIfAborted()
        client = createImapConnection(receive, password, this.config.runtime.connectionTimeoutMs,
          Math.max(this.config.runtime.connectionTimeoutMs, receive.rescanIntervalMs * 2))
        this.clients.add(client)
        const current = client
        let wake: (() => void) | undefined
        let disconnected = false
        current.on('error', () => { disconnected = true; wake?.() })
        current.on('close', () => { disconnected = true; wake?.() })
        current.on('exists', () => wake?.())
        await current.connect()
        const mailbox = await current.mailboxOpen(folder, { readOnly: true })
        const validity = mailbox.uidValidity.toString()
        const key = identity(this.account.id, folder)
        let cursor = this.runtime.cursor(key)
        if (cursor && cursor.validity !== validity) throw new MailError('uidvalidity-changed-review-required')
        if (!cursor) {
          let high = 0
          if (receive.initialSync === 'new-only') {
            if (!mailbox.uidNext) throw new MailError('uidnext-unavailable')
            high = mailbox.uidNext - 1
          }
          cursor = { validity, high }
          await this.runtime.checkpoint(key, cursor)
        }
        while (!signal.aborted && !disconnected) {
          const high: number = cursor.high
          const uids: number[] | false | undefined = await current.search({ uid: `${high + 1}:*` }, { uid: true })
          for (const uid of (uids || []).filter(uid => uid > high).sort((a, b) => a - b)) {
            signal.throwIfAborted()
            const meta = await current.fetchOne(uid, { size: true, internalDate: true }, { uid: true })
            if (!meta) continue
            let raw = Buffer.alloc(0)
            let tooLarge = (meta.size ?? 0) > this.config.runtime.maxMessageBytes
            if (!tooLarge) {
              const download = await current.download(uid, undefined, { uid: true, maxBytes: this.config.runtime.maxMessageBytes + 1 })
              if (!download.content) throw new MailError('message-content-unavailable', true)
              const chunks: Buffer[] = []
              let size = 0
              for await (const chunk of download.content) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                size += bytes.length
                if (size > this.config.runtime.maxMessageBytes) { tooLarge = true; download.content.destroy(); break }
                chunks.push(bytes)
              }
              if (!tooLarge) raw = Buffer.concat(chunks)
            }
            if (!(meta.internalDate instanceof Date)) throw new MailError('receive-time-unavailable')
            await this.runtime.admit({ account: this.account.id, folder, uidValidity: validity, uid,
              receivedAt: meta.internalDate.getTime(), raw, tooLarge })
            cursor = { validity, high: uid }
            await this.runtime.checkpoint(key, cursor)
          }
          this.runtime.health.set(healthKey, 'healthy')
          await new Promise<void>(resolve => {
            const finish = (): void => { clearTimeout(timer); signal.removeEventListener('abort', finish); wake = undefined; resolve() }
            const timer = setTimeout(finish, receive.rescanIntervalMs)
            wake = finish
            signal.addEventListener('abort', finish, { once: true })
            if (signal.aborted || disconnected) finish()
          })
        }
      } catch (error) {
        if (!signal.aborted) this.runtime.health.set(healthKey, error instanceof MailError ? error.code : 'imap-connection-failed')
      } finally {
        if (client) { client.close(); this.clients.delete(client) }
      }
      if (!signal.aborted) {
        try { await delay(this.config.runtime.retryDelayMs, undefined, { signal }) } catch (error) { if (!signal.aborted) throw error }
      }
    }
  }
  /** Abort timers and socket work, then await every supervised folder loop. */
  async close(): Promise<void> { this.controller.abort(); for (const client of this.clients) client.close(); await Promise.all(this.active) }
}

/** Open a fresh bounded SMTP attempt; no background pool can resubmit after cancellation. */
export function smtpSender(config: Config, secret: ResolveSecret): (message: OutboundMessage, signal: AbortSignal) => Promise<SendOutcome> {
  return async (message, signal) => {
    const account = config.accounts.find(a => a.id === message.account)
    const send = account?.send
    if (!account || !send) return { state: 'failed', retryable: false, reason: 'send-account-missing' }
    let password: string
    try { password = await secret(send.auth.credentialRef) } catch (error) {
      return { state: 'failed', retryable: false, reason: error instanceof MailError ? error.code : 'credential-unavailable' }
    }
    if (signal.aborted) return { state: 'failed', retryable: true, reason: 'submission-not-started' }
    const transport = createSmtpTransport(send, password, config.runtime.connectionTimeoutMs)
    const abort = (): void => transport.close()
    signal.addEventListener('abort', abort, { once: true })
    try {
      const info: SMTPTransport.SentMessageInfo = await transport.sendMail({ from: account.address, to: message.to,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}), messageId: message.messageId,
        ...(message.inReplyTo ? { inReplyTo: message.inReplyTo, references: message.references } : {}),
        headers: { 'Auto-Submitted': 'auto-replied', 'X-DSH-Mail-Task': message.taskId },
        disableFileAccess: true, disableUrlAccess: true,
      })
      return info.accepted.length === 1 ? { state: 'accepted' } : { state: 'failed', retryable: false, reason: 'recipient-rejected' }
    } catch (error) {
      // SMTP's explicit rejection and failures before DATA are safe to classify.
      // A socket failure after DATA may have lost only the server's final acknowledgement.
      const smtp = error as { code?: string; command?: string; responseCode?: number }
      if (smtp.responseCode && smtp.responseCode >= 400 && smtp.responseCode <= 599) return { state: 'failed', retryable: smtp.responseCode < 500, reason: 'smtp-rejected' }
      if (smtp.code === 'EAUTH') return { state: 'failed', retryable: false, reason: 'smtp-authentication-failed' }
      if (smtp.code === 'EDNS' || smtp.command && /^(EHLO|HELO|AUTH|MAIL FROM|RCPT TO)/.test(smtp.command)) return { state: 'failed', retryable: true, reason: 'smtp-before-submission' }
      return { state: 'unknown', reason: 'smtp-acknowledgement-unknown' }
    } finally { signal.removeEventListener('abort', abort); transport.close() }
  }
}
