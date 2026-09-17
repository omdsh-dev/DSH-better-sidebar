/**
 * Task-list checkbox toggling for the markdown preview.
 *
 * The preview renders the file through MarkdownText, whose task-list
 * checkboxes are rendered `disabled`. This module maps a clicked preview
 * checkbox back to its source line in the ORIGINAL file text (the CodeMirror
 * document, frontmatter included) so the toggle can be written back to disk.
 *
 * Mapping strategy: preview renderers all consume `markdownPreviewSource(text)`
 * (leading closed YAML frontmatter hidden) and produce one `<li
 * class="task-list-item">` per task item in document order. We therefore
 * (1) scan the preview source for task-marker lines in order (skipping fenced
 * code, whose contents are never rendered as checkboxes), (2) pick the Nth
 * hit, and (3) map that line back into the full document by adding the number
 * of lines the frontmatter mask removed at the top.
 *
 * Known limitations (accepted for real-world markdown):
 * - a line that looks like a task inside a raw-HTML run or an indented code
 *   block is skipped by the renderer but counted here, so an ambiguous index
 *   would flip the wrong item; fenced code and blockquote tasks are handled.
 */

/** A task marker with the same syntax markdown list items use: a blockquote
 *  prefix (`> `…), a bullet or ordered marker, then `[ ]`/`[x]`/`[X]`. */
export interface TaskMarker {
  /** 0-based line index within the scanned text. */
  lineIndex: number
  checked: boolean
}

const TASK_MARKER_RE = /^((?:\s*>)*\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\](?:$|\s)/u
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})/u

function fenceRun(line: string): { char: string; length: number } | null {
  const match = FENCE_OPEN_RE.exec(line)
  if (match === null) return null
  const fence = match[2]!
  return { char: fence.charAt(0), length: fence.length }
}

/** Scan `text` line by line, returning every task-marker line that the
 *  MarkdownText preview would render as a checkbox (i.e. outside fenced
 *  code). Lines inside a fence — however task-like — are skipped. */
export function collectTaskMarkers(text: string): TaskMarker[] {
  const markers: TaskMarker[] = []
  const lines = text.split('\n')
  let fence: { char: string; length: number } | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (fence !== null) {
      const run = fenceRun(line)
      if (run !== null && run.char === fence.char && run.length >= fence.length) fence = null
      continue
    }
    const run = fenceRun(line)
    if (run !== null) {
      fence = run
      continue
    }
    if (TASK_MARKER_RE.test(line)) {
      markers.push({ lineIndex: index, checked: /\[[xX]\]/u.test(line) })
    }
  }
  return markers
}

export interface FlipResult {
  ok: boolean
  /** 0-based line index of the flipped line in the FULL source text. */
  fullLineIndex: number
  /** The flipped source line (no trailing line break). */
  newLine: string
}

/**
 * Flip the `previewTaskIndex`-th rendered task item in `fullText` (the full
 * document, frontmatter included) between unchecked and checked. Returns the
 * flipped line position/content on success; `{ ok: false }` when the index is
 * out of range or the marker could not be flipped (callers should then leave
 * the file untouched).
 *
 * @param previewSource the text the preview renderer consumed
 *   (`markdownPreviewSource(fullText)`); provided so callers that already
 *   computed it do not recompute, and so both share the identical source.
 */
export function flipPreviewTask(fullText: string, previewSource: string, previewTaskIndex: number): FlipResult {
  const markers = collectTaskMarkers(previewSource)
  const marker = markers[previewTaskIndex]
  if (marker === undefined) return { ok: false, fullLineIndex: -1, newLine: '' }
  // `markdownPreviewSource` only ever removes a closed leading frontmatter
  // block, so `previewSource` is a suffix of `fullText`; the removed prefix
  // contributes exactly its newline count to the source line numbers.
  const removedLines = fullText.length === previewSource.length
    ? 0
    : fullText.slice(0, fullText.length - previewSource.length).split('\n').length - 1
  const fullLineIndex = marker.lineIndex + removedLines
  const fullLines = fullText.split('\n')
  const line = fullLines[fullLineIndex]
  if (line === undefined) return { ok: false, fullLineIndex: -1, newLine: '' }
  const match = TASK_MARKER_RE.exec(line)
  if (match === null) return { ok: false, fullLineIndex: -1, newLine: '' }
  const prefix = match[1]!
  const checked = match[2] === 'x' || match[2] === 'X'
  const replacement = checked ? ' ' : 'x'
  // Replace the character inside the checkbox brackets.
  const bracketStart = match.index + prefix.length
  const newLine = line.slice(0, bracketStart + 1) + replacement + line.slice(bracketStart + 2)
  return { ok: true, fullLineIndex, newLine }
}
