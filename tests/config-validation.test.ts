// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import { z } from 'zod'
import { Config } from '../src/config.ts'
import { configurationSchema, settingsValueSchema } from '../src/config-schema.ts'
import { PluginConfig, settingsSchema } from '../src/settings.ts'
import { configuration } from './helpers.ts'

function issues(schema: z.ZodType, input: unknown) {
  const result = schema.safeParse(input)
  assert.ok(!result.success)
  return result.error.issues
}

const invalidRelations: { name: string; change: (value: Config) => void; message: string }[] = [
  { name: 'missing incoming account', change: value => { value.rules[0]!.account = 'missing' }, message: 'report: receive account not found' },
  { name: 'missing outgoing account', change: value => { value.rules[0]!.reply.account = 'missing' }, message: 'report: send account not found' },
  { name: 'missing sender policy', change: value => { value.senderPolicies = {} }, message: 'report: sender policy not found' },
  { name: 'missing task template', change: value => { value.templates = {} }, message: 'report: template not found' },
  { name: 'duplicate account id', change: value => { value.accounts.push(structuredClone(value.accounts[0]!)) }, message: 'duplicate accounts id' },
  { name: 'duplicate rule id', change: value => { value.rules.push(structuredClone(value.rules[0]!)) }, message: 'duplicate rules id' },
  { name: 'unknown template variable', change: value => { value.templates.report = '{{notDefined}}' }, message: 'report: unknown template variable' },
  { name: 'reserved extraction name', change: value => { value.rules[0]!.extract.body = { source: 'body', after: 'Task:' } }, message: 'report: reserved extraction field' },
  { name: 'missing notification rule', change: value => { value.notifications.rule = 'missing' }, message: 'notification rule not found' },
  { name: 'notifications without a rule', change: value => { value.rules = []; value.notifications.enabled = true }, message: 'notification rule missing' },
  { name: 'too many IMAP folders', change: value => {
    const receive = value.accounts[0]!.receive!
    assert.equal(receive.protocol, 'imap')
    if (receive.protocol === 'imap') receive.folders = ['INBOX', 'Tasks']
    value.runtime.maxImapConnections = 1
  }, message: 'mailbox folder count exceeds maxImapConnections' },
]

for (const candidate of invalidRelations) {
  test(`shared configuration validation rejects ${candidate.name} across runtime and settings entry points`, () => {
    const value = configuration('/tmp/mail-config-validation')
    candidate.change(value)
    for (const schema of [configurationSchema, Config]) {
      assert.ok(issues(schema, value).some(issue => issue.message === candidate.message && issue.path.length === 0))
    }
    for (const enabled of [false, true]) for (const schema of [settingsValueSchema, settingsSchema]) {
      assert.ok(issues(schema, { ...value, enabled }).some(issue => issue.message === candidate.message && issue.path.length === 0))
    }
  })
}

test('settings retain nested field paths without repeating field validation issues', () => {
  const value = configuration('/tmp/mail-config-validation')
  const receive = value.accounts[0]!.receive!
  assert.ok(receive.protocol === 'imap')
  receive.folders = ['INBOX', 'INBOX']
  const path = ['accounts', 0, 'receive', 'folders']
  for (const schema of [configurationSchema, Config, settingsValueSchema, settingsSchema]) {
    const input = schema === settingsValueSchema || schema === settingsSchema ? { ...value, enabled: false } : value
    const rejected = issues(schema, input)
    assert.equal(rejected.length, 1)
    assert.deepEqual(rejected[0]!.path, path)
    assert.equal(rejected[0]!.message, 'duplicate mailbox folder')
  }
})

test('paused empty settings keep their defaults while enabling requires accounts and rules', () => {
  const paused = settingsValueSchema.parse({ enabled: false })
  assert.equal(paused.stateDirectory, undefined)
  assert.deepEqual(paused.accounts, [])
  assert.deepEqual(paused.rules, [])
  assert.deepEqual(paused.senderPolicies, {})
  assert.deepEqual(paused.templates, {})
  assert.deepEqual(paused.notifications, { enabled: false, receipts: true })
  const hosted = settingsSchema.parse({ enabled: false })
  assert.equal(hosted.stateDirectory, join(homedir(), '.dsh', 'mail'))
  assert.deepEqual(hosted.runtime, paused.runtime)
  assert.equal(settingsValueSchema.safeParse({ enabled: false, notifications: { enabled: true, rule: 'future' } }).success, true)
  const invalid = issues(settingsSchema, { enabled: true })
  assert.ok(invalid.some(issue => issue.path.length === 0 && issue.message === 'Configure an account and a rule before enabling mail'))
  assert.ok(invalid.some(issue => JSON.stringify(issue.path) === '["accounts"]'))
  const value = configuration('/tmp/mail-config-validation')
  value.rules = []
  assert.equal(Config.safeParse(value).success, true)
  assert.equal(settingsSchema.safeParse({ ...value, enabled: false }).success, true)
  assert.equal(settingsSchema.safeParse({ ...value, enabled: true }).success, false)
})

test('configured settings require the same missing values at their existing paths', () => {
  const value = configuration('/tmp/mail-config-validation')
  const { stateDirectory: _directory, ...withoutDirectory } = value
  const missingDirectory = issues(settingsValueSchema, { ...withoutDirectory, enabled: false })
  assert.deepEqual(missingDirectory.map(issue => issue.path), [['stateDirectory']])
  assert.equal(missingDirectory[0]!.code, 'invalid_type')
  assert.equal(missingDirectory[0]!.message, issues(configurationSchema, withoutDirectory)[0]!.message)
  for (const schema of [settingsValueSchema, settingsSchema]) {
    const rejected = issues(schema, { ...value, enabled: false, accounts: [] })
    assert.ok(rejected.some(issue => JSON.stringify(issue.path) === '["accounts"]' && issue.code === 'too_small'))
    assert.ok(rejected.some(issue => issue.message === 'report: receive account not found'))
  }
})

test('Host path validation remains stricter than browser configuration without a second parse', () => {
  const value = configuration('/tmp/mail-config-validation')
  const input = { ...value, enabled: false, stateDirectory: 'relative/state', rules: value.rules.map(rule => ({ ...rule, task: { ...rule.task, workspacePath: 'relative/project' } })) }
  assert.equal(settingsValueSchema.safeParse(input).success, true)
  assert.deepEqual(issues(settingsSchema, input).map(issue => issue.path), [['stateDirectory'], ['rules', 0, 'task', 'workspacePath']])
  const { enabled: _enabled, ...runtime } = input
  assert.equal(configurationSchema.safeParse(runtime).success, true)
  assert.deepEqual(issues(Config, runtime).map(issue => issue.path), [['stateDirectory'], ['rules', 0, 'task', 'workspacePath']])
})

test('Host settings metadata retains shared reference checks and required-value paths', () => {
  const value = configuration('/tmp/mail-config-validation')
  value.templates = {}
  const result = PluginConfig['~standard'].validate({ ...value, enabled: false })
  assert.ok(!('then' in result))
  assert.ok(result.issues?.some(issue => issue.message === 'report: template not found'))
  const account = { ...value.accounts[0]!, receive: { ...value.accounts[0]!.receive!, auth: { user: 'bot', credentialRef: 'MAIL_PASSWORD', password: 'DO_NOT_PERSIST' } } }
  assert.ok(issues(settingsSchema, { ...value, enabled: false, accounts: [account] }).some(issue => JSON.stringify(issue.path) === '["accounts",0,"receive","auth"]'))
})
