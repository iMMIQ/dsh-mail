// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage, createUserMessage, type ContentBlock, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { observeTurn, type TurnObservation } from '../src/turn-observation.ts'

const start: SessionEvent<'turn/start'> = { type: 'turn/start', seq: SessionSeq(1), time: 100, data: { turn: 1 } }
const step: SessionEvent<'step/start'> = { type: 'step/start', seq: SessionSeq(2), time: 101, data: { turn: 1, step: 1 } }
const prompt: SessionEvent<'user/message'> = { type: 'user/message', seq: SessionSeq(3), time: 102, surfaceOp: 'append',
  data: createUserMessage({ content: [{ type: 'text', text: 'Test task' }], source: { kind: 'user' } }) }
function assistant(content: ContentBlock[], seq = 4): SessionEvent<'assistant/message'> {
  return { type: 'assistant/message', seq: SessionSeq(seq), time: 100 + seq, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: createAssistantMessage({ content, source: { provider: 'fixture', model: 'fixture-model' } }), stream: [] } }
}
const ending: SessionEvent<'turn/end'> = { type: 'turn/end', seq: SessionSeq(9), time: 109, data: { turn: 1, reason: { kind: 'completed' } } }
const tool: ContentBlock = { type: 'tool-call', id: brandString<ToolCallId>('test-call'), name: 'test_tool', arguments: '{}' }

function fold(events: SessionEvent[]): TurnObservation | undefined { return events.reduce<TurnObservation | undefined>(observeTurn, undefined) }

test('turn observations include the step preceding the claimed input and preserve complete Markdown', () => {
  const markdown = '## Result\n\n| Check | State |\n| --- | --- |\n| Tests | passed |\n\n```ts\nconsole.log("done")\n```'
  const observed = fold([start, step, prompt, assistant([{ type: 'text', text: markdown }]), ending])!
  assert.equal(observed.report.steps, 1)
  assert.deepEqual(observed.report, { startedAt: 100, steps: 1, turn: 1, finishedAt: 109, provider: 'fixture', model: 'fixture-model' })
  assert.equal(observed.lastOutput, markdown)
  assert.equal(observed.finalText, markdown)
  assert.equal(observed.ending, 'completed')
})

test('a tool-bearing or reasoning-only assistant response cannot become a final text result', () => {
  const observed = fold([start, step, assistant([{ type: 'text', text: 'Working' }, tool]), assistant([{ type: 'reasoning', text: 'PRIVATE_REASONING' }], 5), ending])!
  assert.equal(observed.lastOutput, 'Working')
  assert.equal(observed.finalText, '')
  assert.ok(!JSON.stringify(observed).includes('PRIVATE_REASONING'))
})

test('observations do not alter earlier state and a new turn discards the previous result', () => {
  const previous = fold([start, step, assistant([{ type: 'text', text: 'Old result' }])])!
  const before = structuredClone(previous)
  const ended = observeTurn(previous, ending)!
  assert.deepEqual(previous, before)
  assert.equal(previous.report.finishedAt, undefined)
  assert.equal(ended.report.finishedAt, 109)
  const next = observeTurn(ended, { type: 'turn/start', seq: SessionSeq(10), time: 110, data: { turn: 2 } })!
  assert.deepEqual(next, { report: { startedAt: 110, steps: 0, turn: 2 }, lastOutput: '', finalText: '' })
})
