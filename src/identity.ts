// SPDX-License-Identifier: LGPL-3.0-or-later
/** Stable identities shared by ingress adapters and durable work records. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MailId } from './types.ts'

/** Hash an unambiguous sequence without changing the provider's identity components.
 * @param parts Ordered provider or work-record identity components.
 * @returns Stable SHA-256 identifier.
 */
export function identity(...parts: (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** Brand a provider's stable message identity for admission.
 * @param parts Ordered identity components retained across reconnects and upgrades.
 * @returns Durable mail identifier.
 */
export function mailIdentity(...parts: (string | number)[]): MailId { return brandString<MailId>(identity(...parts)) }
