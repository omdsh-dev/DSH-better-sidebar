/**
 * Tool click context tracking:
 * Tracks which tool (read / edit / write / subagent / etc.) was clicked in the chat
 * so file-open funnels (`openSidebarFile`, `wrapOpenWorkspacePath`) know whether
 * an open request was triggered by a read tool (show file only, never diff)
 * vs an edit tool (show git diff when `editOpensDiff` is on).
 */

export interface ActiveToolContext {
  tool?: string
  variant?: string
  targetLine?: number
  isRead: boolean
  isEdit: boolean
  timestamp: number
}

let lastToolContext: ActiveToolContext | null = null

/** Whether a tool name or variant represents a read operation. */
export function isReadTool(nameOrVariant?: string | null): boolean {
  if (!nameOrVariant) return false
  const lower = nameOrVariant.trim().toLowerCase()
  return (
    lower === 'read' ||
    lower.startsWith('read_') ||
    lower.startsWith('read-') ||
    lower === 'read_image' ||
    lower === 'readimage' ||
    lower === 'read_file' ||
    lower === 'readfile' ||
    lower.includes('read')
  )
}

/** Whether a tool name or variant represents an edit/mutation operation. */
export function isEditTool(nameOrVariant?: string | null): boolean {
  if (!nameOrVariant) return false
  const lower = nameOrVariant.trim().toLowerCase()
  return (
    lower === 'edit' ||
    lower === 'write' ||
    lower.startsWith('edit_') ||
    lower.startsWith('write_') ||
    lower.startsWith('edit-') ||
    lower.startsWith('write-') ||
    lower === 'str_replace_editor' ||
    lower.includes('edit') ||
    lower.includes('write')
  )
}

/**
 * Find the file path from a tool row DOM element.
 */
export function findFilePathInTool(toolEl: Element): string | undefined {
  // 1. Check fileLink button text
  const fileBtn = toolEl.querySelector('button[class*="fileLink" i]')
  if (fileBtn?.textContent?.trim()) return fileBtn.textContent.trim()

  // 2. Check summary span text
  const summarySpan = toolEl.querySelector('span[class*="summary" i]')
  if (summarySpan?.textContent?.trim()) return summarySpan.textContent.trim()

  // 3. Check SideChat meta
  const metaSpan = toolEl.querySelector('[class*="RowMeta" i], [class*="sidechatRowMeta" i]')
  if (metaSpan?.textContent?.trim()) return metaSpan.textContent.trim()

  // 4. Try parsing tool arguments from text or code blocks
  const text = toolEl.textContent || ''
  const pathMatch = text.match(/"file_path"\s*:\s*"([^"]+)"/) || text.match(/"path"\s*:\s*"([^"]+)"/)
  if (pathMatch && pathMatch[1] !== undefined) return pathMatch[1]

  return undefined
}

/**
 * Extract target line number (e.g. read tool offset) from the tool row DOM element.
 */
export function findTargetLineInTool(toolEl: Element): number | undefined {
  // 1. Check if toolEl has any line number indicators
  const lineEl = toolEl.querySelector('[class*="number" i], [class*="lineNum" i]')
  if (lineEl?.textContent) {
    const num = parseInt(lineEl.textContent.trim(), 10)
    if (!isNaN(num) && num > 0) return num
  }
  // 2. Check if toolEl contains JSON arguments with offset
  const text = toolEl.textContent || ''
  const offsetMatch = text.match(/"offset"\s*:\s*(\d+)/) || text.match(/\boffset\s*[:=]\s*(\d+)/i)
  if (offsetMatch && offsetMatch[1] !== undefined) {
    const num = parseInt(offsetMatch[1], 10)
    if (!isNaN(num) && num > 0) return num
  }
  return undefined
}

/**
 * Capture click/pointerdown target in the DOM to record tool context.
 */
export function trackToolClick(event: Event): void {
  const target = event.target as Element | null
  if (!target || typeof target.closest !== 'function') return
  const toolEl = target.closest('[data-tool], [data-variant]')
  if (!toolEl) return

  const tool = toolEl.getAttribute('data-tool') || undefined
  const variant = toolEl.getAttribute('data-variant') || undefined
  const isRead = isReadTool(variant) || isReadTool(tool)
  const isEdit = isEditTool(variant) || isEditTool(tool)
  const targetLine = findTargetLineInTool(toolEl)

  lastToolContext = {
    tool,
    variant,
    targetLine,
    isRead,
    isEdit,
    timestamp: Date.now(),
  }
}

/**
 * Return the most recent tool context if within the recency threshold (2 seconds).
 */
export function getLastToolContext(): ActiveToolContext | null {
  if (lastToolContext !== null && Date.now() - lastToolContext.timestamp < 2000) {
    return lastToolContext
  }
  return null
}

/** Set tool context for testing. */
export function setLastToolContextForTest(context: ActiveToolContext | null): void {
  lastToolContext = context
}

/**
 * Register document-level click tracking.
 * @returns cleanup disposer (HMR-safe)
 */
export function registerToolClickTracking(): () => void {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('pointerdown', trackToolClick, true)
  document.addEventListener('click', trackToolClick, true)
  return () => {
    document.removeEventListener('pointerdown', trackToolClick, true)
    document.removeEventListener('click', trackToolClick, true)
  }
}
