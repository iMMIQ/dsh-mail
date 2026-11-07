// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import Pop3 from 'node-pop3'
import { waitFor } from './network.ts'
import { pop3Server } from './pop3-network.ts'

test('POP3 dependency preserves MIME octets and CRLF across every two-part response split', async () => {
  const raw = Buffer.from([46, 102, 105, 114, 115, 116, 13, 10, 233, 255, 128, 13, 10])
  const wire = Buffer.concat([Buffer.from('.'), raw, Buffer.from('.\r\n')])
  for (let split = 1; split < wire.length; split++) {
    const client = new Pop3({ host: 'unused', user: '', password: '' })
    const stream = client._updateStream()
    client._pushStream(wire.subarray(0, split))
    client._pushStream(wire.subarray(split))
    assert.equal(client._stream, null, `response ends at split ${split}`)
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk)
    assert.deepEqual(Buffer.concat(chunks), raw, `original bytes at split ${split}`)
  }
})

test('closing the POP3 dependency settles an interrupted STLS handshake and drains every socket', async () => {
  await using resources = new AsyncDisposableStack()
  const server = await pop3Server(resources, 'starttls')
  server.behavior.stallHandshake = true
  const client = new Pop3({ host: '127.0.0.1', port: server.port, user: '', password: '', tlsOptions: { ca: server.ca } })
  resources.defer(() => client.close())
  await client.connect()
  const upgrading = assert.rejects(client.STLS())
  await waitFor(() => server.handshakeSeen(), () => 'TLS ClientHello received')
  await client.close()
  await upgrading
  await waitFor(() => server.sockets.size === 0, () => 'interrupted TLS socket drained')
})
