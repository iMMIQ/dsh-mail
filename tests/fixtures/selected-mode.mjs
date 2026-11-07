// SPDX-License-Identifier: LGPL-3.0-or-later
/** A tool present only when the selected preset was restored. */
import { defineTool } from '@deepseek-ai/dsh-tools'
export const inject = ['tools']
export function apply(ctx) {
  ctx.tools.register(defineTool({ name: 'selected_mode_tool', description: 'Identify the selected fixture mode.', parameters: {},
    output: { schema: { type: 'string' }, render: value => [{ type: 'text', text: value }] },
    async execute() { return 'selected' }, presentCall: () => ({ card: 'generic', title: 'Selected mode', kind: 'other' }),
  }))
}
