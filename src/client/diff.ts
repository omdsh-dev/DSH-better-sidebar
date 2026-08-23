/**
 * Minimal self-contained unified-diff builder for per-turn file changes.
 *
 * The session log's mutation views carry `{ path, oldText, newText }` — the
 * before/after text of one change (a `write`'s full content, or the hunks an
 * `edit`/`str_replace` applied). This module turns those into a standard
 * unified-diff string (`@@ -a,b +c,d @@` hunks with 3 context lines) that the
 * existing `DiffView`/`parseUnifiedDiff` renderer consumes, so a per-turn
 * change shows as a real red/green diff with no git round-trip.
 *
 * The line-diff is a classic LCS DP over the old/new line arrays (bounded by
 * the sizes of the two texts; for typical edit hunks this is tiny, and the
 * caller caps the whole turn's retained content).
 */
export interface FileChangeText {
  path: string
  oldText: string | null
  newText: string
}

/** One operation in the LCS-derived edit script. */
type Op =
  | { kind: 'eq'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'add'; text: string }

/** Split text into lines, keeping a trailing empty line for a trailing newline. */
function splitLines(text: string | null): string[] {
  if (text === null) return []
  if (text === '') return []
  const lines = text.split('\n')
  // A trailing newline produces a final empty segment that represents the
  // newline itself; drop it (the unified format re-adds it per line).
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Compute the LCS edit script between two line arrays (Myers-free, plain DP). */
function editScript(oldLines: string[], newLines: string[]): Op[] {
  const n = oldLines.length
  const m = newLines.length
  // dp[i][j] = LCS length of oldLines[i..] and newLines[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const oldLine = oldLines[i]
      const newLine = newLines[j]
      const diag = dp[i + 1]![j + 1]!
      const down = dp[i + 1]![j]!
      const right = dp[i]![j + 1]!
      dp[i]![j] = oldLine === newLine ? diag + 1 : Math.max(down, right)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const oldLine = oldLines[i]
    const newLine = newLines[j]
    if (oldLine !== undefined && newLine !== undefined && oldLine === newLine) {
      ops.push({ kind: 'eq', text: oldLine })
      i++
      j++
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      if (oldLine !== undefined) ops.push({ kind: 'del', text: oldLine })
      i++
    } else {
      if (newLine !== undefined) ops.push({ kind: 'add', text: newLine })
      j++
    }
  }
  while (i < n) {
    const line = oldLines[i]
    if (line !== undefined) ops.push({ kind: 'del', text: line })
    i++
  }
  while (j < m) {
    const line = newLines[j]
    if (line !== undefined) ops.push({ kind: 'add', text: line })
    j++
  }
  return ops
}

/** Group ops into hunks with the given context window. */
function hunksOf(ops: Op[], context = 3): { oldStart: number; oldLen: number; newStart: number; newLen: number; lines: Op[] }[] {
  const hunks: { oldStart: number; oldLen: number; newStart: number; newLen: number; lines: Op[] }[] = []
  const n = ops.length
  // Index positions of changed (non-eq) ops.
  const changedIdx: number[] = []
  for (let k = 0; k < n; k++) {
    const op = ops[k]
    if (op !== undefined && op.kind !== 'eq') changedIdx.push(k)
  }

  // Split changed ops into clusters: two changes belong to the same hunk if
  // the number of equal lines between them is <= 2*context.
  let clusterStart = 0
  for (let c = 0; c < changedIdx.length; c++) {
    const cur = changedIdx[c]
    const next = c + 1 < changedIdx.length ? changedIdx[c + 1] : undefined
    if (next !== undefined && cur !== undefined && next - cur - 1 <= 2 * context) continue // same cluster
    // Close the cluster [clusterStart..c].
    const firstChanged = changedIdx[clusterStart]
    const lastChanged = changedIdx[c]
    if (firstChanged === undefined || lastChanged === undefined) { clusterStart = c + 1; continue }
    // Hunk spans from (firstChanged - context) to (lastChanged + context),
    // clamped to the op range.
    const start = Math.max(0, firstChanged - context)
    const end = Math.min(n, lastChanged + context + 1)
    const body = ops.slice(start, end)
    // Compute line numbers for the hunk header by walking ops up to `start`.
    let oldLine = 1
    let newLine = 1
    for (let k = 0; k < start; k++) {
      const op = ops[k]
      if (op === undefined) continue
      if (op.kind === 'eq' || op.kind === 'del') oldLine++
      if (op.kind === 'eq' || op.kind === 'add') newLine++
    }
    // Count changes within the body for the lengths.
    let oldLen = 0
    let newLen = 0
    for (const op of body) {
      if (op.kind === 'del') oldLen++
      else if (op.kind === 'add') newLen++
      else { oldLen++; newLen++ }
    }
    hunks.push({ oldStart: oldLine, oldLen, newStart: newLine, newLen, lines: body })
    clusterStart = c + 1
  }
  return hunks
}

/** Escape a path for the `---` / `+++` header lines (git-style `a/`/`b/`). */
function diffPath(path: string): string {
  return path.startsWith('/') ? path : `a/${path}`
}

/**
 * Build a unified-diff string for one or more file changes, rendered by
 * `DiffView`. Pure insertions (`oldText === null`) produce a `/dev/null` old
 * side; otherwise both sides use `a/`/`b/` prefixes.
 * @param changes - one entry per file with its before/after text.
 * @returns the unified diff text (empty when there is nothing to show).
 */
export function buildUnifiedDiff(changes: readonly FileChangeText[]): string {
  const out: string[] = []
  for (const change of changes) {
    const oldLines = splitLines(change.oldText)
    const newLines = splitLines(change.newText)
    const ops = editScript(oldLines, newLines)
    const hunks = hunksOf(ops)
    if (hunks.length === 0 && change.oldText !== null && change.oldText === change.newText) continue
    const isAdd = change.oldText === null || oldLines.length === 0
    const oldPath = isAdd ? '/dev/null' : diffPath(change.path)
    const newPath = diffPath(change.path)
    // `parseUnifiedDiff` opens a file only on a `diff --git` header.
    out.push(`diff --git ${oldPath} ${newPath}`)
    out.push(`--- ${oldPath}`)
    out.push(`+++ ${newPath}`)
    for (const hunk of hunks) {
      out.push(`@@ -${hunk.oldStart},${hunk.oldLen} +${hunk.newStart},${hunk.newLen} @@`)
      for (const op of hunk.lines) {
        if (op.kind === 'eq') out.push(` ${op.text}`)
        else if (op.kind === 'del') out.push(`-${op.text}`)
        else out.push(`+${op.text}`)
      }
    }
  }
  return out.join('\n')
}
