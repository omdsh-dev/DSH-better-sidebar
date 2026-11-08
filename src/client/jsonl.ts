/**
 * JSONL (newline-delimited JSON) parsing for the preview.
 *
 * The editor's CodeMirror surface keeps using `@codemirror/lang-json` for
 * `.json`; JSONL gets its own per-line language (see `lang-jsonl.ts`) because
 * the stock JSON grammar treats a second top-level value as an error. For the
 * PREVIEW the grammar is irrelevant: one line IS one record, so the preview
 * parses each line on its own and never has to reason about the document as a
 * single JSON value.
 *
 * Kept dependency-free and pure so the record handling is unit-testable
 * without a DOM.
 */
import { extOf } from './paths.ts'

/** Whether a path is newline-delimited JSON (one record per line). */
export function isJsonlPath(path: string): boolean {
  const ext = extOf(path)
  return ext === 'jsonl' || ext === 'ndjson'
}

/** One parsed line. */
export type JsonlRecord =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

/** A record that is an object or array can render as a `JsonTree`. */
export function isTreeRecord(value: unknown): value is object | unknown[] {
  return typeof value === 'object' && value !== null
}

/**
 * Parse one JSONL line.
 *
 * A blank line is NOT a record — JSONL writers commonly end the file with one
 * newline, and the host's pages are line-aligned, so a trailing blank must not
 * render as a broken record. It is reported as `{ok: false}` with an empty
 * error so the caller can skip it instead.
 *
 * @param line - one line of the file, without its newline.
 * @returns the parsed value, or the failure reason.
 */
export function parseRecord(line: string): JsonlRecord {
  const trimmed = line.trim()
  if (trimmed === '') return { ok: false, error: '' }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** How many characters of a collapsed record's summary are kept. */
const SUMMARY_MAX = 200

/**
 * One-line summary of a record for its collapsed row.
 *
 * Objects and arrays become `{a: 1, b: "x", rest: …}` rather than raw JSON:
 * a collapsed row has to be scannable, and a raw `JSON.stringify` of a session
 * event is a wall of punctuation. Nesting beyond the first level is elided —
 * the expanded `JsonTree` is where detail lives.
 *
 * @param value - the parsed record.
 * @returns a single-line summary, never longer than {@link SUMMARY_MAX}.
 */
export function summarizeRecord(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.length} items]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    const rendered = entries.map(([key, item]) => `${key}: ${preview(item)}`)
    const shown: string[] = []
    for (const part of rendered) {
      const candidate = shown.length === 0 ? part : `${shown.join(', ')}, ${part}`
      // Room for the closing brace and, when properties were dropped, '…'.
      if (candidate.length + 4 > SUMMARY_MAX) break
      shown.push(part)
    }
    if (shown.length === 0) {
      // Even the FIRST property does not fit (one enormous string value): clamp
      // it rather than returning a summary that names nothing at all.
      return `{${rendered[0]!.slice(0, SUMMARY_MAX - 6)}…}`
    }
    return `{${shown.join(', ')}${shown.length < rendered.length ? ', …' : ''}}`
  }
  // A scalar has no structure to elide, so the JSON literal is already the
  // best summary — clamped when the string itself is enormous.
  const literal = JSON.stringify(value) ?? String(value)
  return literal.length <= SUMMARY_MAX ? literal : `${literal.slice(0, SUMMARY_MAX - 1)}…`
}

/** The first-level preview of one property value. */
function preview(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[…${value.length}]`
  if (typeof value === 'object') return '{…}'
  return JSON.stringify(value) ?? String(value)
}
