// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { MailSettings } from '../src/settings.ts'
import { settingsSchema } from '../src/settings.ts'
import { MailPageController, type MailPageApi } from '../src/client/controller.ts'
import { configuration } from './helpers.ts'

class Form implements ConfigForm<MailSettings> {
  state: ConfigFormSnapshot<MailSettings> & { mode: 'host' }
  listeners = new Set<() => void>()
  writes: unknown[] = []
  refuse = false
  constructor(value = settingsSchema.parse({ ...configuration('/tmp/mail-ui'), enabled: true })) { this.state = { status: 'ready', mode: 'host', value, base: {}, user: {}, revision: 1, writable: true } }
  getSnapshot() { return this.state }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  async set(field: string, value: unknown) { return this.mutate([{ op: 'set', path: [field], value: JSON.parse(JSON.stringify(value)) }]) }
  async unset(_field: string) { return false }
  async mutate(operations: Parameters<ConfigForm<MailSettings>['mutate']>[0], expected?: number) {
    if (this.refuse || expected !== this.state.revision) return false
    const candidate = { ...this.state.value }
    for (const op of operations) { assert.equal(op.path.length, 1); if (op.op === 'set') Object.assign(candidate, { [op.path[0]!]: op.value }) }
    this.writes.push(structuredClone(candidate))
    this.state = { ...this.state, value: settingsSchema.parse(candidate), revision: this.state.revision! + 1 }
    for (const listener of this.listeners) listener()
    return true
  }
}
function fixture(value?: MailSettings, configured = true) {
  const scope = new Form(value)
  const writes: [string, string][] = []
  const saved = new Set(configured ? scope.state.value!.accounts.flatMap(account => [account.receive?.auth.credentialRef, account.send?.auth.credentialRef]) : [])
  const api: MailPageApi = {
    async describe(refs) { return { ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: saved.has(ref), writable: true }])) } },
    async set(ref, value) { saved.add(ref); writes.push([ref, value]); return { ok: true, value: undefined } },
    async unset(ref) { saved.delete(ref); writes.push([ref, '']); return { ok: true, value: undefined } },
    async getStatus() { return { ok: true, value: { phase: scope.state.value!.enabled ? 'running' : 'paused', health: {}, defaultAgentPreset: 'mail-reader' } } },
    async checkConnection() { return { ok: true, value: { imap: 'ok', smtp: 'ok' } } },
  }
  const page = new MailPageController(scope, api)
  return { scope, page, api, writes }
}

test('authorization updates pause mail before writing and resume only after credential success', async () => {
  const { page, scope, writes, api } = fixture()
  try {
    await page.refreshCredentials()
    api.set = async (ref, value) => { assert.equal(scope.state.value!.enabled, false); writes.push([ref, value]); return { ok: true, value: undefined } }
    page.editCredential('MAIL_PASSWORD', 'SYNTHETIC_TEST_CODE')
    await page.save()
    assert.deepEqual(writes, [['MAIL_PASSWORD', 'SYNTHETIC_TEST_CODE']])
    assert.equal(scope.state.value!.enabled, true)
    assert.equal(JSON.stringify(scope.writes).includes('SYNTHETIC_TEST_CODE'), false)
    assert.equal(page.store.getSnapshot().credentials.MAIL_PASSWORD?.text ?? '', '')
    assert.equal(page.store.getSnapshot().toast?.message, 'saved')
  } finally { await page.dispose() }
})

test('a rejected settings write never changes the stored credential', async () => {
  const { page, scope, writes } = fixture()
  try {
    await page.refreshCredentials(); page.editCredential('MAIL_PASSWORD', 'SYNTHETIC_TEST_CODE'); scope.refuse = true
    await page.save()
    assert.equal(writes.length, 0)
    assert.equal(page.store.getSnapshot().failed, true)
  } finally { await page.dispose() }
})

test('a credential failure leaves mail paused, retains the draft and can be retried', async () => {
  const { page, scope, api } = fixture()
  try {
    await page.refreshCredentials(); page.editCredential('MAIL_PASSWORD', 'SYNTHETIC_TEST_CODE')
    const set = api.set; api.set = async () => { throw new Error('Provider unavailable') }
    await page.save()
    assert.equal(scope.state.value!.enabled, false)
    assert.equal(page.store.getSnapshot().toast?.message, 'credentialFailed')
    assert.equal(page.store.getSnapshot().credentials.MAIL_PASSWORD?.text, 'SYNTHETIC_TEST_CODE')
    api.set = set; await page.save()
    assert.equal(scope.state.value!.enabled, true)
    assert.equal(page.store.getSnapshot().toast?.message, 'saved')
  } finally { await page.dispose() }
})

test('a stale form refuses to overwrite another editor or rotate its credential', async () => {
  const { page, scope, writes } = fixture()
  try {
    await page.refreshCredentials(); page.editCredential('MAIL_PASSWORD', 'SYNTHETIC_TEST_CODE')
    scope.state = { ...scope.state, revision: 9 }
    await page.save()
    assert.equal(writes.length, 0)
    assert.equal(scope.writes.length, 0)
    assert.equal(page.store.getSnapshot().toast?.message, 'conflict')
  } finally { await page.dispose() }
})

test('removing a mailbox removes linked rules without deleting credentials from the provider', async () => {
  const { page, writes } = fixture()
  try {
    page.removeAccount()
    assert.equal(page.store.getSnapshot().draft?.accounts.length, 0)
    assert.equal(page.store.getSnapshot().draft?.rules.length, 0)
    assert.equal(writes.length, 0)
  } finally { await page.dispose() }
})

test('discard erases authorization code drafts and restores the saved configuration', async () => {
  const { page } = fixture()
  try {
    await page.refreshCredentials(); page.editCredential('MAIL_PASSWORD', 'SYNTHETIC_TEST_CODE'); page.editAccount('address', 'other@example.com')
    page.discard()
    assert.equal(page.store.getSnapshot().draft?.accounts[0]?.address, 'bot@example.com')
    assert.equal(page.store.getSnapshot().credentials.MAIL_PASSWORD?.text ?? '', '')
    assert.equal(page.store.getSnapshot().dirty, false)
  } finally { await page.dispose() }
})

test('mailbox modes preserve server drafts and independent outgoing credentials', async () => {
  const { page } = fixture()
  try {
    const original = page.store.getSnapshot().draft!.accounts[0]!
    page.editAccount('sharedCredential', 'false')
    const separate = page.store.getSnapshot().draft!.accounts[0]!.send!.auth.credentialRef
    assert.notEqual(separate, original.receive!.auth.credentialRef)
    page.editAccount('receive.port', 'invalid')
    page.editAccount('mode', 'send')
    assert.equal(page.store.getSnapshot().draft!.accounts[0]!.receive, undefined)
    page.editAccount('mode', 'both')
    const restored = page.store.getSnapshot().draft!.accounts[0]!
    assert.deepEqual(restored.receive, original.receive)
    assert.equal(restored.send!.auth.credentialRef, separate)
    assert.equal(page.store.getSnapshot().invalid, false)
    page.editAccount('sharedCredential', 'true')
    assert.equal(page.store.getSnapshot().draft!.accounts[0]!.send!.auth.credentialRef, original.receive!.auth.credentialRef)
  } finally { await page.dispose() }
})

test('a late connection result is discarded after editing the checked account', async () => {
  const { page, api } = fixture()
  try {
    const reply = Promise.withResolvers<Awaited<ReturnType<MailPageApi['checkConnection']>>>()
    api.checkConnection = () => reply.promise
    const checking = page.checkConnection()
    page.editAccount('address', 'other@example.com')
    reply.resolve({ ok: true, value: { imap: 'ok', smtp: 'ok' } })
    await checking
    assert.equal(page.store.getSnapshot().check, undefined)
    assert.equal(page.store.getSnapshot().toast, undefined)
    assert.equal(page.store.getSnapshot().checking, false)
  } finally { await page.dispose() }
})

test('a concurrent edit during credential rotation prevents automatic resume', async () => {
  const { page, scope, api } = fixture()
  try {
    await page.refreshCredentials()
    page.editCredential('MAIL_PASSWORD', 'SYNTHETIC_TEST_CODE')
    api.set = async () => { scope.state = { ...scope.state, revision: scope.state.revision! + 1 }; return { ok: true, value: undefined } }
    await page.save()
    assert.equal(scope.state.value!.enabled, false)
    assert.equal(page.store.getSnapshot().toast?.message, 'conflict')
  } finally { await page.dispose() }
})

async function setup() {
  const result = fixture(settingsSchema.parse({ enabled: false, stateDirectory: '/tmp/mail-ui' }), false)
  await result.page.refresh()
  result.page.editSetup('address', 'bot@company.local')
  result.page.editSetup('server', 'mail.company.local')
  result.page.editSetup('sender', 'owner@company.local')
  await result.page.refreshCredentials()
  const ref = result.page.store.getSnapshot().draft!.accounts[0]!.receive!.auth.credentialRef
  result.page.editCredential(ref, 'SYNTHETIC_TEST_CODE')
  return { ...result, ref }
}

test('basic setup creates one rule using the DSH default and follows the sender for replies', async () => {
  const { page, scope } = await setup()
  try {
    const draft = page.store.getSnapshot().draft!
    assert.equal(scope.writes.length, 0)
    assert.equal(draft.accounts.length, 1)
    assert.equal(draft.rules.length, 1)
    assert.equal(draft.accounts[0]!.receive!.auth.user, 'bot@company.local')
    assert.equal(draft.accounts[0]!.send!.host, 'mail.company.local')
    assert.equal(draft.rules[0]!.task.agentPreset, undefined)
    assert.equal(draft.rules[0]!.task.permissionPreset, 'danger-full-access')
    assert.equal(draft.senderPolicies[draft.rules[0]!.authorization.policy]?.evidence, 'local-signature')
    assert.equal(draft.rules[0]!.reply.to, 'owner@company.local')
    page.editSetup('sender', 'second@company.local')
    assert.equal(page.store.getSnapshot().draft!.rules[0]!.reply.to, 'second@company.local')
    page.editRule('replyTo', 'audit@company.local')
    page.editSetup('sender', 'third@company.local')
    assert.equal(page.store.getSnapshot().draft!.rules[0]!.reply.to, 'audit@company.local')
    assert.equal(page.store.getSnapshot().draft!.rules.length, 1)
    page.editRule('agentPreset', 'custom')
    assert.equal(page.store.getSnapshot().draft!.rules[0]!.task.agentPreset, 'custom')
    page.editRule('agentPreset', '')
    assert.equal(page.store.getSnapshot().draft!.rules[0]!.task.agentPreset, undefined)
    assert.equal(page.store.getSnapshot().invalid, false)
  } finally { await page.dispose() }
})

test('save and enable writes credentials while paused and starts only after login succeeds', async () => {
  const { page, scope, api, writes } = await setup()
  try {
    api.checkConnection = async () => {
      assert.equal(scope.state.value!.enabled, false)
      assert.equal(writes.length, 1)
      assert.equal(page.store.getSnapshot().connecting, true)
      return { ok: true, value: { imap: 'ok', smtp: 'ok' } }
    }
    await page.start()
    assert.equal(scope.state.value!.enabled, true)
    assert.equal(scope.writes.length, 2)
    assert.equal(JSON.stringify(scope.writes).includes('SYNTHETIC_TEST_CODE'), false)
    assert.equal(page.store.getSnapshot().connecting, false)
    assert.equal(page.store.getSnapshot().toast?.message, 'started')
  } finally { await page.dispose() }
})

test('a failed connection keeps the saved setup paused and supports retrying', async () => {
  const { page, scope, api } = await setup()
  try {
    const check = api.checkConnection
    api.checkConnection = async () => ({ ok: true, value: { imap: 'ok', smtp: 'failed' } })
    await page.start()
    assert.equal(scope.state.value!.enabled, false)
    assert.equal(page.store.getSnapshot().check?.smtp, 'failed')
    assert.equal(page.store.getSnapshot().toast?.message, 'checkFailed')
    api.checkConnection = check
    await page.start()
    assert.equal(scope.state.value!.enabled, true)
    assert.equal(page.store.getSnapshot().toast?.message, 'started')
  } finally { await page.dispose() }
})

test('credential failure stops setup before connecting or enabling mail', async () => {
  const { page, scope, api } = await setup()
  let checked = false
  try {
    api.set = async () => { throw new Error('Credential provider unavailable') }
    api.checkConnection = async () => { checked = true; return { ok: true, value: { imap: 'ok', smtp: 'ok' } } }
    await page.start()
    assert.equal(scope.state.value!.enabled, false)
    assert.equal(checked, false)
    assert.equal(page.store.getSnapshot().toast?.message, 'credentialFailed')
  } finally { await page.dispose() }
})

test('an external settings edit during connection checks prevents automatic activation', async () => {
  const { page, scope, api } = await setup()
  try {
    const checking = Promise.withResolvers<void>()
    const reply = Promise.withResolvers<Awaited<ReturnType<MailPageApi['checkConnection']>>>()
    api.checkConnection = () => { checking.resolve(); return reply.promise }
    const starting = page.start()
    await checking.promise
    scope.state = { ...scope.state, revision: scope.state.revision! + 1 }
    reply.resolve({ ok: true, value: { imap: 'ok', smtp: 'ok' } })
    await starting
    assert.equal(scope.state.value!.enabled, false)
    assert.equal(scope.writes.length, 1)
    assert.equal(page.store.getSnapshot().toast?.message, 'conflict')
  } finally { await page.dispose() }
})

test('basic server edits preserve a separately configured SMTP server and existing task options', async () => {
  const { page } = fixture()
  try {
    const original = structuredClone(page.store.getSnapshot().draft!.rules[0]!.task)
    page.setSeparateServers(true)
    page.editAccount('send.host', 'smtp.company.local')
    page.editSetup('server', 'imap.company.local')
    page.editSetup('sender', 'other@company.local')
    assert.equal(page.store.getSnapshot().draft!.accounts[0]!.send!.host, 'smtp.company.local')
    assert.deepEqual(page.store.getSnapshot().draft!.rules[0]!.task, original)
    page.setSeparateServers(false)
    assert.equal(page.store.getSnapshot().draft!.accounts[0]!.send!.host, 'imap.company.local')
  } finally { await page.dispose() }
})

test('connection presets update standard ports while retaining custom ports and reject private CA keys', async () => {
  const { page, scope } = fixture()
  try {
    page.editAccount('send.tls', 'starttls')
    assert.equal(page.store.getSnapshot().draft!.accounts[0]!.send!.port, 587)
    page.editAccount('send.port', '2525')
    page.editAccount('send.tls', 'direct')
    assert.equal(page.store.getSnapshot().draft!.accounts[0]!.send!.port, 2525)
    page.editAccount('receive.ca', '-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----')
    assert.equal(page.store.getSnapshot().invalid, true)
    await page.save()
    assert.equal(scope.writes.length, 0)
  } finally { await page.dispose() }
})


test('selecting a rule shows its sender instead of another rule’s unsaved field', async () => {
  const { page } = await setup()
  try {
    const first = page.store.getSnapshot().ruleId
    page.addRule()
    const second = page.store.getSnapshot().ruleId
    page.editSetup('sender', 'second@company.local')
    assert.equal(page.store.getSnapshot().fields['setup-sender'], 'second@company.local')
    page.selectRule(first)
    assert.equal(page.store.getSnapshot().fields['setup-sender'], undefined)
    assert.equal(page.store.getSnapshot().draft!.rules.find(rule => rule.id === first)!.authorization.allowedSenders[0], 'owner@company.local')
    page.selectRule(second)
    assert.equal(page.store.getSnapshot().draft!.rules.find(rule => rule.id === second)!.authorization.allowedSenders[0], 'second@company.local')
  } finally { await page.dispose() }
})

test('enabling multiple mailboxes stops when any saved connection fails', async () => {
  const { page, scope, api } = await setup()
  try {
    const first = page.store.getSnapshot().accountId
    page.addAccount()
    page.editSetup('address', 'second@company.local')
    page.editSetup('server', 'mail.company.local')
    page.editSetup('sender', 'owner@company.local')
    await page.refreshCredentials()
    const second = page.store.getSnapshot().accountId
    const ref = page.store.getSnapshot().draft!.accounts.find(account => account.id === second)!.receive!.auth.credentialRef
    page.editCredential(ref, 'SYNTHETIC_TEST_CODE')
    const checked: string[] = []
    api.checkConnection = async id => { checked.push(id); return { ok: true, value: { imap: 'ok', smtp: id === second ? 'failed' : 'ok' } } }
    await page.start()
    assert.deepEqual(checked, [first, second])
    assert.equal(scope.state.value!.enabled, false)
    assert.equal(page.store.getSnapshot().checkAccountId, second)
    assert.equal(page.store.getSnapshot().toast?.message, 'checkFailed')
  } finally { await page.dispose() }
})


test('global notifications and exact trusted internal addresses are saved without replacing DKIM', async () => {
  const { page, scope } = await setup()
  try {
    page.setNotifications(true)
    page.editRule('trustedSenders', 'owner@company.local')
    await page.save()
    const current = scope.state.value!
    assert.equal(current.notifications.enabled, true)
    const policy = current.senderPolicies[current.rules[0]!.authorization.policy]!
    assert.equal(policy.evidence, 'local-signature')
    assert.deepEqual(policy.evidence === 'local-signature' && policy.trustedSenders, ['owner@company.local'])
    page.editRule('trustedSenders', '*.company.local')
    assert.equal(page.store.getSnapshot().invalid, true)
  } finally { await page.dispose() }
})
