// SPDX-License-Identifier: LGPL-3.0-or-later
/** Persistent mail admission, fair task scheduling and independently retried outbox. */
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Config, Rule } from './config.ts'
import { parseMail, matches, systemReason, taskPrompt, replyInput } from './mail.ts'
import { Spool } from './store.ts'
import { canonicalWorkspace, emailWorkspace, taskWorkspace } from './workspace.ts'
import { createOutbox, outboundMessage, renderResult } from './outbound.ts'
import { MailError, type Delivery, type ExecutionResult, type InboxRecord, type Mail, type MailId, type RuntimeDependencies, type RunReport, type TaskId, type TaskRecord, type TerminalState } from './types.ts'

/** Shared decision produced by preview and actual ingestion without persistence. */
type Decision = { state: 'ignored' | 'quarantined' | 'held' | 'verification_pending'; reason: string }
  | { state: 'matched'; reason: string; rule: Rule; mail: Mail; prompt: string; workspacePath: string; parent?: TaskRecord }

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
    const interrupted = new Set(this.deps.store.tasks().filter(task => task.state === 'starting' || task.state === 'running').map(task => task.sessionId))
    for (const task of this.deps.store.tasks()) {
      if (task.continuation && task.state === 'queued' && interrupted.has(task.sessionId)) {
        await this.settle(task, 'needs_attention', 'A previous turn was interrupted. Inspect the original session before continuing.', 'previous-turn-interrupted')
      }
      if (task.receipt?.state === 'sending') await this.updateTask(task.id, current => ({ ...current, receipt: { ...current.receipt!, state: 'unknown', reason: 'restart-during-send' } }))
      if (task.outbox.state === 'sending') await this.updateTask(task.id, current => ({ ...current, outbox: { ...current.outbox, state: 'unknown', reason: 'restart-during-send' } }))
      if (task.state === 'starting' || task.state === 'running') {
        await this.settle(task,
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
      if (this.deps.store.getInbox(id)) return
      if (this.deps.store.inboxCount >= this.config.runtime.maxRecords) throw new MailError('record-capacity-reached', true)
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
      const receipt = this.deps.store.tasks().find(t => t.receipt?.state === 'pending' && t.receipt.nextAt <= this.now())
      const task = this.deps.store.tasks().find(t => t.outbox.state === 'pending' && t.outbox.nextAt <= this.now())
      if (receipt) await this.send(receipt, 'receipt')
      else if (task) await this.send(task)
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
    const linked = (task: TaskRecord, ids: string[]): boolean => task.account === record.account && [task.outbox.messageId, task.receipt?.messageId, task.originalMessageId].some(id => Boolean(id && ids.includes(id)))
    const direct = mail.inReplyTo ? this.deps.store.tasks().filter(task => linked(task, [mail.inReplyTo!])) : []
    const links = direct.length ? direct : this.deps.store.tasks().filter(task => linked(task, mail.references))
    const sessions = new Set(links.map(task => task.sessionId))
    if (sessions.size > 1) return { state: 'held', reason: 'ambiguous-mail-thread' }
    const parent = links.at(-1)
    const rules = this.config.rules.filter(r => r.account === record.account).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    for (const rule of rules) {
      if (!rule.authorization.allowedSenders.some(s => s.toLowerCase() === mail.from)) continue
      if (parent ? rule.id !== parent.rule.id || parent.authorization.sender !== mail.from : !matches(mail, rule) && !mail.references.length) continue
      const policy = this.config.senderPolicies[rule.authorization.policy]
      if (!policy) throw new MailError('sender-policy-removed')
      try { await this.deps.verify(raw, mail, policy, this.controller.signal) } catch (error) {
        if (this.closing) throw new MailError('runtime-closing')
        const retry = error instanceof MailError && error.retryable && record.attempts + 1 < this.config.runtime.maxVerificationAttempts
        return { state: retry ? 'verification_pending' : 'quarantined', reason: error instanceof MailError ? error.code : 'verification-failed' }
      }
      if (mail.references.length > 0 && !parent && !releaseReply) return { state: 'held', reason: 'reply-requires-review' }
      let prompt: string
      let workspacePath: string
      try {
        const input = parent ? replyInput(mail) : mail
        const selected = await emailWorkspace(input, parent ? { ...rule, task: { ...rule.task, workspacePath: taskWorkspace(parent) } } : rule, this.config.runtime.maxTaskBytes)
        if (parent && selected.workspacePath !== taskWorkspace(parent)) throw new MailError('reply-workspace-changed')
        workspacePath = selected.workspacePath
        prompt = taskPrompt(selected.mail, rule, this.config, workspacePath)
      } catch (error) {
        return { state: 'quarantined', reason: error instanceof MailError ? error.code : 'workspace-selection-failed' }
      }
      return { state: 'matched', reason: rule.id, rule, mail, prompt, workspacePath, ...(parent ? { parent } : {}) }
    }
    return { state: 'ignored', reason: 'no-authorized-rule' }
  }

  private async evaluate(record: InboxRecord, releaseReply = false): Promise<void> {
    const decision = await this.analyze(record, await this.spool.read(record.rawHash), releaseReply)
    if (decision.state === 'matched') {
      const { rule, mail, prompt, workspacePath, parent } = decision
      const duplicate = mail.messageId ? this.deps.store.tasks().find(task => task.account === record.account && task.originalMessageId === mail.messageId) : undefined
      if (duplicate && duplicate.mailId !== record.id) {
        await this.deps.store.putInbox({ ...record, state: duplicate.inputHash === record.rawHash ? 'ignored' : 'quarantined', reason: duplicate.inputHash === record.rawHash ? 'duplicate-message' : 'message-id-collision' })
        return
      }
      const id = brandString<TaskId>(identity(record.id, rule.id))
      if (!this.deps.store.getTask(id)) {
        const address = this.config.accounts.find(account => account.id === rule.reply.account)!.address
        const subject = this.replySubject(mail.subject)
        await this.deps.store.putTask({ id, mailId: record.id, account: record.account, rule: structuredClone(rule), createdAt: this.now(), prompt, workspacePath,
          title: parent?.title ?? `[Mail] ${mail.subject.replace(/[\r\n]/g, ' ').slice(0, 160)}`, sessionId: parent?.sessionId ?? `mail-${id}`, messageId: `mail-input-${id}`,
          sequence: parent ? this.deps.store.tasks().filter(task => task.sessionId === parent.sessionId).length : 0, inputHash: record.rawHash, ...(parent ? { continuation: true, ...(parent.origin ? { origin: parent.origin } : {}) } : {}),
          originalMessageId: mail.messageId, references: mail.references.slice(-20), state: 'queued', summary: '', reason: '', attempt: 1, lastOutput: '',
          authorization: { sender: mail.from, policy: structuredClone(this.config.senderPolicies[rule.authorization.policy]!) },
          operations: releaseReply ? [{ kind: 'operator-released-reply', at: this.now() }] : [],
          outbox: createOutbox({ id, address, subject, state: 'none', nextAt: 0 }),
          ...(this.config.notifications.receipts ? { receipt: createOutbox({ id, address, subject, state: 'pending', nextAt: this.now(), kind: 'receipt',
            text: `Task: ${id}\nSession: ${parent?.sessionId ?? `mail-${id}`}\n\nReceived and queued. The final result will follow in this email thread.` }) } : {}) })
      }
    }
    await this.deps.store.putInbox({ ...record, state: decision.state, reason: decision.reason,
      attempts: record.attempts + (decision.state === 'verification_pending' || decision.state === 'quarantined' ? 1 : 0),
      nextAt: decision.state === 'verification_pending' ? this.now() + this.config.runtime.retryDelayMs : 0 })
  }

  private startWorkers(): void {
    const candidates = this.deps.store.tasks().filter(t => t.state === 'queued').sort((a, b) => a.sessionId === b.sessionId && a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence : a.createdAt - b.createdAt)
    const accounts = [...new Set(candidates.map(t => t.account))].sort()
    const pivot = accounts.indexOf(this.lastAccount)
    const ordered = [...accounts.slice(pivot + 1), ...accounts.slice(0, pivot + 1)]
    for (const account of ordered) {
      if (this.closing || this.workers.size >= this.config.runtime.maxConcurrentTasks) return
      const task = candidates.find(t => t.account === account && (!this.deps.executor.ready || this.deps.executor.ready(t)) && ![...this.workers.values()].some(w => w.workspace === taskWorkspace(t)))
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
    await this.updateTask(task.id, current => ({ ...current, state: 'running', report: { startedAt: this.now() } }))
    if (this.closing) { await this.settle(task, 'needs_attention', 'Stopped before execution.', 'runtime-stopped'); return }
    const timer = setTimeout(() => controller.abort(new MailError('task-timeout')), task.rule.task.timeoutMs)
    let result: ExecutionResult
    try {
      result = await this.deps.executor.execute(task, controller.signal)
    } catch (error) {
      if (error instanceof MailError && error.code === 'session-busy' && !controller.signal.aborted && !this.closing) {
        await this.updateTask(task.id, current => ({ ...current, state: 'queued', reason: 'waiting-for-session' }))
        return
      }
      result = { state: 'needs_attention', summary: 'Execution did not complete. Inspect the DSH session before retrying.',
        reason: error instanceof MailError ? error.code : 'execution-unknown' }
    } finally { clearTimeout(timer) }
    const timeout = controller.signal.reason instanceof MailError && controller.signal.reason.code === 'task-timeout'
    const state = timeout ? 'timed_out' : controller.signal.aborted ? 'cancelled' : result.state
    await this.settle(task, state, result.summary, timeout ? 'task-timeout' : result.reason, result.lastOutput ?? '', result.report)
  }

  private async settle(task: TaskRecord, state: TerminalState, summary: string, reason: string, lastOutput = task.lastOutput ?? '', report?: RunReport): Promise<void> {
    const notify = task.rule.reply.on.some(value => value === state)
    await this.updateTask(task.id, current => {
      const { finishedAt: _previousFinish, ...observed } = { ...current.report, ...report }
      const finishedAt = report?.finishedAt ?? (state === 'needs_attention' ? undefined : this.now())
      const settled = { ...current, state, summary, reason, lastOutput, report: { ...observed, ...(finishedAt !== undefined ? { finishedAt } : {}) } }
      const { html: _previousHtml, ...outbox } = current.outbox
      return { ...settled, outbox: { ...outbox, state: notify ? 'pending' : 'none', ...renderResult(settled, this.config.runtime.maxReplyBytes), nextAt: this.now() } }
    })
  }

  private replySubject(subject: string): string { return `Re: ${subject.replace(/^(?:(?:re|回复)\s*[:：]\s*)+/i, '').replace(/[\r\n]/g, ' ').slice(0, 160)}` }

  private async updateTask(id: TaskId, update: (task: TaskRecord) => TaskRecord): Promise<void> {
    try { await this.deps.store.updateTask(id, update) }
    catch (error) { this.block(error); throw error }
  }

  private async send(task: TaskRecord, field: 'outbox' | 'receipt' = 'outbox'): Promise<void> {
    const current = this.config.rules.find(r => r.id === task.rule.id)
    const entry = task[field]!
    if (!current || current.reply.to !== task.rule.reply.to || current.reply.account !== task.rule.reply.account) {
      await this.updateTask(task.id, latest => ({ ...latest, [field]: { ...entry, state: 'failed', reason: 'reply-policy-changed' } })); return
    }
    const sending = { ...entry, state: 'sending' as const, attempts: entry.attempts + 1 }
    await this.updateTask(task.id, latest => ({ ...latest, [field]: sending }))
    this.lastSendAt = this.now()
    let outcome
    try { outcome = await this.deps.send(outboundMessage(task, sending, this.config), this.controller.signal) } catch (error) {
      outcome = { state: 'unknown' as const, reason: error instanceof MailError ? error.code : 'submission-unknown' }
    }
    const retry = outcome.state === 'failed' && outcome.retryable && sending.attempts < this.config.runtime.maxSendAttempts
    const settled = { ...sending, state: retry ? 'pending' as const : outcome.state,
      reason: outcome.state === 'accepted' ? '' : outcome.reason, nextAt: this.now() + this.config.runtime.retryDelayMs * sending.attempts }
    await this.updateTask(task.id, latest => ({ ...latest, [field]: settled }))
  }

  /** Stop catch-up across an explicit notification pause; normal shutdown preserves recovery. */
  async pauseNotifications(): Promise<void> {
    if (this.deps.store.cursor('notification-epoch')) await this.checkpoint('notification-epoch', { validity: 'paused', high: this.now() })
  }

  /** Earliest observation time; persisted so a restart can recover missed turn notifications. */
  async notificationEpoch(): Promise<number> {
    const previous = this.deps.store.cursor('notification-epoch')
    if (previous?.validity === 'turn-v1') return previous.high
    const high = this.now()
    await this.checkpoint('notification-epoch', { validity: 'turn-v1', high })
    return high
  }

  /** Persist one externally created Session turn as a notification, never as executable work. */
  notifySession(input: { sessionId: SessionId; turn: number; title: string; workspacePath?: string; state: TerminalState; lastOutput: string; reason: string; report?: RunReport }): Promise<void> {
    return this.manage(async () => {
      if (!this.config.notifications.enabled) return
      const previous = this.deps.store.tasks().filter(task => task.sessionId === input.sessionId).at(-1)
      const rule = previous ? this.config.rules.find(rule => rule.id === previous.rule.id)
        : this.config.rules.find(rule => rule.id === this.config.notifications.rule) ?? this.config.rules[0]
      if (!rule) throw new MailError('notification-rule-removed')
      const id = brandString<TaskId>(identity('session-notification', input.sessionId, input.turn))
      if (this.deps.store.getTask(id)) return
      if (this.deps.store.taskCount >= this.config.runtime.maxRecords) throw new MailError('record-capacity-reached')
      const task: TaskRecord = { id, mailId: brandString<MailId>(identity('session-notification', input.sessionId, input.turn)), account: rule.account, rule: structuredClone(rule),
        createdAt: this.now(), prompt: '', title: input.title, sessionId: input.sessionId, messageId: `mail-input-${id}`, ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
        originalMessageId: previous?.outbox.messageId ?? null, references: previous ? [...previous.references, ...(previous.originalMessageId ? [previous.originalMessageId] : [])].slice(-20) : [], state: input.state, summary: input.state === 'succeeded' ? '' : 'Inspect this DSH session before continuing.',
        reason: input.reason, attempt: 1, lastOutput: input.lastOutput, ...(input.report ? { report: input.report } : {}), origin: 'session', turn: input.turn,
        authorization: { sender: previous?.authorization.sender ?? rule.reply.to.toLowerCase(), policy: structuredClone(this.config.senderPolicies[rule.authorization.policy]!) }, operations: [],
        outbox: createOutbox({ id, address: this.config.accounts.find(account => account.id === rule.reply.account)!.address,
          subject: `${previous ? 'Re: ' : ''}[DSH] ${input.title.replace(/[\r\n]/g, ' ').slice(0, 160)}`, state: 'pending', nextAt: this.now() }) }
      Object.assign(task.outbox, renderResult(task, this.config.runtime.maxReplyBytes))
      await this.deps.store.putTask(task)
    })
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
      notification: { pending: tasks.filter(t => t.outbox.state === 'pending' || t.receipt?.state === 'pending').length, failed: tasks.filter(t => t.outbox.state === 'failed' || t.receipt?.state === 'failed').length, unknown: tasks.filter(t => t.outbox.state === 'unknown' || t.receipt?.state === 'unknown').length },
      inbox: this.deps.store.inbox().map(r => ({ id: r.id, state: r.state, reason: r.reason })),
      tasks: tasks.map(t => ({ id: t.id, sessionId: t.sessionId, workspacePath: t.workspacePath ?? t.rule.task.workspacePath, state: t.state, reason: t.reason, outbox: t.outbox.state, sendReason: t.outbox.reason, receipt: t.receipt?.state, receiptReason: t.receipt?.reason })) }
  }

  /** Await currently owned executions without polling a timer. */
  async whenSettled(): Promise<void> { await Promise.all([...this.workers.values()].map(w => w.done)) }
  /** Cancel one active task; settled or absent tasks are unchanged. */
  cancel(id: string): void { for (const [key, worker] of this.workers) if (key === id) worker.controller.abort(new MailError('user-cancelled')) }
  /** Retry only a definitively failed notification; unknown requires explicit acknowledgement. */
  retryNotification(id: string, acknowledgeUnknown = false): Promise<void> { return this.manage(async () => {
    const task = this.deps.store.getTask(brandString<TaskId>(id))
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
    const record = this.deps.store.getInbox(brandString<MailId>(id))
    if (!record || record.state !== 'held') throw new MailError('mail-not-held')
    await this.evaluate(record, true)
  }) }
  /** Retry with a new message identity; follow-ups retain their conversation, initial tasks create a new Session. */
  retryTask(id: string): Promise<void> { return this.manage(async () => {
    const task = this.deps.store.getTask(brandString<TaskId>(id))
    if (!task || !['failed', 'cancelled', 'timed_out', 'needs_attention'].includes(task.state)) throw new MailError('task-not-retryable')
    if (task.origin === 'session' && !task.continuation) throw new MailError('notification-has-no-mail-input')
    const nextId = brandString<TaskId>(identity(task.id, 'operator-retry', this.deps.store.tasks().filter(t => t.mailId === task.mailId).length))
    const { receipt: _receipt, report: _report, ...previous } = task
    const { html: _html, ...previousOutbox } = task.outbox
    await this.deps.store.putTask({ ...previous, sequence: task.continuation ? this.deps.store.tasks().filter(value => value.sessionId === task.sessionId).length : 0, id: nextId, state: 'queued', summary: '', reason: '', lastOutput: '', attempt: task.attempt + 1,
      sessionId: task.continuation ? task.sessionId : `mail-${nextId}`, messageId: `mail-input-${nextId}`, createdAt: this.now(),
      operations: [...task.operations, { kind: `operator-retry-task:${task.id}`, at: this.now() }],
      outbox: { ...previousOutbox, state: 'none', messageId: task.outbox.messageId.replace(task.id, nextId), attempts: 0, nextAt: 0, text: '', reason: '' } })
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
