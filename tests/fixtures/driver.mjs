// SPDX-License-Identifier: LGPL-3.0-or-later
/** Test-only deterministic LLM and tool, mounted by the real dsh profile launcher. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'mail-e2e-fixture'
export const inject = ['llm', 'tools']

export function apply(ctx, config) {
  const requests = []
  class RecordedAdapter extends LlmAdapter {
    async *stream(options) {
      options.signal?.throwIfAborted()
      requests.push({ tools: options.tools.map(t => t.name).sort(), roles: options.messages.map(m => m.role) })
      await writeFile(join(config.root, 'requests.json'), JSON.stringify(requests, null, 2))
      if (config.scenario === 'text-only') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Analysis completed without the result tool.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const step = options.messages.filter(m => m.role === 'assistant').length
      if (config.scenario === 'empty-result') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (config.scenario === 'model-error') {
        if (step > 0) throw new Error('Fixture model unavailable')
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE_FIXTURE_REASONING' } }
        yield { type: 'block-start', index: 1, blockType: 'text' }
        yield { type: 'block-end', index: 1, block: { type: 'text', text: 'Partial analysis before the model failure.' } }
        yield { type: 'block-start', index: 2, blockType: 'tool-call' }
        yield { type: 'block-end', index: 2, block: { type: 'tool-call', id: ToolCallId('fixture-error-call'), name: 'fixture_write', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (step < 2) {
        const block = { type: 'tool-call', id: ToolCallId(`fixture-call-${step}`), name: step === 0 ? 'fixture_write' : 'mail_task_result',
          arguments: step === 0 ? '{}' : JSON.stringify({ status: 'succeeded', summary: 'Evidence file created.' }) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Task finished.' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Task finished.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['mail-fixture'], new RecordedAdapter())
  ctx.tools.register(defineTool({ name: 'fixture_write', description: 'Write the integration-test evidence file.', parameters: {},
    output: { schema: { type: 'object', properties: { written: { type: 'boolean', required: true } }, additionalProperties: false },
      render: () => [{ type: 'text', text: 'Evidence file created.' }] },
    async execute(_args, execution) {
      if (!execution.agent?.session.header.cwd) throw new Error('No task working directory')
      await writeFile(join(execution.agent.session.header.cwd, 'evidence.txt'), 'created by a real DSH tool call\n')
      return { written: true }
    },
    presentCall: () => ({ card: 'generic', title: 'Write evidence', kind: 'other' }),
  }))
  ctx.inject(['mailAutomation'], child => {
    let ready = false
    const timer = setInterval(async () => {
      const status = child.mailAutomation.status()
      if (!ready && Object.values(status.health).includes('healthy')) { ready = true; process.stdout.write('DSH_MAIL_READY\n') }
      await writeFile(join(config.root, 'status.json'), JSON.stringify(status))
    }, 20)
    child.effect(() => () => clearInterval(timer))
  })
}
