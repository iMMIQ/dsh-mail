// SPDX-License-Identifier: LGPL-3.0-or-later
/** Pure per-turn observations shared by task execution, live notices and recovery. */
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { RunReport } from './types.ts'

/** Complete observed text and counters for one turn; tool output and reasoning are excluded. */
export interface TurnObservation {
  report: RunReport & { steps: number }
  lastOutput: string
  finalText: string
  ending?: TurnEndReason['kind']
}

/** Fold one committed event without changing the previous observation.
 * @param previous Current turn, or undefined until its start is observed.
 * @param event Committed Session event.
 * @returns Updated observations, retaining unchanged state for unrelated events.
 */
export function observeTurn(previous: TurnObservation | undefined, event: SessionEvent): TurnObservation | undefined {
  if (event.type === 'turn/start') return { report: { startedAt: event.time, steps: 0, turn: event.data.turn }, lastOutput: '', finalText: '' }
  if (!previous || previous.ending !== undefined) return previous
  switch (event.type) {
    case 'step/start': return { ...previous, report: { ...previous.report, steps: previous.report.steps + 1, turn: event.data.turn } }
    case 'assistant/message': {
      const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
      return { ...previous, report: { ...previous.report, provider: event.data.message.source.provider, model: event.data.message.source.model },
        lastOutput: text || previous.lastOutput, finalText: event.data.message.content.some(block => block.type === 'tool-call') ? '' : text }
    }
    case 'turn/end': return { ...previous, report: { ...previous.report, finishedAt: event.time }, ending: event.data.reason.kind }
    default: return previous
  }
}
