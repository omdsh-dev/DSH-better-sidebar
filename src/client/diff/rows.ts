/**
 * The one diff engine every file-change surface shares (the changes tab's
 * git and session lenses, the diff tab): a unified DiffRow model fed by two
 * producers — a line LCS over known contents (session file ops) and git's
 * own unified-diff text (worktree/commit diffs, via `parseUnifiedDiff` +
 * `unifiedSegments`) — collapsed into hunk/fold segments for the shared
 * renderer. Pure functions only — no React, no DOM.
 */

/** One rendered diff row. */
export interface DiffRow {
  /** Change class: 'context' shared, 'del' removed, 'add' added, 'mod'
   *  rewritten (paired del+add), 'meta' an attached marker row. */
  readonly kind: 'context' | 'del' | 'add' | 'mod' | 'meta'
  /** Old-side 1-based line number; absent on pure additions. */
  readonly oldLine?: number
  /** New-side 1-based line number; absent on pure deletions. */
  readonly newLine?: number
  /** The line's text without its terminator. */
  readonly text: string
}

/**
 * Longest-common-subsequence table over line equality.
 * @param oldLines - old side lines.
 * @param newLines - new side lines.
 * @returns the LCS length matrix (rows index oldLines, columns newLines).
 */
function lcsTable(oldLines: readonly string[], newLines: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0))
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i]![j] = oldLines[i] === newLines[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  return table
}

/**
 * Pair each del-run with the add-run that follows it: the overlapping
 * `min(len)` rows on both sides become 'mod' so rewrites tint distinctly and
 * receive intra-line highlighting. Pure — returns a new array when anything
 * changed. Shared by the LCS walk and the unified-diff converter so git
 * hunks rewrite-pair exactly like session ops do.
 */
export function pairMods(rows: readonly DiffRow[]): DiffRow[] {
  const out = rows.slice()
  let k = 0
  while (k < out.length) {
    if (out[k]!.kind !== 'del') { k += 1; continue }
    const delStart = k
    while (k < out.length && out[k]!.kind === 'del') k += 1
    const addStart = k
    while (k < out.length && out[k]!.kind === 'add') k += 1
    const pairs = Math.min(addStart - delStart, k - addStart)
    for (let p = 0; p < pairs; p += 1) {
      out[delStart + p] = { ...out[delStart + p]!, kind: 'mod' }
      out[addStart + p] = { ...out[addStart + p]!, kind: 'mod' }
    }
  }
  return out
}

/**
 * Line diff by LCS walk with rewrite pairing: the raw walk emits context/del/
 * add rows; `pairMods` marks rewritten pairs as 'mod'.
 * @param oldText - the previous content; empty string diffs against nothing.
 * @param newText - the next content.
 * @returns ordered diff rows, old-side deletions before new-side additions.
 */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const oldLines = oldText.length === 0 ? [] : oldText.split('\n')
  const newLines = newText.length === 0 ? [] : newText.split('\n')
  const table = lcsTable(oldLines, newLines)
  const raw: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      raw.push({ kind: 'context', oldLine: i + 1, newLine: j + 1, text: oldLines[i]! })
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      raw.push({ kind: 'del', oldLine: i + 1, text: oldLines[i]! })
      i += 1
    } else {
      raw.push({ kind: 'add', newLine: j + 1, text: newLines[j]! })
      j += 1
    }
  }
  while (i < oldLines.length) {
    raw.push({ kind: 'del', oldLine: i + 1, text: oldLines[i]! })
    i += 1
  }
  while (j < newLines.length) {
    raw.push({ kind: 'add', newLine: j + 1, text: newLines[j]! })
    j += 1
  }
  return pairMods(raw)
}

/** One rendered hunk: change rows plus the surrounding context window. */
export interface HunkSegment { readonly kind: 'hunk'; readonly rows: readonly DiffRow[] }

/** One collapsed run of unchanged rows (the "… n 行" fold). */
export interface FoldSegment {
  readonly kind: 'fold'
  /** The rows this fold hides, when the producer knows them (session diffs
   *  re-derive them from full contents; git gaps never emitted the text, so
   *  those folds carry only their line ranges and cannot expand). */
  readonly rows?: readonly DiffRow[]
  /** How many rows the fold hides. */
  readonly count: number
  readonly oldStart: number
  readonly oldEnd: number
  readonly newStart: number
  readonly newEnd: number
}

export type DiffSegment = HunkSegment | FoldSegment

/** Context window (rows around a change) kept visible in a hunk. */
export const HUNK_CONTEXT = 3

/** Folded context runs shorter than this are shown directly, not collapsed. */
export const MIN_FOLD = 3

/**
 * Group a line diff into hunks and folded context runs. Consecutive changes
 * whose gap fits within the context window merge into one hunk; unchanged
 * regions between hunks (and any surrounding the whole diff) become fold
 * segments that default collapsed. This yields the file-hunk presentation
 * familiar from terminal diffs (Claude Code / git hunk headers).
 * @param rows - the flat diff rows.
 * @param context - how many unchanged rows around a change stay visible.
 * @returns ordered segments (hunks and folds).
 */
export function buildDiffSegments(rows: readonly DiffRow[], context = HUNK_CONTEXT): DiffSegment[] {
  if (rows.length === 0) return []
  const changeIndexes = rows.flatMap((row, index) => (row.kind === 'context' || row.kind === 'meta' ? [] : [index]))
  if (changeIndexes.length === 0) {
    // Whole diff is unchanged (or a pure no-op): hide it all behind one fold.
    return [{
      kind: 'fold', rows: [...rows], count: rows.length,
      oldStart: 1, oldEnd: rows.length, newStart: 1, newEnd: rows.length,
    }]
  }
  // Cluster changes into runs whose gaps fit within 2*context+1 rows.
  const hunks: { start: number; end: number }[] = []
  for (const ci of changeIndexes) {
    const start = Math.max(0, ci - context)
    const end = Math.min(rows.length - 1, ci + context)
    const last = hunks[hunks.length - 1]
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end)
    } else {
      hunks.push({ start, end })
    }
  }
  const segments: DiffSegment[] = []
  let cursor = 0
  for (const hunk of hunks) {
    if (hunk.start > cursor) segments.push(foldOf(rows.slice(cursor, hunk.start)))
    segments.push({ kind: 'hunk', rows: rows.slice(hunk.start, hunk.end + 1) })
    cursor = hunk.end + 1
  }
  if (cursor < rows.length) segments.push(foldOf(rows.slice(cursor)))
  return segments
}

function foldOf(rows: readonly DiffRow[]): FoldSegment {
  return {
    kind: 'fold',
    rows,
    count: rows.length,
    oldStart: firstOldLine(rows) ?? 1,
    oldEnd: lastOldLine(rows) ?? 0,
    newStart: firstNewLine(rows) ?? 1,
    newEnd: lastNewLine(rows) ?? 0,
  }
}

function firstOldLine(rows: readonly DiffRow[]): number | undefined {
  for (const row of rows) if (row.oldLine !== undefined) return row.oldLine
  return undefined
}
function lastOldLine(rows: readonly DiffRow[]): number | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i]!.oldLine !== undefined) return rows[i]!.oldLine
  return undefined
}
function firstNewLine(rows: readonly DiffRow[]): number | undefined {
  for (const row of rows) if (row.newLine !== undefined) return row.newLine
  return undefined
}
function lastNewLine(rows: readonly DiffRow[]): number | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i]!.newLine !== undefined) return rows[i]!.newLine
  return undefined
}

/** One intra-line segment: a run of chars with a changed flag. */
export interface InlineSegment { readonly text: string; readonly changed: boolean }
/** Each side's intra-line segments. */
export interface InlineDiff { readonly old: readonly InlineSegment[]; readonly next: readonly InlineSegment[] }

/**
 * Intra-line diff by common prefix/suffix: the shared leading and trailing
 * characters stay unchanged, and only the differing middle is marked changed
 * on both sides. This never highlights identical characters and keeps a small
 * edit inside a long line immediately visible. Pure, no React/DOM.
 * @param oldText - the old line.
 * @param newText - the new line.
 * @returns per-side segments marking changed runs.
 */
export function diffInline(oldText: string, newText: string): InlineDiff {
  const minLen = Math.min(oldText.length, newText.length)
  let prefix = 0
  while (prefix < minLen && oldText[prefix] === newText[prefix]) prefix += 1
  let suffix = 0
  while (suffix < minLen - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix += 1
  const oldMidStart = prefix
  const oldMidEnd = oldText.length - suffix
  const newMidStart = prefix
  const newMidEnd = newText.length - suffix
  const segments = (text: string, midStart: number, midEnd: number): InlineSegment[] => {
    const out: InlineSegment[] = []
    if (midStart > 0) out.push({ text: text.slice(0, midStart), changed: false })
    const mid = text.slice(midStart, midEnd)
    if (mid.length > 0) out.push({ text: mid, changed: true })
    if (midEnd < text.length) out.push({ text: text.slice(midEnd), changed: false })
    return out
  }
  return { old: segments(oldText, oldMidStart, oldMidEnd), next: segments(newText, newMidStart, newMidEnd) }
}

/**
 * Merge adjacent inline segments sharing the same changed flag, so rendering
 * wraps each run — not each character — in one span.
 * @param segments - the raw per-character-heavy inline segments.
 * @returns coalesced segments; identical text joined into runs.
 */
export function coalesceInline(segments: readonly InlineSegment[]): InlineSegment[] {
  const out: InlineSegment[] = []
  for (const seg of segments) {
    const last = out[out.length - 1]
    if (last !== undefined && last.changed === seg.changed) out[out.length - 1] = { text: last.text + seg.text, changed: seg.changed }
    else out.push(seg)
  }
  return out
}

/** Human byte count for the panel meta row. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified-diff text (git) → DiffRow segments
// ─────────────────────────────────────────────────────────────────────────────

/** One parsed diff line of a unified diff (git's own hunk structure). */
export interface DiffLine {
  kind: 'ctx' | 'del' | 'add' | 'meta'
  /** The line content without its diff marker ('' for the no-newline marker). */
  text: string
  /** Old-side line number (null for pure additions / metadata). */
  oldNum: number | null
  /** New-side line number (null for pure deletions / metadata). */
  newNum: number | null
}

/** One parsed hunk. */
export interface DiffHunk {
  /** The old-side start line (`-a[,b]`). */
  oldStart: number
  /** The new-side start line (`+c[,d]`). */
  newStart: number
  /** The section text after the trailing `@@` (may be empty). */
  header: string
  lines: DiffLine[]
}

/** One parsed file section of a unified diff. */
export interface DiffFile {
  /** The old-side path ('/dev/null' for a new file); '' when git named none. */
  oldPath: string
  /** The new-side path ('/dev/null' for a deleted file); '' when git named none. */
  newPath: string
  /** The file changed with binary content: no hunks to draw. */
  binary: boolean
  hunks: DiffHunk[]
}

/** The parsed unified diff. */
export interface ParsedDiff {
  files: DiffFile[]
}

/** Parse the hunk header `@@ -a[,b] +c[,d] @@ section` (section may contain '@@'). */
function parseHunkHeader(line: string): { oldStart: number; newStart: number; header: string } | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
  if (match === null) return null
  return { oldStart: Number(match[1]), newStart: Number(match[3]), header: match[5] ?? '' }
}

/** A git C-quoted path literal (`"a/x y.md"`, escapes included). */
const QUOTED_PATH = '"(?:[^"\\\\]|\\\\.)*"'

/** git's single-character C escapes, mapped to their byte. */
const C_ESCAPES: Record<string, number> = {
  a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92,
}

const pathEncoder = new TextEncoder()
const pathDecoder = new TextDecoder()

/**
 * Undo git's C-quoting of a path (`"a/\346\226\207.md"` → `a/中文.md`).
 * git quotes a path holding a byte outside ASCII, a control character, a
 * quote or a backslash; `-c core.quotePath=false` (see `runGit`) already
 * removes the non-ASCII half for our own commands, so this is the remaining
 * defensive half — and what keeps replayed/pasted diff text readable.
 * Unquoted input comes back unchanged.
 * @param raw - the path as it appears in the diff text.
 * @returns the literal path.
 */
export function decodeGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw
  const body = raw.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!
    if (char !== '\\') {
      for (const byte of pathEncoder.encode(char)) bytes.push(byte)
      continue
    }
    const escaped = body[i + 1]
    const simple = escaped === undefined ? undefined : C_ESCAPES[escaped]
    if (simple !== undefined) {
      bytes.push(simple)
      i += 1
      continue
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8))
      i += octal[0].length
      continue
    }
    // Unknown escape: keep the backslash verbatim.
    for (const byte of pathEncoder.encode(char)) bytes.push(byte)
  }
  return pathDecoder.decode(new Uint8Array(bytes))
}

/** A `---`/`+++` header value: git appends a TAB when the path has a space. */
function headerPath(raw: string): string {
  return decodeGitPath(raw.endsWith('\t') ? raw.slice(0, -1) : raw)
}

/**
 * Both sides of a `diff --git` header, or null when it cannot be split.
 * Needed for the sections that never reach `---`/`+++` — a mode-only change
 * (its path is the same on both sides, which is what the split looks for).
 */
function pathsFromGitHeader(rest: string): { oldPath: string; newPath: string } | null {
  const quoted = new RegExp(`^(${QUOTED_PATH}) (${QUOTED_PATH})$`).exec(rest)
  if (quoted !== null) return { oldPath: decodeGitPath(quoted[1]!), newPath: decodeGitPath(quoted[2]!) }
  // Unquoted (core.quotePath=false) paths may contain spaces, so walk every
  // ` b/` and keep the split whose sides name the same file.
  for (let at = rest.indexOf(' b/'); at !== -1; at = rest.indexOf(' b/', at + 1)) {
    const oldPath = rest.slice(0, at)
    const newPath = rest.slice(at + 1)
    if (oldPath.startsWith('a/') && newPath.startsWith('b/') && oldPath.slice(2) === newPath.slice(2)) {
      return { oldPath, newPath }
    }
  }
  return null
}

/** Both sides of a `Binary files A and B differ` line (A or B may be /dev/null). */
function pathsFromBinaryLine(raw: string): { oldPath: string; newPath: string } | null {
  const body = raw.slice('Binary files '.length).replace(/ differ$/, '')
  const quoted = new RegExp(`^(${QUOTED_PATH}) and (${QUOTED_PATH})$`).exec(body)
  if (quoted !== null) return { oldPath: decodeGitPath(quoted[1]!), newPath: decodeGitPath(quoted[2]!) }
  for (let at = body.indexOf(' and '); at !== -1; at = body.indexOf(' and ', at + 1)) {
    const oldPath = decodeGitPath(body.slice(0, at))
    const newPath = decodeGitPath(body.slice(at + ' and '.length))
    const oldSide = oldPath === '/dev/null' || oldPath.startsWith('a/')
    const newSide = newPath === '/dev/null' || newPath.startsWith('b/')
    if (oldSide && newSide) return { oldPath, newPath }
  }
  return null
}

/**
 * Parse `git diff --no-color` output into file sections and hunks. Rows
 * outside a file section (leading noise) and metadata rows between the
 * `diff --git`/`---`/`+++` headers and the first hunk (index lines, mode
 * changes, rename/similarity lines) are skipped.
 *
 * Paths come from whichever header names them: `---`/`+++` win when present,
 * otherwise the section's own `rename from|to`, `Binary files … differ` or
 * `diff --git` line supplies them. git emits no `---`/`+++` at all for a
 * binary file, a pure rename and a mode-only change, so without those
 * fallbacks the section renders as an anonymous header (the badge with no
 * file name the reader cannot place).
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let inHunk = false
  let hunk: DiffHunk | null = null
  let oldNum = 0
  let newNum = 0
  const flushHunk = (): void => {
    if (current !== null && hunk !== null) current.hunks.push(hunk)
    hunk = null
    inHunk = false
  }
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flushHunk()
      current = { oldPath: '', newPath: '', binary: false, hunks: [] }
      const headPaths = pathsFromGitHeader(raw.slice('diff --git '.length))
      if (headPaths !== null) {
        current.oldPath = headPaths.oldPath
        current.newPath = headPaths.newPath
      }
      files.push(current)
      continue
    }
    if (current === null) continue
    if (raw.startsWith('rename from ')) {
      current.oldPath = decodeGitPath(raw.slice('rename from '.length))
      continue
    }
    if (raw.startsWith('rename to ')) {
      current.newPath = decodeGitPath(raw.slice('rename to '.length))
      continue
    }
    if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') {
      flushHunk()
      current.binary = true
      if (raw.startsWith('Binary files ')) {
        const binPaths = pathsFromBinaryLine(raw)
        if (binPaths !== null) {
          current.oldPath = binPaths.oldPath
          current.newPath = binPaths.newPath
        }
      }
      continue
    }
    if (raw.startsWith('--- ')) {
      flushHunk()
      current.oldPath = headerPath(raw.slice(4))
      continue
    }
    if (raw.startsWith('+++ ')) {
      current.newPath = headerPath(raw.slice(4))
      continue
    }
    const header = parseHunkHeader(raw)
    if (header !== null) {
      flushHunk()
      hunk = { oldStart: header.oldStart, newStart: header.newStart, header: header.header, lines: [] }
      oldNum = header.oldStart
      newNum = header.newStart
      inHunk = true
      continue
    }
    if (!inHunk || hunk === null) continue
    const marker = raw[0]
    if (marker === '\\') {
      // `\ No newline at end of file`: metadata attached to the previous row.
      hunk.lines.push({ kind: 'meta', text: raw.slice(1), oldNum: null, newNum: null })
      continue
    }
    if (marker === ' ') {
      hunk.lines.push({ kind: 'ctx', text: raw.slice(1), oldNum, newNum })
      oldNum += 1
      newNum += 1
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', text: raw.slice(1), oldNum, newNum: null })
      oldNum += 1
    } else if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: raw.slice(1), oldNum: null, newNum })
      newNum += 1
    } else {
      // Not a diff line (a hunk can never contain one): stop the hunk.
      flushHunk()
    }
  }
  flushHunk()
  return { files }
}

/** One DiffLine row mapped onto the shared DiffRow model. */
function rowOfLine(line: DiffLine): DiffRow {
  if (line.kind === 'meta') return { kind: 'meta', text: line.text }
  const kind: DiffRow['kind'] = line.kind === 'ctx' ? 'context' : line.kind
  if (line.kind === 'del') return { kind, oldLine: line.oldNum ?? undefined, text: line.text }
  if (line.kind === 'add') return { kind, newLine: line.newNum ?? undefined, text: line.text }
  return { kind, oldLine: line.oldNum ?? undefined, newLine: line.newNum ?? undefined, text: line.text }
}

/**
 * Convert one parsed unified-diff file into renderer segments: each hunk's
 * lines become a paired-mod hunk segment, and the unemitted context gaps
 * between hunks (git already trimmed them) become non-expandable folds that
 * still carry their old/new line ranges. The rewrite pairing applies within
 * each hunk, exactly like session-op diffs.
 */
export function unifiedSegments(file: DiffFile): DiffSegment[] {
  const segments: DiffSegment[] = []
  file.hunks.forEach((hunk, index) => {
    const rows = pairMods(hunk.lines.map(rowOfLine))
    const prev = file.hunks[index - 1]
    if (prev !== undefined) {
      // The gap git never emitted: rows are unknown (non-expandable), but
      // the ranges are derivable from the surrounding hunk headers/counts.
      const prevOldEnd = prev.oldStart + prev.lines.filter(line => line.oldNum !== null).length - 1
      const prevNewEnd = prev.newStart + prev.lines.filter(line => line.newNum !== null).length - 1
      const oldGap = hunk.oldStart - prevOldEnd - 1
      const newGap = hunk.newStart - prevNewEnd - 1
      if (oldGap > 0 || newGap > 0) {
        segments.push({
          kind: 'fold',
          count: Math.max(oldGap, newGap, 0),
          oldStart: prevOldEnd + 1,
          oldEnd: Math.max(hunk.oldStart - 1, prevOldEnd),
          newStart: prevNewEnd + 1,
          newEnd: Math.max(hunk.newStart - 1, prevNewEnd),
        })
      }
    } else if (hunk.oldStart > 1 || hunk.newStart > 1) {
      // Leading context git trimmed (e.g. -U0 diffs).
      segments.push({
        kind: 'fold',
        count: Math.max(hunk.oldStart - 1, hunk.newStart - 1, 0),
        oldStart: 1,
        oldEnd: hunk.oldStart - 1,
        newStart: 1,
        newEnd: hunk.newStart - 1,
      })
    }
    segments.push({ kind: 'hunk', rows })
  })
  return segments
}

/** Build the untracked-file shape: one file, one hunk of pure additions. */
export function untrackedFile(path: string, content: string): DiffFile {
  const lines: DiffLine[] = []
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  if (body !== '') {
    let num = 1
    for (const line of body.split('\n')) {
      lines.push({ kind: 'add', text: line, oldNum: null, newNum: num })
      num += 1
    }
  }
  return { oldPath: '/dev/null', newPath: `b/${path}`, binary: false, hunks: [{ oldStart: 0, newStart: 1, header: '', lines }] }
}

/**
 * Materialize a git gap fold's hidden rows from the two sides' full file
 * contents, by the fold's known line ranges: the old side drives context
 * rows (each mapped onto the new side through the fold's offset — a gap is
 * an unchanged run, so the sides align), and new-side lines the old range
 * never reaches become pure additions. Line numbers clip to the actual
 * content (a no-newline file's ranges can overrun by one); `\r` endings
 * survive verbatim, like git's own context lines.
 */
export function foldRowsFromContents(fold: FoldSegment, oldContent: string, newContent: string): DiffRow[] {
  const oldLines = oldContent.length === 0 ? [] : oldContent.split('\n')
  const newLines = newContent.length === 0 ? [] : newContent.split('\n')
  const offset = fold.newStart - fold.oldStart
  const rows: DiffRow[] = []
  const oldFrom = Math.max(fold.oldStart, 1)
  const oldTo = Math.min(fold.oldEnd, oldLines.length)
  for (let oldLine = oldFrom; oldLine <= oldTo; oldLine += 1) {
    const text = oldLines[oldLine - 1]!
    const newLine = oldLine + offset
    rows.push(
      newLine >= fold.newStart && newLine <= fold.newEnd && newLine <= newLines.length
        ? { kind: 'context', oldLine, newLine, text }
        : { kind: 'context', oldLine, text },
    )
  }
  // New-side lines beyond what the old range reached (a pure-addition gap):
  // rows carrying only the new-side number, exactly like added lines.
  const newFrom = Math.max(fold.newStart, 1)
  const newTo = Math.min(fold.newEnd, newLines.length)
  for (let newLine = Math.max(newFrom, oldTo + offset + 1); newLine <= newTo; newLine += 1) {
    rows.push({ kind: 'add', newLine, text: newLines[newLine - 1]! })
  }
  return rows
}

/** Strip the `a/` / `b/` prefix git puts on diff paths (not on /dev/null). */
export function displayPath(path: string): string {
  if (path === '/dev/null') return path
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2)
  return path
}

/** The diff's add/del/mod row counts (the "+n −m" header chips). */
export function diffStats(segments: readonly DiffSegment[]): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const segment of segments) {
    if (segment.kind !== 'hunk') continue
    for (const row of segment.rows) {
      if (row.kind === 'add' || row.kind === 'mod') added += 1
      if (row.kind === 'del' || row.kind === 'mod') deleted += 1
    }
  }
  return { added, deleted }
}
