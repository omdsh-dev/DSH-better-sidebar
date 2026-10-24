/**
 * Side-chat live push behind `/sidebar/ws/sidechat`.
 *
 * The side-chat transcript used to learn about new rows only by polling
 * `sidechat.events` every 2s while the thread ran, so a streaming answer, the
 * claim of a just-sent message, or a finished tool call could sit invisible for
 * up to two seconds. The host already knows the moment either happens: the
 * session append feed (`session/event`) carries every durable row, and the
 * process-local `agent/assistant-stream` frames carry in-flight model deltas
 * (they are deliberately NOT logged — see assistant-live.ts).
 *
 * This hub turns both feeds into per-thread INVALIDATION notices. A notice
 * never carries event bodies: the client re-pulls `sidechat.events` with its
 * `afterSeq`, so the transcript transport, its tail cap and its delta logic are
 * unchanged, a dropped socket self-heals, and there is exactly one source of
 * truth for what a thread contains.
 *
 * Two coalescing windows, shortest first: a durable append is worth telling the
 * reader about almost immediately (60ms), while stream deltas arrive tens of
 * times a second and are folded into one notice per 250ms — each notice costs
 * the client a pull that re-sends the CURRENT attempt's chunks, so faster would
 * only burn bandwidth.
 * @module dsh-better-sidebar/sidechat-push
 */
import type { WebSocket } from 'ws'
import type { Context } from './context-types.ts'

/** Coalescing window for durable session appends. */
const DURABLE_DEBOUNCE_MS = 60
/** Coalescing window for in-flight model deltas. */
const STREAM_DEBOUNCE_MS = 250
/** Thread ids one socket may watch (a resource guard, not a policy). */
const MAX_WATCHED = 64

/** One frame the host pushes: the thread whose transcript is stale. */
export interface SidechatPushFrame {
  threadId: string
}

/** The frame the client sends to replace its watch set. */
interface WatchFrame {
  op?: unknown
  threadIds?: unknown
}

/** The host-side push hub: one set of feeds, any number of sockets. */
export interface SidechatPushHub {
  /** Attach one accepted socket (reads its watch frames, pushes notices). */
  attach(ws: WebSocket): void
  /** Release the session feeds (socket teardown stays with the server). */
  dispose(): void
}

/**
 * Register the side-chat push feeds.
 * @param ctx - host plugin context (its `on` subscribes the append feed).
 * @returns the hub plus a disposer unbinding both listeners.
 */
export function createSidechatPushHub(ctx: Context): SidechatPushHub {
  const sockets = new Set<SidechatSocket>()
  if (typeof ctx.on !== 'function') {
    // Test doubles without the event API still accept sockets, which then
    // simply never hear anything.
    return { attach: () => {}, dispose: () => {} }
  }
  const offEvent = ctx.on('session/event', (session) => {
    const sessionId = (session as { id?: unknown } | null)?.id
    if (typeof sessionId !== 'string') return
    for (const socket of sockets) socket.notify(sessionId, DURABLE_DEBOUNCE_MS)
  })
  const offStream = ctx.on('agent/assistant-stream', (payload) => {
    const record = payload as { agent?: unknown } | null
    const session = (record?.agent as { session?: { id?: unknown } } | undefined)?.session
    const sessionId = typeof session?.id === 'string' ? session.id : undefined
    if (sessionId === undefined) return
    for (const socket of sockets) socket.notify(sessionId, STREAM_DEBOUNCE_MS)
  })
  return {
    attach: (ws) => {
      const socket = new SidechatSocket(ws, () => { sockets.delete(socket) })
      sockets.add(socket)
    },
    dispose: () => {
      offEvent()
      offStream()
      for (const socket of sockets) socket.close()
      sockets.clear()
    },
  }
}

/** One attached socket's watch set and per-thread coalescing timers. */
class SidechatSocket {
  private readonly socket: WebSocket
  private readonly onClosed: () => void
  private readonly watched = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private closed = false

  /**
   * @param socket - the accepted WebSocket.
   * @param onClosed - hub-side cleanup (idempotent).
   */
  constructor(socket: WebSocket, onClosed: () => void) {
    this.socket = socket
    this.onClosed = onClosed
    socket.on('message', (data: unknown) => { this.onMessage(data) })
    socket.on('close', () => { this.close() })
    socket.on('error', () => { this.close() })
  }

  /** Apply one client frame (an unparseable frame is ignored, never fatal). */
  private onMessage(data: unknown): void {
    let frame: WatchFrame
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data)) as WatchFrame
    } catch {
      return
    }
    if (frame === null || typeof frame !== 'object' || frame.op !== 'watch') return
    const ids = Array.isArray(frame.threadIds)
      ? frame.threadIds.filter((id): id is string => typeof id === 'string' && id !== '')
      : []
    this.watched.clear()
    for (const id of ids.slice(0, MAX_WATCHED)) this.watched.add(id)
    // Threads no longer watched drop their pending notice with their timer.
    for (const [id, timer] of this.timers) {
      if (this.watched.has(id)) continue
      clearTimeout(timer)
      this.timers.delete(id)
    }
  }

  /**
   * Coalesce one notice for a thread. The FIRST trigger's window wins, so a
   * burst of deltas never postpones the notice it already scheduled.
   * @param threadId - the session whose transcript is stale.
   * @param delayMs - coalescing window for this trigger.
   */
  notify(threadId: string, delayMs: number): void {
    if (this.closed || !this.watched.has(threadId) || this.timers.has(threadId)) return
    this.timers.set(threadId, setTimeout(() => {
      this.timers.delete(threadId)
      this.send({ threadId })
    }, delayMs))
  }

  /** Push one notice (silently dropped once the socket is gone). */
  private send(frame: SidechatPushFrame): void {
    if (this.closed) return
    try {
      this.socket.send(JSON.stringify(frame))
    } catch {
      // A send on a dying socket is expected; the close handler cleans up.
    }
  }

  /** Release every timer and de-register (idempotent). */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.watched.clear()
    this.onClosed()
  }
}
