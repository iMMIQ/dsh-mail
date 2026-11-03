// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSocket } from 'node:dgram'
import { generateKeyPairSync } from 'node:crypto'
import { dkimSign } from 'mailauth'
import { parseMail } from '../src/mail.ts'
import { verifySender } from '../src/auth.ts'
import { configuration, message } from './helpers.ts'

test('local DKIM accepts a real aligned whole-message signature and rejects tampering and unsigned routing headers', async t => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  const dns = createSocket('udp4')
  await new Promise<void>(resolve => dns.bind(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => dns.close(resolve)))
  const value = `v=DKIM1; k=rsa; p=${keys.publicKey.toString('base64')}`
  // This fixture answers the library's TXT lookup with a single record split into DNS character strings.
  dns.on('message', (query, remote) => {
    let end = 12
    while (query[end]) end += query[end]! + 1
    end += 5
    const header = Buffer.from(query.subarray(0, end))
    header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 6); header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10)
    const pieces: Buffer[] = []
    for (let offset = 0; offset < value.length; offset += 255) {
      const part = Buffer.from(value.slice(offset, offset + 255))
      pieces.push(Buffer.from([part.length]), part)
    }
    const text = Buffer.concat(pieces)
    const answer = Buffer.alloc(12)
    answer.writeUInt16BE(0xc00c, 0); answer.writeUInt16BE(16, 2); answer.writeUInt16BE(1, 4); answer.writeUInt32BE(60, 6); answer.writeUInt16BE(text.length, 10)
    dns.send(Buffer.concat([header, answer, text]), remote.port, remote.address)
  })
  const address = dns.address()
  const policy = { evidence: 'local-signature' as const, dnsServers: [`127.0.0.1:${address.port}`] }
  const config = configuration('/tmp/parser-only')
  const raw = message()
  const sign = async (headerList: string[]): Promise<Buffer> => {
    const signed = await dkimSign(raw, { headerList, signatureData: [{ signingDomain: 'example.com', selector: 'fixture', privateKey: keys.privateKey }] })
    assert.equal(signed.errors?.length ?? 0, 0)
    return Buffer.concat([Buffer.from(signed.signatures), raw])
  }
  const whole = await sign(['From', 'To', 'Subject', 'Message-ID'])
  await verifySender(whole, await parseMail(whole, config.runtime), policy, new AbortController().signal, 1_000)
  const tampered = Buffer.from(whole.toString().replace('Summarize the repository.', 'Delete the repository.'))
  await assert.rejects(verifySender(tampered, await parseMail(tampered, config.runtime), policy, new AbortController().signal, 1_000))
  const unsignedSubject = await sign(['From', 'To', 'Message-ID'])
  await assert.rejects(verifySender(unsignedSubject, await parseMail(unsignedSubject, config.runtime), policy, new AbortController().signal, 1_000))
})
