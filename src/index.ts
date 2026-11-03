// SPDX-License-Identifier: LGPL-3.0-or-later
/** Cordis bundle entry: persistent mail-triggered Workspace Sessions and result replies. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config } from './config.ts'
import { verifySender } from './auth.ts'
import { DshExecutor } from './session.ts'
import { DomainMailStore, Spool } from './store.ts'
import { MailRuntime } from './runtime.ts'
import { ImapReceiver, smtpSender } from './transports.ts'
import { MailError } from './types.ts'
import { canonicalWorkspace } from './workspace.ts'
import type {} from '@deepseek-ai/dsh-commands'

export { Config } from './config.ts'
export { MailRuntime } from './runtime.ts'
export { MailError } from './types.ts'

declare module '@deepseek-ai/cordis' { interface Context { mailAutomation: MailAutomation } }

/** Host service; dependencies remain injected until all owned work has drained. */
export class MailAutomation extends Service {
  static Config = Config
  static inject = ['agents', 'agentDefaultModel', 'agentPresets', 'permissionPresets', 'sessionTitle', 'workspaceRegistry', 'sessions', 'sessionPersistence', 'tools', 'storageDomain', 'credentials', 'commands']
  private runtime: MailRuntime | undefined
  constructor(ctx: Context, private readonly config: Config) { super(ctx, 'mailAutomation') }
  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const config = structuredClone(this.config)
    for (const rule of config.rules) {
      if (rule.task.workspacePath !== undefined) rule.task.workspacePath = await canonicalWorkspace(rule.task.workspacePath)
    }
    const spool = new Spool(config.stateDirectory)
    await spool.open(config.runtime.lockStaleMs)
    let store: DomainMailStore | undefined
    let runtime: MailRuntime | undefined
    const receivers: ImapReceiver[] = []
    let timer: ReturnType<typeof setInterval> | undefined
    ctx.effect(() => async () => {
      if (timer) clearInterval(timer)
      const failures: unknown[] = []
      for (const action of [() => Promise.all(receivers.map(receiver => receiver.close())), () => runtime?.close(), () => store?.close(), () => spool.close()]) {
        try { await action() } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'Mail shutdown failed; inspect retained state before resuming')
    }, 'mailAutomation.lifecycle')
    store = await DomainMailStore.open(ctx.storageDomain)
    const secret = async (reference: string): Promise<string> => {
      const value = await ctx.credentials.resolve(credentialRef(reference))
      if (!value?.value) throw new MailError('credential-missing')
      return value.value
    }
    runtime = new MailRuntime(config, spool, { store, executor: new DshExecutor(ctx),
      verify: (raw, mail, policy, signal) => verifySender(raw, mail, policy, signal, config.runtime.connectionTimeoutMs), send: smtpSender(config, secret),
      report: (code, id) => ctx.logger.error(`dsh-mail: ${code}; ${id}; inspect mail-status before resuming`),
    })
    this.runtime = runtime
    await runtime.initialize()
    const active = runtime
    ctx.commands.register({ name: 'mail-status', description: 'Show mail account, execution and notification status',
      async handler() { return { kind: 'success', text: JSON.stringify(active.status(), null, 2) } } })
    ctx.commands.register({ name: 'mail-cancel', description: 'Cancel one active mail task',
      async handler({ rawInput }) { active.cancel(rawInput.trim()); return { kind: 'success', text: 'Cancellation requested for the matching active task.' } } })
    ctx.commands.register({ name: 'mail-retry-notification', description: 'Retry a failed notification; append acknowledge-duplicate for an unknown submission',
      async handler({ rawInput }) {
        const [id, acknowledgement] = rawInput.trim().split(/\s+/)
        await active.retryNotification(id ?? '', acknowledgement === 'acknowledge-duplicate')
        return { kind: 'success', text: 'Notification queued. Task execution is unchanged.' }
      } })
    ctx.commands.register({ name: 'mail-dry-run', description: 'Preview an .eml file: mail-dry-run <account> <absolute path>',
      async handler({ rawInput }) {
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
        return { kind: 'success', text: JSON.stringify(await active.preview(raw, input.slice(0, separator)), null, 2) }
      } })
    ctx.commands.register({ name: 'mail-release-reply', description: 'Re-verify a held reply and create an independent task',
      async handler({ rawInput }) { await active.releaseReply(rawInput.trim()); return { kind: 'success', text: 'Reply re-evaluated. Check mail-status for the decision.' } } })
    ctx.commands.register({ name: 'mail-retry-task', description: 'Re-execute a task: <task id> acknowledge-side-effects',
      async handler({ rawInput }) {
        const [id, acknowledgement] = rawInput.trim().split(/\s+/)
        if (acknowledgement !== 'acknowledge-side-effects') throw new MailError('task-retry-requires-side-effect-acknowledgement')
        await active.retryTask(id ?? '')
        return { kind: 'success', text: 'A new execution was queued. Previous session and effects are retained.' }
      } })
    for (const account of config.accounts.filter(a => a.receive)) {
      const receiver = new ImapReceiver(account, config, active, secret)
      receivers.push(receiver)
      receiver.start()
    }
    timer = setInterval(() => { void active.tick() }, config.runtime.tickIntervalMs)
    await active.tick()
  }
  /** Host callers can inspect health without exposing stored message bodies. */
  status(): object { return this.runtime?.status() ?? { initializing: true } }
}

export default MailAutomation
