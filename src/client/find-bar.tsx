/**
 * In-viewer text find: a compact find bar over both surfaces of the file
 * viewer — the CodeMirror editor (code files, markdown edit mode) and the
 * rendered markdown preview pane. The Electron shell has no browser find
 * dialog, and CodeMirror ships no search UI unless the `@codemirror/search`
 * package is bundled, so this implements plain-text search directly:
 *
 * - Editor matches select the range and scroll it into view (a CodeMirror
 *   selection dispatch plus the scrollIntoView effect).
 * - Preview matches walk the rendered text nodes (a match may span inline
 *   markup boundaries), scroll the pane and highlight via the CSS Custom
 *   Highlight API (Chromium-only; guarded, and no DOM mutation).
 *
 * The hook owns the state, the CodeMirror key bindings (Mod-f / F3 /
 * Shift-F3 / Escape) and the preview pane's document-level Mod-f listener;
 * the caller renders the returned bar between its header and content.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react'
import { EditorView } from '@codemirror/view'
import type { KeyBinding } from '@codemirror/view'
import { t } from './locales.ts'
import type { ViewMode } from './TextEditor.tsx'
import css from './sidebar.module.css'

/** One plain-text occurrence (offsets into the searched text). */
export interface FindMatch {
  from: number
  to: number
}

/** The open find session. */
export interface FindState {
  query: string
  matches: FindMatch[]
  /** Index of the current match into `matches` (-1 when there are none). */
  index: number
}

/** The CSS Custom Highlight registry name (Chromium-only; guarded). */
const HIGHLIGHT_NAME = 'dsh-better-sidebar-find'

/** Non-overlapping occurrences of `query` in `text` (plain string search). */
function findMatches(text: string, query: string): FindMatch[] {
  const matches: FindMatch[] = []
  let at = 0
  while (at <= text.length) {
    const hit = text.indexOf(query, at)
    if (hit === -1) break
    matches.push({ from: hit, to: hit + query.length })
    at = hit + Math.max(query.length, 1)
  }
  return matches
}

/** One rendered text node with its offsets into the preview's flat text. */
interface TextSegment {
  node: Text
  start: number
  end: number
}

/** Collect the rendered text nodes of the preview pane as offset segments. */
function textSegments(root: HTMLElement): TextSegment[] {
  const segments: TextSegment[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.textContent !== '' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  })
  let offset = 0
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    segments.push({ node: node as Text, start: offset, end: offset + text.length })
    offset += text.length
  }
  return segments
}

/** The DOM range for one match (start/end may land in different text nodes). */
function rangeFor(segments: TextSegment[], match: FindMatch): Range | null {
  const startSeg = segments.find((seg) => match.from >= seg.start && match.from < seg.end)
  const endSeg = segments.find((seg) => match.to - 1 >= seg.start && match.to - 1 < seg.end)
  if (startSeg === undefined || endSeg === undefined) return null
  const range = new Range()
  range.setStart(startSeg.node, match.from - startSeg.start)
  range.setEnd(endSeg.node, match.to - endSeg.start)
  return range
}

interface FindBarProps {
  state: FindState
  inputRef: RefObject<HTMLInputElement>
  onQuery: (query: string) => void
  onStep: (delta: number) => void
  onClose: () => void
}

/** The compact find bar (input + match counter + prev/next/close). */
function FindBar({ state, inputRef, onQuery, onStep, onClose }: FindBarProps): ReactNode {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      onStep(event.shiftKey ? -1 : 1)
    } else if (event.key === 'F3') {
      event.preventDefault()
      onStep(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }
  return (
    <div className={css.editorFindBar}>
      <input
        ref={inputRef}
        className={css.editorFindInput}
        value={state.query}
        placeholder={t('findPlaceholder')}
        onChange={(event) => { onQuery(event.target.value) }}
        onKeyDown={onKeyDown}
      />
      <span className={css.editorFindCounter}>
        {state.matches.length === 0 ? '0/0' : `${state.index + 1}/${state.matches.length}`}
      </span>
      <button type="button" className={css.iconButton} title={t('findPrevious')} onClick={() => { onStep(-1) }}>↑</button>
      <button type="button" className={css.iconButton} title={t('findNext')} onClick={() => { onStep(1) }}>↓</button>
      <button type="button" className={css.iconButton} aria-label={t('findClose')} onClick={onClose}>✕</button>
    </div>
  )
}

export interface UseFindBarOptions {
  viewerId: string
  mode: ViewMode
  viewRef: RefObject<EditorView | null>
  mdRef: RefObject<HTMLDivElement | null>
  /** Called after the bar closes (e.g. return focus to the editor). */
  onClose?: () => void
}

export interface FindBarApi {
  /** The bar element, or null while closed. */
  bar: ReactNode
  /** Stable CodeMirror key bindings (spread into the editor's keymap.of(...)). */
  keymap: readonly KeyBinding[]
  /** Close the bar (also clears the preview highlight). */
  close: () => void
}

/**
 * The find session behind {@link FindBar}. Editor and preview matching share
 * the same state shape; only the jump/highlight action differs per surface.
 */
export function useFindBar({ viewerId, mode, viewRef, mdRef, onClose }: UseFindBarOptions): FindBarApi {
  const [state, setState] = useState<FindState | null>(null)
  const stateRef = useRef<FindState | null>(null)
  const modeRef = useRef<ViewMode>(mode)
  modeRef.current = mode
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const inputRef = useRef<HTMLInputElement>(null)

  const update = useCallback((next: FindState | null): void => {
    stateRef.current = next
    setState(next)
  }, [])

  const clearHighlight = (): void => {
    try {
      CSS.highlights.delete(HIGHLIGHT_NAME)
    } catch {
      /* non-Chromium */
    }
  }

  const close = useCallback((): void => {
    clearHighlight()
    update(null)
    onCloseRef.current?.()
  }, [update])

  /** Select `match` in the editor and scroll it to the viewport center. */
  const jumpInEditor = useCallback((match: FindMatch): void => {
    const view = viewRef.current
    if (view === null) return
    view.focus()
    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      effects: EditorView.scrollIntoView(match.from, { y: 'center' }),
    })
  }, [viewRef])

  /** Scroll the preview pane to `match` and highlight it. */
  const jumpInPreview = useCallback((match: FindMatch): void => {
    const host = mdRef.current
    if (host === null) return
    const range = rangeFor(textSegments(host), match)
    if (range === null) return
    const rect = range.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    host.scrollTop = Math.max(0, host.scrollTop + rect.top - (hostRect.top + hostRect.height / 2))
    try {
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range))
    } catch {
      /* non-Chromium */
    }
  }, [mdRef])

  /** Re-run the search for `query` (an empty query closes the bar). */
  const search = useCallback((query: string): void => {
    if (query === '') {
      close()
      return
    }
    const preview = modeRef.current === 'preview' && viewerId === 'markdown'
    const text = preview
      ? (mdRef.current === null ? null : textSegments(mdRef.current).map((seg) => seg.node.textContent ?? '').join(''))
      : (viewRef.current === null ? null : viewRef.current.state.doc.toString())
    if (text === null) {
      close()
      return
    }
    const matches = findMatches(text, query)
    const first = matches[0]
    if (first === undefined) {
      update({ query, matches, index: -1 })
      return
    }
    update({ query, matches, index: 0 })
    if (preview) jumpInPreview(first)
    else jumpInEditor(first)
  }, [close, jumpInEditor, jumpInPreview, mdRef, update, viewRef, viewerId])

  /** Move the current match by `delta` (wraps around; no-op when none). */
  const step = useCallback((delta: number): void => {
    const current = stateRef.current
    if (current === null || current.matches.length === 0) return
    const index = (current.index + delta + current.matches.length) % current.matches.length
    const match = current.matches[index]
    if (match === undefined) return
    update({ ...current, index })
    if (modeRef.current === 'preview' && viewerId === 'markdown') jumpInPreview(match)
    else jumpInEditor(match)
  }, [jumpInEditor, jumpInPreview, update, viewerId])

  // CodeMirror key bindings (stable: the handlers read refs only).
  const keymap = useMemo<readonly KeyBinding[]>(() => [
    {
      key: 'Mod-f',
      preventDefault: true,
      run: () => { update({ query: '', matches: [], index: 0 }); return true },
    },
    {
      key: 'Escape',
      run: () => {
        if (stateRef.current === null) return false
        close()
        return true
      },
    },
    { key: 'F3', preventDefault: true, run: () => { step(1); return true } },
    { key: 'Shift-F3', preventDefault: true, run: () => { step(-1); return true } },
  ], [close, step, update])

  // Focus (and pre-select) the input when the bar opens.
  const open = state !== null
  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [open])

  // The preview pane has no CodeMirror surface: catch Mod-f at the document
  // level (the Electron shell provides no browser find dialog).
  useEffect(() => {
    if (viewerId !== 'markdown' || mode !== 'preview') return
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      update({ query: '', matches: [], index: 0 })
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [mode, update, viewerId])

  // A mode flip invalidates the current surface's matches.
  useEffect(() => { close() }, [close, mode])

  return {
    bar: state === null
      ? null
      : (
        <FindBar
          state={state}
          inputRef={inputRef}
          onQuery={search}
          onStep={step}
          onClose={close}
        />
      ),
    keymap,
    close,
  }
}
