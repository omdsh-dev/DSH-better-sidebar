/**
 * Byte-offset paging over one text file, shared by every over-limit preview
 * (the generic read-only text reader and the JSONL record list).
 *
 * Why paging at all: the editor answers "this file is too big to edit" by
 * refusing to show it (VS Code pops a placeholder and offers "Open Anyway").
 * That is safe but useless for the files people actually want to LOOK at —
 * session logs, eval dumps, dataset rows — so instead of refusing, this reads
 * the file in windows.
 *
 * The model is APPEND-ONLY, which is what VS Code's output/log viewer does
 * (its `readFile(resource, { position: endOffset })` tail reads append into the
 * model). Pages accumulate in file order, so:
 *
 * - scrolling to the bottom appends the next page instead of replacing the
 *   current one — the reader keeps everything they have already scrolled past;
 * - "load all" is just "append until EOF", one sequential request at a time.
 *   It HAS to be sequential: each request's `offset` is the previous response's
 *   `nextOffset`, so the offsets cannot be computed ahead of time.
 *
 * That is also why there is no page count and no jump-to-the-end: a byte offset
 * is only knowable for the pages already read. A random-access index would mean
 * scanning the whole file on open — exactly the cost paging exists to avoid.
 *
 * Memory is therefore proportional to what the user has actually read, and the
 * VIEW caps that (see `MAX_PREVIEW_ROWS` in LargeFileView): this hook will
 * append for as long as it is asked to.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type SessionScope } from './api.ts'

/** Everything one read produced, in the shape the preview renders from. */
interface PagerState {
  /** Decoded page texts, in file order (`pages[0]` is the first window). */
  pages: string[]
  /** Absolute 1-based number of the first line each page holds. */
  lineStarts: number[]
  /** Lines in each page (parallel to `pages`; summed for the row cap). */
  lineCounts: number[]
  /** Where the next page starts — also the count of bytes read so far. */
  nextOffset: number
  /** The file's size in bytes, as the first response reported it. */
  size: number
  atEnd: boolean
  encoding: string
}

/** The empty state (also what a file switch resets to). */
const EMPTY: PagerState = {
  pages: [],
  lineStarts: [],
  lineCounts: [],
  nextOffset: 0,
  size: 0,
  atEnd: false,
  encoding: 'utf8',
}

/** The paging state one preview renders from. */
export interface TextPager {
  /** A single page append is in flight. */
  loading: boolean
  /** The "load all" loop is running (its per-page appends also set `loading`). */
  loadingAll: boolean
  /** Wire/transport failure of the last append; cleared once one succeeds. */
  error: string | null
  /** Loaded page texts, in file order. Append-only — nothing is ever dropped. */
  pages: readonly string[]
  /** Absolute 1-based first line of each page (parallel to `pages`). */
  lineStarts: readonly number[]
  /** Total decoded lines across the loaded pages (the row cap's input). */
  totalLines: number
  /** Bytes read so far (`nextOffset` — the same number, named for the UI). */
  loadedBytes: number
  /** The file's size in bytes (0 until the first response arrives). */
  size: number
  /** True once the file's last page has been read. */
  atEnd: boolean
  /** True when `maxLines` is what stopped the reading (not EOF). */
  atCap: boolean
  /** Append the next page, unless nothing may be appended any more. */
  loadMore: () => void
  /**
   * Read every remaining page, one at a time, until EOF, the `maxLines`
   * ceiling, or a failure.
   */
  loadAll: () => void
  /** Throw away everything and re-read from the first page (the refresh). */
  reload: () => void
  /** The file's detected encoding, as the first page reported it. */
  encoding: string
}

/**
 * Page through one file, appending.
 *
 * @param scope - the session scope.
 * @param path - the file to read ('' parks the hook).
 * @param enabled - false issues no request and keeps the previous state (a
 *  viewer that is merely hidden must not keep reading).
 * @param revision - bump to restart from the first page (the host's refresh).
 * @param maxLines - ceiling on accumulated lines. The hook stops appending
 *  once it is reached, and reports `atCap`. It lives HERE rather than in the
 *  caller because the accounting has to be synchronous: while `loadAll` walks
 *  pages in an `await` loop, a caller reading its own RENDERED row count would
 *  decide from a stale number and overshoot the ceiling by however many pages
 *  React had not re-rendered yet.
 * @returns the accumulator and its commands.
 */
export function useTextPager(
  scope: SessionScope,
  path: string,
  enabled: boolean,
  revision: number,
  maxLines = Number.POSITIVE_INFINITY,
): TextPager {
  const [state, setState] = useState<PagerState>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [loadingAll, setLoadingAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadSeq, setReloadSeq] = useState(0)

  /** One append at a time: every request needs the previous `nextOffset`. */
  const inFlight = useRef(false)
  /** Guards a late response from the file/revision we have already left. */
  const generationRef = useRef(0)
  /**
   * The cursor, as REFS rather than reads of the rendered state.
   *
   * This is load-bearing, not a micro-optimisation: `loadAll` walks pages in a
   * tight `await` loop, and a `setState` from the previous page is not rendered
   * yet when the next iteration starts. Reading the offset out of state there
   * re-requests the SAME page forever (found by the spec — it OOMs the worker in
   * about ten seconds). The refs are written synchronously with the response,
   * so the loop always advances.
   */
  const nextOffsetRef = useRef(0)
  const atEndRef = useRef(false)
  const totalLinesRef = useRef(0)
  const loadingAllRef = useRef(false)
  /** Mirror of the ceiling, so the identity-stable callbacks read it fresh. */
  const maxLinesRef = useRef(maxLines)
  maxLinesRef.current = maxLines

  /** Whether anything may still be appended: neither EOF nor the ceiling. */
  const canAppend = (): boolean =>
    !atEndRef.current && totalLinesRef.current < maxLinesRef.current

  const reset = useCallback((): void => {
    generationRef.current += 1
    inFlight.current = false
    loadingAllRef.current = false
    nextOffsetRef.current = 0
    atEndRef.current = false
    totalLinesRef.current = 0
    setState(EMPTY)
    setLoading(false)
    setLoadingAll(false)
    setError(null)
  }, [])

  // A new file restarts from the first page; so does the host's refresh — the
  // file may have moved on disk, and a stale byte offset would splice two
  // different revisions of the document together.
  useEffect(() => {
    reset()
    setReloadSeq(sequence => sequence + 1)
  }, [reset, path, scope.sessionId, scope.cwd, revision])

  /**
   * Read the page at the current `nextOffset` and append it.
   *
   * @returns whether the caller's loop may continue (false on a failure, on a
   *  superseded generation, or when another append is already in flight).
   */
  const appendOnce = useCallback((): Promise<boolean> => {
    if (inFlight.current) return Promise.resolve(false)
    if (!canAppend()) return Promise.resolve(false)
    const generation = generationRef.current
    const offset = nextOffsetRef.current
    inFlight.current = true
    setLoading(true)
    setError(null)
    return api.fsReadPage(scope, path, offset).then((result) => {
      if (generation !== generationRef.current) return false
      inFlight.current = false
      // Written BEFORE the state update: the next iteration of `loadAll` runs
      // off these, and `setState` has not rendered yet at that point.
      nextOffsetRef.current = result.nextOffset
      atEndRef.current = result.eof
      const lines = splitLines(result.text).length
      totalLinesRef.current += lines
      setState((previous) => {
        const previousStart = previous.lineStarts[previous.lineStarts.length - 1] ?? 1
        const previousLines = previous.lineCounts[previous.lineCounts.length - 1] ?? 0
        return {
          pages: [...previous.pages, result.text],
          lineStarts: [
            ...previous.lineStarts,
            previous.pages.length === 0 ? 1 : previousStart + previousLines,
          ],
          lineCounts: [...previous.lineCounts, lines],
          nextOffset: result.nextOffset,
          size: result.size,
          atEnd: result.eof,
          encoding: result.encoding,
        }
      })
      setLoading(false)
      return canAppend()
    }).catch((reason: unknown) => {
      inFlight.current = false
      if (generation !== generationRef.current) return false
      setLoading(false)
      setError(reason instanceof Error ? reason.message : String(reason))
      return false
    })
  }, [scope, path])

  const loadMore = useCallback((): void => {
    if (!canAppend()) return
    void appendOnce()
  }, [appendOnce])

  const loadAll = useCallback((): void => {
    if (loadingAllRef.current) return
    loadingAllRef.current = true
    setLoadingAll(true)
    void (async () => {
      try {
        // Sequential on purpose: each page's offset IS the previous page's
        // `nextOffset`, so there is nothing to parallelise.
        for (;;) {
          // Both guards read REFS, which `appendOnce` writes synchronously with
          // the response — the rendered state lags an `await` behind.
          if (!canAppend()) break
          // Sequential by construction, not by style: the next request's
          // offset IS this response's `nextOffset`.
          const advanced = await appendOnce()
          if (!advanced) break
        }
      } finally {
        loadingAllRef.current = false
        setLoadingAll(false)
      }
    })()
  }, [appendOnce])

  const reload = useCallback(() => {
    reset()
    setReloadSeq(sequence => sequence + 1)
  }, [reset])

  // The first page, and the first page only: later appends are driven by the
  // view's scroll and load-all. `pages.length` returning to 0 is what a reset
  // looks like from here, so a file/revision change re-seeds automatically.
  useEffect(() => {
    void reloadSeq
    if (!enabled || path === '') return
    if (state.pages.length > 0 || state.atEnd) return
    if (inFlight.current || !canAppend()) return
    void appendOnce()
    // The guards are the two `state` FIELDS, not `state`: the effect must fire
    // on "nothing loaded yet", not on every append.
  }, [enabled, path, reloadSeq, state.pages.length, state.atEnd, appendOnce])

  return useMemo<TextPager>(() => ({
    loading,
    loadingAll,
    error,
    pages: state.pages,
    lineStarts: state.lineStarts,
    totalLines: state.lineCounts.reduce((sum, count) => sum + count, 0),
    loadedBytes: state.nextOffset,
    size: state.size,
    atEnd: state.atEnd,
    atCap: !state.atEnd && state.lineCounts.reduce((sum, count) => sum + count, 0) >= maxLines,
    loadMore,
    loadAll,
    reload,
    encoding: state.encoding,
  }), [loading, loadingAll, error, state, maxLines, loadMore, loadAll, reload])
}

/**
 * One page's text as rows. The host trims every page to a line break, so the
 * '' a trailing newline produces is dropped — except on an empty page, which is
 * no rows rather than one empty one.
 */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
