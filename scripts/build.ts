// SPDX-License-Identifier: LGPL-3.0-or-later
/** Build ESM and declarations with Bun while keeping DSH services external. */
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const outdir = fileURLToPath(new URL('../lib/', import.meta.url))
await rm(outdir, { recursive: true, force: true })
const build = await Bun.build({
  entrypoints: [...new Bun.Glob('*.ts').scanSync({ cwd: `${root}src`, absolute: true })],
  root: `${root}src`,
  outdir,
  target: 'node',
  format: 'esm',
  packages: 'external',
  splitting: true,
  sourcemap: 'linked',
})
if (!build.success) throw new AggregateError(build.logs, 'Plugin build failed')
const types = Bun.spawn([process.execPath, 'run', '--bun', 'tsc', '-p', `${root}tsconfig.json`], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
})
if (await types.exited !== 0) throw new Error('Declaration generation failed')
