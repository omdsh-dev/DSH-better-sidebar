/**
 * The tree mode of the Tasks page: the SAME unified model rendered as the
 * classic indentation tree — nested children with a hairline connector, the
 * mockup's row metrics (12px title / 9.5px mono meta), left accent bar on the
 * current session, dashed fold rows, and the shared bottom-right control
 * cluster (view toggle + fold toggle) so switching back is always possible.
 */
import { useCallback, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TasksAgentNode, TasksNode, TasksWorkflowNode } from './tasks-model.ts'
import { agentMeta, foldPreviews, LiveLine, nodeDotState, workflowMeta } from './tasks-shared.tsx'
import { FoldToggleButton, ViewModeToggle } from './TasksGraph.tsx'
import { t } from './locales.ts'
import css from './tasks-graph.module.css'

export interface TasksTreeProps {
  nodes: readonly TasksNode[]
  folded: boolean
  onActivate(node: TasksAgentNode): void
  onNodeInfo(node: TasksAgentNode, anchor: HTMLElement): void
  onWorkflowInfo(node: TasksWorkflowNode, anchor: HTMLElement): void
  onToggleFold(): void
  mode: 'graph' | 'tree'
  onModeChange(mode: 'graph' | 'tree'): void
  /** Fallback loading row while the root catalog hydrates. */
  loading?: boolean
}

export function TasksTree(props: TasksTreeProps): ReactNode {
  const {
    nodes, folded, onActivate, onNodeInfo, onWorkflowInfo, onToggleFold, mode, onModeChange, loading,
  } = props
  const bodyRef = useRef<HTMLDivElement>(null)

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
  }, [focusAt])

  const activateOnKey = (event: KeyboardEvent, action: () => void): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      action()
    }
  }

  /** One row plus its nested children (connector line per the mockup). */
  const renderNode = (node: TasksNode, depth: number): ReactNode => {
    const children = childrenOf.get(node.id) ?? []
    const row = node.kind === 'fold'
      ? (
        <div
          key={node.id}
          data-tasks-row
          role="treeitem"
          tabIndex={0}
          aria-level={depth + 1}
          aria-label={`${t('tasksFoldCompleted', { count: node.count })} · ${t('tasksFoldExpand')}`}
          className={clsx(css.treeRow, css.treeFoldRow)}
          onClick={onToggleFold}
          onKeyDown={(event) => { activateOnKey(event, onToggleFold) }}
        >
          <StateDot state="done" size={6} />
          <span className={css.treeContent}>
            <span className={css.treeTitle}>
              {t('tasksFoldCompleted', { count: node.count })}
              <span className={css.treeMeta}>
                {`${folded ? '⇪' : '⇩'} ${t(folded ? 'tasksFoldExpand' : 'tasksFoldCollapse')}`}
              </span>
            </span>
            <span className={css.treeMeta}>{foldPreviews(node.previews)}</span>
          </span>
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
            aria-expanded="true"
            aria-label={`${node.run.name} ${workflowMeta(node)}`}
            className={clsx(css.treeRow, node.run.status !== 'running' && css.treeRowSettled)}
            onClick={(event) => { onWorkflowInfo(node, event.currentTarget) }}
            onKeyDown={(event) => {
              activateOnKey(event, () => { onWorkflowInfo(node, event.currentTarget as HTMLElement) })
            }}
          >
            <StateDot state={node.run.status === 'running' ? 'ongoing' : 'done'} size={6} />
            <span className={css.treeContent}>
              <span className={css.treeTitle}>{`▶ ${node.run.name}`}</span>
              <span className={css.treeMeta}>{workflowMeta(node)}</span>
            </span>
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
            aria-current={node.current ? 'true' : undefined}
            className={clsx(
              css.treeRow,
              node.current && css.treeRowActive,
              (node.state === 'done' || node.state === 'error') && !node.current && css.treeRowSettled,
            )}
            onClick={() => { onActivate(node) }}
            onKeyDown={(event) => { activateOnKey(event, () => { onActivate(node) }) }}
          >
            <StateDot state={nodeDotState(node.state)} size={6} />
            <span className={css.treeContent}>
              <span className={css.treeTitle}>
                {node.team?.role === 'teammate' ? `◇ ${node.label}` : node.label}
              </span>
              <span className={css.treeMeta}>{agentMeta(node)}</span>
              {node.state === 'running' && <LiveLine live={node.live} />}
            </span>
            <button
              type="button"
              className={css.treeInfo}
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
    if (children.length === 0) return <div key={node.id}>{row}</div>
    return (
      <div key={node.id}>
        {row}
        <div className={css.treeKids}>
          {children.map(child => renderNode(child, depth + 1))}
        </div>
      </div>
    )
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
          <div className={css.viewEmptyHint}>{t('loading')}</div>
        )}
        {roots.map(root => renderNode(root, 0))}
      </div>
      <div className={css.controls} data-graph-controls>
        <ViewModeToggle mode={mode} onModeChange={onModeChange} />
        <FoldToggleButton folded={folded} onToggleFold={onToggleFold} />
      </div>
    </div>
  )
}
