// SPDX-License-Identifier: LGPL-3.0-or-later
/** Client-safe Remote values; Host, wire codecs and Client types share these definitions. */
import { z } from 'zod'

/** Mail lifecycle and connection health without messages or credential values. */
export const mailStatusSchema = z.strictObject({
  phase: z.enum(['paused', 'running', 'changing', 'error']),
  health: z.record(z.string(), z.string()),
  defaultAgentPreset: z.string().min(1).optional(),
})

/** Fixed login-check results for every supported incoming protocol and SMTP. */
export const connectionCheckSchema = z.strictObject({
  imap: z.enum(['ok', 'failed', 'absent']),
  smtp: z.enum(['ok', 'failed', 'absent']),
  pop3: z.enum(['ok', 'failed']).optional(),
})

/** Status returned by the mail settings owner. */
export type MailStatus = z.infer<typeof mailStatusSchema>
/** Login check result; transport errors and secrets never cross the Remote interface. */
export type ConnectionCheck = z.infer<typeof connectionCheckSchema>
