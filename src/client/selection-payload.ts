/**
 * Pure payload builders for the "add selection to conversation" popup in the
 * text viewers (markdown preview + the catch-all code viewer). Everything
 * here is string math — no React, no ctx — so the unit tests cover it
 * directly.
 *
 * Insert shape (agreed with the product owner):
 * - Selection ≤ SELECTION_LIMIT characters: a fenced code block whose info
 *   line is `相对路径:起止行` and whose body is the selected text.
 * - Selection over the limit: a single plain-text line `相对路径:起止行`
 *   (no fence, no content).
 * - The path is relative to the session cwd (the same projection the
 *   explorer's @ button uses); an unknown cwd falls back to the absolute
 *   path.
 * - Line numbers: single-line selections write `path:12`, multi-line write
 *   `path:12-15`. The markdown preview cannot map rendered DOM back to
 *   source lines directly, so it reverse-searches the selected text in the
 *   source and only reports lines on an unambiguous hit (see
 *   {@link linesOfSelection}).
 *
 * The two halves travel separately (see {@link PendingReference}).
 */
import { relativeTo } from './paths.ts'
import type { PendingReference } from './conversation-draft.ts'

/** Max inserted selection length (UTF-16 code units, i.e. JS `.length`). */
export const SELECTION_LIMIT = 500

/** The source line span a selection maps to (1-based, inclusive). */
export interface SelectionLines {
  start: number
  end: number
}

/**
 * The fence info line: `rel[:start[-end]]` — lines are omitted entirely
 * when unknown (the preview reverse-search missed).
 */
export function headerOf(path: string, cwd: string | undefined, lines?: SelectionLines): string {
  const rel = cwd !== undefined ? relativeTo(cwd, path) : path
  if (lines === undefined) return rel
  if (lines.end > lines.start) return `${rel}:${lines.start}-${lines.end}`
  return `${rel}:${lines.start}`
}

/**
 * The chip label's identity: `file Lstart[-end]` — the file's basename plus
 * the line span, mirroring the header's line variants (a single line keeps
 * just `Lstart`; unknown lines drop the `L` part). Deliberately NO sequence
 * number: file+lines IS the identity, so deleting a chip from the draft can
 * never leave a numbering gap — the next quote simply names itself again.
 */
export function whereOf(path: string, lines?: SelectionLines): string {
  const file = path.replace(/\\/g, '/').split('/').at(-1) ?? path
  if (lines === undefined) return file
  if (lines.end > lines.start) return `${file} L${lines.start}-${lines.end}`
  return `${file} L${lines.start}`
}

/**
 * The composer payload for one selection: the chip label and the model text.
 * Over the limit the content is dropped and both halves are the plain path
 * line (an empty fenced block would just occupy the draft).
 */
export function buildSelectionInsert(
  path: string,
  cwd: string | undefined,
  lines: SelectionLines | undefined,
  selected: string,
): PendingReference {
  const header = headerOf(path, cwd, lines)
  if (selected.length > SELECTION_LIMIT) return { label: header, text: header }
  return { label: header, text: `\`\`\`${header}\n${selected}\n\`\`\`` }
}

/** 1-based line number of a character index in a text. */
function lineAt(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++
  }
  return line
}

/**
 * Reverse-map a rendered-DOM selection back to source line numbers. The
 * preview selection is plain text (block boundaries come out as `\n`), so
 * this is a best-effort substring search: a single trailing newline is
 * stripped first (DOM block selections tend to carry one), and only an
 * EXACTLY-ONE occurrence yields lines — an ambiguous or missing match
 * returns null (the header then carries the path without line numbers).
 */
export function linesOfSelection(source: string, selected: string): SelectionLines | null {
  const text = selected.endsWith('\n') ? selected.slice(0, -1) : selected
  if (text === '') return null
  const at = source.indexOf(text)
  if (at === -1) return null
  if (source.indexOf(text, at + 1) !== -1) return null
  return {
    start: lineAt(source, at),
    end: lineAt(source, at + Math.max(text.length - 1, 0)),
  }
}

/** The localized envelope + optional plan identity a payload carries. */
export interface PlanAnnotationOptions {
  /** e.g. `计划批注` — the first line's heading. */
  heading: string
  /** e.g. `原文` — the label preceding the quoted plan text. */
  quoteLabel: string
  /** The plan's heading, appended to the envelope when present. */
  planTitle?: string
}

/** Longest plan title kept in the payload heading (code points). */
const PLAN_TITLE_HEADING_MAX = 60

/**
 * Collapse whitespace and cap one plan title. Shared by the payload heading
 * and the chip label so the same title cannot be cleaned two different ways —
 * a raw newline in a title would otherwise inject extra envelope lines.
 */
export function cleanPlanTitle(title: string | undefined, max: number): string | undefined {
  if (title === undefined) return undefined
  const clean = title.replace(/\s+/g, ' ').trim()
  if (clean === '') return undefined
  const points = Array.from(clean)
  return points.length > max ? `${points.slice(0, max).join('')}…` : clean
}

/** Drop a UTF-16 high surrogate left dangling by a code-unit slice. */
function trimLoneHighSurrogate(text: string): string {
  return text.replace(/[\uD800-\uDBFF]$/, '')
}

/** Clip an unbounded selection to a preview budget without splitting a surrogate pair. */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${trimLoneHighSurrogate(text.slice(0, max))}…`
}

/**
 * The composer payload for one plan annotation: the note plus the quoted
 * plan text as a blockquote, normally capped at {@link SELECTION_LIMIT}. The
 * note is the useful part and is never dropped: an over-limit note returns the
 * bare envelope (heading + full note) uncut, and only the quote is truncated
 * to fit the remaining budget.
 */
export function buildPlanAnnotationInsert(
  note: string,
  selected: string,
  options: PlanAnnotationOptions,
): string {
  const title = cleanPlanTitle(options.planTitle, PLAN_TITLE_HEADING_MAX)
  const heading = title === undefined ? options.heading : `${options.heading} · ${title}`
  const base = `${heading}\n${note}`
  // Over the limit the note still wins: fall back to the bare envelope with
  // the reader's words intact rather than silently chopping them mid-note.
  if (base.length >= SELECTION_LIMIT) return base
  const intro = `\n\n${options.quoteLabel}:\n`
  const budget = SELECTION_LIMIT - base.length - intro.length
  if (budget <= 2) return base
  const quoted = (text: string): string => text.split('\n').map(line => `> ${line}`).join('\n')
  let quote = selected.trim()
  // A prefix longer than the budget can never fit once every line gains its
  // `> ` prefix, so bound the candidate before widening into code points: an
  // unbounded selection is never copied whole just to be cut back.
  if (quote.length > budget) quote = trimLoneHighSurrogate(quote.slice(0, budget))
  if (quoted(quote).length > budget) {
    // Reserve one character for the ellipsis and search a prefix whose
    // blockquote form fits; binary search keeps the longest useful quote.
    // Slice by CODE POINT so an emoji's surrogate pair is never split.
    const points = Array.from(quote)
    let low = 0
    let high = points.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (quoted(`${points.slice(0, mid).join('')}…`).length <= budget) low = mid
      else high = mid - 1
    }
    quote = `${points.slice(0, low).join('')}…`
  }
  return `${base}${intro}${quoted(quote)}`
}
