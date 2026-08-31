/**
 * Find-in-page for the markdown preview: Cmd/Ctrl+F opens a small find bar
 * pinned to the top-right of the preview's scroll container, highlights every
 * match, and steps through them with Enter / Shift+Enter (or the arrows).
 * Escape closes it and clears the highlight.
 *
 * Why not just leave the browser's own find to it: the preview is one pane
 * inside the sidebar, so the native dialog searches the WHOLE GUI (chat
 * transcript, file tree, every other open tab) and its match ring is drawn
 * over a scroll container it does not know how to scroll. This bar is scoped
 * to the one document the reader is actually reading.
 *
 * Mount contract: render as a DIRECT child of the preview's scroll container,
 * the same contract MdToc documents. The container is discovered through the
 * bar's own `parentElement`, not a passed ref — React attaches a parent host
 * element's ref only after its children's layout effects have run, so a
 * ref-based read here would see null at mount and never re-run. The bar is
 * zero-height and pointer-transparent, so it never shifts the preview.
 *
 * Highlighting goes through the CSS Custom Highlight API: match ranges are
 * painted without inserting a single node, which is the only safe option over
 * a React-rendered, DOMPurify-sanitized subtree (see md-find-engine.ts).
 * Where the API is missing, the current match still gets selected through the
 * Selection API, so the reader keeps a visible match and working navigation —
 * only the "every other match" tint is lost.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconCloseOutline16,
  IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { findRanges } from './md-find-engine.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Highlight registry names. Static, because `::highlight()` cannot match a
 *  name built at runtime — which is exactly why only one find bar may be open
 *  at a time (see {@link closeOpenFind}). Paired with layout.css. */
const HIGHLIGHT_ALL = 'dsh-md-find'
const HIGHLIGHT_CURRENT = 'dsh-md-find-current'

/** Marks the find bar's own subtree so the engine never matches the query
 *  the reader is typing (the bar renders inside the container it searches). */
const FIND_BAR_ATTR = 'data-dsh-md-find'

/** The minimal shape of the CSS Custom Highlight API this module uses. */
interface HighlightRegistry {
  set: (name: string, highlight: object) => void
  delete: (name: string) => void
}
interface HighlightConstructor { new (...ranges: Range[]): object }

/** The registry, or null where the API is unavailable (fallback path).
 *  Read off globalThis rather than the bare `CSS` binding: `CSS` is undefined
 *  in non-browser DOM environments (jsdom), where a bare reference throws a
 *  ReferenceError instead of yielding undefined. */
function highlightRegistry(): HighlightRegistry | null {
  const scope = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistry }
    Highlight?: HighlightConstructor
  }
  const registry = scope.CSS?.highlights
  return registry !== undefined && scope.Highlight !== undefined ? registry : null
}

function paintHighlights(all: readonly Range[], current: Range | undefined): void {
  const registry = highlightRegistry()
  if (registry === null) return
  const ctor = (globalThis as unknown as { Highlight: HighlightConstructor }).Highlight
  registry.set(HIGHLIGHT_ALL, new ctor(...all))
  registry.set(HIGHLIGHT_CURRENT, current === undefined ? new ctor() : new ctor(current))
}

function clearHighlights(): void {
  const registry = highlightRegistry()
  if (registry === null) return
  registry.delete(HIGHLIGHT_ALL)
  registry.delete(HIGHLIGHT_CURRENT)
}

/**
 * The one open find bar, if any. The highlight names above are document-global
 * and the `::highlight()` rules cannot be keyed per instance, so a second bar
 * opening in a split pane would repaint the first one's tint. Opening closes
 * whichever bar was open.
 */
let closeOpenFind: (() => void) | null = null

/**
 * Cmd/Ctrl+F events already claimed by one bar this tick. Several previews can
 * be mounted at once (split panes); without this, every visible one would
 * claim the same keystroke and open together.
 */
const claimed = new WeakSet<KeyboardEvent>()

/** Whether the container is on screen (a hidden pane must not claim Cmd+F). */
function isVisible(element: HTMLElement): boolean {
  return element.isConnected && element.getClientRects().length > 0
}

export function MdFind(): ReactNode {
  const barRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Range[]>([])
  const [index, setIndex] = useState(0)
  /** Bumped when the rendered document changes, to re-run the search. */
  const [revision, setRevision] = useState(0)

  const close = useCallback((): void => {
    setOpen(false)
    setQuery('')
    setMatches([])
    setIndex(0)
    clearHighlights()
  }, [])

  // Cmd/Ctrl+F. Bound to the document rather than the container: the preview
  // holds no focusable content, so a reader who has only scrolled leaves
  // focus on <body> and a container-bound listener would never fire. The gate
  // keeps the native dialog for every other surface — this bar claims the key
  // only when its own preview is visible AND focus is either inside it or
  // nowhere in particular (body). Typing in the chat composer or a file-tree
  // filter still reaches the browser's find, as it should.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'f' && event.key !== 'F') return
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const container = barRef.current?.parentElement ?? null
      if (container === null || !isVisible(container)) return
      const active = document.activeElement
      const focusIsLoose = active === null || active === document.body
      if (!focusIsLoose && !container.contains(active)) return
      if (claimed.has(event)) return
      claimed.add(event)
      event.preventDefault()
      if (closeOpenFind !== null && closeOpenFind !== close) closeOpenFind()
      closeOpenFind = close
      setOpen(true)
      // Focus after the input exists; selecting the old query lets a second
      // Cmd+F retype straight over the previous search.
      requestAnimationFrame(() => { inputRef.current?.select() })
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [close])

  // Release the shared slot and the highlight on unmount (tab close, pane
  // split, a preview→edit toggle) — a stale tint would otherwise outlive the
  // document it belonged to.
  useEffect(() => {
    return () => {
      if (closeOpenFind === close) closeOpenFind = null
      clearHighlights()
    }
  }, [close])

  // Re-run the search when the rendered document changes underneath it: the
  // mermaid lazy chunk and shiki highlighting both land after first paint, and
  // a `<details>` the reader expands adds text. Mutations from the bar itself
  // are ignored, or every keystroke would queue another scan of its own input.
  useLayoutEffect(() => {
    if (!open) return
    const container = barRef.current?.parentElement ?? null
    if (container === null) return
    let frame: number | null = null
    const observer = new MutationObserver((records) => {
      const fromBar = records.every((record) => {
        const target = record.target
        const element = target instanceof Element ? target : target.parentElement
        return element?.closest(`[${FIND_BAR_ATTR}]`) != null
      })
      if (fromBar) return
      if (frame !== null) return
      frame = requestAnimationFrame(() => { frame = null; setRevision((n) => n + 1) })
    })
    observer.observe(container, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [open])

  // The search itself. Ranges are recomputed from scratch on every query or
  // document change: a Range whose nodes React has replaced is detached and
  // would scroll to nowhere.
  useLayoutEffect(() => {
    if (!open) {
      setMatches([])
      return
    }
    const container = barRef.current?.parentElement ?? null
    if (container === null) return
    const found = findRanges(container, query, (element) => element.hasAttribute(FIND_BAR_ATTR))
    setMatches(found)
    setIndex((previous) => (found.length === 0 ? 0 : Math.min(previous, found.length - 1)))
  }, [open, query, revision])

  // Paint, then bring the current match into view. Scrolling is computed
  // against the container rather than `scrollIntoView`: the match may sit deep
  // inside a paragraph, and scrolling its parent element would leave a long
  // paragraph's match off screen.
  useLayoutEffect(() => {
    if (!open) return
    const current = matches[index]
    paintHighlights(matches, current)
    if (current === undefined) return
    const container = barRef.current?.parentElement ?? null
    if (container === null) return
    // A match inside a collapsed <details> has no box until it is opened.
    const host = current.startContainer.parentElement
    const collapsed = host?.closest('details:not([open])')
    if (collapsed != null) {
      collapsed.setAttribute('open', '')
      return // the mutation observer re-runs the search against the new layout
    }
    const rect = current.getBoundingClientRect()
    const bounds = container.getBoundingClientRect()
    if (rect.height === 0 && rect.width === 0) return
    const above = rect.top < bounds.top
    const below = rect.bottom > bounds.bottom
    if (above || below) {
      container.scrollTop += rect.top - bounds.top - (container.clientHeight - rect.height) / 2
    }
    // Fallback for engines without the Highlight API: the selection is the
    // only remaining way to show the reader WHICH match is current.
    if (highlightRegistry() === null) {
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(current)
    }
  }, [open, matches, index])

  const step = (delta: number): void => {
    if (matches.length === 0) return
    setIndex((previous) => (previous + delta + matches.length) % matches.length)
  }

  if (!open) return <div className={css.mdFindBar} ref={barRef} {...{ [FIND_BAR_ATTR]: '' }} />

  const total = matches.length
  const hasQuery = query.trim() !== ''
  return (
    <div className={css.mdFindBar} ref={barRef} {...{ [FIND_BAR_ATTR]: '' }}>
      <div className={css.mdFindPanel}>
        <IconSearchOutline16 className={css.mdFindIcon} />
        <input
          ref={inputRef}
          type="search"
          className={css.mdFindInput}
          value={query}
          placeholder={t('find')}
          aria-label={t('find')}
          onChange={(event) => { setQuery(event.target.value); setIndex(0) }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); close() }
            else if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1) }
          }}
        />
        <span className={css.mdFindCount} aria-live="polite">
          {!hasQuery ? '' : total === 0 ? t('findNoResults') : `${index + 1}/${total}`}
        </span>
        <button
          type="button"
          className={css.mdFindButton}
          aria-label={t('findPrev')}
          title={t('findPrev')}
          disabled={total === 0}
          onClick={() => { step(-1) }}
        >
          <IconChevronUpOutline14 />
        </button>
        <button
          type="button"
          className={css.mdFindButton}
          aria-label={t('findNext')}
          title={t('findNext')}
          disabled={total === 0}
          onClick={() => { step(1) }}
        >
          <IconChevronDownOutline14 />
        </button>
        <button
          type="button"
          className={css.mdFindButton}
          aria-label={t('findClose')}
          title={t('findClose')}
          onClick={close}
        >
          <IconCloseOutline16 />
        </button>
      </div>
    </div>
  )
}
