/**
 * Live invalidation push for Side Chat transcripts.
 *
 * The transcript used to advance on a 2s poll while the thread ran, so a
 * claimed message, a settled assistant message or a finished tool call became
 * visible up to two seconds after the host wrote it. DSH's agent pipeline
 * offers no client-side event feed for a hidden child session, so the plugin
 * carries its own channel: one socket per mounted side-chat tab, watching the
 * single thread that tab is bound to.
 *
 * The host's frames are INVALIDATION ONLY — `{ threadId, running? }` says
 * "this thread's transcript is stale, re-pull `sidechat.events` with your
 * afterSeq". No event body ever crosses this socket, so the existing delta
 * pull stays the single source of transcript data and a dropped socket
 * self-heals through the same pull (plus the slow fallback poll).
 *
 * Lifecycle mirrors use-dir-watch: one socket for the component's lifetime
 * while the tab is VISIBLE, a full `watch` frame re-announcing the
 * subscription set whenever the id list changes, exponential backoff
 * (1s → 15s) on a drop, and no socket at all while the list is empty or the
 * tab is parked. The host keeps every visited tab body mounted, so an un-gated
 * subscription would leave one socket per side-chat tab the reader ever
 * opened — and a notice delivered to a parked tab re-pulled a transcript
 * nobody could see. A parked tab therefore closes its socket, and a late frame
 * from that dead socket is dropped (`closed`) instead of triggering a pull.
 */
import { useEffect, useMemo, useRef } from 'react'
import { hostWebSocketUrl } from './host-route-url.ts'

/** One host frame: a watched thread whose transcript is stale. `running` is
 *  the host's own run-state hint; it is deliberately not read here — the
 *  panel re-reads both the transcript and `sidechat.info` on every notice. */
interface SidechatPushFrame {
  threadId?: unknown
  running?: unknown
}

/** What the view hands the hook. */
export interface SidechatPushOptions {
  /** Threads to watch; an empty list closes the socket entirely. */
  threadIds: readonly string[]
  /**
   * Whether the owning tab is on screen. Defaults to true; a parked tab has
   * no socket, and coming back re-subscribes and re-pulls once.
   */
  visible?: boolean
  /**
   * A watched thread whose transcript should be re-pulled.
   * @param threadId - the thread the host named, always one of `threadIds`.
   */
  onInvalidate: (threadId: string) => void
}

/** How long to wait before re-opening a dropped socket; failures back off to the cap. */
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15_000

/**
 * Follow the host's staleness notices for the given side-chat threads.
 * @param options - the watched ids, the tab's visibility, and the invalidation callback.
 */
export function useSidechatPush(options: SidechatPushOptions): void {
  const { threadIds, visible = true, onInvalidate } = options
  // The id list is a fresh array on every render, so neither the socket effect
  // nor the invalidation callback may depend on its identity. The CONTENT key
  // (NUL-joined — no session id can contain one) is what everything derives
  // from, exactly like use-dir-watch's expanded set.
  const idsKey = threadIds.join('\u0000')
  const wanted = useMemo(() => (idsKey === '' ? [] : idsKey.split('\u0000')), [idsKey])
  const wantedRef = useRef(wanted)
  wantedRef.current = wanted
  const invalidateRef = useRef(onInvalidate)
  invalidateRef.current = onInvalidate
  /** Set by the socket effect; re-announces the current subscription set. */
  const reconcileRef = useRef<() => void>(() => {})
  /**
   * Stable dependency: re-open the socket only when it gains or loses every
   * id — or when the tab is parked/shown. Visibility is an INPUT here rather
   * than a second mechanism, so a parked tab is simply "not subscribed".
   */
  const subscribed = visible && idsKey !== ''

  useEffect(() => {
    if (!subscribed) return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    let failures = 0

    /** Push this socket's whole subscription set (a full replacement). */
    const reconcile = (): void => {
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ op: 'watch', threadIds: [...wantedRef.current] }))
      }
    }
    reconcileRef.current = reconcile

    const connect = (): void => {
      if (closed) return
      socket = new WebSocket(hostWebSocketUrl('sidebar/ws/sidechat').toString())
      socket.onopen = () => {
        failures = 0
        reconcile()
      }
      socket.onmessage = (event) => {
        // A frame from the socket this effect already tore down (the tab was
        // parked, the ids emptied) must not re-pull: the transcript it names
        // is not on screen any more.
        if (closed) return
        if (typeof event.data !== 'string') return
        let frame: SidechatPushFrame
        try {
          frame = JSON.parse(event.data) as SidechatPushFrame
        } catch {
          return
        }
        if (frame === null || typeof frame !== 'object' || typeof frame.threadId !== 'string') return
        // Only watched ids: a frame for a thread this socket no longer
        // subscribes to is a late notice, not an invalidation.
        if (!wantedRef.current.includes(frame.threadId)) return
        invalidateRef.current(frame.threadId)
      }
      socket.onclose = () => {
        if (closed) return
        failures += 1
        retry = window.setTimeout(connect, Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS))
      }
    }
    connect()

    return () => {
      closed = true
      reconcileRef.current = () => {}
      if (retry !== undefined) window.clearTimeout(retry)
      socket?.close()
    }
  }, [subscribed])

  // A subscription change on the SAME socket only re-sends the watch frame.
  useEffect(() => {
    void idsKey
    reconcileRef.current()
  }, [idsKey])

  /**
   * Shown again after being parked: the socket is new (nothing the host
   * noticed in between was delivered), so the transcript may have moved. Pull
   * once through the same invalidation path the host's own frames use.
   */
  const wasSubscribedRef = useRef(subscribed)
  useEffect(() => {
    const previous = wasSubscribedRef.current
    wasSubscribedRef.current = subscribed
    if (!subscribed || previous) return
    for (const id of wantedRef.current) invalidateRef.current(id)
  }, [subscribed])
}
