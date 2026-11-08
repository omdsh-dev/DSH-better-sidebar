/**
 * The one size constant both halves need, kept dependency-free on purpose.
 *
 * This replaces the retired `readLimit` deployment knob (`config.ts`). The old
 * cap answered "how many bytes may the host hand the client" by truncating the
 * document — which produced an editor that could neither be trusted nor saved
 * (issue #732: saving a partial document destroys the tail). Transfer size is
 * no longer a thing this plugin limits at all: upload, download, the HTML
 * preview route and the archive route all stream, so a 10 GB file is simply a
 * 10 GB file.
 *
 * What is still bounded is what an EDITOR can hold. CodeMirror keeps the whole
 * document in the browser, so a file above this size gets a read-only paged
 * preview (see `paged-text.tsx` / `jsonl-preview.tsx`) instead of an edit
 * buffer. VS Code draws the same line at a different number — its
 * `getLargeFileConfirmationLimit()` is 50 MB on the web build — and the shape
 * of the answer (threshold → degraded read-only view) is deliberately the same.
 *
 * Imported by BOTH halves, so this module must stay free of node builtins and
 * of anything that reaches them.
 */

/**
 * Text files at or below this size load whole and are editable; anything above
 * gets the read-only paged preview.
 */
export const MAX_EDITABLE_BYTES = 5 * 1024 * 1024

/**
 * Bytes one `fs.readPage` request returns. Pages are trimmed back to the last
 * newline so a page is normally a whole number of lines (and therefore, for
 * JSONL, a whole number of records); a single line longer than this is
 * returned untrimmed and stitched back together by the client.
 *
 * Sized so that even a file of very short lines lands in the low thousands of
 * rendered rows per page — the preview renders a page's rows as plain elements,
 * and the page size is the only thing bounding that.
 */
export const PAGE_BYTES = 128 * 1024

/**
 * Hard ceiling on one editor save request body.
 *
 * This is a SERVER-SIDE SANITY GUARD, not a product limit: the editor cannot
 * produce more than {@link MAX_EDITABLE_BYTES} of text, so the UI can never
 * reach it. It exists because the save route receives a raw body and the
 * encoding transform (`restoreEol` + `encodeText`) needs the whole document as
 * a string.
 */
export const WRITE_BODY_GUARD_BYTES = 8 * 1024 * 1024

/**
 * Format a byte count for the "this file is too large to edit" notice. Kept
 * here beside the constant so the host and the client round identically.
 *
 * @param bytes - the file's size.
 * @returns e.g. `12.4 MB`, `512 KB`, `900 B`.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * The human-facing form of {@link MAX_EDITABLE_BYTES}, for copy that names the
 * editing threshold.
 */
export const MAX_EDITABLE_LABEL = '5 MB'
