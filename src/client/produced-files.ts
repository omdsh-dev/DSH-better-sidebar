/**
 * Pure derivation of one turn's produced files from finalized conversation
 * nodes — a structural replica of ui-deliverables' `producedForClosing`
 * (the mutation tools' follow-along `locations`, by render intent: a diff
 * card or a generic edit card; reads/deletes/failures produce nothing).
 * Kept dependency-free so the takeover logic is unit-testable and the
 * replica is easy to diff against upstream when it drifts.
 */
import { isAbsolutePath } from './paths.ts'

/** Paths a tool-result view reports as produced, by render intent. */
export function producedPaths(view: unknown): readonly string[] {
  if (view === null || typeof view !== 'object') return []
  const record = view as { card?: unknown; kind?: unknown; locations?: unknown }
  const isEdit = record.card === 'diff' || (record.card === 'generic' && record.kind === 'edit')
  if (!isEdit) return []
  if (!Array.isArray(record.locations)) return []
  const paths: string[] = []
  for (const location of record.locations) {
    if (location !== null && typeof location === 'object' && typeof (location as { path?: unknown }).path === 'string') {
      paths.push((location as { path: string }).path)
    }
  }
  return paths
}

/**
 * Files produced by the turn the assistant at `seq` closes. Accumulation
 * resets on turn boundaries (a user message, or a node reporting a different
 * turn number); paths keep first-seen order and appear once.
 * @param nodes - snapshot nodes in surface order (structural, unknown-safe).
 * @param seq - the closing assistant's seq (the render site's anchor).
 * @returns produced paths; empty when the turn wrote nothing.
 */
export function producedForClosing(nodes: readonly unknown[], seq: number): readonly string[] {
  let pending: string[] = []
  let seen = new Set<string>()
  let turn: number | undefined
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    const record = node as { kind?: unknown; isError?: unknown; callView?: unknown; turn?: unknown; seq?: unknown }
    if (record.kind === 'tool-result') {
      if (record.isError === true) continue
      for (const path of producedPaths(record.callView)) {
        if (seen.has(path)) continue
        seen.add(path)
        pending.push(path)
      }
      continue
    }
    if (record.kind === 'user') {
      turn = undefined
      pending = []
      seen = new Set()
    } else if (typeof record.turn === 'number') {
      if (turn !== undefined && record.turn !== turn) {
        pending = []
        seen = new Set()
      }
      turn = record.turn
    }
    if (record.kind === 'assistant' && record.seq === seq) return pending
  }
  return []
}

/**
 * Claim the turn-tail chain only when the closing turn produced files.
 * @param owner - the turn-tail owner currency ({nodes, seq}).
 * @returns produced paths as the matched value, or null to decline.
 */
export function selectProducedFiles(owner: unknown): readonly string[] | null {
  const record = owner as { nodes?: unknown; seq?: unknown } | null
  if (record === null || typeof record !== 'object') return null
  if (!Array.isArray(record.nodes) || typeof record.seq !== 'number') return null
  const paths = producedForClosing(record.nodes, record.seq)
  return paths.length === 0 ? null : paths
}

/**
 * Resolve a (possibly relative) path against the session cwd for the sidebar.
 * Absolute detection mirrors the host (see client/paths.isAbsolutePath):
 * POSIX roots, drive letters and UNC shares must not be joined onto the cwd.
 */
export function resolveSidebarPath(cwd: string | undefined, path: string): string {
  if (isAbsolutePath(path)) return path
  const base = cwd ?? ''
  if (base === '') return path
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}${path}`
}
