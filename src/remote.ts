// SPDX-License-Identifier: LGPL-3.0-or-later
/** Strict Remote descriptors shared by the Host and browser across DSH 0.2 releases. */
import { z } from 'zod'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

/** The UI's two read-only endpoints; authorization codes use DSH's credential service. */
export const TYPERT_REMOTE: TypertRemoteContribution = { package: 'dsh-mail', descriptors: [
  { id: 'dsh-mail#mailAutomation/getStatus', service: 'mailAutomation', namespace: 'mailAutomation', method: 'getStatus',
    invocation: { kind: 'direct' }, parameters: [], result: {
      mode: 'strict', typeSymbol: 'dsh-mail#status', create: () => z.object({ phase: z.enum(['paused', 'running', 'changing', 'error']), health: z.record(z.string(), z.string()) }),
    },
  },
  { id: 'dsh-mail#mailAutomation/checkConnection', service: 'mailAutomation', namespace: 'mailAutomation', method: 'checkConnection',
    invocation: { kind: 'direct' }, parameters: [{ name: 'accountId', wire: 'accountId', source: 'json', codec: {
      mode: 'strict', typeSymbol: 'dsh-mail#accountId', create: () => z.string().regex(/^[a-z][a-z0-9-]*$/),
    } }], result: {
      mode: 'strict', typeSymbol: 'dsh-mail#check', create: () => z.object({ imap: z.enum(['ok', 'failed', 'absent']), smtp: z.enum(['ok', 'failed', 'absent']) }),
    },
  },
] }

export default TYPERT_REMOTE
