/**
 * The tree mode of the Tasks page: the SAME unified model rendered as the
 * classic indentation tree — nested children with a hairline connector, rows on
 * the shadcn base (a 13px/500 title, an 11px mono meta line, a 2px accent bar
 * on the current session, dashed fold cards), and the shared bottom-right
 * control cluster (view toggle + fold toggle) so switching back is always
 * possible.
 *
 * Visual language: Tailwind utilities over the shadcn tokens
 * (src/client/ui/theme.css). Hierarchy is one 1px `border-border` hairline plus
 * the surface ladder and `hover:bg-muted` — the row carries no shadow (shadows
 * belong to floating layers only). Every color is a semantic token: no palette
 * class and no literal. Controls come from the vendored shadcn set
 * (`ScrollArea`, `Collapsible`, `Spinner`) and glyphs from the host
 * `IconXxx` primitives, so the page owns no artwork of its own.
 *
 * Behaviour is unchanged: the same `data-tasks-row` focus order, the same
 * `role="tree"` / `role="treeitem"` + `aria-level` semantics, the same
 * ArrowUp / ArrowDown / Home / End / Enter / Space handling, and the same
 * global fold aggregate (a fold row toggles the whole page's fold state).
 *
 * `Collapsible` is structural only: no row gains a collapse toggle, because
 * subtree visibility is owned by the page-wide fold state (`folded`). It is
 * rendered open + `forceMount`, so a subtree container is always mounted and
 * `[data-tasks-row]` focus order is exactly the pre-migration one.
 */
import { useCallback, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TasksAgentNode, TasksNode, TasksWorkflowNode } from './tasks-model.ts'
import {
  AgentGlyph, agentMeta, FoldGlyph, foldPreviews, LiveLine, nodeDotState, TaskLine,
  WorkflowGlyph, workflowMeta,
} from './tasks-shared.tsx'
import { FoldToggleButton, ViewModeToggle } from './TasksGraph.tsx'
import { Collapsible, CollapsibleContent } from './ui/collapsible.tsx'
import { ScrollArea } from './ui/scroll-area.tsx'
import { Spinner } from './ui/spinner.tsx'
import { t } from './locales.ts'

/** The row slab: one shared box, so every row kind lines up on the same grid. */
const ROW = 'flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-[1.35] text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring'
/** Hover is a background change only, per the design language. */
const ROW_HOVER = 'hover:bg-muted'
/** The current session: the same muted surface plus the 2px accent bar. */
const ROW_CURRENT = 'bg-muted'
/** Settled (done / error) rows recede by INK — the row's 13px title drops
 *  from the foreground to the secondary ink — never by opacity or hue. */
const ROW_SETTLED = 'text-muted-foreground'
/** The fold aggregate is a dashed inline card, not a filled row. */
const ROW_FOLD = 'border border-dashed border-border text-muted-foreground'
/** One text line of a row body. */
const LINE = 'truncate'
/** The mono meta line: 11px, tabular figures, secondary ink. */
const META = 'truncate font-mono text-[11px] tabular-nums text-muted-foreground'
/** The glyph/state-dot gutter (row level 0). */
const GLYPH = 'mt-0.5 flex-none text-foreground-3'
/** The current-session accent bar; the slot is reserved on EVERY agent row so
 *  the dot and glyphs stay on one vertical line down the whole tree. */
const ACCENT_SLOT = 'mt-0.5 h-4 w-0.5 flex-none rounded-full'
const ACCENT_BAR = `${ACCENT_SLOT} bg-primary`

export interface TasksTreeProps {
  nodes: readonly TasksNode[]
  folded: boolean
  onNodeInfo(node: TasksAgentNode, anchor: HTMLElement): void
  onWorkflowInfo(node: TasksWorkflowNode, anchor: HTMLElement): void
  /** Open the shared task window for one task id. */
  onOpenTask(taskId: string, anchor: HTMLElement): void
  onToggleFold(): void
  mode: 'graph' | 'tree'
  onModeChange(mode: 'graph' | 'tree'): void
  /** Fallback loading row while the root catalog hydrates. */
  loading?: boolean
}

export function TasksTree(props: TasksTreeProps): ReactNode {
  const {
    nodes, folded, onNodeInfo, onWorkflowInfo, onOpenTask, onToggleFold, mode, onModeChange, loading,
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

  /** One row plus its nested children (hairline connector per the mockup). */
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
          className={`${ROW} ${ROW_FOLD} ${ROW_HOVER}`}
          onClick={onToggleFold}
          onKeyDown={(event) => { activateOnKey(event, onToggleFold) }}
        >
          <span className={GLYPH} aria-hidden="true"><FoldGlyph /></span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={`flex items-center gap-1.5 font-medium ${LINE}`}>
              {t('tasksFoldCompleted', { count: node.count })}
              <span className={META}>
                {t(folded ? 'tasksFoldExpand' : 'tasksFoldCollapse')}
              </span>
            </span>
            <span className={META}>{foldPreviews(node.previews)}</span>
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
            className={`${ROW} ${ROW_HOVER} ${node.run.status !== 'running' ? ROW_SETTLED : ''}`}
            onClick={(event) => { onWorkflowInfo(node, event.currentTarget) }}
            onKeyDown={(event) => {
              activateOnKey(event, () => { onWorkflowInfo(node, event.currentTarget as HTMLElement) })
            }}
          >
            <span className="mt-0.5 flex flex-none items-center">
              <StateDot state={node.run.status === 'running' ? 'ongoing' : 'done'} size={6} />
            </span>
            <span className={GLYPH} aria-hidden="true"><WorkflowGlyph /></span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={`font-medium ${LINE}`}>{node.run.name}</span>
              <span className={META}>{workflowMeta(node)}</span>
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
            className={[
              ROW,
              ROW_HOVER,
              node.current ? ROW_CURRENT : '',
              (node.state === 'done' || node.state === 'error') && !node.current ? ROW_SETTLED : '',
            ].join(' ')}
            onClick={(event) => { onNodeInfo(node, event.currentTarget) }}
            onKeyDown={(event) => {
              activateOnKey(event, () => { onNodeInfo(node, event.currentTarget as HTMLElement) })
            }}
          >
            <span
              className={node.current ? ACCENT_BAR : ACCENT_SLOT}
              aria-hidden="true"
            />
            <span className="mt-0.5 flex flex-none items-center">
              <StateDot state={nodeDotState(node.state)} size={6} />
            </span>
            <span className={GLYPH} aria-hidden="true"><AgentGlyph node={node} /></span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={`font-medium ${LINE}`}>{node.label}</span>
              <span className={META}>{agentMeta(node)}</span>
              {node.state === 'running' && <LiveLine live={node.live} />}
              <TaskLine tasks={node.tasks} onOpenTask={onOpenTask} />
            </span>
          </div>
        )
    if (children.length === 0) return <div key={node.id}>{row}</div>
    return (
      <Collapsible key={node.id} open>
        {row}
        <CollapsibleContent
          forceMount
          className="ml-3 border-l border-border pl-2.5"
        >
          {children.map(child => renderNode(child, depth + 1))}
        </CollapsibleContent>
      </Collapsible>
    )
  }

  const roots = childrenOf.get('') ?? []

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1">
        <div ref={bodyRef} className="px-2.5 pt-2 pb-11">
          <div
            role="tree"
            aria-label={t('subagent')}
            onKeyDown={onTreeKeyDown}
          >
            {loading === true && roots.length === 0 && (
              <div className="flex items-center justify-center gap-1.5 px-6 py-3 text-xs text-muted-foreground">
                {/* The visible line carries the copy; the glyph is decoration. */}
                <span aria-hidden="true" className="flex flex-none items-center">
                  <Spinner size={12} />
                </span>
                {t('loading')}
              </div>
            )}
            {roots.map(root => renderNode(root, 0))}
          </div>
        </div>
      </ScrollArea>
      <div className="absolute right-2.5 bottom-2.5 z-[6] flex flex-row items-center" data-graph-controls>
        <ViewModeToggle mode={mode} onModeChange={onModeChange} />
        <FoldToggleButton folded={folded} onToggleFold={onToggleFold} />
      </div>
    </div>
  )
}
