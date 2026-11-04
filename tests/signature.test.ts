// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createSocket } from 'node:dgram'
import { generateKeyPairSync } from 'node:crypto'
import { dkimSign } from 'mailauth'
import { message } from './helpers.ts'

test('local DKIM accepts a real aligned whole-message signature and rejects tampering and unsigned routing headers', async () => {
  await using t = new AsyncDisposableStack()
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  const dns = createSocket('udp4')
  await new Promise<void>(resolve => dns.bind(0, '127.0.0.1', resolve))
  t.defer(() => new Promise<void>(resolve => dns.close(resolve)))
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
  const raw = message()
  // DKIM DNS resolution runs in the same Node host as the installed DSH plugin.
  const verify = async (input: Buffer): Promise<void> => {
    const node = Bun.which(process.env.DSH_TEST_NODE ?? 'node')
    if (!node) throw new Error('Install a Node.js host compatible with the selected DSH version')
    const probe = Bun.spawn([node, 'tests/fixtures/verify-signature.mjs'], {
      stdin: new Response(JSON.stringify({ raw: input.toString('base64'), policy })).body,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    await using resources = new AsyncDisposableStack()
    resources.defer(async () => { if (probe.exitCode === null) probe.kill(); await probe.exited })
    const [stdout, stderr, code] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited])
    assert.equal(stderr, '', `Signature probe failed: ${stderr}`)
    assert.equal(code, 0, `Signature verification rejected: ${stdout}`)
  }
  const sign = async (headerList: string[]): Promise<Buffer> => {
    const signed = await dkimSign(raw, { headerList, signatureData: [{ signingDomain: 'example.com', selector: 'fixture', privateKey: keys.privateKey }] })
    assert.equal(signed.errors?.length ?? 0, 0)
    return Buffer.concat([Buffer.from(signed.signatures), raw])
  }
  const whole = await sign(['From', 'To', 'Subject', 'Message-ID'])
  await verify(whole)
  const tampered = Buffer.from(whole.toString().replace('Summarize the repository.', 'Delete the repository.'))
  await assert.rejects(verify(tampered), /signature-invalid-or-unaligned/)
  const unsignedSubject = await sign(['From', 'To', 'Message-ID'])
  await assert.rejects(verify(unsignedSubject), /signature-invalid-or-unaligned/)
})
