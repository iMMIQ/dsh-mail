// SPDX-License-Identifier: LGPL-3.0-or-later
/** Test-only shell provider: every shell request is refused; no subprocess can start. */
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
export default class DeniedShell extends ShellExecutor {
  get sandboxMode() { return 'read-only' }
  resolve() { throw new Error('Shell execution is disabled in this fixture') }
  execute() { throw new Error('Shell execution is disabled in this fixture') }
}
