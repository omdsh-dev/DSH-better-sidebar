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
import clsx from 'clsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TasksAgentNode, TasksFoldNode, TasksNode, TasksWorkflowNode } from './tasks-model.ts'
import { tasksEdges } from './tasks-model.ts'
import { GRAPH_NODE_W, layoutTasksGraphForWidth, type GraphBox } from './tasks-graph-layout.ts'
import { agentMeta, foldPreviews, LiveLine, nodeDotState, workflowMeta } from './tasks-shared.tsx'
import { t } from './locales.ts'
import css from './tasks-graph.module.css'

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
  onActivate(node: TasksAgentNode): void
  onNodeInfo(node: TasksAgentNode, anchor: HTMLElement): void
  onWorkflowInfo(node: TasksWorkflowNode, anchor: HTMLElement): void
  onToggleFold(): void
  mode: 'graph' | 'tree'
  onModeChange(mode: 'graph' | 'tree'): void
}

/** The shared view-mode toggle (glyph + label, per the mockup). */
export function ViewModeToggle(props: {
  mode: 'graph' | 'tree'
  onModeChange(mode: 'graph' | 'tree'): void
}): ReactNode {
  const { mode, onModeChange } = props
  const toTree = mode === 'graph'
  const label = toTree ? `▤ ${t('tasksViewTree')}` : `⌗ ${t('tasksViewGraph')}`
  return (
    <button
      type="button"
      className={clsx(css.controlBtn, css.controlMode)}
      aria-label={t(toTree ? 'tasksViewSwitchToTree' : 'tasksViewSwitchToGraph')}
      title={t(toTree ? 'tasksViewSwitchToTree' : 'tasksViewSwitchToGraph')}
      onClick={() => { onModeChange(toTree ? 'tree' : 'graph') }}
    >
      {label}
    </button>
  )
}

/** The fold toggle (expand / re-collapse the settled aggregates). */
export function FoldToggleButton(props: { folded: boolean; onToggleFold(): void }): ReactNode {
  const { folded, onToggleFold } = props
  return (
    <button
      type="button"
      className={css.controlBtn}
      aria-pressed={folded}
      aria-label={t(folded ? 'tasksFoldExpand' : 'tasksFoldCollapse')}
      title={t(folded ? 'tasksFoldExpand' : 'tasksFoldCollapse')}
      onClick={onToggleFold}
    >
      {folded ? '⇪' : '⇩'}
    </button>
  )
}

export function TasksGraph(props: TasksGraphProps): ReactNode {
  const { nodes, folded, rootId, onActivate, onNodeInfo, onWorkflowInfo, onToggleFold, mode, onModeChange } = props
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
    <div className={css.graphView}>
      <div
        ref={containerRef}
        className={clsx(css.canvas, dragging && css.canvasDragging)}
        role="group"
        aria-label={t('tasksViewGraph')}
        onPointerDown={onPointerDown}
      >
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
              className={css.phaseFrame}
              style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
            >
              <span className={css.phaseLabel}>{frame.title ?? t('workflowPhaseUnnamed')}</span>
            </div>
          ))}
          {nodes.map((node) => {
            const box = layout.boxes.get(node.id)
            if (box === undefined) return null
            const style = { left: box.x, top: box.y, width: GRAPH_NODE_W, minHeight: box.h }
            if (node.kind === 'fold') return renderFoldNode(node, style, onToggleFold, clickAllowed)
            if (node.kind === 'workflow') {
              return renderWorkflowNode(node, style, onWorkflowInfo, clickAllowed)
            }
            return renderAgentNode(node, style, onActivate, onNodeInfo, clickAllowed)
          })}
        </div>
        <div className={css.controls} data-graph-controls>
          <ViewModeToggle mode={mode} onModeChange={onModeChange} />
          <FoldToggleButton folded={folded} onToggleFold={onToggleFold} />
          <button
            type="button"
            className={css.controlBtn}
            aria-label={t('tasksZoomOut')}
            title={t('tasksZoomOut')}
            onClick={() => { zoomBy(1 / 1.2) }}
          >
            −
          </button>
          <span className={css.controlZoomLevel} aria-hidden="true">{Math.round(tf.k * 100)}%</span>
          <button
            type="button"
            className={css.controlBtn}
            aria-label={t('tasksZoomIn')}
            title={t('tasksZoomIn')}
            onClick={() => { zoomBy(1.2) }}
          >
            +
          </button>
          <button
            type="button"
            className={css.controlBtn}
            aria-label={t('tasksZoomFit')}
            title={t('tasksZoomFit')}
            onClick={refit}
          >
            ⌂
          </button>
        </div>
      </div>
    </div>
  )
}

/** One agent node card: dot + title, one mono meta line, live line when running. */
function renderAgentNode(
  node: TasksAgentNode,
  style: { left: number; top: number; width: number; minHeight: number },
  onActivate: (node: TasksAgentNode) => void,
  onNodeInfo: (node: TasksAgentNode, anchor: HTMLElement) => void,
  clickAllowed: () => boolean,
): ReactNode {
  return (
    <div
      key={node.id}
      data-graph-node={node.id}
      role="button"
      tabIndex={-1}
      aria-label={`${node.label} ${agentMeta(node)}`}
      aria-current={node.current ? 'true' : undefined}
      className={clsx(
        css.node,
        node.parentId === undefined && css.nodeLead,
        node.team?.role === 'teammate' && css.nodeTeam,
        node.current && css.nodeCurrent,
        (node.state === 'done' || node.state === 'error') && !node.current && css.nodeSettled,
        node.state === 'error' && css.nodeError,
      )}
      style={style}
      onClick={() => {
        if (!clickAllowed()) return
        onActivate(node)
      }}
    >
      <span className={css.nodeHeader}>
        <StateDot state={nodeDotState(node.state)} size={6} className={css.nodeDot} />
        <span className={css.nodeTitle} title={node.label}>
          {node.team?.role === 'teammate' ? `◇ ${node.label}` : node.label}
        </span>
      </span>
      <span className={css.nodeMeta} title={agentMeta(node)}>{agentMeta(node)}</span>
      {node.state === 'running' && <LiveLine live={node.live} />}
      <button
        type="button"
        className={css.treeInfo}
        style={{ position: 'absolute', top: 3, right: 3 }}
        aria-label={t('tasksNodeState')}
        title={t('tasksNodeState')}
        onClick={(event) => {
          event.stopPropagation()
          onNodeInfo(node, event.currentTarget)
        }}
      >
        i
      </button>
    </div>
  )
}

/** One workflow run node card. */
function renderWorkflowNode(
  node: TasksWorkflowNode,
  style: { left: number; top: number; width: number; minHeight: number },
  onWorkflowInfo: (node: TasksWorkflowNode, anchor: HTMLElement) => void,
  clickAllowed: () => boolean,
): ReactNode {
  return (
    <div
      key={node.id}
      data-graph-node={node.id}
      role="button"
      tabIndex={-1}
      aria-label={`${node.run.name} ${workflowMeta(node)}`}
      className={clsx(css.node, css.nodeWorkflow, node.run.status !== 'running' && css.nodeSettled)}
      style={style}
      onClick={(event) => {
        if (!clickAllowed()) return
        onWorkflowInfo(node, event.currentTarget)
      }}
    >
      <span className={css.nodeHeader}>
        <StateDot state={node.run.status === 'running' ? 'ongoing' : 'done'} size={6} className={css.nodeDot} />
        <span className={css.nodeTitle} title={node.run.name}>{`▶ ${node.run.name}`}</span>
      </span>
      <span className={css.nodeMeta}>{workflowMeta(node)}</span>
    </div>
  )
}

/** One fold aggregate node. */
function renderFoldNode(
  node: TasksFoldNode,
  style: { left: number; top: number; width: number; minHeight: number },
  onToggleFold: () => void,
  clickAllowed: () => boolean,
): ReactNode {
  return (
    <div
      key={node.id}
      data-graph-node={node.id}
      role="button"
      tabIndex={-1}
      aria-label={`${t('tasksFoldCompleted', { count: node.count })} · ${t('tasksFoldExpand')}`}
      className={clsx(css.node, css.nodeFold)}
      style={style}
      onClick={() => {
        if (!clickAllowed()) return
        onToggleFold()
      }}
    >
      <span className={css.nodeHeader}>
        <StateDot state="done" size={6} className={css.nodeDot} />
        <span className={clsx(css.nodeTitle, css.nodeTitlePlain)}>
          {t('tasksFoldCompleted', { count: node.count })}
        </span>
      </span>
      <span className={css.nodeMeta} title={foldPreviews(node.previews)}>
        {`⇪ ${t('tasksFoldExpand')} · ${foldPreviews(node.previews)}`}
      </span>
    </div>
  )
}
