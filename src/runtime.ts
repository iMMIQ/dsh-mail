// SPDX-License-Identifier: LGPL-3.0-or-later
/** Persistent mail admission, fair task scheduling and independently retried outbox. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Config, Rule } from './config.ts'
import { parseMail, matches, systemReason, taskPrompt } from './mail.ts'
import { Spool } from './store.ts'
import { canonicalWorkspace, emailWorkspace, taskWorkspace } from './workspace.ts'
import { replyText } from './reply.ts'
import { MailError, type Delivery, type InboxRecord, type Mail, type MailId, type RuntimeDependencies, type TaskId, type TaskRecord } from './types.ts'

/** Shared decision produced by preview and actual ingestion without persistence. */
type Decision = { state: 'ignored' | 'quarantined' | 'held' | 'verification_pending'; reason: string }
  | { state: 'matched'; reason: string; rule: Rule; mail: Mail; prompt: string; workspacePath: string }

/** Stable ID from an unambiguous sequence of provider-owned values. */
export function identity(...parts: (string | number)[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex') }

/** Durable runtime. close() drains callers before domain and spool disposal. */
export class MailRuntime {
  private closing = false
  private failure: unknown
  private admission: Promise<void> = Promise.resolve()
  private ticking: Promise<void> | undefined
  private administration: Promise<void> = Promise.resolve()
  private administering = false
  private readonly controller = new AbortController()
  private readonly workers = new Map<TaskId, { controller: AbortController; done: Promise<void>; workspace: string }>()
  private lastAccount = ''
  private lastSendAt = -Infinity
  readonly health = new Map<string, string>()
  private readonly now: () => number

  constructor(readonly config: Config, readonly spool: Spool, private readonly deps: RuntimeDependencies) { this.now = deps.now ?? Date.now }

  /** Recover uncertain attempts without repeating a possibly committed side effect. */
  async initialize(): Promise<void> {
    for (const rule of this.config.rules) await this.deps.executor.validate(rule)
    for (const task of this.deps.store.tasks()) {
      if (task.outbox.state === 'sending') await this.deps.store.putTask({ ...task, outbox: { ...task.outbox, state: 'unknown', reason: 'restart-during-send' } })
      if (task.state === 'starting' || task.state === 'running') {
        await this.settle({ ...task, outbox: task.outbox.state === 'sending' ? { ...task.outbox, state: 'unknown', reason: 'restart-during-send' } : task.outbox },
          'needs_attention', 'The process stopped during execution. Inspect the DSH session before retrying.', 'restart-during-execution')
      }
    }
  }

  private assertUsable(): void {
    this.spool.assertOwned()
    if (this.closing) throw new MailError('runtime-closing')
    if (this.failure) throw new MailError('storage-or-runtime-blocked', false, { cause: this.failure })
  }

  /** Admit once, after bytes are durable; no model or SMTP operation occurs here. */
  admit(delivery: Delivery): Promise<void> {
    const done = this.admission.then(async () => {
      this.assertUsable()
      const id = brandString<MailId>(identity(delivery.account, delivery.folder, delivery.uidValidity, delivery.uid))
      if (this.deps.store.inbox().some(r => r.id === id)) return
      if (this.deps.store.inbox().length >= this.config.runtime.maxRecords) throw new MailError('record-capacity-reached', true)
      const pending = this.deps.store.inbox().filter(r => r.state === 'stored' || r.state === 'verification_pending').length
        + this.deps.store.tasks().filter(r => r.state === 'queued').length
      if (pending >= this.config.runtime.maxQueuedTasks) throw new MailError('queue-full', true)
      const rawHash = await this.spool.write(delivery.raw)
      await this.deps.store.putInbox({ id, account: delivery.account, folder: delivery.folder, uidValidity: delivery.uidValidity,
        uid: delivery.uid, receivedAt: delivery.receivedAt, rawHash,
        state: delivery.tooLarge ? 'quarantined' : 'stored', reason: delivery.tooLarge ? 'message-too-large' : '', attempts: 0, nextAt: 0 })
    })
    this.admission = done.catch(error => { if (!(error instanceof MailError)) this.block(error) })
    return done
  }

  /** Advance a mailbox only after every candidate before this watermark was admitted. */
  async checkpoint(key: string, value: { validity: string; high: number }): Promise<void> {
    this.assertUsable()
    try { await this.deps.store.putCursor(key, value) } catch (error) { this.block(error); throw error }
  }
  /** Read the provider's last committed watermark. */
  cursor(key: string): { validity: string; high: number } | undefined { return this.deps.store.cursor(key) }

  /** Single sweep; callers may request another after observing task settlement. */
  tick(): Promise<void> {
    if (this.closing || this.failure || this.administering) return Promise.resolve()
    this.ticking ??= this.sweep().catch(error => { if (!this.closing) this.block(error) }).finally(() => { this.ticking = undefined })
    return this.ticking
  }

  private async sweep(): Promise<void> {
    this.assertUsable()
    for (const record of this.deps.store.inbox()) {
      if (this.closing) return
      if ((record.state === 'stored' || record.state === 'verification_pending') && record.nextAt <= this.now()) await this.evaluate(record)
    }
    this.startWorkers()
    if (!this.closing && this.now() - this.lastSendAt >= this.config.runtime.minSendIntervalMs) {
      const task = this.deps.store.tasks().find(t => t.outbox.state === 'pending' && t.outbox.nextAt <= this.now())
      if (task) await this.send(task)
    }
  }

  private async analyze(record: Pick<InboxRecord, 'account' | 'receivedAt' | 'attempts'>, raw: Buffer, releaseReply = false): Promise<Decision> {
    let mail
    try { mail = await parseMail(raw, this.config.runtime) } catch (error) {
      return { state: 'quarantined', reason: error instanceof MailError ? error.code : 'mime-invalid' }
    }
    const system = systemReason(mail)
    if (system) return { state: 'ignored', reason: system }
    const account = this.config.accounts.find(a => a.id === record.account)
    if (!account?.receive) return { state: 'quarantined', reason: 'receive-account-removed' }
    if (this.now() - record.receivedAt > account.receive.maxMessageAgeMs) return { state: 'ignored', reason: 'message-too-old' }
    const rules = this.config.rules.filter(r => r.account === record.account).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    for (const rule of rules) {
      if (!rule.authorization.allowedSenders.some(s => s.toLowerCase() === mail.from) || !matches(mail, rule)) continue
      const policy = this.config.senderPolicies[rule.authorization.policy]
      if (!policy) throw new MailError('sender-policy-removed')
      try { await this.deps.verify(raw, mail, policy, this.controller.signal) } catch (error) {
        if (this.closing) throw new MailError('runtime-closing')
        const retry = error instanceof MailError && error.retryable && record.attempts + 1 < this.config.runtime.maxVerificationAttempts
        return { state: retry ? 'verification_pending' : 'quarantined', reason: error instanceof MailError ? error.code : 'verification-failed' }
      }
      if (mail.references.length > 0 && !releaseReply) return { state: 'held', reason: 'reply-requires-review' }
      let prompt: string
      let workspacePath: string
      try {
        const selected = await emailWorkspace(mail, rule, this.config.runtime.maxTaskBytes)
        workspacePath = selected.workspacePath
        prompt = taskPrompt(selected.mail, rule, this.config, workspacePath)
      } catch (error) {
        return { state: 'quarantined', reason: error instanceof MailError ? error.code : 'workspace-selection-failed' }
      }
      return { state: 'matched', reason: rule.id, rule, mail, prompt, workspacePath }
    }
    return { state: 'ignored', reason: 'no-authorized-rule' }
  }

  private async evaluate(record: InboxRecord, releaseReply = false): Promise<void> {
    const decision = await this.analyze(record, await this.spool.read(record.rawHash), releaseReply)
    if (decision.state === 'matched') {
      const { rule, mail, prompt, workspacePath } = decision
      const id = brandString<TaskId>(identity(record.id, rule.id))
      if (!this.deps.store.tasks().some(t => t.id === id)) {
        await this.deps.store.putTask({ id, mailId: record.id, account: record.account, rule: structuredClone(rule), createdAt: this.now(), prompt, workspacePath,
          title: `[Mail] ${mail.subject.replace(/[\r\n]/g, ' ').slice(0, 160)}`, sessionId: `mail-${id}`, messageId: `mail-input-${id}`,
          originalMessageId: mail.messageId, references: mail.references.slice(-20), state: 'queued', summary: '', reason: '', attempt: 1, lastOutput: '',
          authorization: { sender: mail.from, policy: structuredClone(this.config.senderPolicies[rule.authorization.policy]!) },
          operations: releaseReply ? [{ kind: 'operator-released-reply', at: this.now() }] : [],
          outbox: { state: 'none', messageId: `<dsh-mail-${id}@${this.config.accounts.find(a => a.id === rule.reply.account)?.address.split('@')[1]}>`,
            attempts: 0, nextAt: 0, subject: `Re: ${mail.subject.replace(/[\r\n]/g, ' ').slice(0, 160)}`, text: '', reason: '' } })
      }
    }
    await this.deps.store.putInbox({ ...record, state: decision.state, reason: decision.reason,
      attempts: record.attempts + (decision.state === 'verification_pending' || decision.state === 'quarantined' ? 1 : 0),
      nextAt: decision.state === 'verification_pending' ? this.now() + this.config.runtime.retryDelayMs : 0 })
  }

  private startWorkers(): void {
    const candidates = this.deps.store.tasks().filter(t => t.state === 'queued')
    const accounts = [...new Set(candidates.map(t => t.account))].sort()
    const pivot = accounts.indexOf(this.lastAccount)
    const ordered = [...accounts.slice(pivot + 1), ...accounts.slice(0, pivot + 1)]
    for (const account of ordered) {
      if (this.closing || this.workers.size >= this.config.runtime.maxConcurrentTasks) return
      const task = candidates.find(t => t.account === account && ![...this.workers.values()].some(w => w.workspace === taskWorkspace(t)))
      if (!task || this.workers.has(task.id)) continue
      const controller = new AbortController()
      const done = this.run(task, controller).catch(error => this.block(error)).finally(() => this.workers.delete(task.id))
      this.workers.set(task.id, { controller, done, workspace: taskWorkspace(task) })
      this.lastAccount = account
    }
  }

  private async run(task: TaskRecord, controller: AbortController): Promise<void> {
    const current = this.config.rules.find(r => r.id === task.rule.id)
    if (!current || JSON.stringify(current) !== JSON.stringify(task.rule)
      || JSON.stringify(this.config.senderPolicies[current.authorization.policy]) !== JSON.stringify(task.authorization.policy)) {
      await this.settle(task, 'needs_attention', 'The rule changed. Review this task before execution.', 'rule-changed'); return
    }
    try {
      if (await canonicalWorkspace(taskWorkspace(task)) !== taskWorkspace(task)) throw new MailError('workspace-changed')
    } catch (error) {
      await this.settle(task, 'needs_attention', 'The selected workspace is unavailable or changed. Review the task before execution.', error instanceof MailError ? error.code : 'workspace-unavailable')
      return
    }
    await this.deps.store.putTask({ ...task, state: 'starting' })
    if (this.closing) { await this.settle(task, 'needs_attention', 'Stopped before execution.', 'runtime-stopped'); return }
    await this.deps.store.putTask({ ...task, state: 'running' })
    const timer = setTimeout(() => controller.abort(new MailError('task-timeout')), task.rule.task.timeoutMs)
    try {
      const result = await this.deps.executor.execute(task, controller.signal)
      const timeout = controller.signal.reason instanceof MailError && controller.signal.reason.code === 'task-timeout'
      const state = timeout ? 'timed_out' : controller.signal.aborted ? 'cancelled' : result.state
      await this.settle(task, state, result.summary, timeout ? 'task-timeout' : result.reason, result.lastOutput ?? '')
    } catch (error) {
      const state = controller.signal.reason instanceof MailError && controller.signal.reason.code === 'task-timeout' ? 'timed_out'
        : controller.signal.aborted ? 'cancelled' : 'needs_attention'
      await this.settle(task, state, 'Execution did not complete. Inspect the DSH session before retrying.', error instanceof MailError ? error.code : 'execution-unknown')
    } finally { clearTimeout(timer) }
  }

  private async settle(task: TaskRecord, state: TaskRecord['state'], summary: string, reason: string, lastOutput = task.lastOutput ?? ''): Promise<void> {
    const notify = task.rule.reply.on.some(value => value === state)
    const settled = { ...task, state, summary, reason, lastOutput }
    await this.deps.store.putTask({ ...settled,
      outbox: { ...task.outbox, state: notify ? 'pending' : 'none', text: replyText(settled, this.config.runtime.maxReplyBytes), nextAt: this.now() } })
  }

  private async send(task: TaskRecord): Promise<void> {
    const current = this.config.rules.find(r => r.id === task.rule.id)
    if (!current || current.reply.to !== task.rule.reply.to || current.reply.account !== task.rule.reply.account) {
      await this.deps.store.putTask({ ...task, outbox: { ...task.outbox, state: 'failed', reason: 'reply-policy-changed' } }); return
    }
    const sending: TaskRecord = { ...task, outbox: { ...task.outbox, state: 'sending', attempts: task.outbox.attempts + 1 } }
    await this.deps.store.putTask(sending)
    this.lastSendAt = this.now()
    let outcome
    try { outcome = await this.deps.send(sending, this.controller.signal) } catch (error) {
      outcome = { state: 'unknown' as const, reason: error instanceof MailError ? error.code : 'submission-unknown' }
    }
    const retry = outcome.state === 'failed' && outcome.retryable && sending.outbox.attempts < this.config.runtime.maxSendAttempts
    await this.deps.store.putTask({ ...sending, outbox: { ...sending.outbox, state: retry ? 'pending' : outcome.state,
      reason: outcome.state === 'accepted' ? '' : outcome.reason, nextAt: this.now() + this.config.runtime.retryDelayMs * sending.outbox.attempts } })
  }

  private block(error: unknown): void {
    if (this.failure) return
    this.failure = error
    this.controller.abort(new MailError('runtime-blocked'))
    for (const worker of this.workers.values()) worker.controller.abort(new MailError('runtime-blocked'))
    this.deps.report(error instanceof MailError ? error.code : 'mail-runtime-blocked', 'runtime')
  }

  /** Status contains correlation IDs and safe codes, never email content or secrets. */
  status(): object {
    const tasks = this.deps.store.tasks()
    return { closing: this.closing, blocked: Boolean(this.failure), health: Object.fromEntries(this.health),
      execution: { running: this.workers.size, queued: tasks.filter(t => t.state === 'queued').length, needsAttention: tasks.filter(t => t.state === 'needs_attention').length },
      notification: { pending: tasks.filter(t => t.outbox.state === 'pending').length, failed: tasks.filter(t => t.outbox.state === 'failed').length, unknown: tasks.filter(t => t.outbox.state === 'unknown').length },
      inbox: this.deps.store.inbox().map(r => ({ id: r.id, state: r.state, reason: r.reason })),
      tasks: tasks.map(t => ({ id: t.id, sessionId: t.sessionId, workspacePath: taskWorkspace(t), state: t.state, reason: t.reason, outbox: t.outbox.state, sendReason: t.outbox.reason })) }
  }

  /** Await currently owned executions without polling a timer. */
  async whenSettled(): Promise<void> { await Promise.all([...this.workers.values()].map(w => w.done)) }
  /** Cancel one active task; settled or absent tasks are unchanged. */
  cancel(id: string): void { for (const [key, worker] of this.workers) if (key === id) worker.controller.abort(new MailError('user-cancelled')) }
  /** Retry only a definitively failed notification; unknown requires explicit acknowledgement. */
  retryNotification(id: string, acknowledgeUnknown = false): Promise<void> { return this.manage(async () => {
    const task = this.deps.store.tasks().find(t => t.id === id)
    if (!task || !(task.outbox.state === 'failed' || (acknowledgeUnknown && task.outbox.state === 'unknown'))) throw new MailError('notification-not-retryable')
    const operation = acknowledgeUnknown ? 'operator-acknowledged-possible-duplicate' : 'operator-retry-notification'
    await this.deps.store.putTask({ ...task, operations: [...task.operations, { kind: operation, at: this.now() }],
      outbox: { ...task.outbox, state: 'pending', attempts: 0, nextAt: this.now(), reason: operation } })
  }) }
  /** Preview the exact same decision function without writes, task creation or SMTP. */
  async preview(raw: Buffer, account: string): Promise<object> {
    this.assertUsable()
    const result = await this.analyze({ account, receivedAt: this.now(), attempts: 0 }, raw)
    return result.state === 'matched' ? { state: result.state, ruleId: result.rule.id, workspacePath: result.workspacePath,
      permissionPreset: result.rule.task.permissionPreset, replyTo: result.rule.reply.to, prompt: result.prompt } : result
  }
  /** Explicitly convert a held reply into a new independent task after re-verification. */
  releaseReply(id: string): Promise<void> { return this.manage(async () => {
    const record = this.deps.store.inbox().find(r => r.id === id)
    if (!record || record.state !== 'held') throw new MailError('mail-not-held')
    await this.evaluate(record, true)
  }) }
  /** Explicit re-execution gets a new Session and preserves the previous unknown effects. */
  retryTask(id: string): Promise<void> { return this.manage(async () => {
    const task = this.deps.store.tasks().find(t => t.id === id)
    if (!task || !['failed', 'cancelled', 'timed_out', 'needs_attention'].includes(task.state)) throw new MailError('task-not-retryable')
    const nextId = brandString<TaskId>(identity(task.id, 'operator-retry', this.deps.store.tasks().filter(t => t.mailId === task.mailId).length))
    await this.deps.store.putTask({ ...task, id: nextId, state: 'queued', summary: '', reason: '', lastOutput: '', attempt: task.attempt + 1,
      sessionId: `mail-${nextId}`, messageId: `mail-input-${nextId}`, createdAt: this.now(),
      operations: [...task.operations, { kind: `operator-retry-task:${task.id}`, at: this.now() }],
      outbox: { ...task.outbox, state: 'none', messageId: task.outbox.messageId.replace(task.id, nextId), attempts: 0, nextAt: 0, text: '', reason: '' } })
  }) }
  private manage(action: () => Promise<void>): Promise<void> {
    const done = this.administration.then(async () => {
      this.administering = true
      try { if (this.ticking) await this.ticking; this.assertUsable(); await action() } finally { this.administering = false }
    })
    this.administration = done.catch(error => { if (!(error instanceof MailError)) this.block(error) })
    return done
  }
  /** Stop admission and drain executions before dependencies are released. */
  async close(): Promise<void> {
    this.closing = true
    this.controller.abort(new MailError('runtime-stopped'))
    for (const worker of this.workers.values()) worker.controller.abort(new MailError('runtime-stopped'))
    await this.admission
    await this.administration
    await this.ticking
    await this.whenSettled()
  }
}
