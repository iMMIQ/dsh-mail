// SPDX-License-Identifier: LGPL-3.0-or-later
/** Browser-safe configuration schemas and initial editor values. */
import { z } from 'zod'

const id = z.string().regex(/^[a-z][a-z0-9-]*$/)
const line = z.string().min(1).max(998).refine(v => !/[\r\n\0]/.test(v), 'must be a single line')
/** Mail addresses accepted by both configuration and guided setup. */
export const addressSchema = z.email().refine(v => !/[\r\n\0]/.test(v))
const ms = z.number().int().positive().max(2_147_483_647)
const nonBlank = line.refine(value => Boolean(value.trim()), 'value must not be blank')
const auth = z.strictObject({ user: nonBlank, credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) })
const connection = {
  host: line.refine(value => Boolean(value.trim()) && !value.includes('://'), 'host must be a name or IP address'), port: z.number().int().min(1).max(65535),
  tls: z.enum(['direct', 'starttls']), auth,
  ca: z.string().refine(value => !value || value.includes('-----BEGIN CERTIFICATE-----') && !/-----BEGIN[^\n]*PRIVATE KEY-----/.test(value), 'CA must contain public PEM certificates only').optional(),
}

const receiveDefaults = { initialSync: 'new-only' as const, rescanIntervalMs: 60_000, maxMessageAgeMs: 172_800_000 }
const taskDefaults = { permissionPreset: 'danger-full-access', timeoutMs: 900_000, maxSteps: 40 }
const replyStates = ['succeeded', 'failed', 'cancelled', 'timed_out', 'needs_attention'] as const

const reception = {
  initialSync: z.enum(['new-only', 'all']).default(receiveDefaults.initialSync),
  rescanIntervalMs: ms.default(receiveDefaults.rescanIntervalMs),
  maxMessageAgeMs: ms.default(receiveDefaults.maxMessageAgeMs),
}

/** Account schema shared by config validation and durable task snapshots. */
export const accountSchema = z.strictObject({
  id, address: addressSchema,
  receive: z.discriminatedUnion('protocol', [z.strictObject({
    protocol: z.literal('imap'), ...connection,
    folders: z.array(line).min(1).refine(values => new Set(values).size === values.length, 'duplicate mailbox folder').default(['INBOX']),
    ...reception,
  }), z.strictObject({ protocol: z.literal('pop3'), ...connection, ...reception })]).optional(),
  send: z.strictObject({ protocol: z.literal('smtp'), ...connection }).optional(),
}).refine(a => a.receive !== undefined || a.send !== undefined, 'account needs receive or send')

/** A sender policy records which evidence the operator accepts. */
export const senderPolicySchema = z.discriminatedUnion('evidence', [
  z.strictObject({ evidence: z.literal('local-signature'), trustedSenders: z.array(addressSchema).optional(), dnsServers: z.array(line).min(1).optional() }),
  z.strictObject({
    evidence: z.literal('trusted-mta'),
    authservIds: z.array(line).min(1),
    stripsUntrustedHeaders: z.literal(true),
  }),
])

/** One routing rule; omitted Agent and model selections follow DSH at execution. */
export const ruleSchema = z.strictObject({
  id, priority: z.number().int().default(0), account: id,
  authorization: z.strictObject({ policy: id, allowedSenders: z.array(addressSchema).min(1) }),
  match: z.strictObject({
    subjectPrefix: line.optional(), subjectContains: line.optional(), bodyContains: line.optional(),
    to: addressSchema.optional(), hasAttachments: z.boolean().optional(),
  }).default({}),
  extract: z.record(id, z.strictObject({
    source: z.enum(['subject', 'body']), after: z.string().min(1), before: z.string().min(1).optional(),
  })).default({}),
  task: z.strictObject({
    workspacePath: z.string().optional(),
    agentPreset: nonBlank.optional(), permissionPreset: nonBlank.default(taskDefaults.permissionPreset), template: id,
    timeoutMs: ms.default(taskDefaults.timeoutMs), maxSteps: z.number().int().positive().default(taskDefaults.maxSteps),
    attachmentTypes: z.array(z.enum(['text/plain', 'text/csv', 'application/json'])).default([]),
    model: z.strictObject({ provider: line, model: line, maxTokens: z.number().int().positive().optional() }).optional(),
  }),
  reply: z.strictObject({
    account: id, to: addressSchema,
    on: z.array(z.enum(replyStates)).default([...replyStates]),
  }),
})

/** Full plugin config. Unknown keys reject instead of silently changing automation. */
export const configurationSchema = z.strictObject({
  stateDirectory: z.string().min(1),
  accounts: z.array(accountSchema).min(1),
  senderPolicies: z.record(id, senderPolicySchema),
  templates: z.record(id, z.string().refine(value => Boolean(value.trim()), 'template must not be blank')),
  rules: z.array(ruleSchema),
  notifications: z.strictObject({ enabled: z.boolean().default(false), rule: id.optional(), receipts: z.boolean().default(true) }).prefault({}),
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
  if (config.notifications.enabled && !config.rules.length) ctx.addIssue({ code: 'custom', message: 'notification rule missing' })
  if (config.notifications.rule && !config.rules.some(rule => rule.id === config.notifications.rule)) ctx.addIssue({ code: 'custom', message: 'notification rule not found' })
  for (const [name, entries] of [['accounts', config.accounts], ['rules', config.rules]] as const) {
    if (new Set(entries.map(e => e.id)).size !== entries.length) ctx.addIssue({ code: 'custom', message: `duplicate ${name} id` })
  }
  if (config.accounts.reduce((count, account) => count + (account.receive?.protocol === 'imap' ? account.receive.folders.length : 0), 0) > config.runtime.maxImapConnections) ctx.addIssue({ code: 'custom', message: 'mailbox folder count exceeds maxImapConnections' })
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

/** Mailbox connection and sending identity. */
export type Account = z.output<typeof accountSchema>
/** Routing options persisted with each task. */
export type Rule = z.output<typeof ruleSchema>
/** Explicit accepted authentication evidence. */
export type SenderPolicy = z.output<typeof senderPolicySchema>

/** Settings values accepted by both browser drafts and Host configuration.
 * Host readers additionally enforce local path requirements.
 */
export const settingsValueSchema = z.strictObject({
  ...configurationSchema.shape,
  stateDirectory: configurationSchema.shape.stateDirectory.optional(),
  enabled: z.boolean().default(true),
  accounts: z.array(accountSchema).default([]),
  senderPolicies: configurationSchema.shape.senderPolicies.default({}),
  templates: configurationSchema.shape.templates.default({}),
  rules: configurationSchema.shape.rules.default([]),
}).superRefine((value, ctx) => {
  if (value.enabled && (!value.accounts.length || !value.rules.length)) ctx.addIssue({ code: 'custom', message: 'Configure an account and a rule before enabling mail' })
  if (value.accounts.length || value.rules.length || value.enabled) {
    const { enabled: _enabled, ...configuration } = value
    const parsed = configurationSchema.safeParse(configuration)
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
  }
})

/** Standard encrypted transport ports.
 * @param protocol Mail protocol.
 * @param tls Direct encryption or an explicit upgrade.
 * @returns The standard port used for new editor connections.
 */
export function defaultPort(protocol: 'imap' | 'pop3' | 'smtp', tls: 'direct' | 'starttls'): number {
  return { imap: { direct: 993, starttls: 143 }, pop3: { direct: 995, starttls: 110 }, smtp: { direct: 465, starttls: 587 } }[protocol][tls]
}

/** Create an incomplete incoming connection for the editor.
 * @param user Initial login name.
 * @param credentialRef DSH credential reference.
 * @returns An IMAP draft with the same defaults as configuration parsing.
 */
export function createReceiveDraft(user: string, credentialRef: string): NonNullable<Account['receive']> {
  return { protocol: 'imap', host: '', port: defaultPort('imap', 'direct'), tls: 'direct', auth: { user, credentialRef }, folders: ['INBOX'], ...receiveDefaults }
}

/** Create an incomplete outgoing connection for the editor.
 * @param user Initial login name.
 * @param credentialRef DSH credential reference.
 * @returns An SMTP draft.
 */
export function createSendDraft(user: string, credentialRef: string): NonNullable<Account['send']> {
  return { protocol: 'smtp', host: '', port: defaultPort('smtp', 'direct'), tls: 'direct', auth: { user, credentialRef } }
}

/** Create an incomplete mailbox for the guided editor.
 * @param id Account identity.
 * @returns A mailbox with a new shared credential reference.
 */
export function createAccountDraft(id: string): Account {
  const credentialRef = `DSH_MAIL_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`
  return { id, address: '', receive: createReceiveDraft('', credentialRef), send: createSendDraft('', credentialRef) }
}

/** Create a task rule whose Agent and model inherit DSH settings.
 * @param id Rule and template identity.
 * @param account Incoming account identity.
 * @param policy Sender-policy identity.
 * @param replyAccount Outgoing account identity.
 * @returns A draft requiring an allowed sender and result recipient.
 */
export function createRuleDraft(id: string, account: string, policy: string, replyAccount: string): Rule {
  return { id, account, priority: 0, authorization: { policy, allowedSenders: [] }, match: { subjectPrefix: '[DSH]' }, extract: {},
    task: { ...taskDefaults, template: id, attachmentTypes: [] }, reply: { account: replyAccount, to: '', on: [...replyStates] } }
}

/** Validate unfinished positive-integer text without replacing the user's draft.
 * @param text Text entered in a numeric control.
 * @returns Whether it represents a positive safe integer.
 */
export function validIntegerText(text: string): boolean { return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0 }
