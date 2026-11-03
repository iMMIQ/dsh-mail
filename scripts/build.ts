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
const client = await Bun.build({
  entrypoints: [`${root}src/client/index.ts`], target: 'browser', format: 'cjs',
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis', 'zod', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  tsconfig: `${root}tsconfig.client.json`,
})
if (!client.success || !client.outputs[0]) throw new AggregateError(client.logs, 'Client build failed')
await Bun.write(`${outdir}client.js`, `window.__ModuleLoader__.load({ id: "dsh-mail", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n${await client.outputs[0].text()}\nreturn module.exports;\n} });\n`)
const types = Bun.spawn([process.execPath, 'run', '--bun', 'tsc', '-p', `${root}tsconfig.json`], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
})
if (await types.exited !== 0) throw new Error('Declaration generation failed')
const clientTypes = Bun.spawn([process.execPath, 'run', '--bun', 'tsc', '-p', `${root}tsconfig.client.json`], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
if (await clientTypes.exited !== 0) throw new Error('Client declaration generation failed')
