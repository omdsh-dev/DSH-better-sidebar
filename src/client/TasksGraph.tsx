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
  type GraphBox,
} from './tasks-graph-layout.ts'
import {
  agentIdentity, agentMeta, foldPreviews, foldTally, TaskLine, WorkflowGlyph, workflowMeta,
} from './tasks-shared.tsx'
import { CardBar, CardTop, phaseClass, type CardKind } from './tasks-card.tsx'
import { doneActivityTitle, liveActivityLabel } from './process-labels.ts'
import { t } from './locales.ts'
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

/**
 * The bar's activity line. A running node shows the LIVE merged activity; a
 * settled one shows the same merged wording in its completed form (the host's
 * own `done.*` phrasing) — a settled card whose bar read only "已完成" would
 * throw away the one thing the fold is for.
 */
function barActivity(node: TasksAgentNode): string | undefined {
  const summary = node.live?.summary
  if (node.state === 'running') return liveActivityLabel(summary)
  return summary === undefined ? undefined : doneActivityTitle(summary)
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
  /** The fold AGGREGATE's click: expand everything (global + manual folds). */
  onExpandFold(): void
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
    nodes, folded, rootId, onNodeInfo, onWorkflowInfo, onOpenTask, onToggleFold, onExpandFold,
    onFoldNode, mode, onModeChange, loading,
  } = props
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
    () => layoutTasksGraphForWidth(nodes, width, GRAPH_FIT_MIN_SCALE),
    [nodes, width],
  )
  const edges = useMemo(() => tasksEdges(nodes), [nodes])
  const nodeById = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes])

  /**
   * Center the canvas and scale it to fill. The fit measures the CONTENT box
   * (the layout's padding is breathing room, not content): centering the padded
   * box leaves the graph visibly off-center in a narrow panel, which is exactly
   * how "the graph looks small and sits in a corner" happens.
   */
  const fit = useCallback((): void => {
    const container = containerRef.current
    if (container === null) return
    const cw = container.clientWidth
    const ch = container.clientHeight
    if (cw === 0 || ch === 0) return
    const contentW = Math.max(GRAPH_NODE_W, layout.width - GRAPH_PAD * 2)
    const contentH = Math.max(GRAPH_NODE_H, layout.height - GRAPH_PAD * 2)
    const k = Math.max(
      GRAPH_FIT_MIN_SCALE,
      Math.min(
        (cw - FIT_MARGIN * 2) / contentW,
        (ch - FIT_MARGIN * 2) / contentH,
        FIT_MAX_SCALE,
      ),
    )
    setTf({
      x: (cw - contentW * k) / 2 - GRAPH_PAD * k,
      y: Math.max(FIT_MARGIN / 2, (ch - contentH * k) / 2) - GRAPH_PAD * k,
      k,
    })
  }, [layout.width, layout.height])

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
      // Wheel deltas arrive in pixels, lines or pages depending on the device;
      // normalise first, or a line-scrolling mouse zooms 30× slower than a
      // trackpad (and a trackpad pinch, which reports ctrlKey, feels stuck).
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k * Math.exp(-event.deltaY * unit * 0.0014)))
      if (next === k) return
      touchedRef.current = true
      setTf(clampTf({
        x: mx - (mx - x) * (next / k),
        y: my - (my - y) * (next / k),
        k: next,
      }))
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => { container.removeEventListener('wheel', onWheel) }
  }, [clampTf])

  const zoomBy = useCallback((factor: number): void => {
    const container = containerRef.current
    const { x, y, k } = tfRef.current
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k * factor))
    if (next === k || container === null) return
    touchedRef.current = true
    const mx = container.clientWidth / 2
    const my = container.clientHeight / 2
    setTf(clampTf({ x: mx - (mx - x) * (next / k), y: my - (my - y) * (next / k), k: next }))
  }, [clampTf])

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
      setTf(clampTf({ x: x + dx, y: y + dy, k: tfRef.current.k }))
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
  }, [clampTf])

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
  }, [nodes, layout])

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
          {nodes.map((node) => {
            const box = layout.boxes.get(node.id)
            if (box === undefined) return null
            const style = { left: box.x, top: box.y, width: GRAPH_NODE_W, minHeight: box.h }
            if (node.kind === 'fold') return renderFoldNode(node, style, onExpandFold, clickAllowed)
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
      <CardTop
        kind={agentCardKind(node)}
        depth={node.depth}
        {...(node.phase === undefined ? {} : { phase: node.phase })}
        name={node.label}
        meta={agentIdentity(node)}
      >
        <TaskLine tasks={node.tasks} onOpenTask={onOpenTask} />
      </CardTop>
      <CardBar
        state={node.state}
        running={node.state === 'running'}
        {...(barActivity(node) === undefined ? {} : { activity: barActivity(node) })}
        {...(foldable && !node.current && onFold !== undefined
          ? { onFold: () => { onFold(node) } }
          : {})}
      />
    </div>
  )
}

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
 * One fold aggregate node: the completed leaves of one parent, collapsed. Its
 * bar is the action row (expand), so the whole card stays one click target.
 */
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
      data-depth={node.depth}
      role="button"
      tabIndex={-1}
      aria-label={`${foldTally(node)} · ${t('tasksFoldExpand')}`}
      className={clsx(css.node, css.nodeFold)}
      style={style}
      onClick={() => {
        if (!clickAllowed()) return
        onToggleFold()
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
        {/* The bar SAYS what the row holds — "✓ N 已完成 · 出错 N" for finished
            work (a stray failure would otherwise hide inside the ✓) and
            "N 待命" for the waiting members. No action word: the tally needs
            the room and the chevron already points at 展开. */}
        <span className={css.barActivity} title={foldTally(node)}>{foldTally(node)}</span>
        <span className={css.barFold} aria-hidden="true">
          <IconChevronDownOutlineRegular size={12} />
        </span>
      </CardBar>
    </div>
  )
}
