// SPDX-License-Identifier: LGPL-3.0-or-later
/** Standalone HTML email: inline layout, escaped metadata and sanitized Markdown output. */
import MarkdownIt from 'markdown-it'
import sanitizeHtml from 'sanitize-html'
import type { ResultReport } from './report.ts'

const states: Record<ResultReport['state'], { label: string; color: string; background: string }> = {
  succeeded: { label: '已完成', color: '#187249', background: '#e9f6ee' },
  failed: { label: '执行失败', color: '#b63736', background: '#fff0ee' },
  cancelled: { label: '已取消', color: '#586477', background: '#edf0f5' },
  timed_out: { label: '执行超时', color: '#9b620f', background: '#fff5df' },
  needs_attention: { label: '需要核对', color: '#9b620f', background: '#fff5df' },
  queued: { label: '已排队', color: '#365ea8', background: '#edf3ff' },
  starting: { label: '准备执行', color: '#365ea8', background: '#edf3ff' },
  running: { label: '执行中', color: '#365ea8', background: '#edf3ff' },
}
const styles: Record<string, string> = {
  p: 'margin:0 0 14px;line-height:1.8;',
  h1: 'font-size:23px;line-height:1.4;margin:24px 0 12px;font-weight:600;',
  h2: 'font-size:20px;line-height:1.5;margin:22px 0 12px;font-weight:600;',
  h3: 'font-size:17px;line-height:1.5;margin:20px 0 10px;font-weight:600;',
  h4: 'font-size:16px;margin:18px 0 10px;font-weight:600;',
  ul: 'padding-left:23px;margin:0 0 16px;', ol: 'padding-left:23px;margin:0 0 16px;', li: 'padding-left:3px;margin:5px 0;line-height:1.8;',
  pre: 'margin:16px 0;padding:16px;background:#f3f5f9;border:1px solid #e1e6ef;border-radius:8px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;',
  code: 'font-family:Consolas,Menlo,monospace;font-size:13px;line-height:1.7;',
  blockquote: 'margin:16px 0;padding:4px 0 4px 16px;border-left:3px solid #cad5e8;color:#586477;',
  table: 'border-collapse:collapse;width:100%;table-layout:fixed;margin:16px 0;font-size:14px;',
  th: 'border:1px solid #dfe5ee;padding:10px;text-align:left;background:#f3f5f9;font-weight:600;overflow-wrap:anywhere;',
  td: 'border:1px solid #dfe5ee;padding:10px;text-align:left;vertical-align:top;overflow-wrap:anywhere;',
  a: 'color:#365ea8;text-decoration:underline;overflow-wrap:anywhere;', hr: 'border:0;border-top:1px solid #e1e6ef;margin:22px 0;',
}
function escape(text: string): string { return text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!) }
function date(time: number): string { return `${new Date(time).toISOString().replace('T', ' ').slice(0, 19)} UTC` }
function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`
}
function row(label: string, value: string): string {
  return `<tr><td style="padding:8px 16px 8px 0;width:100px;vertical-align:top;color:#738096;font-size:13px;line-height:1.7;">${escape(label)}</td><td style="padding:8px 0;vertical-align:top;color:#344157;font-size:13px;line-height:1.7;word-break:break-word;overflow-wrap:anywhere;">${escape(value)}</td></tr>`
}
function markdown(text: string, renderer: InstanceType<typeof MarkdownIt>, inline = false): string {
  return sanitizeHtml(inline ? renderer.renderInline(text) : renderer.render(text), {
    allowedTags: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 's', 'br', 'pre', 'code', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'hr'],
    allowedAttributes: { '*': ['style'], a: ['href', 'title', 'rel', 'style'], ol: ['start', 'style'] },
    allowedSchemes: ['https', 'http', 'mailto'], allowProtocolRelative: false,
    transformTags: { '*': (tagName, attributes) => {
      const attribs: Record<string, string> = styles[tagName] ? { style: styles[tagName]! } : {}
      if (tagName === 'ol' && /^\d+$/.test(attributes.start ?? '')) attribs.start = attributes.start!
      if (tagName === 'a') {
        try {
          const url = new URL(attributes.href ?? '')
          if (['https:', 'http:', 'mailto:'].includes(url.protocol)) attribs.href = url.href
        } catch (_error) { /* Relative paths remain visible text, without a nonfunctional link. */ }
        if (attributes.title) attribs.title = attributes.title
        attribs.rel = 'noreferrer noopener'
      }
      return { tagName, attribs }
    } },
  })
}

/**
 * Render a complete result email. If the byte budget cannot fit its metadata, use plain text only.
 * @param report Resolved execution facts shared with the plain-text alternative.
 * @param maxBytes Maximum UTF-8 bytes for the HTML alternative, including layout and truncation copy.
 * @returns Safe, balanced HTML within the budget, or undefined when the layout cannot fit.
 */
export function replyHtml(report: ResultReport, maxBytes: number): string | undefined {
  const status = states[report.state]
  const title = report.title
  const renderer = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false })
  renderer.renderer.rules.image = (tokens, index) => escape(tokens[index]?.content ?? '')
  const elapsed = report.elapsedMs !== undefined ? duration(report.elapsedMs) : undefined
  const fields = [
    row('工作目录', report.workspacePath ?? '未记录'),
    ...(report.model ? [row('执行模型', report.model)] : []),
    ...(report.steps !== undefined ? [row('执行步数', String(report.steps))] : []),
    ...(report.startedAt !== undefined ? [row('开始时间', date(report.startedAt))] : []),
    ...(report.finishedAt !== undefined ? [row('结束时间', date(report.finishedAt))] : []),
    row('会话编号', report.sessionId), row('任务编号', report.taskId),
    ...(report.turn !== undefined ? [row('会话轮次', String(report.turn))] : []),
    ...(report.reason ? [row('诊断信息', report.reason)] : []),
  ].join('')
  const summary = report.summary || (report.state === 'succeeded' ? '本轮任务已完成，以下是 Agent 的最后回复。' : '执行结果见下方回复。')
  const output = report.output.trim() || '本轮没有记录到 Agent 的文字输出，请在 DSH 会话中查看执行情况。'
  const build = (body: string, shortened: boolean): string => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(title)}</title></head>
<body style="margin:0;padding:0;background:#f2f5fa;color:#233047;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escape(`${status.label} · ${title}`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#f2f5fa;"><tr><td align="center" style="padding:28px 12px;">
<!--[if mso]><table role="presentation" width="680" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:680px;"><tr><td style="padding:0 4px 18px;color:#5d6b82;font-size:13px;letter-spacing:1px;"><strong style="color:#263b60;font-size:18px;letter-spacing:0;">DSH</strong><span style="padding-left:12px;">任务执行报告</span></td></tr>
<tr><td style="background:#ffffff;border:1px solid #e0e6ef;border-radius:14px;overflow:hidden;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;"><tr><td style="padding:28px 26px 24px;border-top:4px solid ${status.color};border-bottom:1px solid #e8edf4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td><span style="display:inline-block;padding:5px 12px;border-radius:6px;background:${status.background};color:${status.color};font-size:13px;font-weight:600;">${status.label}</span></td>${elapsed ? `<td align="right" style="font-size:13px;color:#738096;">用时 ${escape(elapsed)}</td>` : ''}</tr></table>
<h1 style="margin:18px 0 10px;font-size:25px;line-height:1.45;letter-spacing:-0.3px;font-weight:600;color:#172b4d;word-break:break-word;overflow-wrap:anywhere;">${escape(title)}</h1>
<p style="margin:0;font-size:14px;line-height:1.8;color:#64718a;white-space:pre-wrap;overflow-wrap:anywhere;">${markdown(summary, renderer, true)}</p></td></tr>
<tr><td style="padding:26px;color:#27364d;font-size:15px;line-height:1.8;word-break:break-word;overflow-wrap:anywhere;"><p style="margin:0 0 18px;font-size:12px;font-weight:600;color:#738096;letter-spacing:1px;">AGENT 最后回复</p>${markdown(body, renderer)}${shortened ? '<p style="margin:20px 0 0;padding:12px 14px;background:#fff5df;border:1px solid #f1dfb4;border-radius:6px;font-size:13px;line-height:1.7;color:#866018;">内容较长，邮件仅展示部分结果。完整输出请在下方编号对应的 DSH 会话中查看。</p>' : ''}</td></tr>
<tr><td style="padding:22px 26px;background:#f8fafd;border-top:1px solid #e8edf4;"><p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#50617b;">执行信息</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;table-layout:fixed;">${fields}</table></td></tr></table></td></tr>
<tr><td style="padding:20px 12px 8px;font-size:12px;line-height:1.9;text-align:center;color:#7c889b;">直接回复这封邮件，即可继续当前会话。<br>请将新增要求写在历史引用上方。</td></tr></table>
<!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`
  const source = output.slice(0, maxBytes).replace(/[\uD800-\uDBFF]$/, '')
  const complete = build(source, source.length < output.length)
  if (Buffer.byteLength(complete) <= maxBytes) return complete
  let low = 0
  let high = source.length
  let best = build('', true)
  if (Buffer.byteLength(best) > maxBytes) return undefined
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const prefix = output.slice(0, length).replace(/[\uD800-\uDBFF]$/, '')
    const candidate = build(prefix, true)
    if (Buffer.byteLength(candidate) <= maxBytes) { best = candidate; low = length + 1 }
    else high = length - 1
  }
  return best
}
