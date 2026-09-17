/**
 * The workflow-graph mode of the Tasks page (the approved Variant-D canvas):
 * layered agent/workflow nodes over bezier edges on a dotted grid, drag-pan
 * from the BACKGROUND only (never from a node — the mockup's rule; capturing
 * pointers on the container is what silently swallowed node clicks), wheel
 * zoom to the cursor, dashed phase frames, fold aggregate nodes, and the
 * bottom-right horizontal control cluster (view toggle / zoom out / level /
 * zoom in / fit) that stays reachable in BOTH modes.
 *
 * Fitting: the canvas auto-fits while the reader has not touched the view,
 * re-running on container resize and layout growth (the sidebar mounts
 * hidden at zero size, so a one-shot fit on mount is not enough), centering
 * on both axes and scaling UP to {@link FIT_MAX_SCALE} so a small tree fills
 * the narrow panel instead of hugging the top-left corner.
 *
 * Visual language: every node is a shadcn `Card` — a single 1px `border-border`
 * hairline over the surface ladder, `hover:bg-muted` as the only hover change,
 * no shadow (nothing here floats) and no card tint (the old double/dashed
 * borders and the filled workflow cards are gone; "current" is a 2px accent
 * bar, running is the host `StateDot` plus the live line). Statuses ride the
 * mono meta line, team membership is a `Badge`, a truncated line carries its
 * full text in a shadcn `Tooltip`, and the control cluster is the vendored
 * `Button` recipe (`ghost` / `sm`) with a tooltip per control. The phase frames
 * are 1px dashed `border-border` boxes and the relations are hairline strokes
 * in the border ink (see tasks-canvas.module.css for the canvas-only pieces:
 * the dotted grid, the transformed layer and the edge strokes).
 *
 * Behaviour is unchanged: the same pointer-down-on-background pan, the same
 * wheel zoom to cursor, the same click tolerance, the same auto-fit, and the
 * same stable hooks (`data-graph-node`, `data-graph-controls`, `role="group"`,
 * the aria-label copy).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  IconChecklistOutline14, IconFullscreenOutline16, IconTreeCorner8x10, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TasksAgentNode, TasksFoldNode, TasksNode, TasksWorkflowNode } from './tasks-model.ts'
import { tasksEdges } from './tasks-model.ts'
import { GRAPH_NODE_W, layoutTasksGraphForWidth, type GraphBox } from './tasks-graph-layout.ts'
import {
  AgentGlyph, agentMeta, FoldGlyph, foldPreviews, LiveLine, nodeDotState, TaskLine,
  WorkflowGlyph, workflowMeta,
} from './tasks-shared.tsx'
import { t } from './locales.ts'
import { Badge } from './ui/badge.tsx'
import { buttonVariants } from './ui/button.tsx'
import { Card } from './ui/card.tsx'
import { Spinner } from './ui/spinner.tsx'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx'
import { cn } from './ui/utils.ts'
import css from './tasks-canvas.module.css'

/** The zoom bounds of the canvas. */
const ZOOM_MIN = 0.3
const ZOOM_MAX = 1.5
/** Upper bound of the auto-fit scale (never balloon a two-node tree). */
const FIT_MAX_SCALE = 1.15
/** Lower bound of the auto-fit scale: below this the cards stop being
 *  readable, so the canvas overflows and pans instead of shrinking further. */
const FIT_MIN_SCALE = 0.78
/** Drag-vs-click separation: pointer travel below this stays a click. */
const CLICK_TOLERANCE_PX = 4

/**
 * The shared shell of every node card: absolute (the layout owns left/top),
 * one 1px hairline, the card surface, and `hover:bg-muted` as the only hover
 * change. No shadow — a node never floats — and no tint.
 */
const NODE_CARD = 'absolute cursor-pointer gap-0 overflow-hidden rounded-lg border-border bg-card px-2 py-1.5 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring'
/** The on-screen session: a 2px accent bar, never a tinted or shadowed card. */
const NODE_ACCENT = 'border-l-2 border-l-primary'
/** Settled nodes recede by INK, not by opacity: the whole card drops to the
 *  secondary ink (the title inherits it) and the meta line goes one level
 *  further down (`text-foreground-3`, appended over NODE_META). */
const NODE_SETTLED = 'text-muted-foreground'
/** Card line 1: 12px medium, clamped to TWO lines — at 150px a single
 *  ellipsized line left ~7 CJK characters, which is what made a dense graph
 *  unreadable. The tooltip still carries the full name. */
const NODE_TITLE = 'min-w-0 flex-1 line-clamp-2 text-xs leading-[1.3] font-medium [overflow-wrap:anywhere]'
/** The mono meta line: 11px, tabular figures, secondary ink. */
const NODE_META = 'mt-0.5 truncate font-mono text-[11px] leading-[1.3] tabular-nums text-muted-foreground'

/** One phase frame of a run node (the dashed box behind its members). */
interface PhaseFrame {
  key: string
  title: string | undefined
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
  onToggleFold(): void
  mode: 'graph' | 'tree'
  onModeChange(mode: 'graph' | 'tree'): void
  /** Fallback loading overlay while the root catalog hydrates (the same
   *  signal TasksTree renders its loading row for). */
  loading?: boolean
}

/**
 * One button of the control cluster: the vendored `Button`'s own `ghost` / `sm`
 * recipe on a real `<button>`, with a shadcn tooltip carrying the same copy as
 * the aria-label (`title` used to carry it; the bubble replaces it).
 *
 * The recipe comes from `buttonVariants` rather than the `Button` component for
 * one concrete reason: Radix's `TooltipTrigger` has to attach its ref to the
 * anchor, and the vendored `Button` is a plain function component (not a
 * `forwardRef` one), so on React 18 the cloned ref is dropped with a warning
 * and the tooltip would measure nothing. The rendered element is exactly what
 * `<Button variant="ghost" size="sm">` renders.
 */
function ControlButton(props: {
  label: string
  pressed?: boolean
  onClick(): void
  children: ReactNode
}): ReactNode {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'flex-none px-2 text-[13px]',
              props.pressed === true && 'bg-muted text-foreground',
            )}
            aria-label={props.label}
            aria-pressed={props.pressed}
            onClick={props.onClick}
          >
            {props.children}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-[11px]">{props.label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * One ellipsized card line plus the tooltip that carries its full text — the
 * shadcn replacement for the native `title` these lines used to wear. The
 * anchor is the line itself, so hovering the dot/glyph gutter stays quiet.
 */
function CardLine(props: { className: string; label: string; children?: ReactNode }): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={props.className}>{props.children ?? props.label}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">{props.label}</TooltipContent>
    </Tooltip>
  )
}

/** The shared view-mode toggle (glyph + label, per the mockup). */
export function ViewModeToggle(props: {
  mode: 'graph' | 'tree'
  onModeChange(mode: 'graph' | 'tree'): void
}): ReactNode {
  const { mode, onModeChange } = props
  const toTree = mode === 'graph'
  const label = toTree ? t('tasksViewTree') : t('tasksViewGraph')
  return (
    <ControlButton
      label={t(toTree ? 'tasksViewSwitchToTree' : 'tasksViewSwitchToGraph')}
      onClick={() => { onModeChange(toTree ? 'tree' : 'graph') }}
    >
      {toTree ? <IconTreeCorner8x10 /> : <WorkflowGlyph />}
      {label}
    </ControlButton>
  )
}

/** The fold toggle (expand / re-collapse the settled aggregates). */
export function FoldToggleButton(props: { folded: boolean; onToggleFold(): void }): ReactNode {
  const { folded, onToggleFold } = props
  return (
    <ControlButton
      label={t(folded ? 'tasksFoldExpand' : 'tasksFoldCollapse')}
      pressed={folded}
      onClick={onToggleFold}
    >
      <IconChecklistOutline14 />
    </ControlButton>
  )
}

export function TasksGraph(props: TasksGraphProps): ReactNode {
  const { nodes, folded, rootId, onNodeInfo, onWorkflowInfo, onOpenTask, onToggleFold, mode, onModeChange, loading } = props
  const containerRef = useRef<HTMLDivElement>(null)
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
    () => layoutTasksGraphForWidth(nodes, width, FIT_MIN_SCALE),
    [nodes, width],
  )
  const edges = useMemo(() => tasksEdges(nodes), [nodes])
  const nodeById = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes])

  /** Center the canvas in the container (both axes) and scale to fill. */
  const fit = useCallback((): void => {
    const container = containerRef.current
    if (container === null) return
    const cw = container.clientWidth
    const ch = container.clientHeight
    if (cw === 0 || ch === 0) return
    const k = Math.max(
      FIT_MIN_SCALE,
      Math.min((cw - 24) / layout.width, (ch - 24) / layout.height, FIT_MAX_SCALE),
    )
    setTf({
      x: (cw - layout.width * k) / 2,
      y: Math.max(8, (ch - layout.height * k) / 2),
      k,
    })
  }, [layout.width, layout.height])

  /** The ⌂ button: refit AND re-enable auto-fit for later resizes. */
  const refit = useCallback((): void => {
    touchedRef.current = false
    fit()
  }, [fit])

  // Auto-fit on mount, on layout growth and on container resize — but never
  // over a view the reader has panned/zoomed themselves.
  useEffect(() => {
    if (!touchedRef.current) fit()
  }, [fit, rootId])

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

  // Wheel-zoom to cursor (non-passive: the page must not scroll).
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = container.getBoundingClientRect()
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      const { x, y, k } = tfRef.current
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k * Math.exp(-event.deltaY * 0.0014)))
      if (next === k) return
      touchedRef.current = true
      setTf({
        x: mx - (mx - x) * (next / k),
        y: my - (my - y) * (next / k),
        k: next,
      })
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => { container.removeEventListener('wheel', onWheel) }
  }, [])

  const zoomBy = useCallback((factor: number): void => {
    const container = containerRef.current
    const { x, y, k } = tfRef.current
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k * factor))
    if (next === k || container === null) return
    touchedRef.current = true
    const mx = container.clientWidth / 2
    const my = container.clientHeight / 2
    setTf({ x: mx - (mx - x) * (next / k), y: my - (my - y) * (next / k), k: next })
  }, [])

  /**
   * Drag-pan. The gesture only ever starts on the BACKGROUND: a pointerdown
   * on a node (or the control cluster) is left alone, so the node's own click
   * fires. Listeners live on `window` — never `setPointerCapture` on the
   * container, which retargets the derived click event and silently kills
   * every node interaction.
   */
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-graph-node]') !== null) return
    if (target.closest('[data-graph-controls]') !== null) return
    travelRef.current = 0
    const startX = event.clientX
    const startY = event.clientY
    const { x, y } = tfRef.current
    const onMove = (move: globalThis.PointerEvent): void => {
      const dx = move.clientX - startX
      const dy = move.clientY - startY
      travelRef.current = Math.max(travelRef.current, Math.abs(dx) + Math.abs(dy))
      if (travelRef.current <= CLICK_TOLERANCE_PX) return
      touchedRef.current = true
      setDragging(true)
      setTf(current => ({ ...current, x: x + dx, y: y + dy }))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  /** Suppress node clicks that ended a drag gesture. */
  const clickAllowed = useCallback((): boolean => travelRef.current <= CLICK_TOLERANCE_PX, [])

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
          const box = layout.boxes.get(id)
          if (box !== undefined) boxes.push(box)
        }
        if (boxes.length === 0) return
        const x1 = Math.min(...boxes.map(box => box.x)) - 12
        const y1 = Math.min(...boxes.map(box => box.y)) - 20
        const x2 = Math.max(...boxes.map(box => box.x + box.w)) + 12
        const y2 = Math.max(...boxes.map(box => box.y + box.h)) + 12
        frames.push({ key: `${runNode.id}:${phaseIndex}`, title: phase.title, x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
      })
    }
    return frames
  }, [nodes, layout])

  /** The bezier edge path between two boxes (top-down). */
  const edgePath = (from: GraphBox, to: GraphBox): string => {
    const x1 = from.x + from.w / 2
    const y1 = from.y + from.h
    const x2 = to.x + to.w / 2
    const y2 = to.y
    const dy = Math.max(24, (y2 - y1) / 2)
    return `M ${x1} ${y1} C ${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={containerRef}
        className={cn(css.canvas, dragging && css.canvasDragging)}
        role="group"
        aria-label={t('tasksViewGraph')}
        onPointerDown={onPointerDown}
      >
        <TooltipProvider delayDuration={400}>
          {/* The graph twin of TasksTree's loading row (same Spinner + the
              same `loading` copy key). `pointer-events-none` keeps the
              canvas's pan/zoom/node clicks fully live underneath. */}
          {loading === true && nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-[6] flex items-center justify-center">
              <span className="flex items-center gap-1.5 px-6 py-3 text-xs text-muted-foreground">
                {/* The visible line carries the copy; the glyph is decoration. */}
                <span aria-hidden="true" className="flex flex-none items-center">
                  <Spinner size={12} />
                </span>
                {t('loading')}
              </span>
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
                const from = layout.boxes.get(edge.from)
                const to = layout.boxes.get(edge.to)
                if (from === undefined || to === undefined) return null
                const target = nodeById.get(edge.to)
                return (
                  <path
                    key={`${edge.from}->${edge.to}`}
                    className={cn(
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
                className="pointer-events-none absolute rounded-md border border-dashed border-border"
                style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
              >
                <span className="absolute -top-[7px] left-2 bg-background px-1 font-mono text-[11px] leading-[1.3] tracking-wide text-foreground-3 uppercase">
                  {frame.title ?? t('workflowPhaseUnnamed')}
                </span>
              </div>
            ))}
            {/* KEYBOARD ACCESS (deliberate, F4): graph nodes render with
                tabIndex={-1} on purpose — a graph with dozens of nodes would
                add dozens of Tab stops and drown the page's real controls,
                and the canvas itself supports pointer pan/zoom only. The
                keyboard-equivalent path is the bottom-right control cluster
                (`data-graph-controls`): its "切换为树状图" view toggle is a
                NATIVE <button> (Tab-reachable, Enter/Space-activatable), and
                tree mode provides the full ArrowUp/ArrowDown/Home/End/Enter/
                Space navigation over the same nodes (see TasksTree). Do NOT
                "fix" the nodes' tabIndex without fixing the tab-stop flood. */}
            {nodes.map((node) => {
              const box = layout.boxes.get(node.id)
              if (box === undefined) return null
              const style = { left: box.x, top: box.y, width: GRAPH_NODE_W, minHeight: box.h }
              if (node.kind === 'fold') return renderFoldNode(node, style, onToggleFold, clickAllowed)
              if (node.kind === 'workflow') {
                return renderWorkflowNode(node, style, onWorkflowInfo, clickAllowed)
              }
              return renderAgentNode(node, style, onNodeInfo, onOpenTask, clickAllowed)
            })}
          </div>
        </TooltipProvider>
        <div className="absolute right-2.5 bottom-2.5 z-[6] flex flex-row items-center gap-0.5" data-graph-controls>
          <ViewModeToggle mode={mode} onModeChange={onModeChange} />
          <FoldToggleButton folded={folded} onToggleFold={onToggleFold} />
          <ControlButton label={t('tasksZoomOut')} onClick={() => { zoomBy(1 / 1.2) }}>−</ControlButton>
          <span
            className="flex-none px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground"
            aria-hidden="true"
          >
            {Math.round(tf.k * 100)}%
          </span>
          <ControlButton label={t('tasksZoomIn')} onClick={() => { zoomBy(1.2) }}>+</ControlButton>
          <ControlButton label={t('tasksZoomFit')} onClick={refit}><IconFullscreenOutline16 /></ControlButton>
        </div>
      </div>
    </div>
  )
}

/** One agent node card: dot + title, one mono meta line, live line when running. */
function renderAgentNode(
  node: TasksAgentNode,
  style: { left: number; top: number; width: number; minHeight: number },
  onNodeInfo: (node: TasksAgentNode, anchor: HTMLElement) => void,
  onOpenTask: (taskId: string, anchor: HTMLElement) => void,
  clickAllowed: () => boolean,
): ReactNode {
  const meta = agentMeta(node)
  const settled = (node.state === 'done' || node.state === 'error') && !node.current
  return (
    <Card
      key={node.id}
      data-graph-node={node.id}
      role="button"
      tabIndex={-1}
      aria-label={`${node.label} ${meta}`}
      aria-current={node.current ? 'true' : undefined}
      className={cn(
        NODE_CARD,
        // The lead keeps the stronger hairline rung; the meta line names it.
        node.parentId === undefined && 'border-border-strong',
        node.current && NODE_ACCENT,
        settled && NODE_SETTLED,
      )}
      style={style}
      onClick={(event) => {
        if (!clickAllowed()) return
        onNodeInfo(node, event.currentTarget)
      }}
    >
      <span className="flex min-w-0 items-center gap-1">
        <StateDot state={nodeDotState(node.state)} size={6} className="flex-none" />
        <span className="flex flex-none text-foreground-3" aria-hidden="true"><AgentGlyph node={node} /></span>
        <CardLine className={NODE_TITLE} label={node.label} />
        {node.team?.role === 'teammate' && node.team.name !== '' && (
          <Badge
            variant="outline"
            className="h-4 max-w-[48px] flex-none truncate px-1.5 py-0 text-[11px] font-normal text-muted-foreground"
          >
            {node.team.name}
          </Badge>
        )}
      </span>
      {/* Error is data, not chrome: the card keeps the shared hairline (F6)
          and the state rides the StateDot plus the destructive meta ink —
          the same family success/warning already use on their meta words. */}
      <CardLine
        className={cn(
          NODE_META,
          node.state === 'error' ? 'text-destructive' : settled && 'text-foreground-3',
        )}
        label={meta}
      />
      {node.state === 'running' && <LiveLine live={node.live} />}
      <TaskLine tasks={node.tasks} onOpenTask={onOpenTask} />
    </Card>
  )
}

/** One workflow run node card. */
function renderWorkflowNode(
  node: TasksWorkflowNode,
  style: { left: number; top: number; width: number; minHeight: number },
  onWorkflowInfo: (node: TasksWorkflowNode, anchor: HTMLElement) => void,
  clickAllowed: () => boolean,
): ReactNode {
  const meta = workflowMeta(node)
  const settled = node.run.status !== 'running'
  return (
    <Card
      key={node.id}
      data-graph-node={node.id}
      role="button"
      tabIndex={-1}
      aria-label={`${node.run.name} ${meta}`}
      className={cn(NODE_CARD, settled && NODE_SETTLED)}
      style={style}
      onClick={(event) => {
        if (!clickAllowed()) return
        onWorkflowInfo(node, event.currentTarget)
      }}
    >
      <span className="flex min-w-0 items-center gap-1">
        <StateDot state={node.run.status === 'running' ? 'ongoing' : 'done'} size={6} className="flex-none" />
        <span className="flex flex-none text-foreground-3" aria-hidden="true"><WorkflowGlyph /></span>
        <CardLine className={NODE_TITLE} label={node.run.name} />
      </span>
      <CardLine className={cn(NODE_META, settled && 'text-foreground-3')} label={meta} />
    </Card>
  )
}

/** One fold aggregate node: the settled leaves as a dashed card. */
function renderFoldNode(
  node: TasksFoldNode,
  style: { left: number; top: number; width: number; minHeight: number },
  onToggleFold: () => void,
  clickAllowed: () => boolean,
): ReactNode {
  const previews = foldPreviews(node.previews)
  return (
    <Card
      key={node.id}
      data-graph-node={node.id}
      role="button"
      tabIndex={-1}
      aria-label={`${t('tasksFoldCompleted', { count: node.count })} · ${t('tasksFoldExpand')}`}
      className={cn(NODE_CARD, 'border-dashed text-muted-foreground')}
      style={style}
      onClick={() => {
        if (!clickAllowed()) return
        onToggleFold()
      }}
    >
      <span className="flex min-w-0 items-center gap-1">
        <span className="flex flex-none" aria-hidden="true"><FoldGlyph /></span>
        <span className={NODE_TITLE}>{t('tasksFoldCompleted', { count: node.count })}</span>
      </span>
      <CardLine className={NODE_META} label={previews}>
        {`${t('tasksFoldExpand')} · ${previews}`}
      </CardLine>
    </Card>
  )
}
