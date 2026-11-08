/**
 * The workflow-graph mode of the Tasks page: layered agent / workflow nodes
 * over bezier edges on a dotted grid, drag-pan from the BACKGROUND only
 * (never from a node — capturing pointers on the container retargets the
 * derived click and silently swallows node clicks), wheel zoom to the cursor,
 * dashed phase frames, fold aggregate nodes, and the bottom-right horizontal
 * control cluster (view toggle / fold / zoom out / level / zoom in / fit)
 * that stays reachable in BOTH modes.
 *
 * Fitting: the canvas auto-fits while the reader has not touched the view,
 * re-running on container resize and layout growth (the sidebar mounts
 * hidden at zero size, so a one-shot fit on mount is not enough), centering
 * on both axes and scaling UP to {@link FIT_MAX_SCALE} so a small tree fills
 * the narrow panel instead of hugging the top-left corner.
 *
 * Cards: the node card recipe of tasks-graph.module.css with a TWO-line
 * clamped title (the card reserve in tasks-graph-layout.ts is sized for that
 * second line, plus one row per live / task line the card renders) and the
 * full name in the `title` attribute. While the root catalog hydrates, an
 * empty canvas shows the same hint as the tree (`loading`).
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular,
  IconFullscreenOutlineRegular,
  IconLoadingOutlineRegular, IconTreeCornerRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TasksAgentNode, TasksFoldNode, TasksNode, TasksWorkflowNode } from './tasks-model.ts'
import { tasksEdges } from './tasks-model.ts'
import {
  GRAPH_FIT_MIN_SCALE, GRAPH_NODE_H, GRAPH_NODE_W, GRAPH_PAD, layoutTasksGraphForWidth,
  textTailLines, type GraphBox,
} from './tasks-graph-layout.ts'
import { createFrameBatcher } from './frame-batcher.ts'
import { useTweenedLayout } from './tasks-layout-tween.ts'
import { easeOut as glideEase } from './tasks-layout-tween.ts'
import { fitTransform, GLIDE_MS, lerpTransform, type ViewTransform } from './tasks-view-glide.ts'

/** Whether the reader asked the platform for less motion. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
import {
  activityLine, agentChip, agentMeta, flatten, foldErrorTally, foldPreviews, FoldGlyph,
  foldTally, TaskLine, WorkflowGlyph, workflowMeta,
} from './tasks-shared.tsx'
import { CardBar, CardTop, phaseClass, type CardKind } from './tasks-card.tsx'
import { localeSignature, t } from './locales.ts'
import css from './tasks-graph.module.css'
import canvasCss from './tasks-canvas.module.css'

/** The zoom bounds of the canvas. The upper bound is deliberately above 1: on
 *  a narrow panel the reader zooms IN to read a card, and the fit's own cap
 *  (FIT_MAX_SCALE) is what keeps a two-node tree from ballooning. */
const ZOOM_MIN = 0.4
const ZOOM_MAX = 2
/** Upper bound of the auto-fit scale (never balloon a two-node tree). */
const FIT_MAX_SCALE = 1.3
/** Breathing room the fit leaves around the CONTENT box, per axis. */
const FIT_MARGIN = 24
/** How much of the canvas must stay on screen while panning (px). */
const PAN_KEEP = 72
/* The readability floor the fit honours is `GRAPH_FIT_MIN_SCALE` (imported):
 * the layout budgets its columns from the same number, so scaling and wrapping
 * can never disagree. */
/** The perpendicular stub each connector leaves a card with (px, pre-scale). */
const EDGE_STUB = 8
/** Drag-vs-click separation: pointer travel below this stays a click. */
const CLICK_TOLERANCE_PX = 4

/**
 * The card kind of one agent node: the node's own role decides the badge, so a
 * teammate never reads as a plain subagent and the root never reads as a child.
 */
function agentCardKind(node: TasksAgentNode): CardKind {
  if (node.team?.role === 'teammate') return 'teammate'
  return node.parentId === undefined ? 'main' : 'subagent'
}

/** Members of one run that already reported an outcome. */
function doneMembers(node: TasksWorkflowNode): number {
  let done = 0
  for (const phase of node.run.phases) {
    for (const member of phase.members) if (member.outcome !== undefined) done += 1
  }
  return done
}

/** Members of one run across every phase. */
function totalMembers(node: TasksWorkflowNode): number {
  let total = 0
  for (const phase of node.run.phases) total += phase.members.length
  return total
}

/** One phase frame of a run node (the dashed box behind its members). */
interface PhaseFrame {
  key: string
  title: string | undefined
  /** The phase's index within its run — drives the frame's colour, which the
   *  members' own phase badges repeat (badge + colour, no lines to decode). */
  index: number
  x: number
  y: number
  w: number
  h: number
}

export interface TasksGraphProps {
  nodes: readonly TasksNode[]
  folded: boolean
  /** Re-fit trigger: the topology root id (a reroot re-centers). */
  rootId: string | undefined
  onNodeInfo(node: TasksAgentNode, anchor: HTMLElement): void
  onWorkflowInfo(node: TasksWorkflowNode, anchor: HTMLElement): void
  /** Open the shared task window for one task id. */
  onOpenTask(taskId: string, anchor: HTMLElement): void
  /** The control cluster's global fold switch (settled leaves). */
  onToggleFold(): void
  /** The fold AGGREGATE's click: reveal THIS group's members only. */
  onExpandGroup(node: TasksFoldNode): void
  /** Fold ONE settled node into its parent's aggregate (the bar's chevron). */
  onFoldNode(node: TasksAgentNode): void
  mode: 'graph' | 'tree'
  onModeChange(mode: 'graph' | 'tree'): void
  /** Fallback hint while the root catalog hydrates (the graph twin of
   *  TasksTree's loading row: the same copy key, the same "nothing to show
   *  yet" condition). */
  loading?: boolean
}

/** The shared view-mode toggle (glyph + label) both modes render in their
 *  bottom-right control cluster. */
export function ViewModeToggle(props: {
  mode: 'graph' | 'tree'
  onModeChange(mode: 'graph' | 'tree'): void
}): ReactNode {
  const { mode, onModeChange } = props
  const toTree = mode === 'graph'
  const label = toTree ? t('tasksViewTree') : t('tasksViewGraph')
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={toTree ? <IconTreeCornerRegular /> : <WorkflowGlyph size={13} />}
      aria-label={t(toTree ? 'tasksViewSwitchToTree' : 'tasksViewSwitchToGraph')}
      title={t(toTree ? 'tasksViewSwitchToTree' : 'tasksViewSwitchToGraph')}
      onClick={() => { onModeChange(toTree ? 'tree' : 'graph') }}
    >
      {label}
    </Button>
  )
}

/** The fold toggle (expand / re-collapse the settled aggregates). */
/**
 * The cluster's fold switch. Its glyph names the action it will take, not the
 * state it is in: while the settled nodes are folded the button offers to
 * EXPAND (chevron down), and while they are open it offers to FOLD (chevron
 * up, the same collapse direction the cards' own bar buttons wear). The old
 * single checklist glyph read identically in both states, which is what the
 * reader reported as "折叠按钮和展开一样".
 */
export function FoldToggleButton(props: { folded: boolean; onToggleFold(): void }): ReactNode {
  const { folded, onToggleFold } = props
  return (
    <Button
      variant="ghost"
      size="sm"
      className={clsx(css.controlBtn, folded && css.controlBtnActive)}
      icon={folded
        ? <IconChevronDownOutlineRegular size={13} />
        : <IconChevronUpOutlineRegular size={13} />}
      aria-pressed={folded}
      aria-label={t(folded ? 'tasksFoldExpand' : 'tasksFoldCollapse')}
      title={t(folded ? 'tasksFoldExpand' : 'tasksFoldCollapse')}
      onClick={onToggleFold}
    />
  )
}

export function TasksGraph(props: TasksGraphProps): ReactNode {
  const {
    nodes, folded, rootId, onNodeInfo, onWorkflowInfo, onOpenTask, onToggleFold, onExpandGroup,
    onFoldNode, mode, onModeChange, loading,
  } = props
  const containerRef = useRef<HTMLDivElement>(null)
  /*
   * The canvas deliberately runs NO FLIP library: auto-animate pins a leaving
   * card with absolute `left/top` measured from `getBoundingClientRect()` and
   * translates the movers in UNSCALED units, while this layer carries the
   * fit's `transform: scale(k)`. Inside that layer the leaving card's pinned
   * box cannot even be expressed (its position jumps) and every mover travels
   * k× its true distance — reproduced live as "折叠展开的动效都特别怪".
   * Cards therefore arrive with the CSS entrance in tasks-graph.module.css
   * (mount-only, no geometry math) and leave instantly; the edges they hang
   * from are not animated either, so nothing disagrees with them.
   */
  const [tf, setTf] = useState({ x: 0, y: 0, k: 1 })
  const [dragging, setDragging] = useState(false)
  /** Pointer travel of the in-flight gesture (click suppression). */
  const travelRef = useRef(0)
  /** The reader moved/zoomed: stop auto-fitting over their view. */
  const touchedRef = useRef(false)
  const tfRef = useRef(tf)
  tfRef.current = tf

  /** Container width drives the sibling-band wrap (see bandColsFor). */
  const [width, setWidth] = useState(0)
  const layout = useMemo(
    () => layoutTasksGraphForWidth(nodes, width, GRAPH_FIT_MIN_SCALE),
    [nodes, width],
  )
  /**
   * What is actually drawn: the layout tweened towards, frame by frame, in the
   * canvas's OWN coordinates (see tasks-layout-tween.ts — a screen-space FLIP
   * library cannot work under the fit's scale). Cards, connectors and phase
   * frames all read it, so the lines travel WITH the cards instead of snapping
   * to the new geometry.
   */
  const drawn = useTweenedLayout(layout)
  const edges = useMemo(() => tasksEdges(nodes), [nodes])
  const nodeById = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes])

  /** A running view glide (see fit): cancelled by any reader gesture. */
  const glideRef = useRef(0)

  /** Stop a glide where it is (the reader took the wheel). */
  const stopGlide = useCallback((): void => {
    if (glideRef.current !== 0) {
      cancelAnimationFrame(glideRef.current)
      glideRef.current = 0
    }
  }, [])

  /**
   * The frame the auto-fit wants right now, or undefined before the container
   * has been measured (the sidebar mounts hidden at zero size). The arithmetic
   * lives in tasks-view-glide.ts, where a test can reach it.
   */
  const fitTarget = useCallback((): ViewTransform | undefined => {
    const container = containerRef.current
    if (container === null) return undefined
    return fitTransform({
      containerW: container.clientWidth,
      containerH: container.clientHeight,
      layoutW: layout.width,
      layoutH: layout.height,
      pad: GRAPH_PAD,
      minContentW: GRAPH_NODE_W,
      minContentH: GRAPH_NODE_H,
      margin: FIT_MARGIN,
      minScale: GRAPH_FIT_MIN_SCALE,
      maxScale: FIT_MAX_SCALE,
    })
  }, [layout.width, layout.height])

  /**
   * Put the frame where the fit wants it, either at once (a resize while the
   * reader drags the panel edge, a fresh session) or as a GLIDE — the layout
   * tween moves the cards, and the frame has to travel with them instead of
   * jumping to the new framing a frame later. That glide is what makes "stay
   * auto-fitted" and "never yank the view" the same behavior.
   *
   * @param animate - glide instead of snapping.
   */
  const applyFit = useCallback((animate: boolean): void => {
    const target = fitTarget()
    if (target === undefined) return
    stopGlide()
    if (!animate || prefersReducedMotion()) {
      setTf(target)
      return
    }
    const from = tfRef.current
    const started = performance.now()
    const step = (): void => {
      const progress = glideEase((performance.now() - started) / GLIDE_MS)
      setTf(lerpTransform(from, target, progress))
      glideRef.current = progress < 1 ? requestAnimationFrame(step) : 0
    }
    glideRef.current = requestAnimationFrame(step)
  }, [fitTarget, stopGlide])

  /** The reader's own re-fit (the ⌂ button and a background double-click). */
  const fit = useCallback((): void => { applyFit(true) }, [applyFit])

  /**
   * Keep the canvas reachable: a pan or a zoom-out may never push the whole
   * graph off screen (the classic "I dragged it away and cannot find it").
   * `PAN_KEEP` px of content stay inside the container on every axis.
   */
  const clampTf = useCallback((next: { x: number; y: number; k: number }) => {
    const container = containerRef.current
    if (container === null) return next
    const cw = container.clientWidth
    const ch = container.clientHeight
    const w = layout.width * next.k
    const h = layout.height * next.k
    const minX = Math.min(PAN_KEEP, cw - PAN_KEEP) - w
    const maxX = Math.max(PAN_KEEP, cw - PAN_KEEP)
    const minY = Math.min(PAN_KEEP, ch - PAN_KEEP) - h
    const maxY = Math.max(PAN_KEEP, ch - PAN_KEEP)
    return {
      x: Math.min(maxX, Math.max(minX, next.x)),
      y: Math.min(maxY, Math.max(minY, next.y)),
      k: next.k,
    }
  }, [layout.width, layout.height])

  /** The ⌂ button: refit AND re-enable auto-fit for later resizes. */
  const refit = useCallback((): void => {
    touchedRef.current = false
    fit()
  }, [fit])

  /** The newest `applyFit`, so the effects below can depend on WHAT changed. */
  const fitRef = useRef(applyFit)
  fitRef.current = applyFit

  // A different tree is a different canvas: re-fit AND hand the view back to the
  // auto-fit, whatever the reader did to the previous one. Snapped, because the
  // content changes wholesale.
  useEffect(() => {
    touchedRef.current = false
    fitRef.current(false)
  }, [rootId])

  // Layout growth while the reader has left the view alone: glide to the new
  // framing, so expanding a group KEEPS the graph centred and inside the panel
  // without the frame jumping out from under the cards travelling to it. A
  // reader who panned or zoomed owns the view, and nothing moves it.
  useEffect(() => {
    if (!touchedRef.current) fitRef.current(true)
  }, [layout.width, layout.height])

  useEffect(() => {
    const container = containerRef.current
    if (container === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect !== undefined) setWidth(current => (Math.abs(current - rect.width) < 2 ? current : rect.width))
      if (!touchedRef.current) fit()
    })
    observer.observe(container)
    return () => { observer.disconnect() }
  }, [fit])

  /**
   * Wheel zoom is applied at most once per animation frame, for the same
   * reason the pan is: a trackpad (and a high-report-rate mouse) delivers
   * several wheel events per display frame, and every one of them
   * used to commit a full canvas re-render. Each event chains off the PENDING
   * transform rather than the last drawn one, so coalescing never loses a zoom
   * step — the old code re-read `tfRef` for every event and only one step
   * survived the frame.
   */
  const wheelBatcher = useRef(createFrameBatcher()).current
  const pendingWheelRef = useRef<{ x: number; y: number; k: number } | null>(null)
  /**
   * A background pan gesture owns the transform from pointerdown to release.
   * Wheel zoom and the pan both commit a WHOLE transform, so a wheel mid-drag
   * would be overwritten by the pan's next frame (or vice versa); the wheel is
   * ignored while the gesture is live instead.
   */
  const panActiveRef = useRef(false)

  // Wheel-zoom to cursor (non-passive: the page must not scroll).
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (panActiveRef.current) return
      const rect = container.getBoundingClientRect()
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      const base = pendingWheelRef.current ?? tfRef.current
      // Wheel deltas arrive in pixels, lines or pages depending on the device;
      // normalise first, or a line-scrolling mouse zooms 30× slower than a
      // trackpad (and a trackpad pinch, which reports ctrlKey, feels stuck).
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, base.k * Math.exp(-event.deltaY * unit * 0.0014)))
      if (next === base.k) return
      touchedRef.current = true
      stopGlide()
      // Clamp EACH composed step, not just the frame's final value: the old
      // one-event-per-frame code clamped every step, and a later step's anchor
      // math must start from the in-bounds transform the earlier one would
      // have shown (otherwise coalescing changes where the zoom lands).
      pendingWheelRef.current = clampTf({
        x: mx - (mx - base.x) * (next / base.k),
        y: my - (my - base.y) * (next / base.k),
        k: next,
      })
      wheelBatcher.schedule(() => {
        const pending = pendingWheelRef.current
        if (pending === null) return
        pendingWheelRef.current = null
        setTf(clampTf(pending))
      })
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => { container.removeEventListener('wheel', onWheel) }
  }, [clampTf, stopGlide, wheelBatcher])

  const zoomBy = useCallback((factor: number): void => {
    const container = containerRef.current
    const { x, y, k } = tfRef.current
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k * factor))
    if (next === k || container === null) return
    touchedRef.current = true
    stopGlide()
    const mx = container.clientWidth / 2
    const my = container.clientHeight / 2
    setTf(clampTf({ x: mx - (mx - x) * (next / k), y: my - (my - y) * (next / k), k: next }))
  }, [clampTf, stopGlide])

  /**
   * Drag-pan. The gesture only ever starts on the BACKGROUND: a pointerdown
   * on a node (or the control cluster) is left alone, so the node's own click
   * fires. Listeners live on `window` — never `setPointerCapture` on the
   * container, which retargets the derived click event and silently kills
   * every node interaction.
   */
  /**
   * Double-clicking the BACKGROUND re-fits and hands the view back to auto-fit
   * (the gesture a pan/zoom away from the graph needs); a double-click on a
   * card stays the card's own.
   */
  const onDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    if (target.closest('[data-graph-node]') !== null) return
    if (target.closest('[data-graph-controls]') !== null) return
    refit()
  }, [refit])

  /**
   * The pan is applied at most once per animation frame. A pointer stream fires
   * several times faster than the display (a 1000 Hz mouse, a trackpad, some
   * Electron builds), and committing every move re-renders the whole canvas —
   * cards and edges — at event cadence. The latest position is composed in a
   * ref and the frame task reads it, so coalescing loses nothing; release
   * flushes synchronously so the final position is never dropped.
   */
  const panBatcher = useRef(createFrameBatcher()).current
  const pendingPanRef = useRef<{ x: number; y: number; k: number } | null>(null)
  const draggingRef = useRef(false)
  useEffect(() => () => {
    panBatcher.dispose()
    wheelBatcher.dispose()
  }, [panBatcher, wheelBatcher])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    stopGlide()
    // Click suppression belongs to ONE gesture. A node's next pointerdown
    // must release the previous background pan before the node guard returns.
    travelRef.current = 0
    const target = event.target as HTMLElement
    if (target.closest('[data-graph-node]') !== null) return
    if (target.closest('[data-graph-controls]') !== null) return
    const startX = event.clientX
    const startY = event.clientY
    panActiveRef.current = true
    const { x, y } = tfRef.current
    const onMove = (move: globalThis.PointerEvent): void => {
      const dx = move.clientX - startX
      const dy = move.clientY - startY
      travelRef.current = Math.max(travelRef.current, Math.abs(dx) + Math.abs(dy))
      if (travelRef.current <= CLICK_TOLERANCE_PX) return
      touchedRef.current = true
      if (!draggingRef.current) {
        draggingRef.current = true
        setDragging(true)
      }
      pendingPanRef.current = { x: x + dx, y: y + dy, k: tfRef.current.k }
      panBatcher.schedule(() => {
        const pending = pendingPanRef.current
        if (pending === null) return
        pendingPanRef.current = null
        setTf(clampTf(pending))
      })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      panBatcher.flushNow()
      panActiveRef.current = false
      draggingRef.current = false
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [clampTf, panBatcher, stopGlide])

  /** Suppress node clicks that ended a drag gesture. */
  const clickAllowed = useCallback((): boolean => travelRef.current <= CLICK_TOLERANCE_PX, [])

  /*
   * Folding does NOT claim the view. The frame stays auto-fitted for as long as
   * the reader has not panned or zoomed, and the fit GLIDES (applyFit), so a
   * group that expands larger than the panel stays centred and inside it
   * without the jump that claiming the view used to trade for.
   */

  // Phase frames: group each run's members by phase and box them.
  const phaseFrames = useMemo((): PhaseFrame[] => {
    const frames: PhaseFrame[] = []
    for (const node of nodes) {
      if (node.kind !== 'workflow') continue
      const runNode = node
      runNode.run.phases.forEach((phase, phaseIndex) => {
        const boxes: GraphBox[] = []
        for (const member of phase.members) {
          const id = member.childId !== '' ? member.childId : `wfmember:${runNode.run.runId}:${member.seq}`
          const box = drawn.boxes.get(id)
          if (box !== undefined) boxes.push(box)
        }
        if (boxes.length === 0) return
        const x1 = Math.min(...boxes.map(box => box.x)) - 12
        const y1 = Math.min(...boxes.map(box => box.y)) - 20
        const x2 = Math.max(...boxes.map(box => box.x + box.w)) + 12
        const y2 = Math.max(...boxes.map(box => box.y + box.h)) + 12
        frames.push({
          key: `${runNode.id}:${phaseIndex}`,
          title: phase.title,
          index: phaseIndex,
          x: x1,
          y: y1,
          w: x2 - x1,
          h: y2 - y1,
        })
      })
    }
    return frames
  }, [nodes, drawn])

  /**
   * The connector between two boxes: a straight PERPENDICULAR stub out of the
   * parent's bottom and into the child's top, joined by one bezier. The stubs
   * are what make the hierarchy legible where several lines leave one card —
   * a pure bottom-center-to-top-center bezier leaves at an angle, so a ranked
   * tree reads as a fan of diagonals over the cards between the rows.
   */
  const edgePath = (from: GraphBox, to: GraphBox): string => {
    const x1 = from.x + from.w / 2
    const y1 = from.y + from.h
    const x2 = to.x + to.w / 2
    const y2 = to.y
    const span = Math.max(0, y2 - y1)
    const stub = Math.min(EDGE_STUB, span / 3)
    const dy = Math.max(16, (y2 - y1 - stub * 2) / 2)
    return `M ${x1} ${y1} L ${x1} ${y1 + stub} `
      + `C ${x1} ${y1 + stub + dy} ${x2} ${y2 - stub - dy} ${x2} ${y2 - stub} `
      + `L ${x2} ${y2}`
  }

  return (
    <div className={css.graphView}>
      <div
        ref={containerRef}
        className={clsx(css.canvas, dragging && css.canvasDragging)}
        role="group"
        aria-label={t('tasksViewGraph')}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
      >
        {/* The graph twin of TasksTree's loading row: the same copy key and the
            same "nothing to show yet" condition (an empty canvas would render
            as a bare grid). `pointer-events: none` keeps the canvas's pan /
            zoom / node clicks fully live underneath. */}
        {loading === true && nodes.length === 0 && (
          <div className={canvasCss.loading}>
            <span className={canvasCss.loadingGlyph} aria-hidden="true"><IconLoadingOutlineRegular size={12} /></span>
            {t('loading')}
          </div>
        )}
        <div
          className={css.canvasInner}
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.k})`,
          }}
        >
          <svg className={css.edges} width={layout.width} height={layout.height} aria-hidden="true">
            {edges.map((edge) => {
              const from = drawn.boxes.get(edge.from)
              const to = drawn.boxes.get(edge.to)
              if (from === undefined || to === undefined) return null
              const target = nodeById.get(edge.to)
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  className={clsx(
                    css.edge,
                    edge.kind === 'team' && css.edgeTeam,
                    edge.kind === 'workflow' && css.edgeWorkflow,
                    target?.kind === 'fold' && css.edgeFold,
                  )}
                  d={edgePath(from, to)}
                />
              )
            })}
          </svg>
          {phaseFrames.map(frame => (
            <div
              key={frame.key}
              className={clsx(css.phaseFrame, phaseClass(frame.index))}
              style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
            >
              <span className={css.phaseLabel}>{frame.title ?? t('workflowPhaseUnnamed')}</span>
            </div>
          ))}
          {/* KEYBOARD ACCESS (deliberate): graph nodes render with tabIndex={-1}
              on purpose — a graph with dozens of nodes would add dozens of Tab
              stops and drown the page's real controls, and the canvas itself
              supports pointer pan/zoom only. The keyboard-equivalent path is the
              bottom-right control cluster (`data-graph-controls`): its "switch to
              tree" toggle is a real <button> (Tab-reachable, Enter/Space-
              activatable), and tree mode provides the full Arrow/Home/End/Enter
              navigation over the same nodes (see TasksTree). Do NOT "fix" the
              nodes' tabIndex without fixing the tab-stop flood. */}
          {nodes.map((node, index) => {
            const box = drawn.boxes.get(node.id)
            if (box === undefined) return null
            const style = {
              left: box.x,
              top: box.y,
              width: GRAPH_NODE_W,
              minHeight: box.h,
              /*
               * The entrance is STAGGERED by the node's page order: a group that
               * reveals several cards at once (or a page that loads a tree)
               * cascades instead of popping in one frame. Capped, so a big tree
               * settles quickly, and inert for cards that were already mounted
               * (their entrance ran when they arrived).
               */
              animationDelay: `${Math.min(index, 9) * 26}ms`,
            }
            if (node.kind === 'fold') return renderFoldNode(node, style, onExpandGroup, clickAllowed)
            if (node.kind === 'workflow') {
              return renderWorkflowNode(node, style, onWorkflowInfo, clickAllowed)
            }
            return renderAgentNode(node, style, onNodeInfo, onOpenTask, clickAllowed, onFoldNode)
          })}
        </div>
        <div className={css.controls} data-graph-controls>
          <ViewModeToggle mode={mode} onModeChange={onModeChange} />
          <FoldToggleButton folded={folded} onToggleFold={onToggleFold} />
          <Button
            variant="ghost"
            size="sm"
            className={css.controlBtn}
            aria-label={t('tasksZoomOut')}
            title={t('tasksZoomOut')}
            onClick={() => { zoomBy(1 / 1.2) }}
          >
            −
          </Button>
          <span className={css.controlZoomLevel} aria-hidden="true">{Math.round(tf.k * 100)}%</span>
          <Button
            variant="ghost"
            size="sm"
            className={css.controlBtn}
            aria-label={t('tasksZoomIn')}
            title={t('tasksZoomIn')}
            onClick={() => { zoomBy(1.2) }}
          >
            +
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={css.controlBtn}
            icon={<IconFullscreenOutlineRegular size={13} />}
            aria-label={t('tasksZoomFit')}
            title={t('tasksZoomFit')}
            onClick={refit}
          />
        </div>
      </div>
    </div>
  )
}

/** One agent node card: identity on top, the state bar at the bottom. */
function renderAgentNode(
  node: TasksAgentNode,
  style: { left: number; top: number; width: number; minHeight: number },
  onNodeInfo: (node: TasksAgentNode, anchor: HTMLElement) => void,
  onOpenTask: (taskId: string, anchor: HTMLElement) => void,
  clickAllowed: () => boolean,
  onFold?: (node: TasksAgentNode) => void,
): ReactNode {
  const settled = node.state === 'done' || node.state === 'error'
  return (
    <div
      key={node.id}
      data-graph-node={node.id}
      data-depth={node.depth}
      role="button"
      tabIndex={-1}
      aria-label={`${node.label} ${agentMeta(node)}`}
      aria-current={node.current ? 'true' : undefined}
      className={clsx(
        css.node,
        node.team?.role === 'teammate' && css.nodeTeam,
        node.current && css.nodeCurrent,
        settled && !node.current && css.nodeSettled,
        node.state === 'error' && css.nodeError,
      )}
      style={style}
      onClick={(event) => {
        if (!clickAllowed()) return
        onNodeInfo(node, event.currentTarget)
      }}
    >
      <AgentCardContents
        key={localeSignature()}
        node={node}
        onOpenTask={onOpenTask}
        onFold={onFold}
      />
    </div>
  )
}

/** Position changes do not rebuild the card's text, badges or task controls. */
const AgentCardContents = memo(function AgentCardContents(props: {
  node: TasksAgentNode
  onOpenTask: (taskId: string, anchor: HTMLElement) => void
  onFold: ((node: TasksAgentNode) => void) | undefined
}): ReactNode {
  const { node, onOpenTask, onFold } = props
  const settled = node.state === 'done' || node.state === 'error'
  /**
   * Whether this card offers its own fold chevron. A WAITING member counts:
   * it is not executing either, and the chevron is the reader's own trigger
   * (independent of the page-level rule and of the idle head count). The
   * `settled` flag stays a separate idea — that one controls how the card
   * RECEDES, and an idle teammate is not finished work.
   *
   * The ROOT never offers it: the model pushes the root card unconditionally
   * (it is the page's anchor and its tree's parent), so a chevron there is a
   * control that cannot fire — exactly the dead-button shape the manual-fold
   * design set out to avoid (issue #784). `parentId` is absent on the root row
   * and only there.
   */
  const foldable = (settled || node.state === 'idle') && node.parentId !== undefined
  /** The merged process line the bar shows in place of the state word. */
  const activity = activityLine(node)
  /** The identity word beside the kind badge (one badge row, no meta line). */
  const chip = agentChip(node)
  /**
   * The newest assistant text, under the name: what the node is SAYING (a
   * running child) or said last (a settled one). The bar keeps the merged
   * activity — the two answer different questions — and the line count comes
   * from the layout so the card never renders taller than its box.
   */
  const tail = node.live?.text === undefined ? undefined : flatten(node.live.text)
  return (
    <>
      <CardTop
        kind={agentCardKind(node)}
        depth={node.depth}
        {...(node.phase === undefined ? {} : { phase: node.phase })}
        {...(chip === undefined ? {} : { chip })}
        {...(tail === undefined ? {} : { text: { value: tail, lines: textTailLines(tail) } })}
        name={node.label}
      >
        <TaskLine tasks={node.tasks} onOpenTask={onOpenTask} />
      </CardTop>
      <CardBar
        state={node.state}
        running={node.state === 'running'}
        {...(activity === undefined ? {} : { activity })}
        {...(foldable && !node.current && onFold !== undefined
          ? { onFold: () => { onFold(node) } }
          : {})}
      />
    </>
  )
})

/** One workflow run node card: same frame, its own badges and state. */
function renderWorkflowNode(
  node: TasksWorkflowNode,
  style: { left: number; top: number; width: number; minHeight: number },
  onWorkflowInfo: (node: TasksWorkflowNode, anchor: HTMLElement) => void,
  clickAllowed: () => boolean,
): ReactNode {
  const running = node.run.status === 'running'
  return (
    <div
      key={node.id}
      data-graph-node={node.id}
      data-depth={node.depth}
      role="button"
      tabIndex={-1}
      aria-label={`${node.run.name} ${workflowMeta(node)}`}
      className={clsx(css.node, css.nodeWorkflow, !running && css.nodeSettled)}
      style={style}
      onClick={(event) => {
        if (!clickAllowed()) return
        onWorkflowInfo(node, event.currentTarget)
      }}
    >
      <CardTop
        kind="workflow"
        depth={node.depth}
        name={node.run.name}
        meta={workflowMeta(node)}
      />
      <CardBar
        state={running ? 'running' : 'done'}
        running={running}
        stateWord={false}
        activity={t('workflowMembers', { done: doneMembers(node), total: totalMembers(node) })}
      />
    </div>
  )
}

/**
 * One fold aggregate node: the finished or the waiting members of one parent,
 * collapsed. Its bar is the action row — the group's own glyph, the word that
 * names what a click does, and the expand chevron — so the whole card stays one
 * click target.
 *
 * The count is printed ONCE: the badge above names it, so the bar carries the
 * ACTION instead (a bare chevron in an otherwise empty strip read as a broken
 * card), plus the one fact the badge cannot say — a stray failure ("出错 N"
 * would otherwise hide inside the ✓). The full tally stays the card's
 * accessible name and tooltip, which a screen reader reads instead of the
 * badge's inner text.
 */
function renderFoldNode(
  node: TasksFoldNode,
  style: { left: number; top: number; width: number; minHeight: number },
  onExpandGroup: (node: TasksFoldNode) => void,
  clickAllowed: () => boolean,
): ReactNode {
  const errors = foldErrorTally(node)
  return (
    <div
      key={node.id}
      data-graph-node={node.id}
      data-depth={node.depth}
      role="button"
      tabIndex={-1}
      aria-label={`${foldTally(node)} · ${t('tasksFoldExpand')}`}
      className={clsx(css.node, css.nodeFold)}
      style={style}
      onClick={() => {
        if (!clickAllowed()) return
        onExpandGroup(node)
      }}
    >
      <CardTop
        kind="fold"
        count={node.count}
        foldKind={node.foldKind}
        depth={node.depth}
        name={foldPreviews(node.previews, node.count)}
        extraClass={css.cardNamePlain}
      />
      <CardBar state={node.foldKind === 'idle' ? 'idle' : 'done'} stateWord={false}>
        <span className={css.barFoldGlyph} aria-hidden="true"><FoldGlyph size={10} /></span>
        <span className={css.barAction} title={foldTally(node)}>{t('tasksFoldExpandShort')}</span>
        {errors !== undefined && (
          <span className={css.barError}>{errors}</span>
        )}
        <span className={css.barFold} aria-hidden="true">
          <IconChevronDownOutlineRegular size={12} />
        </span>
      </CardBar>
    </div>
  )
}
