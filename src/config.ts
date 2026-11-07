// SPDX-License-Identifier: LGPL-3.0-or-later
/** Host configuration adds local path validation to the shared mail schemas. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { configurationSchema, ruleSchema as sharedRuleSchema } from './config-schema.ts'

export { accountSchema, senderPolicySchema } from './config-schema.ts'
export type { Account, Rule, SenderPolicy } from './config-schema.ts'

/** Durable rules retain the Host's absolute-directory requirement. */
export const ruleSchema = sharedRuleSchema.extend({ task: sharedRuleSchema.shape.task.extend({
  workspacePath: z.string().refine(isAbsolute, 'workspacePath must be absolute').optional(),
}) })

/** Fully defaulted Host configuration with deployment-local paths. */
export const Config = configurationSchema.safeExtend({
  stateDirectory: z.string().refine(isAbsolute, 'stateDirectory must be absolute'), rules: z.array(ruleSchema),
})
/** Fully defaulted plugin configuration. */
export type Config = z.output<typeof Config>
