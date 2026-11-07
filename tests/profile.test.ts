// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { simpleParser } from 'mailparser'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dump } from 'js-yaml'
import { z } from 'zod'
import { parseMail } from '../src/mail.ts'
import { Config } from '../src/config.ts'
import { configuration, message } from './helpers.ts'
import { mailServers, waitFor } from './network.ts'
import { pop3Server } from './pop3-network.ts'

const host = z.object({ version: z.string(), dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(await readFile(resolve('node_modules/@deepseek-ai/dsh/package.json'), 'utf8')))

async function profileScenario(scenario: 'success' | 'text-only' | 'empty-result' | 'model-error' | 'reconfigure' | 'conversation' | 'external' | 'markdown', protocol: 'imap' | 'pop3' = 'imap'): Promise<void> {
  const success = scenario === 'success' || scenario === 'reconfigure'
  await using resources = new AsyncDisposableStack()
  const root = await mkdtemp(join(tmpdir(), 'dsh-mail-profile-'))
  resources.defer(() => rm(root, { recursive: true, force: true }))
  const servers = await mailServers(resources)
  const pop3 = protocol === 'pop3' ? await pop3Server(resources, 'starttls') : undefined
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
  const { workspacePath: _oldWorkspace, permissionPreset: _oldPermissions, agentPreset: _oldPreset, ...emailTask } = original.rules[0]!.task
  const config = Config.parse({ ...original, rules: [{ ...original.rules[0]!, task: emailTask }] })
  const emailDirectory = join(root, 'email-workspace')
  await mkdir(emailDirectory)
  if (scenario === 'conversation' || scenario === 'external') {
    config.notifications = { enabled: scenario === 'external', receipts: true }
    config.senderPolicies.trusted = { evidence: 'local-signature', trustedSenders: ['owner@example.com'] }
  }
  config.runtime.tickIntervalMs = 20
  Object.assign(config.accounts[0]!.receive!, { host: '127.0.0.1', port: servers.imapPort, ca: servers.ca, rescanIntervalMs: 50, auth: { user: 'testuser', credentialRef: 'MAIL_PASSWORD' } })
  if (pop3) config.accounts[0]!.receive = { protocol: 'pop3', host: '127.0.0.1', port: pop3.port, tls: 'starttls', ca: pop3.ca, rescanIntervalMs: 50, initialSync: 'new-only', maxMessageAgeMs: 172_800_000, auth: { user: 'testuser', credentialRef: 'MAIL_PASSWORD' } }
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
  if (scenario === 'external') configs['agent-preset'] = { id: 'mail-reader', plugins: [{ name: resolve('tests/fixtures/selected-mode.mjs') }] }
  const rows = names.map(name => ({ id: name, name: name === 'shell' ? resolve('tests/fixtures/denied-shell.mjs') : `@deepseek-ai/dsh-${name}`, ...(configs[name] ? { config: configs[name] } : {}) }))
  if (scenario === 'external') rows.push({ id: 'initial-mode', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'initial-mode', plugins: [] } })
  if (scenario === 'reconfigure') rows.unshift({ id: 'timer', name: '@deepseek-ai/cordis-plugin-timer' })
  const patches = [{ insert: [...rows,
    { id: 'fixture', name: resolve('tests/fixtures/driver.mjs'), config: { root, scenario, workspace: emailDirectory } },
  ] }, { id: 'mail-automation', disabled: false, config }]
  await writeFile(join(profile, 'cordis.patch.yml'), dump(patches, { noRefs: true }))
  const node = Bun.which(process.env.DSH_TEST_NODE ?? 'node')
  if (!node) throw new Error('Install a Node.js host compatible with the selected DSH version')
  let output = ''
  const launch = (): void => {
    exited = false
    output = ''
    child = spawn(node, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'mail-test'],
      { cwd: resolve('.'), env: { ...process.env, DSH_HOME: home, MAIL_PASSWORD: 'testpass' }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout!.on('data', chunk => { output += String(chunk) })
    child.stderr!.on('data', chunk => { output += String(chunk) })
    exit = new Promise<void>(resolveExit => child!.once('exit', () => { exited = true; resolveExit() }))
  }
  launch()
  await waitFor(() => {
    if (exited) throw new Error(`dsh exited before ready:\n${output}`)
    return output.includes('DSH_MAIL_READY')
  }, () => `dsh ready; ${output}`)
  if (scenario === 'conversation' || scenario === 'external') {
    const send = (id: string, body: string, parent?: string): void => {
      const raw = message(parent ? '回复：continue with a different title' : '[DSH] remember', body, parent ? [`In-Reply-To: ${parent}`, `References: ${parent}`] : [])
        .toString().replace('<fixture@example.com>', `<${id}@example.com>`)
      if (pop3) pop3.messages.push({ uid: id, raw: Buffer.from(raw) })
      else servers.imap.appendMessage('INBOX', [], new Date(), raw)
    }
    const control = async (id: string, text: string): Promise<void> => {
      await writeFile(join(root, 'control.tmp'), JSON.stringify({ id, text }))
      await rename(join(root, 'control.tmp'), join(root, 'control.json'))
    }
    const results = async () => {
      const mails = await Promise.all(servers.received.map(raw => parseMail(raw, config.runtime)))
      return mails.filter(mail => mail.body.includes('Status:'))
    }
    const waitResults = async (count: number) => waitFor(async () => { if (exited) throw new Error(`DSH exited before the result: ${output}`); return (await results()).length >= count }, () => `waiting for ${count} turn emails; ${output}`)
    if (scenario === 'external') {
      await control('initial', 'Remember amber.')
    } else send('initial', `---\nworkspace: ${JSON.stringify(emailDirectory)}\n---\nRemember amber.`)
    await waitResults(1)
    const first = (await results())[0]!
    const firstMime = await simpleParser(servers.received.find(raw => raw.toString().includes('multipart/alternative'))!)
    assert.equal(typeof firstMime.html, 'string')
    assert.match(String(firstMime.html), /任务执行报告/)
    assert.match(String(firstMime.html), /mail-fixture/)
    assert.match(first.body, /Remembered amber/)
    assert.ok(first.messageId)
    const sessionId = /Session: ([^\n]+)/.exec(first.body)![1]!.trim()
    if (scenario === 'external') {
      assert.equal(sessionId, 'external-session')
      const expected: unknown = JSON.parse(await readFile(resolve('tests/snapshots/mail-session-notification.json'), 'utf8'))
      assert.deepEqual({ subject: first.subject, to: first.to, body: first.body.trim().replace(/Task: [a-f0-9]{64}/, 'Task: {{taskId}}').replace(emailDirectory, '{{workspace}}') }, expected)
    }
    send('hold', 'HOLD: report the remembered color.\n\nOn Monday, DSH wrote:\n> OLD QUOTED INSTRUCTION', first.messageId)
    await waitFor(async () => { try { await readFile(join(root, 'entered')); return true } catch (error) { if (z.object({ code: z.string() }).parse(error).code !== 'ENOENT') throw error; return false } }, () => `continuation entered; ${output}`)
    send('queued', 'Report the remembered color again.', first.messageId)
    const queuedRaw = message('Re: [DSH] duplicate', 'Report the remembered color again.', [`In-Reply-To: ${first.messageId}`]).toString().replace('<fixture@example.com>', '<queued@example.com>')
    // Same Message-ID with different content is quarantined, not executed twice.
    if (pop3) pop3.messages.push({ uid: 'queued-duplicate', raw: Buffer.from(queuedRaw) })
    else servers.imap.appendMessage('INBOX', [], new Date(), queuedRaw)
    await waitFor(async () => {
      const current = z.object({ tasks: z.array(z.object({ state: z.string() })) }).parse(JSON.parse(await readFile(join(root, 'status.json'), 'utf8')))
      return current.tasks.some(task => task.state === 'queued')
    }, () => `second follow-up queued; ${output}`)
    await writeFile(join(root, 'release'), 'continue')
    await waitResults(3)
    assert.ok((await results()).every(mail => mail.body.includes(`Session: ${sessionId}`)))
    assert.match((await results())[1]!.body, /Remembered color: amber/)
    assert.match((await results())[2]!.body, /Remembered color: amber/)
    if (scenario === 'external') {
      await control('next-ui-turn', 'Report the remembered color from the DSH interface.')
      await waitResults(4)
    }
    const beforeRestart = (await results()).length
    child!.kill('SIGTERM')
    await waitFor(() => exited, () => 'profile stopped before restart')
    await exit
    launch()
    await waitFor(() => output.includes('DSH_MAIL_READY'), () => `profile restarted; ${output}`)
    send('after-restart', 'Report the remembered color after restart.', first.messageId)
    await waitResults(beforeRestart + 1)
    const final = (await results()).at(-1)!
    assert.match(final.body, /Remembered color: amber/)
    assert.ok(final.body.includes(`Session: ${sessionId}`))
    const requests = z.array(z.object({ texts: z.array(z.string()), tools: z.array(z.string()) })).parse(JSON.parse(await readFile(join(root, 'requests.json'), 'utf8')))
    assert.ok(requests.at(-1)!.texts.some(text => text.includes('Remember amber')))
    if (scenario === 'external') assert.ok(requests.at(-1)!.tools.includes('selected_mode_tool'))
    assert.ok(requests.every(request => request.texts.every(text => !text.includes('OLD QUOTED INSTRUCTION'))))
    const logs = await readdir(join(root, 'sessions'), { recursive: true })
    const sessionFile = logs.find(name => /(?:^|[/\\])session\.v\d+\.jsonl$/.test(name))!
    const events = z.array(z.object({ type: z.string(), data: z.object({ preset: z.string().optional(), source: z.object({ kind: z.string() }).optional() }).passthrough().optional() })).parse((await readFile(join(root, 'sessions', sessionFile), 'utf8')).trim().split('\n').map(line => JSON.parse(line)))
    const permissions = events.filter(event => event.type === 'permission/preset').map(event => event.data?.preset)
    const expectedPermission = scenario === 'external' ? 'restricted' : 'danger-full-access'
    assert.equal(permissions.at(-1), expectedPermission)
    const firstUser = events.findIndex(event => event.type === 'user/message')
    assert.ok(events.slice(firstUser).filter(event => event.type === 'permission/preset').every(event => event.data?.preset === expectedPermission))
    assert.equal(events.filter(event => event.type === 'user/message' && ['dsh-mail', 'user'].includes(event.data?.source?.kind ?? '')).length, beforeRestart + 1)
    assert.equal((await results()).length, beforeRestart + 1)
    const received = await Promise.all(servers.received.map(raw => parseMail(raw, config.runtime)))
    const receipts = received.filter(mail => mail.body.includes('Received and queued.'))
    assert.equal(receipts.length, beforeRestart + 1 - (scenario === 'external' ? 2 : 0))
    assert.ok(received.every(mail => mail.headers.some(header => header.key === 'reply-to' && header.line.includes('bot@example.com'))))
    return
  }
  const taskMail = message('[DSH] create evidence', `---\nworkspace: ${JSON.stringify(emailDirectory)}\n---\nWrite the evidence file, then report success.`)
  if (pop3) pop3.messages.push({ uid: 'profile-task', raw: taskMail })
  else servers.imap.appendMessage('INBOX', [], new Date(), taskMail.toString())
  await waitFor(() => servers.received.length === 1, () => `result mail; ${output}`)
  const mime = await simpleParser(servers.received[0]!)
  assert.equal(typeof mime.html, 'string')
  assert.match(String(mime.html), /任务执行报告/)
  assert.match(String(mime.html), /mail-fixture/)
  assert.match(String(mime.html), /执行步数/)
  assert.equal(Number(/执行步数<\/td><td[^>]*>(\d+)<\/td>/.exec(String(mime.html))?.[1]), success ? 3 : scenario === 'model-error' ? 2 : 1)
  if (scenario === 'markdown') {
    assert.match(String(mime.html), /<h2 style=/)
    assert.match(String(mime.html), /<table[^>]*style="border-collapse/)
    assert.match(String(mime.html), /<pre style=/)
    assert.match(String(mime.html), /href="https:\/\/example.com\/report"/)
  }
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
  assert.equal(z.object({ cwd: z.string(), agentPreset: z.string() }).parse(events[0]).agentPreset, 'mail-reader')
  assert.equal(z.object({ cwd: z.string() }).parse(events[0]).cwd, emailDirectory)
  const actual = { input: users[0]!.data.content.map(part => part.text).join('').replace(emailDirectory, '{{workspace}}'), calls, turnEnds: ends, permissions,
    reply: response.body.replace(/Task: [a-f0-9]{64}/, 'Task: {{taskId}}').replace(/Session: mail-[a-f0-9]{64}/, 'Session: {{sessionId}}').replace(emailDirectory, '{{workspace}}').trim() }
  const snapshots = { success: 'mail-turn', 'text-only': 'mail-text-result', 'empty-result': 'mail-missing-result', 'model-error': 'mail-error', reconfigure: 'mail-turn', markdown: 'mail-markdown' }
  const expected: unknown = JSON.parse(await readFile(resolve(`tests/snapshots/${protocol === 'pop3' ? 'mail-pop3' : snapshots[scenario]}.json`), 'utf8'))
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


test('email replies preserve one real DSH conversation through queueing and a process restart', () => profileScenario('conversation'), 90_000)
test('a non-mail DSH session notifies, accepts replies and preserves its original permissions across restart', () => profileScenario('external'), 90_000)

test('a real DSH Markdown response is delivered as styled HTML with its original plain-text alternative', () => profileScenario('markdown'), 60_000)

test('POP3 STLS starts a real DSH Session, executes a tool and replies through SMTP', () => profileScenario('success', 'pop3'), 60_000)

test('POP3 replies continue a real DSH Session across queueing and a process restart', () => profileScenario('conversation', 'pop3'), 90_000)
