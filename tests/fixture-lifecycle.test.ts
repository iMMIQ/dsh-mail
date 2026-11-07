// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import { fixture } from './helpers.ts'

test('fixture cleanup releases storage and directories even when a consumer fails to close', async () => {
  await using resources = new AsyncDisposableStack()
  const f = await fixture(resources)
  const selected = await mkdtemp(join(tmpdir(), 'dsh-mail-fixture-directory-'))
  f.directories.defer(() => rm(selected, { recursive: true, force: true }))
  const failure = new Error('Consumer cleanup failed')
  f.cleanup.defer(async () => {
    await stat(f.directory)
    await stat(selected)
    throw failure
  })
  await assert.rejects(f.cleanup.disposeAsync(), error => error === failure)
  assert.throws(() => f.store.inbox(), /closed/)
  await assert.rejects(f.spool.write(Buffer.from('after cleanup')), /mail-state-lock-lost/)
  await assert.rejects(stat(f.directory), { code: 'ENOENT' })
  await assert.rejects(stat(selected), { code: 'ENOENT' })
})
