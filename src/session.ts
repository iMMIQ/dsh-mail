// SPDX-License-Identifier: LGPL-3.0-or-later
/** Ordinary Workspace-backed DSH Sessions with a scope-local result tool. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Rule } from './config.ts'
import { observeTurn, type TurnObservation } from './turn-observation.ts'
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
  /** Wait in the durable mail queue while another entry point is driving this Session. */
  ready(task: TaskRecord): boolean {
    const agent = this.ctx.agents.get(brandString<SessionId>(task.sessionId))
    return !agent || agent.status === 'idle' && !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length
  }
  /** Execute one identified follow-up, preserving persisted settings and borrowed Agent ownership. */
  async execute(task: TaskRecord, signal: AbortSignal): Promise<ExecutionResult> {
    signal.throwIfAborted()
    const sessionId = brandString<SessionId>(task.sessionId)
    const messageId = brandString<MessageId>(task.messageId)
    const selectedWorkspace = taskWorkspace(task)
    const stored = await this.ctx.sessionPersistence.stat(sessionId)
    if (task.continuation && !stored) throw new MailError('session-missing-review-required')
    if (!task.continuation && stored) throw new MailError('session-already-exists-review-required')
    if (stored && stored.header.cwd !== selectedWorkspace) throw new MailError('workspace-changed')
    let storedPreset = stored?.header.agentPreset
    if (stored) {
      await using reader = await this.ctx.sessionPersistence.open(sessionId, 'read')
      const { events } = await reader.read()
      storedPreset = events.reduce(agentPresetProjectionDefinition.apply, agentPresetProjectionDefinition.init(reader.header)) ?? undefined
      if (events.some(event => event.type === 'user/message' && event.data.id === messageId
        || event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === messageId))) throw new MailError('message-already-submitted-review-required')
    }
    let agent: Agent | undefined = this.ctx.agents.get(sessionId)
    if (agent && !this.ready(task)) throw new MailError('session-busy', true)
    let handle: AgentHandle | undefined
    let presetScope: AsyncDisposable | undefined
    let off: (() => void) | undefined
    let candidate: TaskResult | undefined
    let observation: TurnObservation = { report: { steps: 0 }, lastOutput: '', finalText: '' }
    let entered = false
    const done = Promise.withResolvers<void>()
    const abort = (): void => {
      if (entered) agent?.cancel({ kind: 'user' })
      else agent?.inbox.remove(messageId)
      done.resolve()
    }
    try {
      if (!agent) {
        const preset = await this.ctx.agentPresets.resolve(storedPreset ?? task.rule.task.agentPreset)
        presetScope = await this.ctx.agentPresets.acquireScope(preset.id)
        const setup = async (agentCtx: Context, current: Agent): Promise<void> => {
          if (current.inbox.nextTurn.length || current.inbox.nextStep.length) throw new MailError('session-has-pending-input-review-required')
          await this.ctx.agentPresets.mount(agentCtx, preset.id)
          agentCtx.tools.register(defineTool({
            name: 'mail_task_result', description: 'Optionally record a business status and concise reply summary. The host also emails the final Agent text automatically. Does not send email. Call at most once after finishing the work.',
            parameters: { status: { type: 'string', required: true, enum: ['succeeded', 'failed'] }, summary: { type: 'string', required: true } },
            output: { schema: { type: 'object', properties: { recorded: { type: 'boolean', required: true } }, additionalProperties: false },
              render: () => [{ type: 'text', text: 'Mail task result recorded. The host sends the notification after this turn ends.' }] },
            async execute(args, exec) {
              if (exec.agent !== current || !entered) throw new MailError('result-session-mismatch')
              if (candidate) throw new MailError('result-already-recorded')
              candidate = resultSchema.parse(args)
              return { recorded: true }
            },
            presentCall: args => ({ card: 'generic', title: 'Record mail task result', kind: 'other', rawInput: args }),
          }))
        }
        const agentOptions = task.rule.task.model ? { ...task.rule.task.model } : this.ctx.agentDefaultModel.currentSelection()
        if (stored) {
          try { handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, signal, agentOptions, setup }) }
          catch (error) { if (error instanceof SessionAlreadyOwnedError) throw new MailError('session-busy', true, { cause: error }); throw error }
        }
        else {
          const workspace = await this.ctx.workspaceRegistry.create(selectedWorkspace)
          if (workspace.path !== selectedWorkspace) throw new MailError('workspace-changed')
          handle = await this.ctx.agents.create({ sessionId, signal, meta: { cwd: workspace.path, agentPreset: preset.id }, agentOptions, setup })
          await workspace.attachSession(sessionId)
          this.ctx.permissionPresets.set(handle.agent.session, task.rule.task.permissionPreset)
          this.ctx.sessionTitle.rename(handle.agent.session, task.title)
        }
        agent = handle.agent
      }
      const current = agent
      off = this.ctx.on('session/event', (session, event) => {
        if (session.id !== sessionId || observation.ending !== undefined || event.type === 'turn/end' && !entered) return
        observation = observeTurn(observation, event) ?? observation
        if (event.type === 'user/message' && event.data.id === messageId) {
          entered = true
          observation = { ...observation, report: { ...observation.report, startedAt: observation.report.startedAt ?? event.time } }
        }
        if (!entered) return
        if (event.type === 'step/start' && observation.report.steps > task.rule.task.maxSteps) current.cancel({ kind: 'user' })
        if (event.type === 'turn/end') { entered = false; done.resolve() }
      })
      signal.addEventListener('abort', abort, { once: true })
      signal.throwIfAborted()
      const message = createUserMessage({ content: [{ type: 'text', text: task.prompt }],
        source: { kind: 'dsh-mail', taskId: task.id, mailId: task.mailId, ruleId: task.rule.id } })
      current.followup(Object.freeze({ ...message, id: messageId }))
      await done.promise
      if (signal.aborted && handle) await current.whenIdle()
      if (!await this.ctx.sessions.flush(current.session)) throw new MailError('session-persistence-unavailable')
      const { ending, report, lastOutput, finalText } = observation
      const steps = report.steps
      if (signal.aborted || ending === 'aborted' || steps > task.rule.task.maxSteps) return { state: 'cancelled', summary: 'Task stopped before completion.', reason: steps > task.rule.task.maxSteps ? 'step-budget-exhausted' : 'cancelled', lastOutput, report }
      if (ending === 'error') return { state: 'failed', summary: 'Agent execution failed. Inspect the DSH session for details.', reason: 'agent-execution-error', lastOutput, report }
      if (ending !== 'completed') return { state: 'needs_attention', summary: 'The Agent stopped before normal completion. Inspect the DSH session.', reason: `turn-${ending ?? 'missing'}`, lastOutput, report }
      if (candidate) return { state: candidate.status, summary: candidate.summary, reason: '', lastOutput, report }
      if (finalText) return { state: 'succeeded', summary: '', reason: '', lastOutput, report }
      return { state: 'needs_attention', summary: 'No final text response or structured result was recorded. Inspect the DSH session.', reason: 'missing-completed-result', lastOutput, report }
    } finally {
      signal.removeEventListener('abort', abort)
      off?.()
      try { await handle?.dispose() } finally { await presetScope?.[Symbol.asyncDispose]() }
    }
  }
}
