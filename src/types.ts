// SPDX-License-Identifier: LGPL-3.0-or-later
/** Durable mail state and instance-local provider interfaces. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { ruleSchema, senderPolicySchema } from './config.ts'
import { terminalStates, type TerminalState } from './config-schema.ts'

export type { TerminalState } from './config-schema.ts'

/** Plugin-owned durable identities. */
export type MailId = Branded<'dsh-mail/message'>
/** One execution, stable across connection and process retries. */
export type TaskId = Branded<'dsh-mail/task'>

/** Structured failure with a safe diagnostic code; causes stay off user surfaces. */
export class MailError extends Error {
  constructor(readonly code: string, readonly retryable = false, options?: ErrorOptions) {
    super(code, options)
  }
}

/** Parsed, bounded message; attachment bytes remain outside prompts. */
export interface Mail {
  from: string
  to: string[]
  subject: string
  body: string
  messageId: string | null
  inReplyTo?: string
  references: string[]
  headers: { key: string; line: string }[]
  attachments: { name: string; contentType: string; content: Buffer }[]
}

/** A bounded message identified by its receiving protocol before admission. */
export interface Delivery {
  id: MailId
  account: string
  receivedAt: number
  raw: Buffer
  tooLarge?: boolean
}

/** Completed business result, distinct from SMTP delivery. */
export const resultSchema = z.strictObject({ status: z.enum(['succeeded', 'failed']), summary: z.string().trim().min(1).max(16_384) })
/** Structured candidate published by the session-local result tool. */
export type TaskResult = z.infer<typeof resultSchema>

/** Persistent inbox value. Missing or malformed records fail the whole domain open. */
export const inboxSchema = z.strictObject({
  id: z.string().transform(v => brandString<MailId>(v)),
  account: z.string(),
  receivedAt: z.number(), rawHash: z.string(),
  state: z.enum(['stored', 'verification_pending', 'ignored', 'quarantined', 'held', 'matched']),
  reason: z.string(), attempts: z.number().int(), nextAt: z.number(),
})
/** Stored ingress record; content lives in the owner-only spool. */
export type InboxRecord = z.infer<typeof inboxSchema>

/** One separately submitted mail, including uncertainty after SMTP DATA. */
export const outboxSchema = z.strictObject({
  state: z.enum(['none', 'pending', 'sending', 'accepted', 'failed', 'unknown']),
  messageId: z.string(), attempts: z.number().int(), nextAt: z.number(),
  subject: z.string(), text: z.string(), reason: z.string(),
  html: z.string().optional(),
})

/** Observed execution facts; missing counters are never represented as zero usage. */
export const reportSchema = z.strictObject({
  startedAt: z.number().nonnegative().optional(), finishedAt: z.number().nonnegative().optional(),
  steps: z.number().int().nonnegative().optional(), turn: z.number().int().nonnegative().optional(),
  provider: z.string().optional(), model: z.string().optional(),
})
/** Execution facts included in a result email when the owner recorded them. */
export type RunReport = z.infer<typeof reportSchema>

const recordFields = {
  id: z.string().transform(v => brandString<TaskId>(v)),
  account: z.string(), rule: ruleSchema, createdAt: z.number(),
  title: z.string(), sessionId: z.string(),
  workspacePath: z.string().optional(),
  originalMessageId: z.string().nullable(), references: z.array(z.string()),
  summary: z.string(), reason: z.string(),
  lastOutput: z.string().optional(),
  report: reportSchema.optional(),
  authorization: z.strictObject({ sender: z.string(), policy: senderPolicySchema }),
  operations: z.array(z.strictObject({ kind: z.string(), at: z.number() })),
  outbox: outboxSchema,
}

/** Executable mail input; settlement and result outbox commit together. */
export const taskSchema = z.strictObject({
  ...recordFields, kind: z.literal('task'),
  mode: z.enum(['new', 'followup']),
  mailId: z.string().transform(v => brandString<MailId>(v)),
  prompt: z.string(), messageId: z.string(), attempt: z.number().int(),
  state: z.enum(['queued', 'running', ...terminalStates]),
  sequence: z.number().int().nonnegative().optional(), inputHash: z.string().optional(),
  receipt: outboxSchema.optional(),
})
/** One observed Session turn with no executable email input. */
export const notificationSchema = z.strictObject({
  ...recordFields, kind: z.literal('notification'), state: z.enum(terminalStates),
  turn: z.number().int().nonnegative(),
})
/** One executable email turn. */
export type TaskRecord = z.infer<typeof taskSchema>
/** One result notice from an independently executed Session turn. */
export type NotificationRecord = z.infer<typeof notificationSchema>
/** Durable records share routing and submission while retaining distinct execution fields. */
export const mailRecordSchema = z.discriminatedUnion('kind', [taskSchema, notificationSchema])
/** Stored mail task or notification, selected by its kind. */
export type MailRecord = z.infer<typeof mailRecordSchema>

/** Protocol-owned positions; POP3 UIDLs are stored directly. */
export const mailboxCursorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('imap'), uidValidity: z.string().regex(/^[1-9][0-9]*$/), high: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('pop3'), seen: z.array(z.string().regex(/^[!-~]{1,70}$/)).refine(values => new Set(values).size === values.length, 'duplicate POP3 UIDL') }),
])
/** A committed receive position for one mailbox. */
export type MailboxCursor = z.infer<typeof mailboxCursorSchema>
/** Notification recovery begins at a persisted observation time, independent of mailbox positions. */
export const notificationStateSchema = z.strictObject({ state: z.enum(['observing', 'paused']), since: z.number().int().nonnegative() })
/** Persistent notification observation or pause state. */
export type NotificationState = z.infer<typeof notificationStateSchema>

/** Select executable inputs from durable records.
 * @param record Mail task or independent Session notice.
 * @returns Whether the record owns an executable mail input.
 */
export function isTask(record: MailRecord): record is TaskRecord { return record.kind === 'task' }

/** Settled Agent outcome; text excludes reasoning and raw tool results. */
export interface ExecutionResult {
  state: TerminalState
  /** Empty when the mail renderer should supply its default summary. */
  summary: string
  reason: string
  lastOutput?: string
  report?: RunReport
}

/** Synchronous reads and durable writes owned by one runtime. */
export interface MailStore {
  getInbox(id: MailId): InboxRecord | undefined
  getRecord(id: TaskId): MailRecord | undefined
  readonly inboxCount: number
  readonly recordCount: number
  inbox(): readonly InboxRecord[]
  records(): readonly MailRecord[]
  putInbox(record: InboxRecord): Promise<void>
  putRecord(record: MailRecord): Promise<void>
  /** Transform the record current at the domain's serialized write slot. */
  updateRecord(id: TaskId, update: (record: MailRecord) => MailRecord): Promise<MailRecord>
  cursor(key: string): MailboxCursor | undefined
  putCursor(key: string, value: MailboxCursor): Promise<void>
  notificationState(): NotificationState | undefined
  putNotificationState(value: NotificationState): Promise<void>
  close(): Promise<void>
}

/** DSH execution adapter. Created handles are owned; existing live Agents are borrowed. */
export interface TaskExecutor {
  validate(rule: z.infer<typeof ruleSchema>): Promise<void>
  /** Whether the Session can accept this mail turn without taking over another writer. */
  ready?(task: TaskRecord): boolean
  execute(task: TaskRecord, signal: AbortSignal): Promise<ExecutionResult>
}

/** SMTP result preserves uncertainty after an attempted submission. */
export type SendOutcome = { state: 'accepted' } | { state: 'failed'; retryable: boolean; reason: string } | { state: 'unknown'; reason: string }

/** A frozen receipt or result ready for SMTP; execution state never reaches the sender. */
export interface OutboundMessage {
  account: string
  to: string
  replyTo?: string
  taskId: TaskId
  subject: string
  text: string
  html?: string
  messageId: string
  inReplyTo?: string
  references: string[]
}

/** External operations supplied by production adapters or instance-local fixtures. */
export interface RuntimeDependencies {
  store: MailStore
  executor: TaskExecutor
  verify(raw: Buffer, mail: Mail, policy: import('./config.ts').SenderPolicy, signal: AbortSignal): Promise<void>
  send(message: OutboundMessage, signal: AbortSignal): Promise<SendOutcome>
  report(code: string, id: string): void
  now?: () => number
}
