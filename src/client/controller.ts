// SPDX-License-Identifier: LGPL-3.0-or-later
/** Draft editing and revision-fenced saves; credential writes happen only while mail is paused. */
import { z } from 'zod'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { MailSettings } from '../settings.ts'
import type { Account, Rule } from '../config.ts'
import type { MailStatus } from '../ui-types.ts'
import type { ConnectionCheck } from '../check.ts'

interface CredentialView { configured: boolean; writable: boolean }
interface CredentialDraft extends CredentialView { text: string; remove: boolean; ready: boolean }
type Notice = 'saved' | 'saveFailed' | 'credentialFailed' | 'conflict' | 'checkOk' | 'checkFailed' | 'started' | 'activationFailed'
/** Callbacks supplied by the registration closure; no component receives services. */
export interface MailPageApi {
  describe(refs: string[]): Promise<RemoteResult<Record<string, CredentialView>>>
  set(ref: string, value: string): Promise<RemoteResult<void>>
  unset(ref: string): Promise<RemoteResult<void>>
  getStatus(): Promise<RemoteResult<MailStatus>>
  checkConnection(accountId: string): Promise<RemoteResult<ConnectionCheck>>
}
/** One page snapshot; authorization code text exists only in this local draft. */
export interface MailPageState {
  available: boolean; writable: boolean; dirty: boolean; invalid: boolean; saving: boolean; failed: boolean
  draft: MailSettings | undefined
  accountId: string; ruleId: string
  fields: Record<string, string>
  credentials: Record<string, CredentialDraft>
  status: MailStatus | undefined
  checking: boolean
  connecting: boolean
  separateServers: boolean
  checkAccountId: string
  check: ConnectionCheck | undefined
  toast: { id: number; message: Notice; success: boolean } | undefined
}
/** Framework-injected face of the page and its independent toast host. */
export interface MailPageFace {
  hooks: { mailPage: SnapshotStore<MailPageState> }
  selectAccount(id: string): void; selectRule(id: string): void
  addAccount(): void; removeAccount(): void; addRule(): void; removeRule(): void
  editAccount(field: string, text: string): void; editRule(field: string, text: string): void
  editSetup(field: 'address' | 'server' | 'sender', text: string): void
  setSeparateServers(separate: boolean): void
  editSetting(field: 'maxReplyBytes' | 'maxConcurrentTasks', text: string): void
  editCredential(ref: string, text: string): void; removeCredential(ref: string): void
  setEnabled(enabled: boolean): void
  watchStatus(): () => void
  save(): void; start(): void; discard(): void; checkConnection(): void; refresh(): void; dismissToast(): void
}

function freshId(prefix: string, existing: readonly { id: string }[]): string {
  let index = 1
  while (existing.some(value => value.id === `${prefix}-${index}`)) index++
  return `${prefix}-${index}`
}
function refs(value: MailSettings): string[] {
  return [...new Set(value.accounts.flatMap(account => [account.receive?.auth.credentialRef, account.send?.auth.credentialRef].filter((ref): ref is string => ref !== undefined)))]
}
function valid(value: MailSettings, fields: Record<string, string>): boolean {
  if (Object.entries(fields).some(([key, text]) => /(?:port|maxReplyBytes|maxConcurrentTasks|timeoutMs|maxSteps)$/.test(key) && (!/^\d+$/.test(text) || Number(text) < 1))) return false
  if (value.enabled && (!value.accounts.length || !value.rules.length)) return false
  return value.accounts.every(account => z.email().safeParse(account.address).success && Boolean(account.receive || account.send) && [account.receive, account.send].every(connection => !connection || Boolean(connection.host.trim() && !connection.host.includes('://') && connection.auth.user.trim() && connection.port > 0 && connection.port <= 65535
      && (!connection.ca || connection.ca.includes('-----BEGIN CERTIFICATE-----') && !/-----BEGIN[^\n]*PRIVATE KEY-----/.test(connection.ca)))))
    && value.runtime.maxReplyBytes >= 1024
    && Object.values(value.senderPolicies).every(policy => policy.evidence !== 'trusted-mta' || policy.authservIds.length > 0)
    && value.rules.every(rule => value.accounts.some(account => account.id === rule.account && account.receive) && value.accounts.some(account => account.id === rule.reply.account && account.send) && rule.authorization.allowedSenders.length > 0
      && rule.authorization.allowedSenders.every(address => z.email().safeParse(address).success) && z.email().safeParse(rule.reply.to).success
      && Boolean((rule.task.agentPreset === undefined || rule.task.agentPreset.trim()) && rule.task.permissionPreset.trim()) && Boolean(value.senderPolicies[rule.authorization.policy]) && Boolean(value.templates[rule.task.template]?.trim()))
}
const split = (text: string): string[] => text.split(/[\s,;]+/).filter(Boolean)

function makeAccount(id: string): Account {
  const credentialRef = `DSH_MAIL_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`
  return { id, address: '', receive: { protocol: 'imap', host: '', port: 993, tls: 'direct', auth: { user: '', credentialRef }, folders: ['INBOX'], initialSync: 'new-only', rescanIntervalMs: 60_000, maxMessageAgeMs: 172_800_000 },
    send: { protocol: 'smtp', host: '', port: 465, tls: 'direct', auth: { user: '', credentialRef } } }
}

/** One controller per mounted browser plugin; all operations drain on disposal. */
export class MailPageController {
  readonly store = createSnapshotStore<MailPageState>({ available: false, writable: false, dirty: false, invalid: false, saving: false, failed: false,
    draft: undefined, accountId: '', ruleId: '', fields: {}, credentials: {}, status: undefined, checking: false, connecting: false, separateServers: false, checkAccountId: '', check: undefined, toast: undefined })
  private baseline: number | undefined
  private disposed = false
  private sequence = 0
  private credentialRead = 0
  private statusRead = 0
  private checkRead = 0
  private discardAfterSave = false
  private readonly protocolDrafts = new Map<string, Pick<Account, 'receive' | 'send'>>()
  private statusTimer: ReturnType<typeof setTimeout> | undefined
  private watchers = 0
  private watchGeneration = 0
  private readonly pending = new Set<Promise<void>>()
  private readonly unsubscribe: () => void
  constructor(private readonly scope: ConfigForm<MailSettings>, private readonly api: MailPageApi) {
    this.unsubscribe = scope.subscribe(() => this.accept())
    this.accept()
    this.run(() => this.refresh())
  }
  private state(): MailPageState { return this.store.getSnapshot() }
  private publish(patch: Partial<MailPageState>): void {
    if (this.disposed) return
    const next = { ...this.state(), ...patch }
    next.invalid = next.draft !== undefined && !valid(next.draft, next.fields)
    this.store.set(next)
  }
  private run(action: () => Promise<void>): void {
    if (this.disposed) return
    const task = action().catch(() => { this.notice('saveFailed', false) })
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
  }
  private notice(message: Notice, success: boolean): void { this.publish({ toast: { id: ++this.sequence, message, success } }) }
  private accept(): void {
    const snapshot = this.scope.getSnapshot()
    this.publish({ available: snapshot.status === 'ready', writable: snapshot.writable })
    if (snapshot.status !== 'ready' || !snapshot.value || this.state().dirty || this.state().saving || this.state().connecting) return
    this.baseline = snapshot.revision
    const draft = structuredClone(snapshot.value)
    const account = draft.accounts.find(a => a.id === this.state().accountId) ?? draft.accounts.find(a => a.receive) ?? draft.accounts[0]
    this.publish({ draft, accountId: account?.id ?? '', separateServers: Boolean(account?.receive && account.send && account.receive.host !== account.send.host),
      ruleId: draft.rules.find(r => r.id === this.state().ruleId && r.account === account?.id)?.id ?? draft.rules.find(r => r.account === account?.id)?.id ?? '', fields: {}, failed: false })
    this.run(() => this.refreshCredentials())
  }
  private edit(change: (draft: MailSettings) => void, field?: [string, string]): void {
    if (this.state().saving || this.state().connecting || !this.state().writable || !this.state().draft) return
    const draft = structuredClone(this.state().draft!)
    change(draft)
    this.checkRead++
    this.publish({ draft, dirty: true, failed: false, check: undefined, fields: field ? { ...this.state().fields, [field[0]]: field[1] } : this.state().fields })
  }
  selectAccount(id: string): void {
    const account = this.state().draft?.accounts.find(a => a.id === id)
    this.checkRead++
    this.publish({ accountId: id, check: undefined, separateServers: Boolean(account?.receive && account.send && account.receive.host !== account.send.host),
      ruleId: this.state().draft?.rules.find(rule => rule.account === id)?.id ?? '', fields: Object.fromEntries(Object.entries(this.state().fields).filter(([key]) => key !== 'setup-sender')) })
  }
  selectRule(id: string): void { this.publish({ ruleId: id, fields: Object.fromEntries(Object.entries(this.state().fields).filter(([key]) => key !== 'setup-sender')) }) }
  addAccount(): void {
    const id = freshId('mail', this.state().draft?.accounts ?? [])
    this.edit(draft => { draft.accounts.push(makeAccount(id)) })
    this.selectAccount(id)
    this.run(() => this.refreshCredentials())
  }
  removeAccount(): void {
    const id = this.state().accountId
    this.edit(draft => { draft.accounts = draft.accounts.filter(account => account.id !== id); draft.rules = draft.rules.filter(rule => rule.account !== id && rule.reply.account !== id) })
    const keep = new Set(refs(this.state().draft!))
    this.protocolDrafts.delete(id)
    this.publish({ credentials: Object.fromEntries(Object.entries(this.state().credentials).filter(([ref]) => keep.has(ref))), fields: {} })
    this.selectAccount(this.state().draft?.accounts[0]?.id ?? '')
  }
  private makeRule(draft: MailSettings, account: Account): Rule {
    const id = freshId('rule', [...draft.rules, ...Object.keys(draft.templates).map(id => ({ id }))])
    const policy = Object.keys(draft.senderPolicies).find(key => draft.senderPolicies[key]?.evidence === 'local-signature')
      ?? freshId('signed', Object.keys(draft.senderPolicies).map(id => ({ id })))
    draft.senderPolicies[policy] ??= { evidence: 'local-signature' }
    draft.templates[id] = 'Execute this task in {{workspace}}.\nSubject: {{subject}}\n{{body}}\n{{attachmentText}}'
    const rule: Rule = { id, account: account.id, priority: 0, authorization: { policy, allowedSenders: [] }, match: { subjectPrefix: '[DSH]' }, extract: {},
      task: { permissionPreset: 'danger-full-access', template: id, timeoutMs: 900_000, maxSteps: 40, attachmentTypes: [] },
      reply: { account: draft.accounts.find(a => a.id === account.id && a.send)?.id ?? draft.accounts.find(a => a.send)?.id ?? account.id, to: '', on: ['succeeded', 'failed', 'cancelled', 'timed_out', 'needs_attention'] } }
    draft.rules.push(rule)
    return rule
  }
  addRule(): void {
    let id = ''
    this.edit(draft => { const account = draft.accounts.find(a => a.id === this.state().accountId) ?? draft.accounts[0]; if (account) id = this.makeRule(draft, account).id })
    if (id) this.selectRule(id)
  }
  /** Fill the common mailbox and sender fields without requiring manual rule construction. */
  editSetup(field: 'address' | 'server' | 'sender', text: string): void {
    let accountId = this.state().accountId
    let ruleId = this.state().ruleId
    let created = false
    this.edit(draft => {
      let account = draft.accounts.find(a => a.id === accountId)
      if (!account) { account = makeAccount(freshId('mail', draft.accounts)); draft.accounts.push(account); accountId = account.id; created = true }
      const rule = account.receive ? draft.rules.find(r => r.id === ruleId && r.account === accountId) ?? draft.rules.find(r => r.account === accountId) ?? this.makeRule(draft, account) : undefined
      ruleId = rule?.id ?? ''
      if (field === 'address') { for (const connection of [account.receive, account.send]) if (connection && (!connection.auth.user || connection.auth.user === account.address)) connection.auth.user = text; account.address = text }
      if (field === 'server') { const connection = account.receive ?? account.send; if (connection) connection.host = text; if (!this.state().separateServers && account.send) account.send.host = text }
      if (field === 'sender' && rule) {
        const previous = rule.authorization.allowedSenders[0]
        rule.authorization.allowedSenders = split(text)
        if (!rule.reply.to || rule.reply.to === previous) rule.reply.to = rule.authorization.allowedSenders[0] ?? ''
      }
    })
    if (accountId !== this.state().accountId) this.selectAccount(accountId)
    const reset = field === 'sender' ? [`rule.${ruleId}.allowedSenders`, `rule.${ruleId}.replyTo`]
      : field === 'address' ? [`account.${accountId}.address`, `account.${accountId}.receive.user`, `account.${accountId}.send.user`]
        : [`account.${accountId}.receive.host`, `account.${accountId}.send.host`]
    const fields = Object.fromEntries(Object.entries(this.state().fields).filter(([key]) => !reset.includes(key)))
    this.publish({ ruleId, fields: field === 'sender' ? { ...fields, 'setup-sender': text } : fields })
    if (created) this.run(() => this.refreshCredentials())
  }
  setSeparateServers(separate: boolean): void {
    if (!separate) this.edit(draft => { const account = draft.accounts.find(a => a.id === this.state().accountId); if (account?.receive && account.send) account.send.host = account.receive.host })
    this.publish({ separateServers: separate })
  }
  removeRule(): void { const id = this.state().ruleId; this.edit(draft => { draft.rules = draft.rules.filter(rule => rule.id !== id) }); this.publish({ fields: {} }); this.selectRule(this.state().draft?.rules.find(rule => rule.account === this.state().accountId)?.id ?? '') }
  editAccount(field: string, text: string): void {
    const id = this.state().accountId
    let resetPort = false
    this.edit(draft => {
      const account = draft.accounts.find(value => value.id === id)
      if (!account) return
      if (field === 'address') { for (const connection of [account.receive, account.send]) if (connection && (!connection.auth.user || connection.auth.user === account.address)) connection.auth.user = text; account.address = text; return }
      if (field === 'mode') {
        const cached = this.protocolDrafts.get(id) ?? {}
        if (account.receive) cached.receive = account.receive
        if (account.send) cached.send = account.send
        this.protocolDrafts.set(id, cached)
        const credentialRef = account.receive?.auth.credentialRef ?? account.send?.auth.credentialRef ?? `DSH_MAIL_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`
        if (text === 'send') delete account.receive
        else account.receive ??= cached.receive ?? { protocol: 'imap', host: '', port: 993, tls: 'direct', auth: { user: account.address, credentialRef }, folders: ['INBOX'], initialSync: 'new-only', rescanIntervalMs: 60_000, maxMessageAgeMs: 172_800_000 }
        if (text === 'receive') delete account.send
        else account.send ??= cached.send ?? { protocol: 'smtp', host: '', port: 465, tls: 'direct', auth: { user: account.address, credentialRef } }
        return
      }
      if (field === 'sharedCredential' && account.receive && account.send) {
        account.send.auth.credentialRef = text === 'true' ? account.receive.auth.credentialRef : `DSH_MAIL_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`
        return
      }
      const [side, key] = field.split('.')
      const connection = side === 'receive' ? account.receive : side === 'send' ? account.send : undefined
      if (!connection) return
      if (key === 'host') connection.host = text
      if (key === 'user') connection.auth.user = text
      if (key === 'port' && /^\d+$/.test(text)) connection.port = Number(text)
      if (key === 'tls' && (text === 'direct' || text === 'starttls')) {
        const direct = side === 'receive' ? 993 : 465
        const starttls = side === 'receive' ? 143 : 587
        if (connection.port === direct || connection.port === starttls) { connection.port = text === 'direct' ? direct : starttls; resetPort = true }
        connection.tls = text
      }
      if (key === 'ca') { if (text.trim()) connection.ca = text; else delete connection.ca }
      if (key === 'folders' && side === 'receive' && account.receive) account.receive.folders = split(text)
    }, [`account.${id}.${field}`, text])
    if (field === 'mode') this.publish({ fields: Object.fromEntries(Object.entries(this.state().fields).filter(([key]) => !key.startsWith(`account.${id}.`))) })
    if (resetPort) this.publish({ fields: Object.fromEntries(Object.entries(this.state().fields).filter(([key]) => key !== `account.${id}.${field.split('.')[0]}.port`)) })
    if (field === 'mode' || field === 'sharedCredential') this.run(() => this.refreshCredentials())
  }
  editRule(field: string, text: string): void {
    const id = this.state().ruleId
    this.edit(draft => {
      const rule = draft.rules.find(value => value.id === id)
      if (!rule) return
      if (field === 'account') rule.account = text
      else if (field === 'replyAccount') rule.reply.account = text
      else if (field === 'replyTo') rule.reply.to = text
      else if (field === 'allowedSenders') rule.authorization.allowedSenders = split(text)
      else if (field === 'subjectPrefix' || field === 'subjectContains' || field === 'bodyContains') { if (text) rule.match[field] = text; else delete rule.match[field] }
      else if (field === 'agentPreset') { if (text.trim()) rule.task.agentPreset = text; else delete rule.task.agentPreset }
      else if (field === 'permissionPreset') rule.task.permissionPreset = text
      else if (field === 'timeoutMs' && /^\d+$/.test(text)) rule.task.timeoutMs = Number(text)
      else if (field === 'maxSteps' && /^\d+$/.test(text)) rule.task.maxSteps = Number(text)
      else if (field === 'template') draft.templates[rule.task.template] = text
      else if (field === 'attachments') rule.task.attachmentTypes = text === 'true' ? ['text/plain', 'text/csv', 'application/json'] : []
      else if (field === 'policy') rule.authorization.policy = text
      else if (field === 'evidence') draft.senderPolicies[rule.authorization.policy] = text === 'trusted-mta'
        ? { evidence: 'trusted-mta', authservIds: [], stripsUntrustedHeaders: true } : { evidence: 'local-signature' }
      else if (field === 'authservIds') { const policy = draft.senderPolicies[rule.authorization.policy]; if (policy?.evidence === 'trusted-mta') policy.authservIds = split(text) }
    }, [`rule.${id}.${field}`, text])
    if (field === 'account') { this.selectAccount(text); this.selectRule(id) }
  }
  editSetting(field: 'maxReplyBytes' | 'maxConcurrentTasks', text: string): void {
    this.edit(draft => { if (/^\d+$/.test(text)) draft.runtime[field] = Number(text) }, [field, text])
  }
  setEnabled(enabled: boolean): void { this.edit(draft => { draft.enabled = enabled }) }
  editCredential(ref: string, text: string): void {
    const current = this.state().credentials[ref]
    if (!current?.ready || !current.writable || this.state().saving || this.state().connecting) return
    this.publish({ credentials: { ...this.state().credentials, [ref]: { ...current, text, remove: false } }, dirty: true, failed: false })
  }
  removeCredential(ref: string): void {
    const current = this.state().credentials[ref]
    if (!current?.ready || !current.writable || this.state().saving || this.state().connecting) return
    this.publish({ credentials: { ...this.state().credentials, [ref]: { ...current, text: '', remove: !current.remove } }, dirty: true, failed: false })
  }
  async refreshCredentials(): Promise<void> {
    if (this.disposed) return
    const draft = this.state().draft
    if (!draft) return
    const generation = ++this.credentialRead
    const requested = refs(draft)
    try {
      const answers = await Promise.all(Array.from({ length: Math.ceil(requested.length / 64) }, (_, index) => this.api.describe(requested.slice(index * 64, index * 64 + 64))))
      if (this.disposed || generation !== this.credentialRead) return
      const credentials = { ...this.state().credentials }
      for (const answer of answers) {
        if (!answer.ok) throw new Error('Credential state unavailable')
        for (const [ref, info] of Object.entries(answer.value)) credentials[ref] = { text: '', remove: false, ...credentials[ref], configured: info.configured, writable: info.writable, ready: true }
      }
      this.publish({ credentials })
    } catch (_error) {
      if (generation !== this.credentialRead) return
      this.publish({ credentials: Object.fromEntries(requested.map(ref => [ref, { ...this.state().credentials[ref], text: this.state().credentials[ref]?.text ?? '', remove: false, configured: false, writable: false, ready: false }])) })
    }
  }
  async refresh(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.statusRead
    try {
      const answer = await this.api.getStatus()
      if (generation !== this.statusRead) return
      this.publish({ status: answer.ok ? answer.value : { phase: 'error', health: {} } })
    }
    catch (_error) { if (generation === this.statusRead) this.publish({ status: { phase: 'error', health: {} } }) }
  }
  /** Poll only while a configuration page is visible, using the configured runtime cadence. */
  watchStatus(): () => void {
    this.watchers++
    const generation = this.watchers === 1 ? ++this.watchGeneration : this.watchGeneration
    const tick = (): void => {
      if (this.disposed || !this.watchers || generation !== this.watchGeneration) return
      this.run(async () => {
        await this.refresh()
        const interval = this.scope.getSnapshot().value?.runtime.tickIntervalMs
        if (!this.disposed && this.watchers && generation === this.watchGeneration && interval !== undefined) this.statusTimer = setTimeout(tick, interval)
      })
    }
    if (this.watchers === 1) tick()
    let stopped = false
    return () => { if (stopped) return; stopped = true; this.watchers--; if (!this.watchers) { this.watchGeneration++; clearTimeout(this.statusTimer); this.statusTimer = undefined } }
  }
  discard(): void {
    if (this.state().saving) { this.discardAfterSave = true; this.publish({ credentials: {} }); return }
    this.publish({ dirty: false, fields: {}, credentials: {}, check: undefined, failed: false })
    this.protocolDrafts.clear()
    this.accept()
  }
  async save(): Promise<void> {
    const state = this.state()
    if (!state.draft || state.saving || state.invalid || !state.writable || !state.dirty || this.disposed) return
    if (this.scope.getSnapshot().revision !== this.baseline) { this.publish({ failed: true }); this.notice('conflict', false); return }
    const wanted = structuredClone(state.draft)
    const credentialEdits = Object.entries(state.credentials).filter(([ref, value]) => refs(wanted).includes(ref) && (value.text || value.remove))
    this.publish({ saving: true, failed: false })
    let notice: Notice = 'saveFailed'
    try {
      const candidate = { ...wanted, enabled: credentialEdits.length ? false : wanted.enabled }
      const operations = Object.entries(candidate).map(([key, value]) => ({ op: 'set' as const, path: [key], value: z.json().parse(value) }))
      if (!await this.scope.mutate(operations, this.baseline)) throw new Error('Configuration refused')
      const committedRevision = this.scope.getSnapshot().revision
      this.baseline = committedRevision
      if (this.disposed) return
      if (credentialEdits.length) {
        const paused = await this.api.getStatus()
        if (this.disposed) return
        if (!paused.ok || paused.value.phase !== 'paused') throw new Error('Runtime did not stop')
        notice = 'credentialFailed'
        for (const [ref, edit] of credentialEdits) {
          const result = edit.remove ? await this.api.unset(ref) : await this.api.set(ref, edit.text)
          if (!result.ok) throw new Error('Credential write refused')
          if (this.disposed) return
        }
        if (wanted.enabled) {
          notice = 'conflict'
          if (!await this.scope.mutate([{ op: 'set', path: ['enabled'], value: true }], committedRevision)) throw new Error('Configuration changed')
        }
      }
      this.publish({ dirty: false, fields: {}, credentials: {} })
      if (!this.state().connecting) this.notice('saved', true)
    } catch (_error) { this.publish({ failed: true }); this.notice(notice, false) }
    finally {
      this.publish({ saving: false })
      if (this.discardAfterSave) { this.discardAfterSave = false; this.discard() }
      if (!this.state().dirty) this.accept()
      await this.refresh()
    }
  }
  /** Save while paused, verify every saved mailbox, then enable with the accepted revision. */
  async start(): Promise<void> {
    const state = this.state()
    if (this.disposed || state.connecting || state.saving || state.checking || state.invalid || !state.writable || !state.draft?.accounts.length || !state.draft.rules.length) return
    this.publish({ connecting: true, draft: { ...state.draft, enabled: false }, dirty: true, check: undefined })
    try {
      await this.save()
      if (this.disposed || this.state().failed || this.state().dirty) return
      if (this.state().status?.phase !== 'paused') { this.notice('activationFailed', false); return }
      this.publish({ checking: true })
      const generation = ++this.checkRead
      for (const account of this.state().draft!.accounts) {
        if (this.scope.getSnapshot().revision !== this.baseline) { this.publish({ failed: true }); this.notice('conflict', false); return }
        this.publish({ checkAccountId: account.id, check: undefined })
        const answer = await this.api.checkConnection(account.id)
        if (this.disposed || generation !== this.checkRead) return
        if (this.scope.getSnapshot().revision !== this.baseline) { this.publish({ failed: true }); this.notice('conflict', false); return }
        if (!answer.ok) throw new Error('Connection check refused')
        this.publish({ check: answer.value })
        if (answer.value.imap === 'failed' || answer.value.smtp === 'failed') { this.notice('checkFailed', false); return }
      }
      this.publish({ checking: false, draft: { ...this.state().draft!, enabled: true }, dirty: true })
      await this.save()
      if (!this.disposed && !this.state().dirty && !this.state().failed) this.notice(this.state().status?.phase === 'running' ? 'started' : 'activationFailed', this.state().status?.phase === 'running')
    } catch (_error) { this.notice('checkFailed', false) }
    finally { this.publish({ checking: false, connecting: false }); if (!this.state().dirty) this.accept() }
  }
  async checkConnection(): Promise<void> {
    if (this.state().checking || this.state().connecting || this.state().dirty || !this.state().accountId) return
    this.publish({ checking: true, check: undefined, checkAccountId: this.state().accountId })
    const generation = ++this.checkRead
    try {
      const account = this.state().accountId
      const result = await this.api.checkConnection(account)
      if (this.disposed || generation !== this.checkRead) return
      if (!result.ok) throw new Error('Check failed')
      if (this.state().accountId === account) this.publish({ check: result.value })
      this.notice(result.value.imap !== 'failed' && result.value.smtp !== 'failed' ? 'checkOk' : 'checkFailed', result.value.imap !== 'failed' && result.value.smtp !== 'failed')
    } catch (_error) { if (!this.disposed && generation === this.checkRead) this.notice('checkFailed', false) }
    finally { this.publish({ checking: false }) }
  }
  /** Bind callbacks and the one stable source used by framework-made hooks. */
  face(): MailPageFace {
    return { hooks: { mailPage: this.store }, selectAccount: id => this.selectAccount(id), selectRule: id => this.selectRule(id),
      addAccount: () => this.addAccount(), removeAccount: () => this.removeAccount(), addRule: () => this.addRule(), removeRule: () => this.removeRule(),
      editSetup: (field, text) => this.editSetup(field, text), setSeparateServers: separate => this.setSeparateServers(separate),
      editAccount: (field, text) => this.editAccount(field, text), editRule: (field, text) => this.editRule(field, text), editSetting: (field, text) => this.editSetting(field, text),
      editCredential: (ref, text) => this.editCredential(ref, text), removeCredential: ref => this.removeCredential(ref), setEnabled: enabled => this.setEnabled(enabled),
      save: () => this.run(() => this.save()), start: () => this.run(() => this.start()), discard: () => this.discard(), checkConnection: () => this.run(() => this.checkConnection()), refresh: () => this.run(async () => { await Promise.all([this.refresh(), this.refreshCredentials()]) }), watchStatus: () => this.watchStatus(),
      dismissToast: () => this.publish({ toast: undefined }) }
  }
  /** Stop subscriptions, erase authorization drafts, and drain admitted writes. */
  async dispose(): Promise<void> { this.disposed = true; clearTimeout(this.statusTimer); this.protocolDrafts.clear(); this.unsubscribe(); this.store.set({ ...this.state(), credentials: {}, draft: undefined }); await Promise.allSettled(this.pending) }
}
