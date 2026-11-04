// SPDX-License-Identifier: LGPL-3.0-or-later
/** Build and exercise the plugin against one isolated, published DSH release. */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(version)) throw new Error('Usage: bun run test:compat <exact DSH version>')
const source = fileURLToPath(new URL('../', import.meta.url))
const manifest = z.object({
  devDependencies: z.record(z.string(), z.string()), peerDependencies: z.record(z.string(), z.string()),
}).passthrough().parse(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')))
const response = await fetch(`https://registry.npmjs.org/@deepseek-ai%2Fdsh/${encodeURIComponent(version)}`)
if (!response.ok) throw new Error(`Cannot read published DSH ${version}: HTTP ${response.status}`)
const host = z.object({ version: z.literal(version), dependencies: z.record(z.string(), z.string()) }).parse(await response.json())
// Each release uses its declared Cordis generation; later Loader prereleases can change its internal API.
const overrides = Object.fromEntries(Object.entries(host.dependencies).filter(([name]) => name.startsWith('@deepseek-ai/cordis') || name === '@deepseek-ai/schemastery').map(([name, range]) => {
  const exact = /^~?(\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?)$/.exec(range)?.[1]
  if (!exact) throw new Error(`Cannot select the release dependency for ${name}: ${range}`)
  return [name, exact]
}))
manifest.overrides = overrides
for (const name of new Set([...Object.keys(manifest.devDependencies), ...Object.keys(manifest.peerDependencies)])) {
  if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) manifest.devDependencies[name] = version
  if (name === '@deepseek-ai/cordis' || name === '@deepseek-ai/schemastery') {
    const required = overrides[name]
    if (!required) throw new Error(`DSH ${version} does not declare ${name}`)
    manifest.devDependencies[name] = required
  }
}

await using resources = new AsyncDisposableStack()
const directory = await mkdtemp(join(tmpdir(), 'dsh-mail-compat-'))
resources.defer(() => rm(directory, { recursive: true, force: true }))
await Promise.all(['src', 'tests', 'scripts', 'examples', 'cordis.patch.yml', 'bunfig.toml', 'tsconfig.json', 'tsconfig.client.json', 'tsconfig.check.json']
  .map(name => cp(join(source, name), join(directory, name), { recursive: true })))
await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], { cwd: directory, stdout: 'inherit', stderr: 'inherit' })
  try { if (await child.exited !== 0) throw new Error(`DSH ${version}: bun ${args.join(' ')} failed`) }
  finally { if (child.exitCode === null) { child.kill(); await child.exited } }
}

console.info(`Checking DSH ${version}`)
await run(['install', '--ignore-scripts'])
for (const name of Object.keys(manifest.devDependencies).filter(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))) {
  const installed = z.object({ version: z.string() }).parse(JSON.parse(await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8')))
  if (installed.version !== version) throw new Error(`${name}: expected ${version}, installed ${installed.version}`)
}
await run(['run', 'check'])
console.info(`DSH ${version}: build, types and all behavior tests passed`)
