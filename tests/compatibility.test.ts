// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'bun:test'
import { Context } from '@deepseek-ai/cordis'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { z } from 'zod'
import remote, { TYPERT_REMOTE } from '../src/remote.ts'
import { TYPERT } from '../src/typert.ts'

test('DSH admits the Node 24 generation and rejects older and next-minor hosts', async () => {
  const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')))
  for (const version of ['0.2.2-alpha.2', '0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2', '0.2.9']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version)
  }
  for (const version of ['0.2.1-alpha.3', '0.2.1-rc.5', '0.2.2-alpha.1', '0.3.0-alpha.1', '0.3.0-rc.1', '0.3.0', '1.0.0']) assert.ok(evaluatePluginCompatibility(manifest, {}, version), version)
})

test('the DSH registry admits both UI endpoints with strict parameter and result validation', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(TypertRegistry)
    ctx.effect(() => ctx.typert.register(TYPERT))
    ctx.effect(() => ctx.typert.remotes.register(remote))
    const check = ctx.typert.remotes.get('mailAutomation/checkConnection')!
    assert.ok(check)
    assert.equal(ctx.typert.local.get('mailAutomation/checkConnection')?.id, check.id)
    const input = TYPERT_REMOTE.methods['mailAutomation/checkConnection']!.input({ strict: true }).create()
    assert.deepEqual(input.parse({ accountId: 'mail-1' }), { accountId: 'mail-1' })
    assert.throws(() => input.parse({ accountId: 'mail-1', extra: true }))
    const parameter = check.parameters[0]!.codec
    assert.equal(parameter.mode, 'strict')
    if (parameter.mode !== 'strict') throw new Error('Expected strict account validation')
    assert.equal(parameter.create().parse('mail-1'), 'mail-1')
    assert.throws(() => parameter.create().parse('../other'))
    const status = ctx.typert.local.get('mailAutomation/getStatus')!.result
    if (status.mode !== 'strict') throw new Error('Expected strict status validation')
    assert.deepEqual(status.create().parse({ phase: 'paused', health: {} }), { phase: 'paused', health: {} })
    assert.throws(() => status.create().parse({ phase: 'unknown', health: {} }))
    const result = check.result
    if (result.mode !== 'strict') throw new Error('Expected strict connection result validation')
    assert.throws(() => result.create().parse({ imap: 'ok', smtp: 'password' }))
    const pop3 = { imap: 'absent', smtp: 'ok', pop3: 'failed' }
    assert.deepEqual(result.create().parse(pop3), pop3)
  } finally { await ctx.fiber.dispose() }
})
