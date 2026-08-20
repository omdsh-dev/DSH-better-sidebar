/**
 * Pure parsing of chat "path:line" references and editor line-jump payloads.
 *
 * The model's prose (and user messages) frequently reference code with line
 * suffixes inside inline code — `src/foo.ts:42`, `src/foo.ts:42-56`,
 * `lib/utils.ts:10:5` (line:col) — or as bare paths (`src/foo.ts`). These
 * strings travel through THREE consumers in this plugin, all sharing the
 * same parsing rules so a mention produced in the chat and a line suffix
 * split off inside the open-path interception can never disagree:
 *
 * 1. The enhanced `chatFileMentions` resolver (chat-mentions.ts) turns a
 *    matched value into a clickable mention whose open callback rides the
 *    chat file-open funnel with the line suffix appended to the path.
 * 2. The open-path interception (intercept.tsx) splits that suffix back off
 *    the resolved absolute path before opening the editor, so the editor
 *    never reads a file literally named `foo.ts:42`.
 * 3. The editor tab reads `tab.meta.line` (written by the opener) through
 *    `readJumpMeta` and jumps the CodeMirror view to the range.
 *
 * Heuristics are deliberately conservative — the resolver only runs on
 * INLINE CODE spans in settled chat text, so a wrong guess costs a single
 * click that opens (or errors on) a file, never a mangled document:
 * - a `path:line` candidate needs a trailing `:\d+` (no space), and its
 *   path part must be plausible: no whitespace, no URL scheme (`://`), not
 *   all digits, and file-ish (contains a separator, a dot, or an uppercase
 *   letter — `Makefile:12` / `Dockerfile:15` match, `host:8080` /
 *   `localhost:3000` don't).
 * - a bare-path candidate needs a path separator (`/` or `\`), so prose
 *   like `obj.method` or `npm` never becomes a link; produced-file
 *   mentions (exact path / unique basename) keep their own DSH resolution.
 *
 * This module is dependency-free by design (no React / node:path), so the
 * rules are unit-testable and importable from the test runtime.
 */

/** A 1-based line range (inclusive both ends). */
export interface LineRange {
  /** 1-based first line (inclusive). */
  start: number
  /** 1-based last line (inclusive); equals `start` for a single line. */
  end: number
}

/** One parsed line reference: the file path and the 1-based line range. */
export interface LineJump extends LineRange {
  /** The file path WITHOUT the line suffix (may still be relative). */
  path: string
}

/** Whether a `path:line` suffix candidate looks like a filesystem path
 *  (not a URL, a time, a ratio, or prose). See the module comment. */
export function isPlausiblePath(path: string): boolean {
  if (path === '') return false
  if (path.length < 2) return false
  if (/\s/.test(path)) return false
  if (path.includes('://')) return false
  if (/^\d+$/.test(path)) return false
  // A separator or a dot covers the overwhelming majority of real paths
  // (`src/foo.ts`, `C:\proj\foo.ts`, `webpack.config.js`); an uppercase
  // letter admits extensionless build files (`Makefile`, `Dockerfile`,
  // `Gemfile`) while excluding lowercase prose tokens (`host`, `step`).
  return path.includes('/') || path.includes('\\') || path.includes('.') || /[A-Z]/.test(path)
}

/**
 * Parse a `path:line` reference (`foo.ts:42`, `foo.ts:42-56`, `foo.ts:42:13`
 * — the column is accepted and ignored). The suffix is matched at the LAST
 * `:\d+`, so absolute Windows drive letters (`C:\proj\foo.ts:42`) survive
 * intact. Returns null when the value carries no line suffix or its path
 * part fails the plausibility check.
 */
export function parsePathLine(value: string): LineJump | null {
  // Unanchored: the regex engine finds the last `:digits` run, so a drive
  // letter colon (`C:`) or a line:col form can never capture the path.
  const m = /:(\d+)(?:-(\d+))?(?::\d+)?$/.exec(value)
  if (m === null) return null
  const path = value.slice(0, m.index)
  if (!isPlausiblePath(path)) return null
  const start = Number(m[1])
  const end = m[2] === undefined ? start : Math.max(start, Number(m[2]))
  if (!Number.isFinite(start) || start < 1) return null
  return { path, start, end }
}

/** Whether a bare (line-less) inline-code value is a clickable file path:
 *  it must contain a path separator (so `obj.method` never matches) and be
 *  free of URL schemes / whitespace. Relative and absolute, both
 *  separators, are accepted. */
export function looksLikePath(value: string): boolean {
  if (value === '') return false
  if (/\s/.test(value)) return false
  if (value.includes('://')) return false
  if (/^\d+$/.test(value)) return false
  return value.includes('/') || value.includes('\\')
}

/** Serialize a parsed line jump back to the path form the chat funnel
 *  carries (`foo.ts:42`, `foo.ts:42-56`). `parsePathLine` is its inverse. */
export function linePathWithSuffix(line: LineJump): string {
  return line.end > line.start
    ? `${line.path}:${line.start}-${line.end}`
    : `${line.path}:${line.start}`
}

/**
 * Validate the `tab.meta` payload the opener writes for a line jump:
 * `meta: { line: { start, end } }` with sane 1-based numbers. Anything else
 * (absent meta, a different plugin's shape, malformed numbers) yields null —
 * the editor simply opens without a jump.
 */
export function readJumpMeta(meta: unknown): LineRange | null {
  if (meta === null || typeof meta !== 'object') return null
  const line = (meta as { line?: unknown }).line
  if (line === null || typeof line !== 'object') return null
  const record = line as { start?: unknown; end?: unknown }
  if (typeof record.start !== 'number' || typeof record.end !== 'number') return null
  const start = Math.round(record.start)
  const end = Math.round(record.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return null
  return { start, end }
}
