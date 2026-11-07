// SPDX-License-Identifier: LGPL-3.0-or-later
/** Strict metadata for the mail configuration page's two read-only Remote methods. */
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { mailStatusSchema, connectionCheckSchema } from './ui-types.ts'

const account = { mode: 'strict' as const, typeSymbol: 'dsh-mail#accountId', create: () => z.string().regex(/^[a-z][a-z0-9-]*$/) }

/** Exact methods the UI can invoke; there is no credential read or mail-send endpoint. */
export const TYPERT_REMOTE = createTypertRemoteInfo({ package: 'dsh-mail', methods: {
  'mailAutomation/getStatus': { service: 'mailAutomation', invocation: { kind: 'direct' }, parameters: [], result: {
    mode: 'strict', typeSymbol: 'dsh-mail#status', create: () => mailStatusSchema,
  } },
  'mailAutomation/checkConnection': { service: 'mailAutomation', invocation: { kind: 'direct' },
    parameters: [{ name: 'accountId', source: 'json', codec: account, strictCodec: account }], result: {
      mode: 'strict', typeSymbol: 'dsh-mail#check', create: () => connectionCheckSchema,
    },
  },
} }, z)

/** Consumer registration owned by the page's Cordis fiber. */
const contribution: TypertRemoteContribution = { package: 'dsh-mail', get descriptors() { return TYPERT_REMOTE.descriptors } }
export default contribution
