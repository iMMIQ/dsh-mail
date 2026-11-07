// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { renderResult } from '../src/outbound.ts'
import { emailExample, notificationExample } from './email-fixture.ts'

test('both result alternatives use the configured directory when an older task has no selected directory', () => {
  const task = emailExample()
  delete task.workspacePath
  task.rule.task.workspacePath = '/srv/projects/older-task'
  const result = renderResult(task, 65_536)
  assert.match(result.text, /Working directory: \/srv\/projects\/older-task/)
  assert.ok(result.html?.includes('/srv/projects/older-task'))
})

for (const summary of ['Agent completed normally.', 'DSH turn completed.']) {
  test(`a business summary matching '${summary}' remains literal in both alternatives`, () => {
    const task = emailExample()
    task.summary = summary
    const result = renderResult(task, 65_536)
    assert.ok(result.text.includes(summary))
    assert.ok(result.html?.includes(summary))
    assert.ok(!result.html?.includes('本轮任务已完成，以下是 Agent 的最后回复。'))
  })
}

test('an automatic summary uses presentation defaults without storing their wording as business data', () => {
  const task = emailExample()
  task.summary = ''
  const execution = renderResult(task, 65_536)
  assert.match(execution.text, /Summary:\nAgent completed normally\./)
  assert.ok(execution.html?.includes('本轮任务已完成，以下是 Agent 的最后回复。'))
  const notice = notificationExample()
  notice.summary = ''
  const notification = renderResult(notice, 65_536)
  assert.match(notification.text, /Summary:\nDSH turn completed\./)
  assert.ok(notification.html?.includes('本轮任务已完成，以下是 Agent 的最后回复。'))
  task.mode = 'followup'
  assert.match(renderResult(task, 65_536).text, /Summary:\nAgent completed normally\./)
  assert.equal(task.summary, '')
})
