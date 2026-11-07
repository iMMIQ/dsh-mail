// SPDX-License-Identifier: LGPL-3.0-or-later
/** POP3 polling uses durable UIDLs rather than session-local message numbers. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { Account, Config } from './config.ts'
import { Pop3Connection } from './pop3.ts'
import { MailRuntime, identity } from './runtime.ts'
import type { ResolveSecret } from './transports.ts'
import { MailError } from './types.ts'

const remembered = z.array(z.string().regex(/^[!-~]{1,70}$/))

/** One cancellable connection per scan; successful admissions survive reconnect and restart. */
export class Pop3Receiver {
  private readonly controller = new AbortController()
  private active: Promise<void> | undefined
  constructor(private readonly account: Account, private readonly config: Config, private readonly runtime: MailRuntime, private readonly secret: ResolveSecret) {}
  /** Start polling; health reports connection, UIDL and storage failures. */
  start(): void { this.active ??= this.watch() }
  private async watch(): Promise<void> {
    const receive = this.account.receive
    if (receive?.protocol !== 'pop3') return
    const signal = this.controller.signal
    const healthKey = `${this.account.id}:POP3`
    const source = identity('pop3', receive.host, receive.port, receive.auth.user)
    const key = identity(this.account.id, source)
    while (!signal.aborted) {
      let client: Pop3Connection | undefined
      let pause = receive.rescanIntervalMs
      try {
        const password = await this.secret(receive.auth.credentialRef)
        client = await Pop3Connection.open(receive, password, this.config.runtime.connectionTimeoutMs, signal)
        const rows = await client.list(this.config.runtime.maxMessageBytes)
        const cursor = this.runtime.cursor(key)
        const seen = new Set(cursor ? remembered.parse(JSON.parse(cursor.validity)) : [])
        const save = async (): Promise<void> => {
          await this.runtime.checkpoint(key, { validity: JSON.stringify(rows.filter(row => seen.has(row.uid)).map(row => row.uid)), high: 0 })
        }
        if (!cursor && receive.initialSync === 'new-only') {
          for (const row of rows) seen.add(row.uid)
          await save()
        } else {
          // Commit an empty first baseline before admission so a restart keeps initialSync semantics.
          if (!cursor) await save()
          for (const row of rows) {
            signal.throwIfAborted()
            if (seen.has(row.uid)) continue
            let raw: Buffer = Buffer.alloc(0)
            let tooLarge = row.size > this.config.runtime.maxMessageBytes
            let disconnected = false
            if (!tooLarge) {
              try { raw = await client.retrieve(row.number, this.config.runtime.maxMessageBytes) }
              catch (error) {
                if (!(error instanceof MailError) || error.code !== 'pop3-response-too-large') throw error
                tooLarge = true
                disconnected = true
              }
            }
            await this.runtime.admit({ account: this.account.id, folder: 'INBOX', uidValidity: identity(source, row.uid), uid: 0,
              receivedAt: Date.now(), raw, tooLarge })
            seen.add(row.uid)
            await save()
            if (disconnected) throw new MailError('pop3-message-too-large-reconnecting', true)
          }
          await save()
        }
        await client.quit()
        this.runtime.health.set(healthKey, 'healthy')
      } catch (error) {
        pause = this.config.runtime.retryDelayMs
        if (!signal.aborted) this.runtime.health.set(healthKey, error instanceof MailError ? error.code : 'pop3-connection-failed')
      } finally { await client?.close() }
      if (!signal.aborted) {
        try { await delay(pause, undefined, { signal }) } catch (error) { if (!signal.aborted) throw error }
      }
    }
  }
  /** Cancel connection work and polling, then await the receiver before releasing storage. */
  async close(): Promise<void> { this.controller.abort(); await this.active }
}
