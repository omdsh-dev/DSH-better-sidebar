/**
 * Subagent tool-call jump interception:
 * Clicking a subagent delegation tool call (e.g. `subagent`, `subagent_explorer`,
 * `subagent_fixer`, `subagent_oracle`, `subagent_librarian`, `subagent_designer`,
 * `subagent_council`, `subagent_fork`, `send_message`, etc.) in the main chat
 * or sidechat navigates directly to the corresponding child subagent session.
 */
import type {
  Context,
  SidebarSessionList,
  SidebarSubagentAddress,
  SidebarSubagentChildEntry,
} from '../context-types.ts'
import { t } from './locales.ts'
import { isPlainLeftClick } from './link-intercept.ts'
import { firstLeaf, togglePanel, type SidebarStore } from './state.ts'

/** Whether a tool name represents a subagent delegation or communication tool. */
export function isSubagentTool(name: string | null | undefined): boolean {
  if (!name) return false
  const trimmed = name.trim()
  return (
    trimmed === 'subagent' ||
    trimmed.startsWith('subagent_') ||
    trimmed === 'send_message' ||
    trimmed === 'interrupt_agent'
  )
}

/**
 * Find the corresponding child subagent session id for a given tool element.
 * @param toolEl - the DOM element containing or tagged with the tool call
 * @param parentSessionId - current active parent session id
 * @param sessionList - snapshot of all sessions
 * @returns child session id, if identified
 */
export function findSubagentForTool(
  toolEl: Element,
  parentSessionId: string,
  sessionList: SidebarSessionList,
): string | undefined {
  const text = toolEl.textContent ?? ''

  // 1. Check for explicit UUID match in the tool element text (e.g. in result or args)
  const uuidMatches = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)
  if (uuidMatches) {
    for (const id of uuidMatches) {
      if (sessionList.byId[id]?.parentId === parentSessionId) {
        return id
      }
    }
  }

  // 2. Check for explicit agent id pattern (e.g. `started subagent a-...` or `agent_id: "..."`)
  const idMatch = text.match(/\b(a-[a-zA-Z0-9_-]+)\b/)
  if (idMatch && idMatch[1] !== undefined && sessionList.byId[idMatch[1]]) {
    return idMatch[1]
  }

  // 3. Match by child label from subagentsByParent catalog
  const catalog = sessionList.subagentsByParent?.[parentSessionId]
  const catalogChildren = (catalog?.entries ?? []).filter(
    (entry): entry is SidebarSubagentChildEntry => entry.kind === 'child',
  )
  for (const child of catalogChildren) {
    if (child.label && child.label.trim() !== '' && text.includes(child.label.trim())) {
      return child.id
    }
  }

  // 4. Match by displayTitle from sessionList.byId
  const directChildren = Object.values(sessionList.byId).filter(
    summary => summary.origin === 'subagent' && summary.parentId === parentSessionId,
  )
  for (const child of directChildren) {
    if (child.displayTitle && child.displayTitle.trim() !== '' && text.includes(child.displayTitle.trim())) {
      return child.id
    }
  }

  // 5. If there is only one child, it is unambiguously that child
  if (catalogChildren.length === 1 && catalogChildren[0] !== undefined) {
    return catalogChildren[0].id
  }
  if (directChildren.length === 1 && directChildren[0] !== undefined) {
    return directChildren[0].id
  }

  // 6. Match by structural DOM position among all subagent tools in the document
  if (catalogChildren.length > 0 || directChildren.length > 0) {
    const allTools = Array.from(document.querySelectorAll('[data-tool]')).filter(el =>
      isSubagentTool(el.getAttribute('data-tool')),
    )
    const index = allTools.indexOf(toolEl)
    if (index >= 0) {
      const childFromCatalog = catalogChildren[index]
      if (childFromCatalog !== undefined) return childFromCatalog.id
      const childFromDirect = directChildren[index]
      if (childFromDirect !== undefined) return childFromDirect.id
    }
  }

  // 7. Fallback to latest child created
  const lastCatalogChild = catalogChildren[catalogChildren.length - 1]
  if (lastCatalogChild !== undefined) return lastCatalogChild.id
  const lastDirectChild = directChildren[directChildren.length - 1]
  return lastDirectChild?.id
}

/**
 * Navigate to the target subagent child session and highlight it in the sidebar.
 */
export function jumpToSubagent(
  ctx: Context,
  store: SidebarStore,
  parentSessionId: string,
  childSessionId: string,
  onJump?: (id: string) => void,
): void {
  onJump?.(childSessionId)
  const sessions = ctx.sessions
  try {
    if (typeof sessions?.openSubagent === 'function') {
      const address: SidebarSubagentAddress = sessions.subagentAddress?.(childSessionId) ?? {
        parentSessionId,
        childSessionId,
        mode: 'one-shot',
      }
      sessions.openSubagent(address)
    } else if (typeof sessions?.open === 'function') {
      sessions.open(childSessionId)
    }
  } catch (error) {
    console.error('[dsh-better-sidebar] Failed to open subagent session:', error)
  }

  // Ensure the sidebar panel is expanded and Tasks tab is active
  store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
  store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
  ctx.get('betterSidebar')?.openTab({ type: 'subagent', title: t('subagent') })
}

/**
 * Register document-level click interception to navigate to subagent on tool-call clicks.
 * @returns cleanup disposer (HMR-safe)
 */
export function registerSubagentToolJump(
  ctx: Context,
  store: SidebarStore,
  onJump?: (id: string) => void,
): () => void {
  const onClick = (event: MouseEvent): void => {
    if (!isPlainLeftClick(event)) return
    if (event.defaultPrevented) return

    const target = event.target as Element | null
    if (!target || typeof target.closest !== 'function') return

    // Find closest tool call container
    const toolEl = target.closest('[data-tool]')
    if (!toolEl) return

    const toolName = toolEl.getAttribute('data-tool')
    if (!isSubagentTool(toolName)) return

    // If user explicitly clicked a toggle chevron, let it toggle expansion
    const isChevron = Boolean(target.closest('[class*="chevron" i], [data-slot*="chevron" i], svg'))
    if (isChevron) return

    const snapshot = ctx.sessions?.list?.getSnapshot()
    const parentSessionId = snapshot?.current
    if (!parentSessionId) return

    const childId = findSubagentForTool(toolEl, parentSessionId, snapshot)
    if (!childId) return

    event.preventDefault()
    event.stopPropagation()
    jumpToSubagent(ctx, store, parentSessionId, childId, onJump)
  }

  document.addEventListener('click', onClick, true)
  return () => {
    document.removeEventListener('click', onClick, true)
  }
}
