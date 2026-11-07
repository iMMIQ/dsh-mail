// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { load } from 'js-yaml'
import { readFile } from 'node:fs/promises'
import { PluginConfig, readSettings, settingsSchema } from '../src/settings.ts'
import { configuration } from './helpers.ts'
import { mailServers } from './network.ts'
import { checkConnection } from '../src/check.ts'

test('an installed bundle exposes a paused settings form without a mailbox or password', async () => {
  const rows = load(await readFile('cordis.patch.yml', 'utf8'))
  assert.ok(Array.isArray(rows))
  const options = settingsSchema.parse({ enabled: false })
  const result = PluginConfig['~standard'].validate(options)
  assert.ok(!('then' in result))
  assert.ok(!result.issues)
  assert.ok(JSON.stringify(PluginConfig.toJSON()).includes('volatile'))
  const parsed = PluginConfig(options)
  assert.equal(readSettings(parsed).enabled, false)
  assert.deepEqual(readSettings(parsed).accounts, [])
})

test('settings writes retain domain validation and reject secrets in ordinary configuration', () => {
  for (const input of [
    { enabled: true },
    { ...configuration('/tmp/dsh-mail-settings'), accounts: [{ id: 'work', address: 'invalid', send: { protocol: 'smtp', host: 'localhost', port: 465, tls: 'direct', auth: { user: 'bot', credentialRef: 'MAIL_PASSWORD', password: 'DO_NOT_PERSIST' } } }] },
    { ...configuration('/tmp/dsh-mail-settings'), runtime: { maxReplyBytes: 5 } },
  ]) {
    const result = PluginConfig['~standard'].validate(input)
    assert.ok(!('then' in result))
    assert.ok(result.issues?.length)
  }
})

test('connection checks verify actual TLS login without sending a message', async () => {
  await using resources = new AsyncDisposableStack()
  const servers = await mailServers(resources)
  const account = configuration('/tmp/dsh-mail-check').accounts[0]!
  Object.assign(account.receive!, { host: '127.0.0.1', port: servers.imapPort, ca: servers.ca, auth: { user: 'testuser', credentialRef: 'MAIL_PASSWORD' } })
  Object.assign(account.send!, { host: '127.0.0.1', port: servers.smtpPort, ca: servers.ca, auth: { user: 'testuser', credentialRef: 'MAIL_PASSWORD' } })
  assert.deepEqual(await checkConnection(account, async () => 'testpass', 2_000, new AbortController().signal), { imap: 'ok', smtp: 'ok' })
  assert.deepEqual(await checkConnection(account, async () => 'incorrect', 2_000, new AbortController().signal), { imap: 'failed', smtp: 'failed' })
  assert.equal(servers.received.length, 0)
})


test('shared connection validation rejects URLs, blank logins and private CA keys on Host writes', () => {
  const config = configuration('/tmp/dsh-mail-shared-validation')
  for (const patch of [{ host: 'https://mail.example.com' }, { auth: { user: ' ', credentialRef: 'MAIL_PASSWORD' } }, { ca: '-----BEGIN PRIVATE KEY-----\nnot-a-public-certificate' }]) {
    const account = { ...config.accounts[0]!, receive: { ...config.accounts[0]!.receive!, ...patch } }
    assert.equal(settingsSchema.safeParse({ ...config, accounts: [account], enabled: false }).success, false)
  }
})

test('Host settings retain absolute path checks when using browser-safe schemas', () => {
  const config = configuration('/tmp/dsh-mail-shared-paths')
  assert.equal(settingsSchema.safeParse({ ...config, stateDirectory: 'relative/state', enabled: false }).success, false)
  const rule = { ...config.rules[0]!, task: { ...config.rules[0]!.task, workspacePath: 'relative/project' } }
  assert.equal(settingsSchema.safeParse({ ...config, rules: [rule], enabled: false }).success, false)
})
