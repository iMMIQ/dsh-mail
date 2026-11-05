// SPDX-License-Identifier: LGPL-3.0-or-later
/** Ordinary Workspace-backed DSH Sessions with a scope-local result tool. */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Rule } from './config.ts'
import { taskWorkspace } from './workspace.ts'
import { MailError, resultSchema, type ExecutionResult, type TaskExecutor, type TaskRecord, type TaskResult } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Mail task correlation; the entire admitted prompt remains in user/message. */
    'dsh-mail': { kind: 'dsh-mail'; taskId: string; mailId: string; ruleId: string }
  }
}

/** Creates and owns one root Agent per task, never importing agent-loop. */
export class DshExecutor implements TaskExecutor {
  constructor(private readonly ctx: Context) {}
  /** Validate the explicit or current default Agent preset before accepting mail. */
  async validate(rule: Rule): Promise<void> {
    this.ctx.permissionPresets.resolve(rule.task.permissionPreset)
    await this.ctx.agentPresets.resolve(rule.task.agentPreset)
  }
  /** Settle a turn from its durable ending, optional business result and last Agent text. */
  async execute(task: TaskRecord, signal: AbortSignal): Promise<ExecutionResult> {
    signal.throwIfAborted()
    const sessionId = brandString<SessionId>(task.sessionId)
    if (await this.ctx.sessionPersistence.stat(sessionId)) throw new MailError('session-already-exists-review-required')
    const preset = await this.ctx.agentPresets.resolve(task.rule.task.agentPreset)
    await using presetScope = await this.ctx.agentPresets.acquireScope(preset.id)
    void presetScope
    const selectedWorkspace = taskWorkspace(task)
    const workspace = await this.ctx.workspaceRegistry.create(selectedWorkspace)
    if (workspace.path !== selectedWorkspace) throw new MailError('workspace-changed')
    let handle: AgentHandle | undefined
    let candidate: TaskResult | undefined
    let ending: TurnEndReason['kind'] | undefined
    let lastOutput = ''
    let finalText = ''
    let steps = 0
    const abort = (): void => handle?.agent.cancel({ kind: 'user' })
    try {
      signal.throwIfAborted()
      handle = await this.ctx.agents.create({ sessionId, signal,
        meta: { cwd: workspace.path, agentPreset: preset.id },
        agentOptions: task.rule.task.model ? { provider: task.rule.task.model.provider, model: task.rule.task.model.model,
          ...(task.rule.task.model.maxTokens === undefined ? {} : { maxTokens: task.rule.task.model.maxTokens }) } : this.ctx.agentDefaultModel.currentSelection(),
        setup: async (agentCtx, agent) => {
          await this.ctx.agentPresets.mount(agentCtx, preset.id)
          agentCtx.tools.register(defineTool({
            name: 'mail_task_result', description: 'Optionally record a business status and concise reply summary. The host also emails the final Agent text automatically. Does not send email. Call at most once after finishing the work.',
            parameters: { status: { type: 'string', required: true, enum: ['succeeded', 'failed'] }, summary: { type: 'string', required: true } },
            output: { schema: { type: 'object', properties: { recorded: { type: 'boolean', required: true } }, additionalProperties: false },
              render: () => [{ type: 'text', text: 'Mail task result recorded. The host sends the notification after this turn ends.' }] },
            async execute(args, exec) {
              if (exec.agent !== agent) throw new MailError('result-session-mismatch')
              if (candidate) throw new MailError('result-already-recorded')
              candidate = resultSchema.parse(args)
              return { recorded: true }
            },
            presentCall: args => ({ card: 'generic', title: 'Record mail task result', kind: 'other', rawInput: args }),
          }))
          agentCtx.on('session/event', (session, event) => {
            if (session.id !== sessionId) return
            if (event.type === 'step/start' && ++steps > task.rule.task.maxSteps) agent.cancel({ kind: 'user' })
            if (event.type === 'assistant/message') {
              const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
              if (text) lastOutput = text
              finalText = event.data.message.content.some(block => block.type === 'tool-call') ? '' : text
            }
            if (event.type === 'turn/end') ending = event.data.reason.kind
          })
        },
      })
      signal.addEventListener('abort', abort, { once: true })
      signal.throwIfAborted()
      await workspace.attachSession(sessionId)
      this.ctx.permissionPresets.set(handle.agent.session, task.rule.task.permissionPreset)
      this.ctx.sessionTitle.rename(handle.agent.session, task.title)
      const message = createUserMessage({ content: [{ type: 'text', text: task.prompt }],
        source: { kind: 'dsh-mail', taskId: task.id, mailId: task.mailId, ruleId: task.rule.id } })
      handle.agent.followup(Object.freeze({ ...message, id: brandString<MessageId>(task.messageId) }))
      await handle.agent.whenIdle()
      if (!await this.ctx.sessions.flush(handle.agent.session)) throw new MailError('session-persistence-unavailable')
      if (signal.aborted || ending === 'aborted' || steps > task.rule.task.maxSteps) return { state: 'cancelled', summary: 'Task stopped before completion.', reason: steps > task.rule.task.maxSteps ? 'step-budget-exhausted' : 'cancelled', lastOutput }
      if (ending === 'error') return { state: 'failed', summary: 'Agent execution failed. Inspect the DSH session for details.', reason: 'agent-execution-error', lastOutput }
      if (ending !== 'completed') return { state: 'needs_attention', summary: 'The Agent stopped before normal completion. Inspect the DSH session.', reason: `turn-${ending ?? 'missing'}`, lastOutput }
      if (candidate) return { state: candidate.status, summary: candidate.summary, reason: '', lastOutput }
      if (finalText) return { state: 'succeeded', summary: 'Agent completed normally.', reason: '', lastOutput }
      return { state: 'needs_attention', summary: 'No final text response or structured result was recorded. Inspect the DSH session.', reason: 'missing-completed-result', lastOutput }
    } finally {
      signal.removeEventListener('abort', abort)
      await handle?.dispose()
    }
  }
}
