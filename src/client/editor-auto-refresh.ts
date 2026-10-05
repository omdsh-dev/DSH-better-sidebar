import type { SidebarSessionEvent } from '../context-types.ts'
import { extractFileOps } from './changes/ops.ts'
import { resolveSidebarPath } from './paths.ts'

export interface PreviewWriteCursor {
  readonly events: readonly SidebarSessionEvent[]
  readonly lastSeq: number
  readonly ready: boolean
}

export const INITIAL_PREVIEW_WRITE_CURSOR: PreviewWriteCursor = { events: [], lastSeq: -1, ready: false }

/** 将工具参数中的路径与编辑器路径化为可比较的绝对路径。 */
function comparablePath(cwd: string | undefined, path: string): string {
  const resolved = resolveSidebarPath(cwd, path).replace(/\\/g, '/')
  const rootLength = resolved.startsWith('//') ? 4 : resolved.startsWith('/') || /^[A-Za-z]:\//.test(resolved) ? 1 : 0
  const parts: string[] = []
  for (const part of resolved.split('/')) {
    if (part === '.') continue
    if (part === '..' && parts.length > rootLength && parts.at(-1) !== '..') parts.pop()
    else if (part !== '..') parts.push(part)
    else if (rootLength === 0) parts.push(part)
  }
  const normalized = parts.join('/')
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized
}

/**
 * 判断本次增量中是否有成功完成的文件写入命中当前预览。
 * 完整事件窗口提供调用参数，本次增量限定刚完成的结果，避免重放历史操作。
 */
export function hasCompletedPreviewWrite(
  events: readonly SidebarSessionEvent[],
  delta: readonly SidebarSessionEvent[],
  cwd: string | undefined,
  path: string,
): boolean {
  const completed = new Set(delta.filter(event => event.type === 'tool/result').map(event => {
    const data = event.data as { message?: { source?: { callId?: unknown } } }
    return data.message?.source?.callId
  }).filter((callId): callId is string => typeof callId === 'string'))
  if (completed.size === 0) return false
  const target = comparablePath(cwd, path)
  return extractFileOps(events).some(op => completed.has(op.callId)
    && (op.kind === 'write' || op.kind === 'edit') && !op.running && !op.isError
    && comparablePath(cwd, op.path) === target)
}

/**
 * 推进预览的会话事件游标，并报告本次增量是否完成了当前文件的写入。
 * 初次响应只建立基线；后续响应按事件序号去重并保留最近的事件窗口。
 */
export function advancePreviewWriteCursor(
  cursor: PreviewWriteCursor,
  response: { events: readonly SidebarSessionEvent[]; lastSeq: number },
  cwd: string | undefined,
  path: string,
): { cursor: PreviewWriteCursor; changed: boolean } {
  const delta = cursor.ready ? response.events.filter(event => event.seq > cursor.lastSeq) : response.events
  const combined = [...cursor.events, ...delta]
  const events = combined.length > 4000 ? combined.slice(combined.length - 4000) : combined
  return {
    cursor: { events, lastSeq: delta.length > 0 ? Math.max(cursor.lastSeq, response.lastSeq) : cursor.lastSeq, ready: true },
    changed: cursor.ready && hasCompletedPreviewWrite(events, delta, cwd, path),
  }
}
