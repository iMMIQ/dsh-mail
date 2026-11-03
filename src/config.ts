// SPDX-License-Identifier: LGPL-3.0-or-later
/** Validated deployment choices; configuration never contains mailbox passwords. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'

const id = z.string().regex(/^[a-z][a-z0-9-]*$/)
const line = z.string().min(1).max(998).refine(v => !/[\r\n\0]/.test(v), 'must be a single line')
const address = z.email().refine(v => !/[\r\n\0]/.test(v))
const ms = z.number().int().positive().max(2_147_483_647)
const auth = z.strictObject({ user: line, credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) })
const connection = {
  host: line, port: z.number().int().min(1).max(65535),
  tls: z.enum(['direct', 'starttls']), auth,
  ca: z.string().optional(),
}

/** Account schema shared by config validation and durable task snapshots. */
export const accountSchema = z.strictObject({
  id, address,
  receive: z.strictObject({
    protocol: z.literal('imap'), ...connection,
    folders: z.array(line).min(1).refine(values => new Set(values).size === values.length, 'duplicate mailbox folder').default(['INBOX']),
    initialSync: z.enum(['new-only', 'all']).default('new-only'),
    rescanIntervalMs: ms.default(60_000),
    maxMessageAgeMs: ms.default(172_800_000),
  }).optional(),
  send: z.strictObject({ protocol: z.literal('smtp'), ...connection }).optional(),
}).refine(a => a.receive !== undefined || a.send !== undefined, 'account needs receive or send')

/** A sender policy records which evidence the operator accepts. */
export const senderPolicySchema = z.discriminatedUnion('evidence', [
  z.strictObject({ evidence: z.literal('local-signature'), dnsServers: z.array(line).min(1).optional() }),
  z.strictObject({
    evidence: z.literal('trusted-mta'),
    authservIds: z.array(line).min(1),
    stripsUntrustedHeaders: z.literal(true),
  }),
])

/** One deterministic routing rule; values entering a task are frozen at admission. */
export const ruleSchema = z.strictObject({
  id, priority: z.number().int().default(0), account: id,
  authorization: z.strictObject({ policy: id, allowedSenders: z.array(address).min(1) }),
  match: z.strictObject({
    subjectPrefix: line.optional(), subjectContains: line.optional(), bodyContains: line.optional(),
    to: address.optional(), hasAttachments: z.boolean().optional(),
  }).default({}),
  extract: z.record(id, z.strictObject({
    source: z.enum(['subject', 'body']), after: z.string().min(1), before: z.string().min(1).optional(),
  })).default({}),
  task: z.strictObject({
    workspacePath: z.string().refine(isAbsolute, 'workspacePath must be absolute').optional(),
    agentPreset: line, permissionPreset: line.default('danger-full-access'), template: id,
    timeoutMs: ms.default(900_000), maxSteps: z.number().int().positive().default(40),
    attachmentTypes: z.array(z.enum(['text/plain', 'text/csv', 'application/json'])).default([]),
    model: z.strictObject({ provider: line, model: line, maxTokens: z.number().int().positive().optional() }).optional(),
  }),
  reply: z.strictObject({
    account: id, to: address,
    on: z.array(z.enum(['succeeded', 'failed', 'cancelled', 'timed_out', 'needs_attention'])).default(['succeeded', 'failed', 'cancelled', 'timed_out', 'needs_attention']),
  }),
})

/** Full plugin config. Unknown keys reject instead of silently changing automation. */
export const Config = z.strictObject({
  stateDirectory: z.string().refine(isAbsolute, 'stateDirectory must be absolute'),
  accounts: z.array(accountSchema).min(1),
  senderPolicies: z.record(id, senderPolicySchema),
  templates: z.record(id, z.string().min(1)),
  rules: z.array(ruleSchema),
  runtime: z.strictObject({
    tickIntervalMs: ms.default(1_000), connectionTimeoutMs: ms.default(30_000),
    maxConcurrentTasks: z.number().int().positive().default(2),
    maxImapConnections: z.number().int().positive().default(8),
    maxQueuedTasks: z.number().int().positive().default(100),
    maxRecords: z.number().int().positive().default(10_000),
    maxMessageBytes: z.number().int().positive().default(10_485_760),
    maxTaskBytes: z.number().int().positive().default(65_536),
    maxReplyBytes: z.number().int().min(1_024).default(65_536),
    maxAttachmentBytes: z.number().int().positive().default(5_242_880),
    maxAttachments: z.number().int().nonnegative().default(5),
    maxVerificationAttempts: z.number().int().positive().default(3),
    maxSendAttempts: z.number().int().positive().default(3),
    retryDelayMs: ms.default(30_000), minSendIntervalMs: ms.default(1_000),
    lockStaleMs: ms.min(5_000).default(60_000),
  }).prefault({}),
}).superRefine((config, ctx) => {
  for (const [name, entries] of [['accounts', config.accounts], ['rules', config.rules]] as const) {
    if (new Set(entries.map(e => e.id)).size !== entries.length) ctx.addIssue({ code: 'custom', message: `duplicate ${name} id` })
  }
  if (config.accounts.reduce((count, account) => count + (account.receive?.folders.length ?? 0), 0) > config.runtime.maxImapConnections) ctx.addIssue({ code: 'custom', message: 'mailbox folder count exceeds maxImapConnections' })
  for (const rule of config.rules) {
    if (!config.accounts.find(a => a.id === rule.account)?.receive) ctx.addIssue({ code: 'custom', message: `${rule.id}: receive account not found` })
    if (!config.accounts.find(a => a.id === rule.reply.account)?.send) ctx.addIssue({ code: 'custom', message: `${rule.id}: send account not found` })
    if (!config.senderPolicies[rule.authorization.policy]) ctx.addIssue({ code: 'custom', message: `${rule.id}: sender policy not found` })
    const template = config.templates[rule.task.template]
    if (!template) ctx.addIssue({ code: 'custom', message: `${rule.id}: template not found` })
    const fields = new Set(['subject', 'body', 'from', 'workspace', 'attachmentText', ...Object.keys(rule.extract)])
    if (Object.keys(rule.extract).some(key => ['subject', 'body', 'from', 'workspace', 'attachmentText'].includes(key))) ctx.addIssue({ code: 'custom', message: `${rule.id}: reserved extraction field` })
    for (const match of template?.matchAll(/\{\{([^{}]+)\}\}/g) ?? []) {
      if (!fields.has(match[1] ?? '')) ctx.addIssue({ code: 'custom', message: `${rule.id}: unknown template variable` })
    }
  }
})

/** Fully defaulted plugin configuration. */
export type Config = z.output<typeof Config>
/** Mailbox connection and sending identity. */
export type Account = z.output<typeof accountSchema>
/** Frozen rule used by one task. */
export type Rule = z.output<typeof ruleSchema>
/** Explicit accepted authentication evidence. */
export type SenderPolicy = z.output<typeof senderPolicySchema>
