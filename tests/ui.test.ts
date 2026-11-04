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
  constructor() { this.state = { status: 'ready', mode: 'host', value: settingsSchema.parse({ ...configuration('/tmp/mail-ui'), enabled: true }), base: {}, user: {}, revision: 1, writable: true } }
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
function fixture() {
  const scope = new Form()
  const writes: [string, string][] = []
  const api: MailPageApi = {
    async describe(refs) { return { ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])) } },
    async set(ref, value) { writes.push([ref, value]); return { ok: true, value: undefined } },
    async unset(ref) { writes.push([ref, '']); return { ok: true, value: undefined } },
    async getStatus() { return { ok: true, value: { phase: scope.state.value!.enabled ? 'running' : 'paused', health: {} } } },
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
