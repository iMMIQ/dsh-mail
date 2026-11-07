// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'bun:test'
import { replyHtml } from '../src/email-template.ts'
import { prepareReport } from '../src/report.ts'
import { emailExample } from './email-fixture.ts'
import { fixture } from './helpers.ts'

test('result email presents its state, Markdown response and observed execution details', async () => {
  const task = emailExample()
  const html = replyHtml(prepareReport(task), 65_536)!
  assert.equal(`${html}\n`, await readFile(new URL('./snapshots/mail-result.html', import.meta.url), 'utf8'))
  for (const text of ['已完成', '用时 1 分 23 秒', '执行信息', 'demo-model', task.workspacePath!, task.sessionId, task.id, '2026-11-07 08:31:27 UTC', '直接回复这封邮件']) assert.ok(html.includes(text), text)
  assert.match(html, /<table[^>]*style="border-collapse/)
  assert.match(html, /<pre style=/)
  assert.doesNotMatch(html, /<img\b|<script\b|<link\b/)
})

test('email rendering escapes metadata, filters active links and does not load Markdown images', () => {
  const task = emailExample()
  task.title = '<img src=x onerror=alert(1)>'
  task.summary = '<script>alert(2)</script>'
  task.lastOutput = '[bad](javascript:alert(1)) [relative](/private) [safe](https://example.com/report)\n\n![hidden tracker](https://example.com/pixel.png)\n\n<iframe src="https://example.com"></iframe>\n\n```html\n<script>code sample</script>\n```'
  const html = replyHtml(prepareReport(task), 65_536)!
  assert.doesNotMatch(html, /<(?:script|img|iframe)\b|href="(?:javascript:|data:|file:|\/)/i)
  assert.match(html, /href="https:\/\/example.com\/report"/)
  assert.match(html, /&lt;script&gt;code sample&lt;\/script&gt;/)
  assert.match(html, /&lt;img/)
})

test('long Unicode results stay within the HTML byte limit without cutting the document', () => {
  const task = emailExample()
  task.lastOutput = '结果🙂 **示例**\n'.repeat(10_000)
  const html = replyHtml(prepareReport(task), 8_192)!
  assert.ok(html)
  assert.ok(Buffer.byteLength(html) <= 8_192)
  assert.match(html, /内容较长/)
  assert.ok(html.endsWith('</html>'))
  assert.doesNotMatch(html, /\uFFFD/)
  assert.equal(replyHtml(prepareReport(task), 1_024), undefined)
})

test('missing execution facts are omitted rather than displayed as invented metrics', () => {
  const task = emailExample('needs_attention')
  delete task.report
  task.lastOutput = ''
  const html = replyHtml(prepareReport(task), 65_536)!
  assert.match(html, /需要核对/)
  assert.match(html, /没有记录到 Agent 的文字输出/)
  assert.doesNotMatch(html, /用时|执行步数|执行模型|开始时间|结束时间/)
})

for (const [state, label] of [['failed', '执行失败'], ['cancelled', '已取消'], ['timed_out', '执行超时']] as const) {
  test(`email reports ${state} with the retained last output`, () => {
    const html = replyHtml(prepareReport(emailExample(state)), 65_536)!
    assert.ok(html.includes(label))
    assert.match(html, /example-diagnostic/)
    assert.match(html, /本轮结果/)
  })
}

test('HTML is frozen with settlement and stays identical across SMTP retries', async () => {
  await using resources = new AsyncDisposableStack()
  const bodies: (string | undefined)[] = []
  const f = await fixture(resources, { async send(message) {
    bodies.push(message.html)
    return bodies.length === 1 ? { state: 'failed', retryable: true, reason: 'temporary' } : { state: 'accepted' }
  } })
  await f.runtime.admit(f.delivery()); await f.finish()
  f.advance(); await f.runtime.tick()
  assert.equal(bodies.length, 2)
  assert.ok(bodies[0])
  assert.equal(bodies[1], bodies[0])
  assert.equal(f.store.tasks()[0]!.outbox.state, 'accepted')
})

test('restart recovery does not invent the end time or elapsed execution duration', async () => {
  await using resources = new AsyncDisposableStack()
  const f = await fixture(resources)
  await f.runtime.admit(f.delivery()); await f.finish()
  const previous = f.store.tasks()[0]!
  await f.store.putTask({ ...previous, state: 'running', report: { startedAt: previous.createdAt, steps: 2 } })
  await f.runtime.initialize()
  const recovered = f.store.tasks()[0]!
  assert.equal(recovered.state, 'needs_attention')
  assert.equal(recovered.report?.finishedAt, undefined)
  assert.doesNotMatch(recovered.outbox.html!, /用时|结束时间/)
})

test('Markdown in the concise summary is rendered as inline formatting', () => {
  const task = emailExample()
  task.summary = '**摘要完成**，请查看 `report.md`。'
  const html = replyHtml(prepareReport(task), 65_536)!
  assert.match(html, /<strong>摘要完成<\/strong>/)
  assert.match(html, /<code style="[^"]+">report.md<\/code>/)
})
