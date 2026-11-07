// SPDX-License-Identifier: LGPL-3.0-or-later
/** Live settings metadata; the domain parser validates every committed configuration. */
import Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Config as DomainConfig, accountSchema } from './config.ts'

/** Plain values persisted by the DSH settings editor. */
export const settingsSchema = z.strictObject({
  ...DomainConfig.shape,
  enabled: z.boolean().default(true),
  stateDirectory: DomainConfig.shape.stateDirectory.default(join(homedir(), '.dsh', 'mail')),
  accounts: z.array(accountSchema).default([]),
  senderPolicies: DomainConfig.shape.senderPolicies.default({}),
  templates: DomainConfig.shape.templates.default({}),
  rules: DomainConfig.shape.rules.default([]),
}).superRefine((value, ctx) => {
  if (value.enabled && (!value.accounts.length || !value.rules.length)) ctx.addIssue({ code: 'custom', message: 'Configure an account and a rule before enabling mail' })
  if (value.accounts.length || value.rules.length || value.enabled) {
    const { enabled: _enabled, ...configuration } = value
    const parsed = DomainConfig.safeParse(configuration)
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
  }
})

/** Ordinary settings values returned to authenticated clients. */
export type MailSettings = z.output<typeof settingsSchema>
/** Stable configuration references supplied by Cordis. */
export type LiveSettings = { [K in keyof MailSettings]: Volatile<MailSettings[K]> }

const schema = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  stateDirectory: Schema.string().default(join(homedir(), '.dsh', 'mail')).volatile(),
  accounts: Schema.array(Schema.any<MailSettings['accounts'][number]>()).default([]).volatile(),
  senderPolicies: Schema.any<MailSettings['senderPolicies']>().default({}).volatile(),
  templates: Schema.dict(Schema.string()).default({}).volatile(),
  rules: Schema.array(Schema.any<MailSettings['rules'][number]>()).default([]).volatile(),
  runtime: Schema.any<MailSettings['runtime']>().default({}).volatile(),
  notifications: Schema.any<MailSettings['notifications']>().default({}).volatile(),
})
const standard = schema['~standard']
// Keep serializable Schemastery metadata for the form, and full Zod validation on Host writes.
Object.defineProperty(schema, '~standard', { value: {
  ...standard,
  validate(input: unknown) {
    const parsed = settingsSchema.safeParse(input)
    return parsed.success ? standard.validate(parsed.data) : { issues: parsed.error.issues }
  },
} })

/** Cordis Config schema exposing only ordinary configuration, never authorization codes. */
export const PluginConfig = schema

/** Read one consistent snapshot for a runtime generation.
 * @param config Live references owned by this plugin.
 * @returns Validated ordinary configuration.
 */
export function readSettings(config: LiveSettings): MailSettings {
  return settingsSchema.parse(Object.fromEntries(Object.entries(config).map(([key, value]) => [key, value.get()])))
}
