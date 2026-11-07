// SPDX-License-Identifier: LGPL-3.0-or-later
/** Synthetic report data shared by email snapshots and the local visual preview. */
import { taskSchema, type TaskRecord } from '../src/types.ts'
import { configuration } from './helpers.ts'

/** @param state State to illustrate. @returns A standalone email example without live credentials or user data. */
export function emailExample(state: TaskRecord['state'] = 'succeeded'): TaskRecord {
  const config = configuration('/srv/projects/example')
  return taskSchema.parse({ id: 'a'.repeat(64), mailId: 'b'.repeat(64), account: 'work', rule: config.rules[0],
    createdAt: Date.parse('2026-11-07T08:30:00Z'), prompt: '', title: '[Mail] [DSH] 示例：检查项目并补齐测试',
    sessionId: 'mail-example-session', messageId: 'example-input', workspacePath: '/srv/projects/example', originalMessageId: '<example@company.local>', references: [],
    state, summary: '示例报告：已完成项目检查，以下展示任务结果的邮件排版。', reason: state === 'succeeded' ? '' : 'example-diagnostic', attempt: 1,
    lastOutput: '## 本轮结果\n\n这是用于展示模板的**示例数据**，并非真实任务执行记录。\n\n- 梳理收发邮件的处理流程\n- 补充边界情况与回归测试\n- 保留现有配置和连续对话行为\n\n### 验证记录\n\n| 检查项 | 示例结果 |\n| --- | --- |\n| 类型检查 | 通过 |\n| 单元测试 | 通过 |\n| 邮件收发链路 | 通过 |\n\n### 后续操作\n\n```sh\nbun run check\n```\n\n你可以直接回复这封邮件，补充下一步要求。',
    report: { startedAt: Date.parse('2026-11-07T08:30:04Z'), finishedAt: Date.parse('2026-11-07T08:31:27Z'), steps: 4, turn: 2, provider: 'example', model: 'demo-model' },
    authorization: { sender: 'owner@example.com', policy: config.senderPolicies.trusted }, operations: [],
    outbox: { state: 'pending', messageId: '<example-result@company.local>', attempts: 0, nextAt: 0, subject: 'Re: 示例任务', text: '', reason: '' },
  })
}
