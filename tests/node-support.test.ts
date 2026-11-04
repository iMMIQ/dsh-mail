// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'bun:test'
import { z } from 'zod'
import { nodeSupportReason } from '../scripts/node-support.ts'

const schedule = {
  v20: { start: '2023-04-18', end: '2026-04-30' },
  v22: { start: '2024-04-24', end: '2027-04-30' },
  v24: { start: '2025-05-06', end: '2028-04-30' },
  v25: { start: '2025-10-15', end: '2026-06-01' },
  v26: { start: '2026-05-05', end: '2029-04-30' },
  v27: { start: '2027-04-22', end: '2030-04-30' },
}

test('Node eligibility follows DSH requirements and the release lifecycle', () => {
  const required = '^22.19.0 || >=24.0.0'
  for (const version of ['22.19.0', '24.0.0', 'v26.13.0']) assert.equal(nodeSupportReason(version, required, schedule, '2026-11-04'), undefined)
  for (const version of ['20.19.0', '22.18.0', '25.0.0', '27.0.0-alpha.1', '27.0.0']) assert.ok(nodeSupportReason(version, required, schedule, '2026-11-04'), version)
  assert.ok(nodeSupportReason('22.23.4', '>=24.9.0', schedule, '2026-11-04'))
  assert.ok(nodeSupportReason('24.8.0', '>=24.9.0', schedule, '2026-11-04'))
  assert.equal(nodeSupportReason('24.9.0', '>=24.9.0', schedule, '2026-11-04'), undefined)
  assert.ok(nodeSupportReason('22.23.4', required, schedule, '2027-05-01'))
})

test('the plugin admits maintained Node branches without imposing Node 24 on older DSH', async () => {
  const { engines } = z.object({ engines: z.object({ node: z.string() }) }).parse(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')))
  for (const version of ['22.19.0', '24.0.0', '26.0.0']) assert.ok(Bun.semver.satisfies(version, engines.node), version)
  for (const version of ['22.18.0', '23.11.0', '25.0.0']) assert.equal(Bun.semver.satisfies(version, engines.node), false, version)
})
