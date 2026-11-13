/** Explicit local-file → native files-tree navigation. No cwd/root inference or host reveal API. */
import type { Context } from '../../context-types.ts'
import type { ClueCandidate, Locator } from '../../clues/types.ts'
import { BUILTIN_SOURCE_IDS } from '../../clues/types.ts'
import { api } from '../api.ts'
import { mountedSessionId } from '../native/surface.ts'
import { revealPaths, type SidebarStore } from '../state.ts'
import type { BetterSidebarService } from '../service.ts'
import { workspaceLocationOf } from './workspace-id.ts'

type Dialect = 'posix' | 'win32'
export type FileRevealResult =
  | { readonly status: 'revealed' | 'queued'; readonly sessionId: string }
  | { readonly status: 'unavailable'; readonly reason: 'locator' | 'workspace' | 'session' | 'tree-root-mismatch' | 'changed' | 'host' }

/** Normalize an absolute root in its declared dialect, without consulting the browser OS. */
function rootOf(root: string, dialect: Dialect): string | undefined {
  if (root.includes('\0')) return undefined
  if (dialect === 'posix') {
    if (!root.startsWith('/') || root.startsWith('//') || root.includes('\\')) return undefined
    const parts = root.split('/').filter(Boolean)
    if (parts.some(part => part === '.' || part === '..')) return undefined
    return `/${parts.join('/')}`
  }
  const normalized = root.replace(/\//g, '\\')
  if (!/^[A-Za-z]:\\/.test(normalized) && !/^\\\\[^\\]+\\[^\\]+/.test(normalized)) return undefined
  const parts = normalized.split('\\').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..')) return undefined
  return normalized.replace(/\\+$/, '') + (/^[A-Za-z]:\\?$/.test(normalized) ? '\\' : '')
}

/** Resolve a workspace-relative locator. Backslash-literal POSIX names cannot be faithfully revealed by the current tree. */
export function fileRevealPathOf(locator: Locator, root: string): string | undefined {
  const dialect = locator.dialect
  const relative = locator.path
  if ((dialect !== 'posix' && dialect !== 'win32') || typeof relative !== 'string' || relative.includes('\0')) return undefined
  const base = rootOf(root, dialect)
  if (base === undefined || relative === '') return undefined
  if (dialect === 'posix' ? relative.startsWith('/') || relative.includes('\\') : /^[\\/]|^[A-Za-z]:/.test(relative)) return undefined
  if (dialect === 'win32' && (/[<>:"|?*]/.test(relative) || [...relative].some(char => char.charCodeAt(0) < 32))) return undefined
  const parts: string[] = []
  for (const part of relative.split(dialect === 'win32' ? /[\\/]+/ : /\/+/).filter(Boolean)) {
    if (part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
    } else parts.push(part)
  }
  if (parts.length === 0) return undefined
  const separator = dialect === 'win32' ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}${parts.join(separator)}`
}

function sameRoot(a: string, b: string, dialect: Dialect): boolean {
  const left = rootOf(a, dialect)
  const right = rootOf(b, dialect)
  return left !== undefined && right !== undefined && (dialect === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right)
}

/** Queue/reveal a path in its own workspace session; never switch the current conversation. */
export async function revealClueFile(input: {
  readonly ctx: Context
  readonly store: SidebarStore
  readonly service: Pick<BetterSidebarService, 'openTab' | 'isTabEnabled'>
  readonly candidate: ClueCandidate
  readonly sessionId: string
}): Promise<FileRevealResult> {
  const { ctx, store, service, candidate, sessionId } = input
  if (sessionId.trim() === '') return { status: 'unavailable', reason: 'session' }
  try {
    const root = candidate.locator.root
    if (candidate.sourceId !== BUILTIN_SOURCE_IDS.files || root === null || typeof root !== 'object' || Array.isArray(root)
      || root.kind !== 'workspace' || typeof root.workspaceId !== 'string' || root.workspaceId === '') {
      return { status: 'unavailable', reason: 'locator' }
    }
    const workspaceId = root.workspaceId
    const location = workspaceLocationOf(ctx, workspaceId)
    if (location === undefined) return { status: 'unavailable', reason: 'workspace' }
    const path = fileRevealPathOf(candidate.locator, location.root)
    if (path === undefined) return { status: 'unavailable', reason: 'locator' }
    const live = ctx.sessions.list.getSnapshot().byId
    const members = location.sessionIds.filter(id => live[id] !== undefined)
    const targetSessionId = members.includes(sessionId) ? sessionId : members[0]
    if (targetSessionId === undefined) return { status: 'unavailable', reason: 'session' }
    if (!service.isTabEnabled('editor')) return { status: 'unavailable', reason: 'host' }
    const native = ctx.get('sidebarRight') as { mounted?: { getSnapshot?: () => string | undefined } } | undefined
    if (typeof native?.mounted?.getSnapshot !== 'function') return { status: 'unavailable', reason: 'host' }
    const initialSession = store.getSnapshot().sessionId
    const initialMounted = mountedSessionId(ctx)
    const effective = await api.sessionCwd({ sessionId: targetSessionId })
    const dialect = candidate.locator.dialect as Dialect
    if (effective.sessionId !== targetSessionId || !sameRoot(effective.cwd, location.root, dialect)) {
      return { status: 'unavailable', reason: 'tree-root-mismatch' }
    }
    // An awaited host read must not authorize a reveal against a workspace or
    // session that disappeared/changed while it was in flight.
    const current = workspaceLocationOf(ctx, workspaceId)
    if (store.getSnapshot().sessionId !== initialSession || mountedSessionId(ctx) !== initialMounted
      || current === undefined || current.root !== location.root || !current.sessionIds.includes(targetSessionId)
      || ctx.sessions.list.getSnapshot().byId[targetSessionId] === undefined) {
      return { status: 'unavailable', reason: 'changed' }
    }
    if (!service.isTabEnabled('editor')) return { status: 'unavailable', reason: 'host' }
    // Windows equality is case-insensitive, but FileTree's revealed Set is
    // exact-string keyed. After proving the same workspace root, mirror the
    // effective tree root's spelling instead of the catalogue's casing.
    const renderedPath = fileRevealPathOf(candidate.locator, effective.cwd)
    if (renderedPath === undefined) return { status: 'unavailable', reason: 'locator' }
    const reveal = (state: Parameters<typeof revealPaths>[0]) => revealPaths(state, effective.cwd, [renderedPath])
    if (store.getSnapshot().sessionId === targetSessionId) store.reduce(reveal)
    else store.reduceFor(targetSessionId, reveal)
    // No path: editor+path is a document tab, while editor without a path is
    // the plugin's files page takeover. Its native body projects this store.
    service.openTab({ type: 'editor' }, { sessionId: targetSessionId, cwd: effective.cwd })
    return { status: initialMounted === targetSessionId ? 'revealed' : 'queued', sessionId: targetSessionId }
  } catch {
    return { status: 'unavailable', reason: 'host' }
  }
}
