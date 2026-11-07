// SPDX-License-Identifier: LGPL-3.0-or-later
/** Cordis bundle entry: persistent mail conversations and notifications for root DSH Sessions. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config as DomainConfig } from './config.ts'
import { PluginConfig, readSettings, type LiveSettings } from './settings.ts'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { checkConnection as checkAccountConnection, type ConnectionCheck } from './check.ts'
import type { MailStatus } from './ui-types.ts'
import type {} from '@deepseek-ai/dsh-settings'
import { verifySender } from './auth.ts'
import { DshExecutor } from './session.ts'
import { DomainMailStore, Spool } from './store.ts'
import { MailRuntime } from './runtime.ts'
import { Pop3Receiver } from './pop3-receiver.ts'
import { ImapReceiver, smtpSender } from './transports.ts'
import { MailError } from './types.ts'
import { SessionNotifications } from './notifications.ts'
import { canonicalWorkspace } from './workspace.ts'
import type {} from '@deepseek-ai/dsh-commands'

async function resolveSecret(ctx: Context, reference: string): Promise<string> {
  const value = await ctx.credentials.resolve(credentialRef(reference))
  if (!value?.value) throw new MailError('credential-missing')
  return value.value
}

export { PluginConfig as Config } from './settings.ts'
export type { MailSettings, LiveSettings } from './settings.ts'
export { MailRuntime } from './runtime.ts'
export { MailError } from './types.ts'

declare module '@deepseek-ai/cordis' { interface Context { mailAutomation: MailAutomation } }

/** Host service; dependencies remain injected until all owned work has drained. */
export class MailAutomation extends TypertRemoteService {
  static Config = PluginConfig
  static inject = ['agents', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessionTitle', 'workspaceRegistry', 'sessions', 'sessionPersistence', 'tools', 'storageDomain', 'credentials', 'commands']
  private runtime: MailRuntime | undefined
  private resources: AsyncDisposableStack | undefined
  private changes: Promise<void> = Promise.resolve()
  private phase: MailStatus['phase'] = 'paused'
  private readonly shutdown = new AbortController()
  private readonly checks = new Set<Promise<ConnectionCheck>>()
  constructor(ctx: Context, private readonly config: LiveSettings) { super(ctx, 'mailAutomation') }
  protected async [Service.init](): Promise<void> {
    this.registerCommands()
    this.ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, this.ctx.fiber)) })
    this.ctx.on('loader/volatile-update', () => this.reconfigure())
    this.ctx.effect(() => async () => {
      this.shutdown.abort()
      await this.changes
      await Promise.allSettled(this.checks)
      await this.stop()
    }, 'mailAutomation.lifecycle')
    await this.reconfigure()
  }
  private active(): MailRuntime {
    if (!this.runtime) throw new MailError('mail-not-enabled')
    return this.runtime
  }
  private registerCommands(): void {
    const owner = this
    const ctx = owner.ctx
    ctx.commands.register({ name: 'mail-status', description: 'Show mail account, execution and notification status',
      async handler() { return { kind: 'success', text: JSON.stringify(owner.status(), null, 2) } } })
    ctx.commands.register({ name: 'mail-cancel', description: 'Cancel one active mail task',
      async handler({ rawInput }) { owner.active().cancel(rawInput.trim()); return { kind: 'success', text: 'Cancellation requested for the matching active task.' } } })
    ctx.commands.register({ name: 'mail-retry-notification', description: 'Retry a failed notification; append acknowledge-duplicate for an unknown submission',
      async handler({ rawInput }) {
        const [id, acknowledgement] = rawInput.trim().split(/\s+/)
        await owner.active().retryNotification(id ?? '', acknowledgement === 'acknowledge-duplicate')
        return { kind: 'success', text: 'Notification queued. Task execution is unchanged.' }
      } })
    ctx.commands.register({ name: 'mail-dry-run', description: 'Preview an .eml file: mail-dry-run <account> <absolute path>',
      async handler({ rawInput }) {
        const config = readSettings(owner.config)
        const input = rawInput.trim()
        const separator = input.indexOf(' ')
        if (separator < 0) throw new MailError('expected-account-and-eml-path')
        const path = input.slice(separator + 1).trim()
        if (!isAbsolute(path)) throw new MailError('preview-path-must-be-absolute')
        const file = await open(path, 'r')
        let raw: Buffer
        try {
          const metadata = await file.stat()
          if (!metadata.isFile() || metadata.size > config.runtime.maxMessageBytes) throw new MailError('preview-file-too-large-or-not-regular')
          raw = Buffer.alloc(config.runtime.maxMessageBytes + 1)
          let size = 0
          while (size < raw.length) {
            const { bytesRead } = await file.read(raw, size, raw.length - size, size)
            if (!bytesRead) break
            size += bytesRead
          }
          raw = raw.subarray(0, size)
        } finally { await file.close() }
        return { kind: 'success', text: JSON.stringify(await owner.active().preview(raw, input.slice(0, separator)), null, 2) }
      } })
    ctx.commands.register({ name: 'mail-release-reply', description: 'Re-verify a held reply and create an independent task',
      async handler({ rawInput }) { await owner.active().releaseReply(rawInput.trim()); return { kind: 'success', text: 'Reply re-evaluated. Check mail-status for the decision.' } } })
    ctx.commands.register({ name: 'mail-retry-task', description: 'Re-execute a task: <task id> acknowledge-side-effects',
      async handler({ rawInput }) {
        const [id, acknowledgement] = rawInput.trim().split(/\s+/)
        if (acknowledgement !== 'acknowledge-side-effects') throw new MailError('task-retry-requires-side-effect-acknowledgement')
        await owner.active().retryTask(id ?? '')
        return { kind: 'success', text: 'A new execution was queued. Previous session and effects are retained.' }
      } })
  }
  private reconfigure(): Promise<void> {
    this.phase = 'changing'
    this.changes = this.changes.then(async () => {
      const requested = readSettings(this.config)
      if (!requested.enabled || !requested.notifications.enabled) await this.runtime?.pauseNotifications()
      await this.stop()
      if (this.shutdown.signal.aborted) return
      const snapshot = readSettings(this.config)
      if (!snapshot.enabled) { this.phase = 'paused'; return }
      const { enabled: _enabled, ...values } = snapshot
      await this.activate(DomainConfig.parse(values))
      this.phase = 'running'
    }).catch(async error => {
      this.phase = 'error'
      try { await this.stop() } catch (closeError) { this.ctx.logger.error('Mail cleanup failed', closeError) }
      this.ctx.logger.error('Mail configuration could not be activated; inspect the settings and retry', error)
    })
    return this.changes
  }
  private async stop(): Promise<void> {
    const resources = this.resources
    this.resources = undefined
    try { await resources?.disposeAsync() } finally { this.runtime = undefined }
  }
  private async activate(config: DomainConfig): Promise<void> {
    const ctx = this.ctx
    const resources = new AsyncDisposableStack()
    this.resources = resources
    for (const rule of config.rules) {
      if (rule.task.workspacePath !== undefined) rule.task.workspacePath = await canonicalWorkspace(rule.task.workspacePath)
    }
    const spool = new Spool(config.stateDirectory)
    await spool.open(config.runtime.lockStaleMs)
    resources.defer(() => spool.close())
    const store = await DomainMailStore.open(ctx.storageDomain)
    resources.defer(() => store.close())
    const secret = (reference: string): Promise<string> => resolveSecret(ctx, reference)
    const runtime = new MailRuntime(config, spool, { store, executor: new DshExecutor(ctx),
      verify: (raw, mail, policy, signal) => verifySender(raw, mail, policy, signal, config.runtime.connectionTimeoutMs), send: smtpSender(config, secret),
      report: (code, id) => ctx.logger.error(`dsh-mail: ${code}; ${id}; inspect mail-status before resuming`),
    })
    this.runtime = runtime
    resources.defer(() => runtime.close())
    await runtime.initialize()
    if (config.notifications.enabled) {
      const notifications = new SessionNotifications(ctx, runtime)
      resources.defer(() => notifications.close())
      await notifications.start()
    }
    for (const account of config.accounts.filter(a => a.receive)) {
      const receiver = account.receive?.protocol === 'pop3' ? new Pop3Receiver(account, config, runtime, secret) : new ImapReceiver(account, config, runtime, secret)
      resources.defer(() => receiver.close())
      receiver.start()
    }
    const timer = setInterval(() => { void runtime.tick() }, config.runtime.tickIntervalMs)
    resources.defer(() => clearInterval(timer))
    await runtime.tick()
  }
  /** Read health after the latest accepted configuration has finished applying.
   * @returns Connection health without messages, passwords or credential values.
   */
  @Remote
  async getStatus(): Promise<MailStatus> {
    await this.changes
    return { phase: this.phase, health: Object.fromEntries(this.runtime?.health ?? []), defaultAgentPreset: this.ctx.agentPresets.defaultId }
  }
  /** Test saved incoming/SMTP login without reading mail or sending a message.
   * @param accountId Saved account id.
   * @returns A bounded result for each configured protocol.
   */
  @Remote
  async checkConnection(accountId: string): Promise<ConnectionCheck> {
    if (typeof accountId !== 'string') throw new MailError('invalid-account')
    const settings = readSettings(this.config)
    const account = settings.accounts.find(value => value.id === accountId)
    if (!account) throw new MailError('account-not-found')
    const signal = this.ctx.invocation?.signal
    const cancellation = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal
    const task = checkAccountConnection(account, ref => resolveSecret(this.ctx, ref), settings.runtime.connectionTimeoutMs, cancellation)
    this.checks.add(task)
    try { return await task } finally { this.checks.delete(task) }
  }
  /** Host callers can inspect health without exposing stored message bodies. */
  status(): object { return { ...(this.runtime?.status() ?? { health: {} }), phase: this.phase } }
}

export default MailAutomation
