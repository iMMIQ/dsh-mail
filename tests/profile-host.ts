// SPDX-License-Identifier: LGPL-3.0-or-later
/** Own a real DSH profile process through readiness, restart and awaited shutdown. */
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'
import { waitFor } from './network.ts'

/** Launch the test profile with its private home and bounded shutdown.
 * @param resources Fixture cleanup stack; the process drains before its files and servers.
 * @param home Private DSH home containing the mail-test profile.
 * @returns Process observations and idempotent stop/restart operations.
 */
export function profileHost(resources: AsyncDisposableStack, home: string) {
  const node = Bun.which(process.env.DSH_TEST_NODE ?? 'node')
  if (!node) throw new Error('Install a Node.js host compatible with the selected DSH version')
  let child: ChildProcess | undefined
  let exit: Promise<void> | undefined
  let exited = true
  let output = ''
  let launchError: Error | undefined
  const stop = async (): Promise<void> => {
    if (!child || !exit) return
    if (!exited) child.kill('SIGTERM')
    const deadline = new AbortController()
    try {
      await Promise.race([exit, delay(10_000, undefined, { signal: deadline.signal }).then(() => { throw new Error(`DSH did not stop after SIGTERM:\n${output}`) })])
    } catch (error) { child.kill('SIGKILL'); await exit; throw error } finally { deadline.abort() }
  }
  resources.defer(stop)
  return {
    get output(): string { return output },
    get exited(): boolean { return exited },
    stop,
    async start(): Promise<void> {
      if (!exited) throw new Error('Stop the previous DSH process before restarting')
      output = ''
      launchError = undefined
      exited = false
      child = spawn(node, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'mail-test'],
        { cwd: resolve('.'), env: { ...process.env, DSH_HOME: home, MAIL_PASSWORD: 'testpass' }, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout!.on('data', chunk => { output += String(chunk) })
      child.stderr!.on('data', chunk => { output += String(chunk) })
      exit = new Promise<void>(resolveExit => {
        child!.once('error', error => { exited = true; launchError = error; resolveExit() })
        child!.once('exit', () => { exited = true; resolveExit() })
      })
      await waitFor(() => {
        if (launchError) throw launchError
        if (exited) throw new Error(`DSH exited before ready:\n${output}`)
        return output.includes('DSH_MAIL_READY')
      }, () => `DSH readiness; ${output}`)
    },
  }
}
