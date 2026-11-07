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

/** Stable provider identity; POP3 encodes the source and UIDL in uidValidity with uid zero. */
export interface Delivery {
  account: string
  folder: string
  uidValidity: string
  uid: number
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
  account: z.string(), folder: z.string(), uidValidity: z.string(), uid: z.number().int(),
  receivedAt: z.number(), rawHash: z.string(),
  state: z.enum(['stored', 'verification_pending', 'ignored', 'quarantined', 'held', 'matched']),
  reason: z.string(), attempts: z.number().int(), nextAt: z.number(),
})
/** Stored ingress record; content lives in the owner-only spool. */
export type InboxRecord = z.infer<typeof inboxSchema>

/** One separately submitted mail, including uncertainty after SMTP DATA. */
const outboxSchema = z.strictObject({
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

/** Atomically stores execution settlement and the corresponding outbox entry. */
export const taskSchema = z.strictObject({
  id: z.string().transform(v => brandString<TaskId>(v)), mailId: z.string().transform(v => brandString<MailId>(v)),
  account: z.string(), rule: ruleSchema, createdAt: z.number(),
  prompt: z.string(), title: z.string(), sessionId: z.string(), messageId: z.string(),
  workspacePath: z.string().optional(),
  originalMessageId: z.string().nullable(), references: z.array(z.string()),
  // Version-one records can contain starting; new executions are claimed as running.
  state: z.enum(['queued', 'starting', 'running', ...terminalStates]),
  summary: z.string(), reason: z.string(), attempt: z.number().int(),
  lastOutput: z.string().optional(),
  report: reportSchema.optional(),
  sequence: z.number().int().nonnegative().optional(),
  continuation: z.boolean().optional(),
  origin: z.literal('session').optional(),
  inputHash: z.string().optional(),
  turn: z.number().int().nonnegative().optional(),
  receipt: outboxSchema.optional(),
  authorization: z.strictObject({ sender: z.string(), policy: senderPolicySchema }),
  operations: z.array(z.strictObject({ kind: z.string(), at: z.number() })),
  outbox: outboxSchema,
})
/** Complete execution and notification state. */
export type TaskRecord = z.infer<typeof taskSchema>

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
  getTask(id: TaskId): TaskRecord | undefined
  readonly inboxCount: number
  readonly taskCount: number
  inbox(): readonly InboxRecord[]
  tasks(): readonly TaskRecord[]
  putInbox(record: InboxRecord): Promise<void>
  putTask(record: TaskRecord): Promise<void>
  /** Transform the record current at the domain's serialized write slot. */
  updateTask(id: TaskId, update: (record: TaskRecord) => TaskRecord): Promise<TaskRecord>
  cursor(key: string): { validity: string; high: number } | undefined
  putCursor(key: string, value: { validity: string; high: number }): Promise<void>
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
