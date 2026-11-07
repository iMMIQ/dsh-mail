// SPDX-License-Identifier: LGPL-3.0-or-later
/** Signature evidence is evaluated independently from routing and Agent permissions. */
import { Resolver } from 'node:dns/promises'
import { domainToASCII } from 'node:url'
import { dkimVerify } from 'mailauth'
import type { SenderPolicy } from './config.ts'
import { MailError, type Mail } from './types.ts'

/** Verify a whole-message signature or an explicitly trusted MTA assertion. */
export async function verifySender(raw: Buffer, mail: Mail, policy: SenderPolicy, signal: AbortSignal, timeoutMs: number): Promise<void> {
  signal.throwIfAborted()
  if (mail.headers.filter(h => h.key === 'from').length !== 1) throw new MailError('invalid-from')
  if (policy.evidence === 'local-signature' && policy.trustedSenders?.some(address => address.toLowerCase() === mail.from)) return
  const domain = domainToASCII(mail.from.slice(mail.from.lastIndexOf('@') + 1)).toLowerCase()
  if (policy.evidence === 'trusted-mta') {
    for (const header of mail.headers.filter(h => h.key === 'authentication-results')) {
      const value = header.line.slice(header.line.indexOf(':') + 1).replace(/\r?\n[\t ]+/g, ' ').trim()
      // Deliberately accepts only the documented simple assertion form. Comments,
      // quoted strings and escapes are rejected rather than heuristically stripped.
      if (/[()"\\\r\n]/.test(value)) continue
      const [server, ...results] = value.split(';').map(s => s.trim())
      if (!server || !policy.authservIds.some(s => s.toLowerCase() === server.toLowerCase())) continue
      if (results.some(r => new RegExp(`^dmarc=pass\\s+header\\.from=${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(r))) return
    }
    throw new MailError('trusted-mta-evidence-missing')
  }
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 })
  if (policy.dnsServers) resolver.setServers(policy.dnsServers)
  const cancellation = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const abort = (): void => resolver.cancel()
  cancellation.addEventListener('abort', abort, { once: true })
  try {
    const result = await dkimVerify(raw, { strict: true, minBitLength: 2048, resolver: (name, type) => {
      cancellation.throwIfAborted()
      if (type !== 'TXT') throw new MailError('signature-dns-query-unsupported')
      return resolver.resolveTxt(name)
    } })
    cancellation.throwIfAborted()
    const requiredHeaders = ['from', 'to', 'subject', 'message-id', 'references', 'in-reply-to'].filter(key => mail.headers.some(h => h.key === key))
    if (requiredHeaders.some(key => mail.headers.filter(h => h.key === key).length !== 1)) throw new MailError('ambiguous-routing-headers')
    if (result.results.some(r => {
      const covered = new Set(r.signingHeaders?.keys.toLowerCase().split(':').map(key => key.trim()))
      return r.status.result === 'pass' && !r.status.testing && !r.status.underSized
        && domainToASCII(r.signingDomain ?? '').toLowerCase() === domain && requiredHeaders.every(key => covered.has(key))
    })) return
    if (result.results.some(r => r.status.result === 'temperror')) throw new MailError('signature-dns-temporary', true)
    throw new MailError('signature-invalid-or-unaligned')
  } catch (error) {
    if (error instanceof MailError) throw error
    throw new MailError('signature-verification-unavailable', true, { cause: error })
  } finally { cancellation.removeEventListener('abort', abort) }
}
