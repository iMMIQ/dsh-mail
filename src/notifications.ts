// SPDX-License-Identifier: LGPL-3.0-or-later
/** Observe root turns without owning their Agents or changing their execution. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { MailRuntime } from './runtime.ts'

interface Turn { turn: number; mail: boolean; lastOutput: string; finalText: string }

/** Fold just the current turn; historical input and reasoning are never copied into notices. */
function observe(turns: Map<SessionId, Turn>, header: SessionHeader, event: SessionEvent) {
  if (header.origin === 'subagent') return
  if (event.type === 'turn/start') turns.set(header.id, { turn: event.data.turn, mail: false, lastOutput: '', finalText: '' })
  const turn = turns.get(header.id)
  if (!turn) return
  if (event.type === 'user/message' && event.data.source?.kind === 'dsh-mail') turn.mail = true
  if (event.type === 'assistant/message') {
    const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
    if (text) turn.lastOutput = text
    turn.finalText = event.data.message.content.some(block => block.type === 'tool-call') ? '' : text
  }
  if (event.type !== 'turn/end') return
  turns.delete(header.id)
  if (turn.mail || event.data.turn !== turn.turn) return
  const kind = event.data.reason.kind
  const state = kind === 'completed' && turn.finalText ? 'succeeded' as const
    : kind === 'error' ? 'failed' as const : kind === 'aborted' ? 'cancelled' as const : 'needs_attention' as const
  return { sessionId: header.id, turn: turn.turn,
    ...(header.cwd ? { workspacePath: header.cwd } : {}), state, lastOutput: turn.lastOutput, reason: state === 'succeeded' ? '' : `turn-${kind}` }
}

/** Event subscriptions and their queued durability work share the runtime's lifetime. */
export class SessionNotifications {
  private readonly turns = new Map<SessionId, Turn>()
  private pending: Promise<void> = Promise.resolve()
  private readonly off: () => void
  private readonly offDisposed: () => void
  constructor(private readonly ctx: Context, private readonly runtime: MailRuntime) {
    this.off = ctx.on('session/event', (session, event) => {
      const finished = observe(this.turns, session.header, event)
      if (!finished) return
      const input = { ...finished, title: ctx.sessionTitle.get(session)?.title ?? session.id }
      this.pending = this.pending.then(async () => {
        if (!await ctx.sessions.flush(session)) throw new Error('Session persistence unavailable; notification was not sent')
        await runtime.notifySession(input)
      }).catch(error => { ctx.logger.error('DSH mail notification could not be recorded; inspect mail-status and the original session', error) })
    })
    this.offDisposed = ctx.on('session/disposed', session => { this.turns.delete(session.id) })
  }
  /** Recover persisted turn endings after observation began; stable turn ids suppress duplicates. */
  async start(): Promise<void> {
    const epoch = await this.runtime.notificationEpoch()
    for (const stored of await this.ctx.sessionPersistence.list()) {
      if (stored.header.origin === 'subagent') continue
      if ('formatStatus' in stored && stored.formatStatus === 'migration-required') {
        this.ctx.logger.warn(`Mail notification recovery skipped session ${stored.header.id}; migrate it in DSH before continuing`)
        continue
      }
      await using reader = await this.ctx.sessionPersistence.open(stored.header.id, 'read')
      const { events } = await reader.read()
      const turns = new Map<SessionId, Turn>()
      for (const event of events.slice(reader.inheritedEventCount)) {
        const finished = observe(turns, reader.header, event)
        if (finished && event.time >= epoch) await this.runtime.notifySession({ ...finished, title: reader.header.id })
      }
    }
  }
  /** Stop observation and drain committed-turn notifications before runtime storage closes. */
  async close(): Promise<void> { this.off(); this.offDisposed(); this.turns.clear(); await this.pending }
}
