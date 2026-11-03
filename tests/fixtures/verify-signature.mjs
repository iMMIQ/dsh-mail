// SPDX-License-Identifier: LGPL-3.0-or-later
/** Verify DKIM through the built plugin in its required DSH Node host. */
import { verifySender } from '../../lib/auth.js'
import { parseMail } from '../../lib/mail.js'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const { raw: encoded, policy } = JSON.parse(Buffer.concat(chunks).toString())
const raw = Buffer.from(encoded, 'base64')
try {
  const mail = await parseMail(raw, { maxMessageBytes: raw.length, maxAttachments: 0, maxAttachmentBytes: 1 })
  await verifySender(raw, mail, policy, AbortSignal.timeout(1_000), 1_000)
} catch (error) {
  process.stdout.write(error.code ?? error.message)
  process.exitCode = 1
}
