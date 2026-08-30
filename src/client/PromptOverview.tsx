/**
 * Codex-style overview of the human prompts in the current conversation.
 *
 * Durable prompt labels come from the read-only session history RPC, so the
 * rail can summarize questions that the native ChatView has not rendered yet.
 * Visible row geometry comes from ChatView's stable DOM landmarks
 * (`data-conversation-scroll`, `data-chat-flow`, `data-chat-flow-kind`). A
 * click on an unloaded prompt drives the native "load earlier" control until
 * that row exists, then scrolls through ChatView's own scrollport. The plugin
 * never copies or mutates conversation state.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Context, SidebarHistoryEntry } from '../context-types.ts'
import { isContextInjectionMessage } from '../sidechat-core.ts'
import { t } from './locales.ts'
import css from './PromptOverview.module.css'

/** One human prompt and its following assistant excerpt. `row` is null while
 * the prompt remains outside the native ChatView's rendered history window. */
export interface PromptOverviewEntry {
  key: string
  question: string
  answer: string
  row: HTMLElement | null
}

interface PromptGeometry {
  left: number
  top: number
  height: number
}

const HUMAN_KINDS = new Set(['user', 'steering'])
const ASSISTANT_KINDS = new Set(['assistant', 'assistant-step'])
const HISTORY_PAGE_MESSAGES = 200
const HISTORY_PAGE_LIMIT = 40
const MIN_RAIL_HEIGHT = 44
const MAX_RAIL_HEIGHT = 420
const RAIL_EDGE_INSET = 12
const RAIL_VERTICAL_CLEARANCE = 96

/** Flatten rendered prose into a compact preview without changing the source DOM. */
export function normalizePromptPreview(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim()
}

/** Extract visible text from a durable content-block list. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return normalizePromptPreview(content)
  if (!Array.isArray(content)) return ''
  const text = content.flatMap(block => {
    if (block === null || typeof block !== 'object') return []
    const candidate = block as { type?: unknown; kind?: unknown; text?: unknown }
    const textKind = candidate.type === 'text' || candidate.kind === 'text'
    return textKind && typeof candidate.text === 'string' ? [candidate.text] : []
  }).join('\n\n')
  return normalizePromptPreview(text)
}

/**
 * User rows keep their bubble stack as the first child of the stable
 * `data-time-hover-root`; reading that branch excludes timestamp/copy/fork
 * chrome from the preview.
 */
function questionText(row: HTMLElement): string {
  const chrome = row.querySelector<HTMLElement>('[data-time-hover-root]')
  return normalizePromptPreview(chrome?.firstElementChild?.textContent ?? row.textContent)
}

/** Remove interactive/action chrome before flattening an assistant excerpt. */
function assistantText(row: HTMLElement): string {
  const clone = row.cloneNode(true) as HTMLElement
  for (const element of clone.querySelectorAll('button, [aria-hidden="true"]')) element.remove()
  return normalizePromptPreview(clone.textContent)
}

/**
 * Derive all currently rendered prompts. The native flow is already ordered,
 * so pairing is a single pass: the last assistant row before the next human
 * row becomes that prompt's live hover excerpt.
 */
export function collectPromptOverviewEntries(flow: HTMLElement): PromptOverviewEntry[] {
  const entries: PromptOverviewEntry[] = []
  let current: PromptOverviewEntry | undefined
  const rows = flow.querySelectorAll<HTMLElement>(':scope > [data-chat-flow-kind]')
  for (const row of rows) {
    const kind = row.dataset.chatFlowKind ?? ''
    if (HUMAN_KINDS.has(kind)) {
      current = {
        key: row.dataset.chatAnchorKey ?? `${kind}:${entries.length}`,
        question: questionText(row),
        answer: '',
        row,
      }
      entries.push(current)
      continue
    }
    if (ASSISTANT_KINDS.has(kind) && current !== undefined) {
      const answer = assistantText(row)
      if (answer !== '') current.answer = answer
    }
  }
  return entries
}

/** Derive the complete durable prompt list from oldest-first history events. */
export function collectHistoryPromptEntries(history: readonly SidebarHistoryEntry[]): PromptOverviewEntry[] {
  const entries: PromptOverviewEntry[] = []
  let current: PromptOverviewEntry | undefined
  const ordered = [...history].sort((left, right) => left.event.seq - right.event.seq)
  for (const { event } of ordered) {
    const data = event.data as Record<string, unknown>
    if (event.type === 'user/message') {
      if (isContextInjectionMessage(data)) continue
      current = {
        key: `history:${event.seq}`,
        question: contentText(data.content),
        answer: '',
        row: null,
      }
      entries.push(current)
      continue
    }
    if (event.type === 'assistant/message' && current !== undefined) {
      const message = data.message as { content?: unknown } | undefined
      const answer = contentText(message?.content)
      if (answer !== '') current.answer = answer
    }
  }
  return entries
}

/**
 * Attach rendered row identities to durable prompts by matching from newest to
 * oldest. New live prompts not present in the last history pull remain as DOM
 * entries at the tail until the next session history refresh.
 */
export function reconcilePromptOverviewEntries(
  history: readonly PromptOverviewEntry[],
  rendered: readonly PromptOverviewEntry[],
): PromptOverviewEntry[] {
  if (history.length === 0) return [...rendered]
  const merged: PromptOverviewEntry[] = history.map(entry => ({ ...entry, row: null }))
  const unmatched: PromptOverviewEntry[] = []
  const used = new Set<number>()
  let ceiling = merged.length - 1
  for (let renderedIndex = rendered.length - 1; renderedIndex >= 0; renderedIndex -= 1) {
    const live = rendered[renderedIndex]!
    let match = -1
    for (let historyIndex = ceiling; historyIndex >= 0; historyIndex -= 1) {
      if (used.has(historyIndex)) continue
      if (merged[historyIndex]!.question === live.question) {
        match = historyIndex
        break
      }
    }
    if (match === -1) {
      unmatched.unshift(live)
      continue
    }
    used.add(match)
    ceiling = match - 1
    merged[match] = {
      ...merged[match]!,
      answer: live.answer || merged[match]!.answer,
      row: live.row,
    }
  }
  return merged.concat(unmatched)
}

/** Short prompts stay subtle; longer prompts grow toward the Codex-style cap. */
export function promptMarkerWidth(text: string): number {
  const length = Array.from(text).length
  return Math.max(9, Math.min(34, 9 + Math.round(Math.sqrt(length) * 2.5)))
}

/** Pick the rendered prompt at (or immediately above) the upper reading band. */
export function activePromptIndex(entries: readonly PromptOverviewEntry[], scroller: HTMLElement): number {
  const rendered = entries.flatMap((entry, index) => entry.row === null ? [] : [{ entry, index }])
  if (rendered.length === 0) return -1
  const viewport = scroller.getBoundingClientRect()
  const floor = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  if (floor - scroller.scrollTop <= 3) return rendered.at(-1)!.index
  const readingLine = viewport.top + Math.min(150, viewport.height * 0.3)
  let active = rendered[0]!.index
  for (const candidate of rendered) {
    if (candidate.entry.row!.getBoundingClientRect().top > readingLine) break
    active = candidate.index
  }
  return active
}

/** Scroll one prompt through the native conversation scrollport. */
export function scrollToPrompt(row: HTMLElement, scroller: HTMLElement): void {
  const rowRect = row.getBoundingClientRect()
  const scrollRect = scroller.getBoundingClientRect()
  const top = Math.max(0, scroller.scrollTop + rowRect.top - scrollRect.top - 24)
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  scroller.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' })
  row.setAttribute('data-prompt-overview-target', '')
  window.setTimeout(() => { row.removeAttribute('data-prompt-overview-target') }, 900)
}

/** Equality that preserves row identities while avoiding observer-driven render churn. */
function sameEntries(left: readonly PromptOverviewEntry[], right: readonly PromptOverviewEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index]
    return other !== undefined
      && entry.key === other.key
      && entry.question === other.question
      && entry.answer === other.answer
      && entry.row === other.row
  })
}

/** Locate the active official Chat flow (never a side-chat flow in the panel host). */
function conversationFlow(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#root [data-slot="conversation"] [data-chat-flow]')
}

/** Find the scrollport using the same landmark as the official ChatView. */
function conversationScroller(flow: HTMLElement): HTMLElement {
  return flow.closest<HTMLElement>('[data-conversation-scroll]') ?? flow.parentElement ?? flow
}

/** The real center-column grid item anchors the minimap gutter. */
function conversationSeat(flow: HTMLElement): HTMLElement {
  const slot = flow.closest<HTMLElement>('[data-slot="conversation"]')
  // Slot wrappers are `display: contents` in DSH 0.1.x and have a zero rect.
  return slot?.parentElement ?? slot ?? flow
}

/** Native history pager inside the flow's leading non-business row. */
function olderButton(flow: HTMLElement): HTMLButtonElement | null {
  for (const child of flow.children) {
    if (!(child instanceof HTMLElement) || child.dataset.chatFlowKind !== undefined) continue
    const button = child.querySelector<HTMLButtonElement>('button:not(:disabled)')
    if (button !== null) return button
  }
  return null
}

/** First business-row identity, used to ignore the pager's loading-state churn. */
function firstFlowKey(flow: HTMLElement): string | null {
  return flow.querySelector<HTMLElement>(':scope > [data-chat-flow-key]')?.dataset.chatFlowKey ?? null
}

/** Wait until one native history page actually prepends business rows. */
function waitForHistoryPrepend(flow: HTMLElement, previousFirstKey: string | null): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    let quietTimer: number | null = null
    const done = (): void => {
      if (settled) return
      settled = true
      observer.disconnect()
      window.clearTimeout(timer)
      if (quietTimer !== null) window.clearTimeout(quietTimer)
      resolve()
    }
    const observer = new MutationObserver(() => {
      if (firstFlowKey(flow) === previousFirstKey) return
      // React may commit the prepended flow in several mutation batches. Wait
      // for a short quiet edge so the prompt rows, not merely the first tool
      // row, are present before reconciliation runs.
      if (quietTimer !== null) window.clearTimeout(quietTimer)
      quietTimer = window.setTimeout(done, 160)
    })
    observer.observe(flow, { childList: true, subtree: true })
    const timer = window.setTimeout(done, 3000)
  })
}

/**
 * Past-prompt minimap. It hides for a missing session, fewer than two prompts,
 * narrow layouts, and while the official Chat view is not mounted.
 */
export function PromptOverview({ ctx, sessionId }: { ctx: Context; sessionId: string | undefined }) {
  const [historyEntries, setHistoryEntries] = useState<PromptOverviewEntry[]>([])
  const [entries, setEntries] = useState<PromptOverviewEntry[]>([])
  const [active, setActive] = useState(-1)
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [geometry, setGeometry] = useState<PromptGeometry | null>(null)
  const entriesRef = useRef<PromptOverviewEntry[]>([])

  // Pull the complete prompt index independently of ChatView's rendered page.
  useEffect(() => {
    const controller = new AbortController()
    if (sessionId === undefined) {
      setHistoryEntries([])
      return () => { controller.abort() }
    }
    void (async () => {
      const bySeq = new Map<number, SidebarHistoryEntry>()
      let beforeSeq: number | undefined
      try {
        for (let page = 0; page < HISTORY_PAGE_LIMIT; page += 1) {
          const response = await ctx.connection.api.sessions.history({
            sessionId,
            maxMessages: HISTORY_PAGE_MESSAGES,
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
          }, controller.signal)
          if (!response.result.ok) break
          const value = response.result.value
          for (const entry of value.events) bySeq.set(entry.event.seq, entry)
          if (!value.hasMore || value.events.length === 0) break
          const nextBefore = Math.min(...value.events.map(entry => entry.event.seq))
          if (nextBefore === beforeSeq) break
          beforeSeq = nextBefore
        }
        if (!controller.signal.aborted) {
          setHistoryEntries(collectHistoryPromptEntries([...bySeq.values()]))
        }
      } catch {
        if (!controller.signal.aborted) setHistoryEntries([])
      }
    })()
    return () => { controller.abort() }
  }, [ctx, sessionId])

  useEffect(() => {
    if (sessionId === undefined) {
      entriesRef.current = []
      setEntries([])
      setActive(-1)
      setGeometry(null)
      return
    }

    let disposed = false
    let scheduled: number | null = null
    let contentTimer: number | null = null
    let boundFlow: HTMLElement | null = null
    let boundScroller: HTMLElement | null = null
    let flowObserver: MutationObserver | null = null
    let resizeObserver: ResizeObserver | null = null

    const updateActive = (): void => {
      if (boundScroller === null) return
      setActive(activePromptIndex(entriesRef.current, boundScroller))
    }
    const onScroll = (): void => { updateActive() }

    const bindFlow = (flow: HTMLElement | null): void => {
      if (flow === boundFlow) return
      flowObserver?.disconnect()
      resizeObserver?.disconnect()
      if (contentTimer !== null) {
        window.clearTimeout(contentTimer)
        contentTimer = null
      }
      boundScroller?.removeEventListener('scroll', onScroll)
      flowObserver = null
      resizeObserver = null
      boundFlow = flow
      boundScroller = flow === null ? null : conversationScroller(flow)
      if (flow === null || boundScroller === null) return

      flowObserver = new MutationObserver(records => {
        // Row prepends/appends affect the rail immediately. Streaming text
        // churn refreshes only the hover excerpt after a short quiet gap.
        if (records.some(record => record.target === flow)) {
          scheduleSync()
          return
        }
        if (contentTimer !== null) window.clearTimeout(contentTimer)
        contentTimer = window.setTimeout(() => {
          contentTimer = null
          scheduleSync()
        }, 240)
      })
      flowObserver.observe(flow, { childList: true, subtree: true, characterData: true })
      boundScroller.addEventListener('scroll', onScroll, { passive: true })
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => { scheduleSync() })
        resizeObserver.observe(conversationSeat(flow))
        resizeObserver.observe(boundScroller)
      }
    }

    const sync = (): void => {
      scheduled = null
      if (disposed) return
      const flow = conversationFlow()
      bindFlow(flow)
      if (flow === null || boundScroller === null) {
        if (entriesRef.current.length > 0) {
          entriesRef.current = []
          setEntries([])
          setActive(-1)
          setGeometry(null)
        }
        return
      }

      const next = reconcilePromptOverviewEntries(historyEntries, collectPromptOverviewEntries(flow))
      entriesRef.current = next
      setEntries(previous => sameEntries(previous, next) ? previous : next)
      updateActive()
      if (next.length < 2) {
        setGeometry(previous => previous === null ? previous : null)
        return
      }

      const seatRect = conversationSeat(flow).getBoundingClientRect()
      const scrollRect = boundScroller.getBoundingClientRect()
      // A narrow center column has no safe gutter: hide rather than cover chat.
      if (seatRect.width < 680 || scrollRect.height < 160) {
        setGeometry(null)
        return
      }
      const available = Math.max(MIN_RAIL_HEIGHT, scrollRect.height - RAIL_VERTICAL_CLEARANCE)
      const height = Math.min(MAX_RAIL_HEIGHT, available, Math.max(MIN_RAIL_HEIGHT, next.length * 11))
      const nextGeometry = {
        left: Math.round(seatRect.left + RAIL_EDGE_INSET),
        top: Math.round(scrollRect.top + scrollRect.height / 2),
        height: Math.round(height),
      }
      setGeometry(previous => previous?.left === nextGeometry.left
        && previous.top === nextGeometry.top
        && previous.height === nextGeometry.height
        ? previous
        : nextGeometry)
    }

    const scheduleSync = (): void => {
      if (scheduled !== null || disposed) return
      scheduled = window.requestAnimationFrame(sync)
    }

    const root = document.querySelector('#root') ?? document.body
    const rootObserver = new MutationObserver(() => {
      // Flow-local observer handles transcript mutations; this broad observer
      // only rebinds after a session/view replacement.
      if (conversationFlow() !== boundFlow) scheduleSync()
    })
    rootObserver.observe(root, { childList: true, subtree: true })
    window.addEventListener('resize', scheduleSync)
    scheduleSync()

    return () => {
      disposed = true
      if (scheduled !== null) window.cancelAnimationFrame(scheduled)
      if (contentTimer !== null) window.clearTimeout(contentTimer)
      rootObserver.disconnect()
      flowObserver?.disconnect()
      resizeObserver?.disconnect()
      boundScroller?.removeEventListener('scroll', onScroll)
    }
  }, [historyEntries, sessionId])

  /** Reveal even an unloaded prompt by paging through native Chat history. */
  const revealPrompt = async (entry: PromptOverviewEntry, index: number): Promise<void> => {
    let candidate = entry
    for (let attempt = 0; attempt < HISTORY_PAGE_LIMIT; attempt += 1) {
      if (candidate.row?.isConnected === true) {
        const flow = conversationFlow()
        if (flow !== null) scrollToPrompt(candidate.row, conversationScroller(flow))
        return
      }
      const flow = conversationFlow()
      if (flow === null) return
      const next = reconcilePromptOverviewEntries(historyEntries, collectPromptOverviewEntries(flow))
      candidate = next.find(item => item.key === entry.key) ?? next[index] ?? entry
      if (candidate.row?.isConnected === true) {
        entriesRef.current = next
        setEntries(next)
        scrollToPrompt(candidate.row, conversationScroller(flow))
        return
      }
      const button = olderButton(flow)
      if (button === null) return
      const changed = waitForHistoryPrepend(flow, firstFlowKey(flow))
      button.click()
      await changed
    }
  }

  const railHeight = geometry?.height ?? MIN_RAIL_HEIGHT
  const positions = useMemo(() => entries.map((_, index) => entries.length <= 1
    ? railHeight / 2
    : 5 + index * (railHeight - 10) / (entries.length - 1)), [entries, railHeight])

  if (geometry === null || entries.length < 2) return null

  return (
    <nav
      className={css.overview}
      data-dsh-prompt-overview
      aria-label={t('history')}
      style={{ left: geometry.left, top: geometry.top, height: geometry.height }}
    >
      {entries.map((entry, index) => {
        const question = entry.question || t('viewerImage')
        const open = hoveredKey === entry.key
        return (
          <button
            key={entry.key}
            type="button"
            className={css.marker}
            data-active={index === active || undefined}
            data-loaded={entry.row !== null || undefined}
            aria-label={`${index + 1}: ${question}`}
            style={{ top: positions[index], '--prompt-marker-width': `${promptMarkerWidth(question)}px` } as CSSProperties}
            onMouseEnter={() => { setHoveredKey(entry.key) }}
            onMouseLeave={() => { setHoveredKey(current => current === entry.key ? null : current) }}
            onFocus={() => { setHoveredKey(entry.key) }}
            onBlur={() => { setHoveredKey(current => current === entry.key ? null : current) }}
            onClick={() => {
              setActive(index)
              void revealPrompt(entry, index)
            }}
          >
            <span className={css.markerLine} aria-hidden="true" />
            {open && (
              <span className={css.preview} role="tooltip">
                <span className={css.previewQuestion}>{question}</span>
                <span className={css.previewAnswer}>{entry.answer || t('loading')}</span>
                <span className={css.previewIndex}>{index + 1}/{entries.length}</span>
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )
}
