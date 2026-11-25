/**
 * `useScrollLoad`: fetch the next page when the end sentinel approaches.
 *
 * The hook is deliberately caller-driven: it never owns a cursor, a page
 * store or an in-flight latch. It only answers "the reader is near the end
 * and the owner says another page exists" by invoking `onLoad`; the owner's
 * synchronous in-flight guard is the single authority on duplicate requests.
 *
 * Three independent paths keep a list filled:
 * - an IntersectionObserver on the sentinel, rooted at the scroll box;
 * - a scroll listener on that box as the fallback (and the only path where
 *   IntersectionObserver is unavailable);
 * - one short-list fill at effect time, skipped while the box has no layout
 *   (a hidden native-tab body reports `clientHeight === 0`).
 *
 * The effect is torn down when `enabled`/`hasMore` goes false, `loading`
 * changes, or the component unmounts. `version` is the owner's re-arm key: a
 * new page (or a filter reset) bumps it so the observer is recreated and the
 * sentinel is evaluated again.
 */
import { useEffect, useRef, type RefObject } from 'react'

/** Props of {@link useScrollLoad}. */
export interface ScrollLoadOptions {
  /** The scrolling element; also the IntersectionObserver root. */
  scrollRef: RefObject<HTMLElement>
  /** The end sentinel placed after the last row. */
  sentinelRef: RefObject<HTMLElement>
  /** Whether the surface is visible. False disconnects every listener. */
  enabled: boolean
  /** The owner reports another page exists. False stops all loading. */
  hasMore: boolean
  /** A request is in flight; callbacks are suppressed until it clears. */
  loading: boolean
  /** Request the next page. The owner must synchronously latch its own guard. */
  onLoad: () => void
  /**
   * Re-arm key: change it after a page arrives (or the query resets) so the
   * observer is recreated even when `hasMore` stays true.
   */
  version?: string | number
}

/** How far before the end the next page is requested. */
const PRELOAD_PX = 100
const ROOT_MARGIN = '100px'

/** Load one more page when the end sentinel becomes visible. */
export function useScrollLoad(options: ScrollLoadOptions): void {
  const { scrollRef, sentinelRef, enabled, hasMore, loading, version } = options
  // The callback rides a ref so a fresh parent closure alone never re-creates
  // the observer; the owner's data changes do, through the deps below.
  const loadRef = useRef(options.onLoad)
  loadRef.current = options.onLoad

  useEffect(() => {
    if (!enabled || !hasMore) return
    const scroll = scrollRef.current
    const sentinel = sentinelRef.current
    if (scroll === null || sentinel === null) return

    let disposed = false
    const maybeLoad = (): void => {
      if (disposed || loading) return
      loadRef.current()
    }
    const withinPreload = (): boolean => {
      const root = scroll.getBoundingClientRect()
      const end = sentinel.getBoundingClientRect()
      return end.top <= root.bottom + PRELOAD_PX
    }

    let observer: IntersectionObserver | undefined
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        if (entries.some(entry => entry.isIntersecting)) maybeLoad()
      }, { root: scroll, rootMargin: ROOT_MARGIN })
      observer.observe(sentinel)
    }

    // Fallback for environments without IntersectionObserver, and a cheap
    // re-check for hosts whose observer batches coalesce a fast scroll.
    const onScroll = (): void => {
      if (withinPreload()) maybeLoad()
    }
    scroll.addEventListener('scroll', onScroll, { passive: true })

    // Short-list fill: only once the box has been laid out. A hidden tab body
    // has no height, so it must never spend a request it cannot show.
    if (scroll.clientHeight > 0 && withinPreload()) maybeLoad()
    // One post-layout re-check covers the frame in which the box measured 0
    // (a section just expanded) and density changes that move the sentinel
    // into view without a scroll event.
    const frame = requestAnimationFrame(() => {
      if (scroll.clientHeight > 0 && withinPreload()) maybeLoad()
    })

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer?.disconnect()
      scroll.removeEventListener('scroll', onScroll)
    }
    // `loading` is intentional: flipping it re-creates the effect, which both
    // silences callbacks during the request and re-arms them after it clears.
  }, [enabled, hasMore, loading, version, scrollRef, sentinelRef])
}
