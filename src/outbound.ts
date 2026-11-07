// SPDX-License-Identifier: LGPL-3.0-or-later
/** Result rendering and explicit SMTP messages shared by tasks, receipts and Session notices. */
import type { Config } from './config.ts'
import { replyHtml } from './email-template.ts'
import { replyText } from './reply.ts'
import type { OutboundMessage, TaskId, TaskRecord } from './types.ts'

type Outbox = TaskRecord['outbox']

/** Create a durable outgoing entry without submitting it.
 * @param input Task identity, sender address, subject and initial delivery state.
 * @returns Entry with stable Message-ID and empty submission history.
 */
export function createOutbox(input: { id: TaskId; address: string; subject: string; state: Outbox['state']; nextAt: number; text?: string; kind?: 'receipt' }): Outbox {
  return { state: input.state, messageId: `<dsh-mail-${input.kind === 'receipt' ? 'received-' : ''}${input.id}@${input.address.split('@')[1]}>`,
    attempts: 0, nextAt: input.nextAt, subject: input.subject, text: input.text ?? '', reason: '' }
}

/** Render both alternatives once before their durable outbox entry becomes pending.
 * @param task Settled execution facts.
 * @param maxBytes Separate byte budget for each body alternative.
 * @returns Frozen-content fields, omitting HTML when the template does not fit.
 */
export function renderResult(task: TaskRecord, maxBytes: number): Pick<Outbox, 'text' | 'html'> {
  const html = replyHtml(task, maxBytes)
  return { text: replyText(task, maxBytes), ...(html ? { html } : {}) }
}

/** Select a task's result or receipt without changing the task supplied to other consumers.
 * @param task Correlation, routing and mail-thread metadata.
 * @param entry Frozen result or receipt entry being submitted.
 * @param config Current receive identities used for Reply-To.
 * @returns An SMTP message with no execution state or credential values.
 */
export function outboundMessage(task: TaskRecord, entry: Outbox, config: Config): OutboundMessage {
  const replyTo = config.accounts.find(account => account.id === task.account)?.address
  return { account: task.rule.reply.account, to: task.rule.reply.to, ...(replyTo ? { replyTo } : {}), taskId: task.id,
    subject: entry.subject, text: entry.text, ...(entry.html ? { html: entry.html } : {}), messageId: entry.messageId,
    ...(task.originalMessageId ? { inReplyTo: task.originalMessageId } : {}),
    references: task.originalMessageId ? [...task.references, task.originalMessageId].slice(-20) : [] }
}
