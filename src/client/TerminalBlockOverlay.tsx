/**
 * The visual "block" layer of the terminal: hairline dividers at every
 * block boundary (each CLI execution is a UI unit) and, on hover, a span
 * highlight of the block under the mouse plus a floating "add to
 * conversation" pill at the hovered row — the per-block face of the same
 * action the text viewers expose through their selection popup.
 *
 * Geometry: the terminal is DOM-rendered with one viewport row per buffer
 * row, so `cellHeight = .xterm-screen.height / term.rows` and
 * `pixelY = screenOriginY + (bufferRow - viewportY) * cellHeight` — no
 * dependence on renderer-internal row elements. The layer renders inside
 * the terminal host (`.terminal` gained `position: relative`), is
 * pointer-transparent, and only the pill itself receives clicks.
 *
 * Refresh model: nothing here is reactive to React state — the layer
 * redraws itself on a rAF-coalesced tick driven by the terminal's own
 * events (scroll / write-parsed / resize) plus a ResizeObserver on the
 * host; mousemove/mouseleave on the host drive the hover highlight. Blocks
 * come from the tracker; each block's echo row is pinned by an xterm
 * marker (see terminal-blocks.ts), so boundaries stay correct while the
 * scrollback trims or the buffer reflows.
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { blockForSelection, blockSpanLines, type TerminalBlock, type TerminalBlockTracker } from './terminal-blocks.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** The overlay's props. `hostRef` points at the terminal host div (the ref
 *  is read inside effects, so the first render may see a null host — the
 *  layer then renders nothing until the host is attached and ticks). */
export interface TerminalBlockOverlayProps {
  hostRef: RefObject<HTMLDivElement | null>
  term: Terminal
  tracker: TerminalBlockTracker
  /** Banners/errors hide the layer (no blocks to hover while degraded). */
  visible: boolean
  onAddBlock: (block: TerminalBlock) => void
}

/** Hover state: the block under the mouse (by id — the tracker's list
 *  rotates, identity lookup keeps it honest) and the hovered buffer row. */
interface Hover {
  blockId: number
  row: number
}

export function TerminalBlockOverlay(props: TerminalBlockOverlayProps) {
  const { hostRef, term, tracker, visible, onAddBlock } = props
  /** rAF-coalesced redraw tick (scroll/write/resize/host-size). */
  const [, setTick] = useState(0)
  const [hover, setHover] = useState<Hover | null>(null)
  const frameRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const schedule = (): void => {
      if (frameRef.current !== undefined) return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = undefined
        setTick(value => value + 1)
      })
    }
    schedule() // First paint once the host (and its size) exists.
    const scrollSub = term.onScroll(schedule)
    const writeSub = term.onWriteParsed(schedule)
    const resizeSub = term.onResize(schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(host)
    // Hover → highlight + pill. The row under the mouse resolves to a block
    // through the tracker; leaving the terminal clears it.
    const onMove = (event: MouseEvent): void => {
      const screen = host.querySelector<HTMLElement>('.xterm-screen')
      if (screen === null || term.rows === 0) return
      const rect = screen.getBoundingClientRect()
      if (rect.height === 0) return
      const cellHeight = rect.height / term.rows
      const buffer = term.buffer.active
      const row = buffer.viewportY + Math.floor((event.clientY - rect.top) / cellHeight)
      const block = blockForSelection(tracker.blocks, row)
      setHover(block === null ? null : { blockId: block.id, row })
    }
    const onLeave = (): void => { setHover(null) }
    host.addEventListener('mousemove', onMove)
    host.addEventListener('mouseleave', onLeave)
    return () => {
      window.cancelAnimationFrame(frameRef.current ?? 0)
      frameRef.current = undefined
      scrollSub.dispose()
      writeSub.dispose()
      resizeSub.dispose()
      observer.disconnect()
      host.removeEventListener('mousemove', onMove)
      host.removeEventListener('mouseleave', onLeave)
    }
    // `visible` only gates the render; the subscriptions are mount-scoped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostRef, term, tracker])

  const host = hostRef.current
  if (host === null || !visible) return null
  const screen = host.querySelector<HTMLElement>('.xterm-screen')
  if (screen === null) return null
  const hostRect = host.getBoundingClientRect()
  const screenRect = screen.getBoundingClientRect()
  if (screenRect.width === 0 || screenRect.height === 0 || term.rows === 0) return null
  const buffer = term.buffer.active
  // The alt buffer (full-screen TUIs) scrolls/reflows its rows in place —
  // block boundaries do not mean anything there; the layer yields.
  if (buffer.type !== 'normal') return null
  const cellHeight = screenRect.height / term.rows
  const viewportY = buffer.viewportY
  const viewportBottom = viewportY + term.rows
  // The screen's origin inside the host (the host carries the padding; the
  // layer coordinates are relative to the host's border box).
  const originX = screenRect.left - hostRect.left
  const originY = screenRect.top - hostRect.top
  const scrollbarGap = hostRect.width - (originX + screenRect.width)

  const blocks = tracker.blocks
  const bufferLength = buffer.length
  const entries: {
    block: TerminalBlock
    dividerY: number // the echo row's pixel Y (block boundary line)
    spanY: number // clipped visible span: top
    spanH: number // clipped visible span: height
  }[] = []
  for (const block of blocks) {
    const span = blockSpanLines(blocks, block, bufferLength)
    const clipStart = Math.max(span.start, viewportY)
    const clipEnd = Math.min(span.end, viewportBottom)
    if (clipEnd <= clipStart) continue
    entries.push({
      block,
      dividerY: (span.start - viewportY) * cellHeight,
      spanY: (clipStart - viewportY) * cellHeight,
      spanH: (clipEnd - clipStart) * cellHeight - 1,
    })
  }

  const hovered = hover !== null
    ? entries.find(entry => entry.block.id === hover.blockId) ?? null
    : null
  // The pill sits at the hovered row — revalidated against the block's
  // CURRENT span (scrolls shift the buffer under a stale hover). A live
  // text selection suppresses it: the selection popup is the action of
  // record then.
  let pill: { block: TerminalBlock; top: number } | null = null
  if (hovered !== null && hover !== null && !term.hasSelection()) {
    const span = blockSpanLines(blocks, hovered.block, bufferLength)
    if (hover.row >= span.start && hover.row < span.end) {
      pill = {
        block: hovered.block,
        top: originY + (hover.row - viewportY) * cellHeight + (cellHeight - 28) / 2,
      }
    }
  }

  return (
    <div className={css.terminalBlockLayer}>
      {entries.map(({ block, dividerY }) => {
        // A block that started above the viewport has its boundary off-screen
        // — only draw the hairline inside the host.
        if (dividerY < 0 || dividerY > hostRect.height - 1) return null
        return (
          <div
            key={block.id}
            className={css.terminalBlockDivider}
            style={{ top: originY + dividerY, left: originX + 6, right: scrollbarGap + 6 }}
          />
        )
      })}
      {hovered !== null && (
        <div
          className={css.terminalBlockHover}
          style={{ top: originY + hovered.spanY, height: hovered.spanH, left: originX, width: screenRect.width }}
        />
      )}
      {pill !== null && (
        <button
          type="button"
          className={css.terminalBlockPill}
          style={{
            top: Math.max(0, Math.min(pill.top, hostRect.height - 28)),
            right: scrollbarGap + 8,
          }}
          title={pill.block.command}
          onClick={() => { onAddBlock(pill.block) }}
        >
          {t('addToConversation')}
        </button>
      )}
    </div>
  )
}