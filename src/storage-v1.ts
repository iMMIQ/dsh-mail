// SPDX-License-Identifier: LGPL-3.0-or-later
/** Frozen version-one storage schemas and one-way conversion to current records. */
import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { inboxSchema, taskSchema, notificationSchema, mailboxCursorSchema, notificationStateSchema, MailError,
  type MailId, type TaskId, type MailRecord, type MailboxCursor, type NotificationState } from './types.ts'

const id = z.string().regex(/^[a-z][a-z0-9-]*$/)
const line = z.string().min(1).max(998).refine(value => !/[\r\n\0]/.test(value), 'must be a single line')
const address = z.email().refine(value => !/[\r\n\0]/.test(value))
const nonBlank = line.refine(value => Boolean(value.trim()), 'value must not be blank')
const ms = z.number().int().positive().max(2_147_483_647)
const v1Policy = z.discriminatedUnion('evidence', [
  z.strictObject({ evidence: z.literal('local-signature'), trustedSenders: z.array(address).optional(), dnsServers: z.array(line).min(1).optional() }),
  z.strictObject({ evidence: z.literal('trusted-mta'), authservIds: z.array(line).min(1), stripsUntrustedHeaders: z.literal(true) }),
])
const v1Rule = z.strictObject({
  id, priority: z.number().int().default(0), account: id,
  authorization: z.strictObject({ policy: id, allowedSenders: z.array(address).min(1) }),
  match: z.strictObject({ subjectPrefix: line.optional(), subjectContains: line.optional(), bodyContains: line.optional(), to: address.optional(), hasAttachments: z.boolean().optional() }).default({}),
  extract: z.record(id, z.strictObject({ source: z.enum(['subject', 'body']), after: z.string().min(1), before: z.string().min(1).optional() })).default({}),
  task: z.strictObject({
    workspacePath: z.string().refine(isAbsolute, 'workspacePath must be absolute').optional(), agentPreset: nonBlank.optional(),
    permissionPreset: nonBlank.default('danger-full-access'), template: id,
    timeoutMs: ms.default(900_000), maxSteps: z.number().int().positive().default(40),
    attachmentTypes: z.array(z.enum(['text/plain', 'text/csv', 'application/json'])).default([]),
    model: z.strictObject({ provider: line, model: line, maxTokens: z.number().int().positive().optional() }).optional(),
  }),
  reply: z.strictObject({ account: id, to: address,
    on: z.array(z.enum(['succeeded', 'failed', 'cancelled', 'timed_out', 'needs_attention'])).default(['succeeded', 'failed', 'cancelled', 'timed_out', 'needs_attention']) }),
})
const v1Outbox = z.strictObject({
  state: z.enum(['none', 'pending', 'sending', 'accepted', 'failed', 'unknown']), messageId: z.string(), attempts: z.number().int(), nextAt: z.number(),
  subject: z.string(), text: z.string(), reason: z.string(), html: z.string().optional(),
})
const v1Report = z.strictObject({
  startedAt: z.number().nonnegative().optional(), finishedAt: z.number().nonnegative().optional(),
  steps: z.number().int().nonnegative().optional(), turn: z.number().int().nonnegative().optional(), provider: z.string().optional(), model: z.string().optional(),
})

/** Released ingress fields; provider identity components remain readable only for migration. */
export const v1InboxSchema = z.strictObject({
  id: z.string().transform(value => brandString<MailId>(value)), account: z.string(), folder: z.string(), uidValidity: z.string(), uid: z.number().int(),
  receivedAt: z.number(), rawHash: z.string(), state: z.enum(['stored', 'verification_pending', 'ignored', 'quarantined', 'held', 'matched']),
  reason: z.string(), attempts: z.number().int(), nextAt: z.number(),
})
/** Released task and notification representation, including its original state vocabulary. */
export const v1TaskSchema = z.strictObject({
  id: z.string().transform(value => brandString<TaskId>(value)), mailId: z.string().transform(value => brandString<MailId>(value)),
  account: z.string(), rule: v1Rule, createdAt: z.number(), prompt: z.string(), title: z.string(), sessionId: z.string(), messageId: z.string(),
  workspacePath: z.string().optional(), originalMessageId: z.string().nullable(), references: z.array(z.string()),
  state: z.enum(['queued', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'needs_attention']),
  summary: z.string(), reason: z.string(), attempt: z.number().int(), lastOutput: z.string().optional(), report: v1Report.optional(),
  sequence: z.number().int().nonnegative().optional(), continuation: z.boolean().optional(), origin: z.literal('session').optional(), inputHash: z.string().optional(),
  turn: z.number().int().nonnegative().optional(), receipt: v1Outbox.optional(),
  authorization: z.strictObject({ sender: z.string(), policy: v1Policy }), operations: z.array(z.strictObject({ kind: z.string(), at: z.number() })), outbox: v1Outbox,
})
/** Released shared cursor format; its meaning is selected during migration. */
export const v1CursorSchema = z.strictObject({ validity: z.string(), high: z.number().int().nonnegative() })
/** Original authoritative domain declaration, retained for format compatibility checks. */
export const v1MailDomain = defineDomain({ name: 'dsh_mail', version: 1,
  tables: { inbox: domainTable(v1InboxSchema), tasks: domainTable(v1TaskSchema), cursors: domainTable(v1CursorSchema) } })

/** Convert a released work record while keeping identities and outgoing bytes unchanged.
 * @param value Validated version-one task or Session notification.
 * @returns Current executable task or independent notification.
 */
function convertRecord(value: z.output<typeof v1TaskSchema>): MailRecord {
  const { mailId, prompt, messageId, attempt, sequence, continuation, origin, inputHash, turn, receipt, ...common } = value
  const report = common.report?.turn === undefined && turn !== undefined ? { ...common.report, turn } : common.report
  const observed = { ...common, ...(report ? { report } : {}) }
  if (origin === 'session' && !continuation) {
    if (receipt !== undefined) throw new MailError('legacy-notification-receipt-requires-review')
    return notificationSchema.parse({ ...observed, kind: 'notification', turn: turn ?? report?.turn })
  }
  return taskSchema.parse({ ...observed, kind: 'task', mode: continuation ? 'followup' : 'new', mailId, prompt, messageId, attempt,
    state: common.state === 'starting' ? 'running' : common.state,
    ...(sequence !== undefined ? { sequence } : {}), ...(inputHash !== undefined ? { inputHash } : {}), ...(receipt !== undefined ? { receipt } : {}) })
}

/** Convert released ingress records without recomputing their persisted identities. */
export const v1InboxDecoder = v1InboxSchema.transform(({ folder: _folder, uidValidity: _validity, uid: _uid, ...value }) => inboxSchema.parse(value))
/** Convert released tasks and notices only after validating the frozen version-one schema. */
export const v1RecordDecoder = v1TaskSchema.transform(convertRecord)

/** Interpret one released cursor without changing its opaque mailbox key.
 * @param key Persisted cursor key.
 * @param cursor Validated version-one position or notification epoch.
 * @returns Typed mailbox position or independent notification recovery state.
 */
export function decodeV1Cursor(key: string, cursor: z.output<typeof v1CursorSchema>): { kind: 'mailbox'; value: MailboxCursor } | { kind: 'notification'; value: NotificationState } {
  if (key === 'notification-epoch') {
    if (cursor.validity !== 'paused' && cursor.validity !== 'turn-v1') throw new MailError('legacy-notification-state-requires-review')
    return { kind: 'notification', value: notificationStateSchema.parse({ state: cursor.validity === 'paused' ? 'paused' : 'observing', since: cursor.high }) }
  }
  if (/^[1-9][0-9]*$/.test(cursor.validity)) return { kind: 'mailbox', value: mailboxCursorSchema.parse({ kind: 'imap', uidValidity: cursor.validity, high: cursor.high }) }
  if (cursor.high !== 0) throw new MailError('legacy-mailbox-state-requires-review')
  return { kind: 'mailbox', value: mailboxCursorSchema.parse({ kind: 'pop3', seen: JSON.parse(cursor.validity) }) }
}
