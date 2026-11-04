// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dump } from 'js-yaml'
import { z } from 'zod'
import { parseMail } from '../src/mail.ts'
import { Config } from '../src/config.ts'
import { configuration, message } from './helpers.ts'
import { mailServers, waitFor } from './network.ts'

const host = z.object({ version: z.string(), dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(await readFile(resolve('node_modules/@deepseek-ai/dsh/package.json'), 'utf8')))

async function profileScenario(scenario: 'success' | 'text-only' | 'empty-result' | 'model-error' | 'reconfigure'): Promise<void> {
  const success = scenario === 'success' || scenario === 'reconfigure'
  await using resources = new AsyncDisposableStack()
  const root = await mkdtemp(join(tmpdir(), 'dsh-mail-profile-'))
  resources.defer(() => rm(root, { recursive: true, force: true }))
  const servers = await mailServers(resources)
  let child: ChildProcess | undefined
  let exit: Promise<void> | undefined
  let exited = false
  // Stop the profile before closing its mail servers and deleting its data.
  resources.defer(async () => {
    if (!child || !exit) return
    if (!exited) child.kill('SIGTERM')
    const timeout = new AbortController()
    try {
      await Promise.race([exit, delay(10_000, undefined, { signal: timeout.signal }).then(() => { throw new Error('dsh did not stop after SIGTERM') })])
    } catch (error) { child.kill('SIGKILL'); await exit; throw error } finally { timeout.abort() }
  })
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'mail-test')
  await mkdir(profile, { recursive: true })
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await symlink(resolve('node_modules/@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'), 'dir')
  await symlink(resolve('.'), join(profile, 'node_modules/dsh-mail'), 'dir')
  const names = ['session-projection', 'session', 'llm', 'tools', 'system-prompt', 'tool-executor-native', 'agent', 'agent-loop',
    'agent-default-model', 'storage', 'storage-sqlite', 'storage-domain', 'session-persistence-jsonl', 'workspace', 'session-title',
    'shell', 'user-approval', 'permission-presets', 'agent-preset-registry', 'agent-preset', 'credentials-local', 'commands']
  if (scenario === 'reconfigure') names.push('hmr')
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-mail-test-profile', private: true, type: 'module',
    dependencies: { ...Object.fromEntries(names.map(name => [`@deepseek-ai/dsh-${name}`, host.version])), '@deepseek-ai/cordis-plugin-timer': host.dependencies['@deepseek-ai/cordis-plugin-timer'], 'dsh-mail': `file:${resolve('.')}` }, dsh: { profile: { bundles: ['dsh-mail'] } } }))
  const original = configuration(join(root, 'spool'))
  const { workspacePath: _oldWorkspace, permissionPreset: _oldPermissions, ...emailTask } = original.rules[0]!.task
  const config = Config.parse({ ...original, rules: [{ ...original.rules[0]!, task: emailTask }] })
  const emailDirectory = join(root, 'email-workspace')
  await mkdir(emailDirectory)
  config.runtime.tickIntervalMs = 20
  Object.assign(config.accounts[0]!.receive!, { host: '127.0.0.1', port: servers.imapPort, ca: servers.ca, rescanIntervalMs: 50, auth: { user: 'testuser', credentialRef: 'MAIL_PASSWORD' } })
  Object.assign(config.accounts[0]!.send!, { host: '127.0.0.1', port: servers.smtpPort, ca: servers.ca, auth: { user: 'testuser', credentialRef: 'MAIL_PASSWORD' } })
  const configs: Record<string, object> = {
    hmr: { root: [] },
    'system-prompt': { personaPrefix: 'Execute the mail task using the available tools.' },
    'agent-loop': { agents: [] },
    'agent-default-model': { provider: 'mail-fixture', model: 'fixture' },
    'storage-sqlite': { path: join(root, 'state.sqlite') }, 'storage-domain': { backend: 'sqlite' },
    'session-persistence-jsonl': { root: join(root, 'sessions'), compression: 'none' },
    'session-title': { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 200 },
    'user-approval': { policy: 'never' },
    'permission-presets': { presets: { restricted: { sandbox: 'read-only', approval: 'never' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } }, defaultPreset: 'restricted' },
    'agent-preset-registry': { default: 'mail-reader' }, 'agent-preset': { id: 'mail-reader', plugins: [] },
    'credentials-local': { path: join(root, 'credentials.yaml'), watch: false },
  }
  const rows = names.map(name => ({ id: name, name: name === 'shell' ? resolve('tests/fixtures/denied-shell.mjs') : `@deepseek-ai/dsh-${name}`, ...(configs[name] ? { config: configs[name] } : {}) }))
  if (scenario === 'reconfigure') rows.unshift({ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' })
  const patches = [{ insert: [...rows,
    { id: 'fixture', name: resolve('tests/fixtures/driver.mjs'), config: { root, scenario } },
  ] }, { id: 'mail-automation', disabled: false, config }]
  await writeFile(join(profile, 'cordis.patch.yml'), dump(patches, { noRefs: true }))
  const node = Bun.which('node')
  if (!node) throw new Error('DSH requires a Node.js host; install Node.js >= 24.9')
  child = spawn(node, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'mail-test'],
    { cwd: resolve('.'), env: { ...process.env, DSH_HOME: home, MAIL_PASSWORD: 'testpass' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout!.on('data', chunk => { output += String(chunk) })
  child.stderr!.on('data', chunk => { output += String(chunk) })
  exit = new Promise<void>(resolveExit => child!.once('exit', () => { exited = true; resolveExit() }))
  await waitFor(() => {
    if (exited) throw new Error(`dsh exited before ready:\n${output}`)
    return output.includes('DSH_MAIL_READY')
  }, () => `dsh ready; ${output}`)
  servers.imap.appendMessage('INBOX', [], new Date(), message('[DSH] create evidence', `---\nworkspace: ${JSON.stringify(emailDirectory)}\n---\nWrite the evidence file, then report success.`).toString())
  await waitFor(() => servers.received.length === 1, () => `result mail; ${output}`)
  const response = await parseMail(servers.received[0]!, config.runtime)
  const readResult = async (path: string): Promise<string> => {
    try { return await readFile(path, 'utf8') }
    catch (error) { throw new Error(`Missing fixture output ${path}\nReply: ${response.body}\nDSH: ${output}`, { cause: error }) }
  }
  if (success || scenario === 'model-error') assert.equal(await readResult(join(emailDirectory, 'evidence.txt')), 'created by a real DSH tool call\n')
  else await assert.rejects(readFile(join(emailDirectory, 'evidence.txt'), 'utf8'), { code: 'ENOENT' })
  await assert.rejects(readFile(join(root, 'evidence.txt'), 'utf8'), { code: 'ENOENT' })
  const requests = z.array(z.object({ tools: z.array(z.string()), roles: z.array(z.string()) })).parse(JSON.parse(await readResult(join(root, 'requests.json'))))
  assert.equal(requests.length, success ? 3 : scenario === 'model-error' ? 2 : 1)
  assert.deepEqual(requests[0]!.tools, ['fixture_write', 'mail_task_result'])
  const logs = await readdir(join(root, 'sessions'), { recursive: true })
  const file = logs.find(name => /(?:^|[/\\])session\.v\d+\.jsonl$/.test(name))
  assert.ok(file)
  const events: unknown[] = (await readFile(join(root, 'sessions', file), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const userSchema = z.object({ type: z.literal('user/message'), data: z.object({ source: z.object({ kind: z.literal('dsh-mail') }), content: z.array(z.object({ type: z.literal('text'), text: z.string() })) }) })
  const callSchema = z.object({ type: z.literal('tool/call'), data: z.object({ name: z.string(), arguments: z.string() }) })
  const endSchema = z.object({ type: z.literal('turn/end'), data: z.object({ reason: z.object({ kind: z.string() }) }) })
  const users = events.flatMap(event => { const result = userSchema.safeParse(event); return result.success ? [result.data] : [] })
  const calls = events.flatMap(event => { const result = callSchema.safeParse(event); return result.success ? [result.data.data] : [] })
  const ends = events.flatMap(event => { const result = endSchema.safeParse(event); return result.success ? [result.data.data.reason.kind] : [] })
  const permissionSchema = z.object({ type: z.literal('permission/preset'), data: z.object({ preset: z.string() }) })
  const sandboxSchema = z.object({ type: z.literal('sandbox/mode'), data: z.object({ mode: z.string() }) })
  const approvalSchema = z.object({ type: z.literal('approval/policy'), data: z.object({ policy: z.string() }) })
  const permissions = {
    preset: events.flatMap(event => { const parsed = permissionSchema.safeParse(event); return parsed.success ? [parsed.data.data.preset] : [] }).at(-1),
    sandbox: events.flatMap(event => { const parsed = sandboxSchema.safeParse(event); return parsed.success ? [parsed.data.data.mode] : [] }).at(-1),
    approval: events.flatMap(event => { const parsed = approvalSchema.safeParse(event); return parsed.success ? [parsed.data.data.policy] : [] }).at(-1),
  }
  assert.equal(users.length, 1)
  assert.equal(z.object({ cwd: z.string() }).parse(events[0]).cwd, emailDirectory)
  const actual = { input: users[0]!.data.content.map(part => part.text).join('').replace(emailDirectory, '{{workspace}}'), calls, turnEnds: ends, permissions,
    reply: response.body.replace(/Task: [a-f0-9]{64}/, 'Task: {{taskId}}').replace(/Session: mail-[a-f0-9]{64}/, 'Session: {{sessionId}}').replace(emailDirectory, '{{workspace}}').trim() }
  const snapshots = { success: 'mail-turn', 'text-only': 'mail-text-result', 'empty-result': 'mail-missing-result', 'model-error': 'mail-error', reconfigure: 'mail-turn' }
  const expected: unknown = JSON.parse(await readFile(resolve(`tests/snapshots/${snapshots[scenario]}.json`), 'utf8'))
  assert.deepEqual(actual, expected)
  assert.doesNotMatch(response.body, /PRIVATE_FIXTURE_REASONING/)
  if (scenario === 'reconfigure') {
    const status = async () => z.object({ phase: z.string(), health: z.record(z.string(), z.string()), tasks: z.array(z.object({ state: z.string() })).optional() }).parse(JSON.parse(await readFile(join(root, 'status.json'), 'utf8')))
    await writeFile(join(profile, 'cordis.patch.yml'), dump([...patches.slice(0, -1), { id: 'mail-automation', config: { ...config, enabled: false } }], { noRefs: true }))
    await waitFor(async () => (await status()).phase === 'paused', () => `mail paused after a live settings write; ${output}`)
    await writeFile(join(profile, 'cordis.patch.yml'), dump([...patches.slice(0, -1), { id: 'mail-automation', config: { ...config, enabled: true } }], { noRefs: true }))
    await waitFor(async () => { const current = await status(); return current.phase === 'running' && Object.values(current.health).includes('healthy') }, () => `mail resumed; ${output}`)
    assert.equal((await status()).tasks?.length, 1)
    servers.imap.appendMessage('INBOX', [], new Date(), message('[DSH] second task', `---\nworkspace: ${JSON.stringify(emailDirectory)}\n---\nWrite the evidence file.`).toString().replace('<fixture@example.com>', '<second@example.com>'))
    await waitFor(() => servers.received.length === 2, () => `new mail executes after reconfiguration; ${output}`)
    assert.equal((await parseMail(servers.received[1]!, config.runtime)).body.includes('Status: succeeded'), true)
  }
}

test('real dsh profile runs an email-created Agent, executes tools, persists the turn and sends its reply', () => profileScenario('success'), 60_000)
test('a final Agent text response is automatically emailed without using the result tool', () => profileScenario('text-only'), 60_000)
test('a real DSH Agent becoming idle without text or a result is reported as needs_attention', () => profileScenario('empty-result'), 60_000)
test('a failed real Agent turn emails failure and the last text while excluding reasoning', () => profileScenario('model-error'), 60_000)
test('live configuration stops and restarts the mail runtime without replaying old mail or retaining the old lock', () => profileScenario('reconfigure'), 60_000)
