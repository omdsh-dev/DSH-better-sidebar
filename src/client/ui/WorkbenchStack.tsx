/** A vertical workbench stack. A sash redistributes only the two nearest open sections. */
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createFrameBatcher } from '../frame-batcher.ts'
import css from './workbench-stack.module.css'

export interface WorkbenchStackSection {
  /** Stable id; also the persistence key of this section's weight. */
  id: string
  title: string
  open: boolean
  weight: number
  content: ReactNode
}

interface Drag {
  pointerId: number
  y: number
  room: number
  start: number
  next: number
}

// A sub-pixel reserve keeps each pair adjustable after other panes collapse.
const limit = (value: number): number => Math.min(0.999, Math.max(0.001, value))

function Sash({ top, bottom, ratio, onPreview, onCommit }: {
  top: { id: string; title: string }
  bottom: { id: string; title: string }
  ratio: number
  onPreview(ratio: number): void
  onCommit(ratio: number): void
}): ReactNode {
  const drag = useRef<Drag | null>(null)
  const [batch] = useState(createFrameBatcher)
  useEffect(() => () => batch.dispose(), [batch])

  return <div className={css.sash} role="separator" tabIndex={0} aria-orientation="horizontal"
    aria-label={top.title + ' / ' + bottom.title} aria-controls={top.id + ' ' + bottom.id}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current !== null) return
      const document = event.currentTarget.ownerDocument
      const upper = document.getElementById(top.id)
      const lower = document.getElementById(bottom.id)
      if (upper === null || lower === null) return
      const room = [upper, lower].reduce((sum, pane) => sum
        + pane.getBoundingClientRect().height - parseFloat(getComputedStyle(pane).minHeight), 0)
      if (room <= 0) return
      event.preventDefault()
      event.currentTarget.focus({ preventScroll: true })
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { pointerId: event.pointerId, y: event.clientY, room, start: ratio, next: ratio }
    }}
    onPointerMove={event => {
      const current = drag.current
      if (current?.pointerId !== event.pointerId) return
      current.next = limit(current.start + (event.clientY - current.y) / current.room)
      batch.schedule(() => { onPreview(current.next) })
    }}
    onPointerUp={event => {
      const current = drag.current
      if (current?.pointerId !== event.pointerId) return
      batch.dispose()
      drag.current = null
      const next = limit(current.start + (event.clientY - current.y) / current.room)
      if (next !== current.start) onCommit(next)
      else onPreview(next)
    }}
    onLostPointerCapture={event => {
      const current = drag.current
      if (current?.pointerId !== event.pointerId) return
      batch.dispose()
      drag.current = null
      onPreview(current.start)
    }}
    onKeyDown={event => {
      if (drag.current !== null) return
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1
        : event.key === 'ArrowUp' ? ratio - 0.05 : event.key === 'ArrowDown' ? ratio + 0.05 : undefined
      if (next === undefined) return
      event.preventDefault()
      if (limit(next) !== ratio) onCommit(limit(next))
    }} />
}

export function WorkbenchStack({ sections, initialWeights, onResize }: {
  sections: readonly WorkbenchStackSection[]
  initialWeights?: Record<string, unknown>
  onResize(weights: Record<string, number>): void
}): ReactNode {
  const prefix = useId()
  const [weights, setWeights] = useState(() => Object.fromEntries(sections.map(({ id, weight }) => {
    const saved = initialWeights?.[id]
    return [id, typeof saved === 'number' && Number.isFinite(saved) && saved > 0 ? saved : weight]
  })))
  const opened = sections.filter(section => section.open)
  const openWeight = opened.reduce((sum, section) => sum + (weights[section.id] ?? section.weight), 0)
  let previous: WorkbenchStackSection | undefined
  return <div className={css.stack}>
    {sections.map(section => {
      const top = section.open ? previous : undefined
      if (section.open) previous = section
      const topWeight = top === undefined ? 0 : weights[top.id] ?? top.weight
      const weight = weights[section.id] ?? section.weight
      const total = topWeight + weight
      const resize = (ratio: number, commit: boolean): void => {
        if (top === undefined || total === 0) return
        const next = { ...weights, [top.id]: total * ratio, [section.id]: total * (1 - ratio) }
        setWeights(next)
        if (commit) onResize(next)
      }
      const id = prefix + section.id
      return <Fragment key={section.id}>
        {top !== undefined && total > 0 && <Sash key={top.id}
          top={{ id: prefix + top.id, title: top.title }} bottom={{ id, title: section.title }}
          ratio={topWeight / total} onPreview={ratio => { resize(ratio, false) }} onCommit={ratio => { resize(ratio, true) }} />}
        <div id={id} className={css.stackPane} data-expanded={section.open}
          style={section.open ? { flexGrow: openWeight === 0 ? 1 : weight / Math.min(1, openWeight) } : undefined}>
          {section.content}
        </div>
      </Fragment>
    })}
  </div>
}
