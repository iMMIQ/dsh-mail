// SPDX-License-Identifier: LGPL-3.0-or-later
/** Deterministic final notification text, frozen before SMTP submission. */
import { taskWorkspace } from './workspace.ts'
import type { TaskRecord } from './types.ts'

/**
 * Include status, workspace, summary and the last Agent text in a bounded UTF-8 reply.
 * @param task - settled task including its independent business status and final output.
 * @param maxBytes - configured text limit, including the truncation notice.
 * @returns the complete notification body, with an explicit notice if shortened.
 */
export function replyText(task: TaskRecord, maxBytes: number): string {
  const text = `Task: ${task.id}\nStatus: ${task.state}\nSession: ${task.sessionId}\nWorking directory: ${taskWorkspace(task)}`
    + (task.reason ? `\nReason: ${task.reason}` : '')
    + `\n\nSummary:\n${task.summary}\n\nAgent last output:\n${task.lastOutput || 'No text output was recorded.'}`
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  const notice = '\n\n[Email shortened. The complete output remains in the DSH session log.]'
  let end = maxBytes - Buffer.byteLength(notice)
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8') + notice
}
