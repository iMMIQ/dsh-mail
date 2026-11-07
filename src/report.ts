// SPDX-License-Identifier: LGPL-3.0-or-later
/** Shared execution facts for the HTML and plain-text mail alternatives. */
import type { MailRecord } from './types.ts'

/** Resolve task and observed-turn facts before rendering either mail alternative.
 * @param task Settled task or session notification; an empty summary selects presentation defaults.
 * @returns Report values without rule configuration, credentials or submission state.
 */
export function prepareReport(task: MailRecord) {
  const observed = task.report
  const startedAt = observed?.startedAt
  const finishedAt = observed?.finishedAt
  return {
    taskId: task.id, sessionId: task.sessionId, state: task.state,
    title: task.title.replace(/^\[Mail\]\s*/, '').replace(/^\[DSH\]\s*/i, '') || 'DSH 任务',
    workspacePath: task.workspacePath ?? task.rule.task.workspacePath,
    summary: task.summary, output: task.lastOutput ?? '', reason: task.reason,
    source: task.kind === 'notification' ? 'session' as const : 'agent' as const,
    model: observed?.model ? [observed.provider, observed.model].filter(Boolean).join(' / ') : undefined,
    steps: observed?.steps, turn: observed?.turn ?? (task.kind === 'notification' ? task.turn : undefined), startedAt, finishedAt,
    elapsedMs: startedAt !== undefined && finishedAt !== undefined && finishedAt >= startedAt ? finishedAt - startedAt : undefined,
  }
}

/** Resolved facts consumed by both mail renderers. */
export type ResultReport = ReturnType<typeof prepareReport>
