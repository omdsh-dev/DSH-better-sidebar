/**
 * The tree mode of the Tasks page: the SAME unified model rendered as the
 * classic indentation tree — nested children on a hairline thread, the plugin's
 * row metrics (12px title / 11px mono meta), the left accent bar on the current
 * session, dashed fold rows, and the shared bottom-right control cluster (view
 * toggle + fold toggle) so switching back is always possible.
 *
 * Behaviour contract: `role="tree"` / `role="treeitem"` + `aria-level`, a
 * `[data-tasks-row]` focus order, ArrowUp / ArrowDown / Home / End focus moves,
 * Enter / Space activation, and the fold rows (a fold row reveals its OWN
 * group; the control cluster keeps the page-level switch).
 *
 * Readability: rows sit on the page's 32px rhythm (a 2px accent bar marks the
 * current session, hover is the native fill, settled rows recede), and every
 * line that can be ellipsised carries its full text as `title` — the label, the
 * workflow name and the fold previews.
 */
import { useCallback, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconLoadingOutlineRegular, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TasksAgentNode, TasksFoldNode, TasksNode, TasksWorkflowNode } from './tasks-model.ts'
import {
  AgentGlyph, agentChip, agentMeta, FoldGlyph, foldPreviews, foldTally, LiveLine, nodeDotState,
  stateLabel, TaskLine, WorkflowGlyph, workflowMeta,
} from './tasks-shared.tsx'
import { FoldToggleButton, ViewModeToggle } from './TasksGraph.tsx'
import { useAutoAnimateRef } from './use-auto-animate.ts'
import { t } from './locales.ts'
import css from './tasks-graph.module.css'

/**
 * One nesting level of the tree: it exists as a COMPONENT so every level can own
 * a FLIP host of its own. The library watches a container's direct children
 * only, so a single host on the scroll container would animate the top level and
 * leave every nested fold to blink — the reader's "嵌套层级也要有动效".
 */
/** The human name of a row, whatever kind it is (the disclosure names it). */
function nodeLabel(node: TasksNode): string {
  if (node.kind === 'agent') return node.label
  if (node.kind === 'workflow') return node.run.name
  return foldTally(node)
}

function TreeLevel(props: { items: readonly ReactNode[] }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useAutoAnimateRef(ref)
  return <div className={css.treeKids} ref={ref}>{props.items}</div>
}

export interface TasksTreeProps {
  nodes: readonly TasksNode[]
  folded: boolean
  /**
   * Nodes whose SUBTREE the reader folded away (the tree's own disclosure, one
   * axis beside the page's settled-leaf rule). A parent not listed here shows
   * its children.
   */
  collapsedIds: ReadonlySet<string>
  /** One row's disclosure control. */
  onToggleCollapse(nodeId: string): void
  /** 全部收起: hide every subtree. */
  onCollapseAll(): void
  /** 全部展开: show every subtree again. */
  onExpandAll(): void
  onNodeInfo(node: TasksAgentNode, anchor: HTMLElement): void
  onWorkflowInfo(node: TasksWorkflowNode, anchor: HTMLElement): void
  /** Open the shared task window for one task id. */
  onOpenTask(taskId: string, anchor: HTMLElement): void
  /** The control cluster's page-level fold switch. */
  onToggleFold(): void
  /** A fold row's own click: reveal THIS group's members only. */
  onExpandGroup(node: TasksFoldNode): void
  mode: 'graph' | 'tree'
  onModeChange(mode: 'graph' | 'tree'): void
  /** Fallback loading row while the root catalog hydrates. */
  loading?: boolean
}

export function TasksTree(props: TasksTreeProps): ReactNode {
  const {
    nodes, folded, collapsedIds, onToggleCollapse, onCollapseAll, onExpandAll,
    onNodeInfo, onWorkflowInfo, onOpenTask, onToggleFold, onExpandGroup,
    mode, onModeChange, loading,
  } = props
  const bodyRef = useRef<HTMLDivElement>(null)
  // The scroll container's own host covers the top level; every nested level
  // brings its own (see TreeLevel).
  useAutoAnimateRef(bodyRef)

  /** children by parent id (model order preserved). */
  const childrenOf = useMemo(() => {
    const map = new Map<string, TasksNode[]>()
    const ids = new Set(nodes.map(node => node.id))
    for (const node of nodes) {
      const parent = node.parentId !== undefined && ids.has(node.parentId) ? node.parentId : ''
      const list = map.get(parent)
      if (list === undefined) map.set(parent, [node])
      else list.push(node)
    }
    return map
  }, [nodes])

  /** Arrow-key navigation over the visible rows (official catalog recipe). */
  const focusAt = useCallback((index: number): void => {
    const items = bodyRef.current?.querySelectorAll<HTMLElement>('[data-tasks-row]') ?? []
    if (items.length === 0) return
    items[(index + items.length) % items.length]?.focus()
  }, [])
  const onTreeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    const items = bodyRef.current?.querySelectorAll<HTMLElement>('[data-tasks-row]') ?? []
    const index = Array.prototype.indexOf.call(items, document.activeElement)
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      // The standard disclosure bindings: Right opens a folded row (and then
      // walks into it with the next press), Left closes an open one (and then
      // walks back out to its parent). Rows that offer neither just move.
      const row = items[index]
      const nodeId = row?.getAttribute('data-tree-node') ?? undefined
      const expandable = row?.getAttribute('data-tree-expandable') === 'true'
      const collapsed = row?.getAttribute('aria-expanded') === 'false'
      event.preventDefault()
      if (event.key === 'ArrowRight') {
        if (nodeId !== undefined && expandable && collapsed) { onToggleCollapse(nodeId); return }
        focusAt(index + 1)
        return
      }
      if (nodeId !== undefined && expandable && !collapsed) { onToggleCollapse(nodeId); return }
      // Walk out: the nearest row above with a SHALLOWER aria-level.
      const level = Number(row?.getAttribute('aria-level') ?? '1')
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (Number(items[cursor]?.getAttribute('aria-level') ?? '0') < level) { focusAt(cursor); return }
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusAt(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusAt(index < 0 ? items.length - 1 : index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(items.length - 1)
    }
  }, [focusAt, onToggleCollapse])

  const activateOnKey = (event: KeyboardEvent, action: () => void): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      action()
    }
  }

  /** One row plus its nested children (the connector line is drawn by
   *  `.treeKids` in tasks-graph.module.css). */
  const renderNode = (node: TasksNode, depth: number, last: boolean): ReactNode => {
    const children = childrenOf.get(node.id) ?? []
    /** The mode chip this row shows (also decides what the mono line holds). */
    const chip = node.kind === 'agent' ? agentChip(node) : undefined
    /**
     * The row's own wrapper is the child of its parent's level: it draws the
     * elbow that connects it to that level's thread, and the LAST sibling stops
     * its segment at the row's marker so the thread never hangs past the group.
     */
    /** Whether this row's subtree is folded away right now. */
    const collapsed = children.length > 0 && collapsedIds.has(node.id)
    const wrap = (body: ReactNode): ReactNode => (
      <div
        key={node.id}
        className={clsx(css.treeChild, last && css.treeChildLast)}
      >
        {body}
        {children.length > 0 && !collapsed && (
          <TreeLevel
            items={children.map(child => renderNode(child, depth + 1, child === children[children.length - 1]))}
          />
        )}
      </div>
    )

    /**
     * The row's own disclosure control, placed at the row's END like the canvas
     * card's own chevron (and measured the same 16px). Rendered only for a row
     * that has children: a leaf gets no dead control, and the reader can read
     * the row's shape from the chevron's direction alone.
     */
    const disclosure = children.length === 0 ? null : (
      <button
        type="button"
        className={css.treeDisclosure}
        aria-label={`${t(collapsed ? 'tasksTreeExpandRow' : 'tasksTreeCollapseRow')} ${nodeLabel(node)}`}
        title={t(collapsed ? 'tasksTreeExpandRow' : 'tasksTreeCollapseRow')}
        onClick={(event) => {
          // The row's own click opens the detail window: the disclosure must
          // never do both.
          event.stopPropagation()
          onToggleCollapse(node.id)
        }}
      >
        {collapsed
          ? <IconChevronRightOutlineRegular size={12} />
          : <IconChevronDownOutlineRegular size={12} />}
      </button>
    )
    const row = node.kind === 'fold'
      ? (
        <div
          key={node.id}
          data-tasks-row
          role="treeitem"
          tabIndex={0}
          aria-level={depth + 1}
          aria-label={`${foldTally(node)} · ${t('tasksFoldExpand')}`}
          className={clsx(css.treeRow, css.treeFoldRow)}
          data-tree-node={node.id}
          data-tree-expandable={children.length > 0 ? 'true' : undefined}
          aria-expanded={children.length === 0 ? undefined : !collapsed}
          onClick={() => { onExpandGroup(node) }}
          onKeyDown={(event) => { activateOnKey(event, () => { onExpandGroup(node) }) }}
        >
          <span className={css.treeGlyph} aria-hidden="true"><FoldGlyph /></span>
          <span className={css.treeContent}>
            <span className={css.treeTitle}>
              {foldTally(node)}
              {/* The row only EXISTS while its group is folded, so its action is
                  always "expand" — the old reading followed the page-level
                  `folded` flag, which said "collapse" on a row that offers to do
                  the opposite. */}
              <span className={css.treeMeta}>{t('tasksFoldExpand')}</span>
            </span>
            <span className={css.treeMeta} title={foldPreviews(node.previews, node.count)}>
              {foldPreviews(node.previews, node.count)}
            </span>
          </span>
          {disclosure}
        </div>
      )
      : node.kind === 'workflow'
        ? (
          <div
            key={node.id}
            data-tasks-row
            role="treeitem"
            tabIndex={0}
            aria-level={depth + 1}
            aria-label={`${node.run.name} ${workflowMeta(node)}`}
            data-tree-node={node.id}
            data-tree-expandable={children.length > 0 ? 'true' : undefined}
            aria-expanded={children.length === 0 ? undefined : !collapsed}
            className={clsx(css.treeRow, node.run.status !== 'running' && css.treeRowSettled)}
            onClick={(event) => { onWorkflowInfo(node, event.currentTarget) }}
            onKeyDown={(event) => {
              activateOnKey(event, () => { onWorkflowInfo(node, event.currentTarget as HTMLElement) })
            }}
          >
            <StateDot className={css.treeDot} state={node.run.status === 'running' ? 'ongoing' : 'done'} size={6} />
            <span className={css.treeGlyph} aria-hidden="true"><WorkflowGlyph /></span>
            <span className={css.treeContent}>
              <span className={css.treeTitle} title={node.run.name}>{node.run.name}</span>
              <span className={css.treeMeta}>{workflowMeta(node)}</span>
            </span>
            {disclosure}
          </div>
        )
        : (
          <div
            key={node.id}
            data-tasks-row
            role="treeitem"
            tabIndex={0}
            aria-level={depth + 1}
            aria-label={`${node.label} ${agentMeta(node)}`}
            data-tree-node={node.id}
            data-tree-expandable={children.length > 0 ? 'true' : undefined}
            aria-expanded={children.length === 0 ? undefined : !collapsed}
            aria-current={node.current ? 'true' : undefined}
            className={clsx(
              css.treeRow,
              node.current && css.treeRowActive,
              (node.state === 'done' || node.state === 'error') && !node.current && css.treeRowSettled,
            )}
            onClick={(event) => { onNodeInfo(node, event.currentTarget) }}
            onKeyDown={(event) => {
              activateOnKey(event, () => { onNodeInfo(node, event.currentTarget as HTMLElement) })
            }}
          >
            <StateDot className={css.treeDot} state={nodeDotState(node.state)} size={6} />
            <span className={css.treeGlyph} aria-hidden="true"><AgentGlyph node={node} /></span>
            <span className={css.treeContent}>
              <span className={css.treeTitle} title={node.label}>
                {node.label}
                {/*
                  The mode word rides the title row, exactly as it rides the
                  badge row on a canvas card — one word per kind of node, next to
                  the name, instead of a mono line that repeated it on every row.
                */}
                {chip !== undefined && <span className={css.treeChip}>{chip}</span>}
              </span>
              {/* With the chip carrying the mode, the mono line holds what is
                  left: the node's own state (and, for the root, its identity). */}
              <span className={css.treeMeta}>{chip === undefined ? agentMeta(node) : stateLabel(node.state)}</span>
              {node.state === 'running' && <LiveLine live={node.live} />}
              <TaskLine tasks={node.tasks} onOpenTask={onOpenTask} />
            </span>
            {disclosure}
          </div>
        )
    return wrap(row)
  }

  const roots = childrenOf.get('') ?? []

  return (
    <div className={css.graphView}>
      <div
        ref={bodyRef}
        className={css.treeView}
        role="tree"
        aria-label={t('subagent')}
        onKeyDown={onTreeKeyDown}
      >
        {loading === true && roots.length === 0 && (
          <div className={css.viewEmptyHint}>
            <span className={css.treeGlyph} aria-hidden="true"><IconLoadingOutlineRegular size={12} /></span>
            {t('loading')}
          </div>
        )}
        {roots.map(root => renderNode(root, 0, false))}
      </div>
      <div className={css.controls} data-graph-controls>
        <ViewModeToggle mode={mode} onModeChange={onModeChange} />
        <FoldToggleButton folded={folded} onToggleFold={onToggleFold} />
        {/*
          The tree's OWN disclosure axis, beside the settled-leaf rule: every
          subtree out, or every subtree back in. Words rather than glyphs — the
          two axes would otherwise wear the same chevron vocabulary and the
          reader could not tell 折叠已完成的节点 from 收起所有子级.
        */}
        <Button
          variant="ghost"
          size="sm"
          className={css.controlText}
          aria-label={t('tasksTreeCollapseAll')}
          title={t('tasksTreeCollapseAll')}
          onClick={onCollapseAll}
        >
          {t('tasksTreeCollapseAll')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={css.controlText}
          aria-label={t('tasksTreeExpandAll')}
          title={t('tasksTreeExpandAll')}
          onClick={onExpandAll}
        >
          {t('tasksTreeExpandAll')}
        </Button>
      </div>
    </div>
  )
}
