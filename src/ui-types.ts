// SPDX-License-Identifier: LGPL-3.0-or-later
/** Client-safe status returned by the mail settings owner. */
export interface MailStatus {
  phase: 'paused' | 'running' | 'changing' | 'error'
  health: Record<string, string>
  defaultAgentPreset?: string
}
