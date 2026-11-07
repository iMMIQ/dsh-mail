// SPDX-License-Identifier: LGPL-3.0-or-later
/** Deterministic final notification text, frozen before SMTP submission. */
import type { ResultReport } from './report.ts'

/**
 * Include status, workspace, summary and the last Agent text in a bounded UTF-8 reply.
 * @param report - resolved execution facts shared with the HTML alternative.
 * @param maxBytes - configured text limit, including the truncation notice.
 * @returns the complete notification body, with an explicit notice if shortened.
 */
export function replyText(report: ResultReport, maxBytes: number): string {
  const summary = report.summary || (report.source === 'session' ? 'DSH turn completed.' : 'Agent completed normally.')
  const text = `Task: ${report.taskId}\nStatus: ${report.state}\nSession: ${report.sessionId}\nWorking directory: ${report.workspacePath ?? "(not set)"}`
    + (report.reason ? `\nReason: ${report.reason}` : '')
    + `\n\nSummary:\n${summary}\n\nAgent last output:\n${report.output || 'No text output was recorded.'}`
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  const notice = '\n\n[Email shortened. The complete output remains in the DSH session log.]'
  let end = maxBytes - Buffer.byteLength(notice)
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8') + notice
}
