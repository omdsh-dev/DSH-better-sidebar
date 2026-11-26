/**
 * Whole-file and paged text reads for the host filesystem API.
 *
 * Extracted verbatim from the `/sidebar` route module so the clue local-file
 * source can reuse the EXACT same read semantics (binary sniffing, editable
 * threshold, line-aligned pages, one locked wide encoding per file) instead of
 * growing a second implementation that could drift. `src/index.ts` imports
 * these back for `fs.read` / `fs.readPage`; behaviour is unchanged.
 *
 * Host-half only: imports `node:fs`, hence never reachable from the browser
 * bundle.
 */
import { open, stat } from 'node:fs/promises'
import { SidebarError } from './wire.ts'
import { fileReadError } from './fs-read-error.ts'
import { hasOverlongLine, MAX_EDITABLE_BYTES, PAGE_BYTES, type EditLimitReason } from './editor-limits.ts'
import { decodeTextAs, decodeTextBytes, isWideEncoding, lastLineBreakEnd, type TextEncoding } from './text-encoding.ts'

/** How many leading bytes a binary read returns for client-side detect sniffing. */
export const READ_HEAD_LIMIT = 4096

/** One file read, in the shape the client's viewer dispatch consumes. */
export type SidebarReadResult =
  | { kind: 'text'; content: string; size: number; mtimeMs: number }
  | { kind: 'binary'; size: number; mtimeMs: number; head: string }
  | { kind: 'too-large'; size: number; mtimeMs: number; head: string; reason: EditLimitReason }

/**
 * Read one file for the editor host.
 *
 * Three outcomes, and the size policy is deliberately about EDITING rather
 * than about transfer:
 *
 * - at or below {@link MAX_EDITABLE_BYTES}: the whole document (or the binary
 *   verdict + a 4 KiB sniff head);
 * - above it: `too-large` (reason `size`), carrying only the 4 KiB head;
 * - at or below it, but with a line at or above `MAX_EDITABLE_LINE_CHARS` in
 *   the document head: also `too-large`, with reason `line` (#1165). CodeMirror
 *   virtualizes by line, so one line of a few hundred KB is laid out in one
 *   frame and hangs the renderer — the explicit probe is what keeps such a
 *   document out of the edit buffer even though it passes the byte limit.
 *
 * Every `too-large` carries only the 4 KiB head. The client answers it with
 * the read-only paged preview, and the head still lets a `detect`-based
 * third-party viewer claim the file — which is also what keeps the binary
 * path (images, office documents) intact for a file of any size.
 *
 * There is no truncation outcome any more. The old capped read handed the
 * editor a partial document it could neither trust nor save (issue #732);
 * "too big to edit" is now its own state instead of a quietly damaged one.
 *
 * Text encoding is detected before the NUL-based binary verdict, so UTF-16 /
 * UTF-32 / GBK text stays text.
 */
export async function readText(path: string): Promise<SidebarReadResult> {
  const info = await stat(path).catch((error: unknown) => {
    throw fileReadError(path, error)
  })
  if (info.isDirectory()) {
    // A dedicated code, not a generic fs failure: the client promotes the tab
    // to the plugin's folder window instead of rendering this as an error (a
    // chat folder link, a sidebar_open folder, a pasted directory path).
    throw new SidebarError('fs-directory', `"${path}" is a directory`, 400)
  }
  const size = info.size
  const oversized = size > MAX_EDITABLE_BYTES
  const handle = await open(path, 'r').catch((error: unknown) => {
    throw fileReadError(path, error)
  })
  try {
    // An over-limit file still yields its first bytes: that is what decides
    // text-vs-binary and what feeds the client's content sniffer.
    const window = oversized ? READ_HEAD_LIMIT : size
    const buffer = Buffer.alloc(window)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const slice = buffer.subarray(0, bytesRead)
    const decoded = decodeTextBytes(slice, oversized)
    if (decoded === null) {
      return {
        kind: 'binary',
        size,
        mtimeMs: info.mtimeMs,
        head: slice.subarray(0, Math.min(slice.length, READ_HEAD_LIMIT)).toString('base64'),
      }
    }
    if (oversized) {
      return {
        kind: 'too-large',
        size,
        mtimeMs: info.mtimeMs,
        head: slice.toString('base64'),
        reason: 'size',
      }
    }
    // The byte limit is not the only way a document is too much for the
    // editor: one line of a few hundred KB hangs CodeMirror's per-line
    // virtualization (#1165). The document is already decoded here, so the
    // probe runs on the host — the client never scans the bytes, and no
    // CodeMirror state is ever built for the file.
    if (hasOverlongLine(decoded.content)) {
      return {
        kind: 'too-large',
        size,
        mtimeMs: info.mtimeMs,
        // Sniff bytes only, never the document: the same `too-large`
        // contract as the size branch above.
        head: slice.subarray(0, Math.min(slice.length, READ_HEAD_LIMIT)).toString('base64'),
        reason: 'line',
      }
    }
    return { kind: 'text', content: decoded.content, size, mtimeMs: info.mtimeMs }
  } finally {
    await handle.close()
  }
}

/**
 * The WIDE encoding a file was found to use, per (path, size, mtime) triple.
 *
 * Only wide encodings (UTF-16/UTF-32) are memoized, and that is the whole
 * point: a page window that happens to contain no NUL bytes cannot tell wide
 * text from byte-oriented text, so a later window of a UTF-16 document must
 * not be allowed to re-decide. Byte-oriented encodings (UTF-8 / GBK / GB18030)
 * are deliberately NOT memoized — a long ASCII prefix sniffs as UTF-8 while a
 * later GBK window sniffs as GBK, and decoding each window on its own terms is
 * what recovers the right text for both. (That is safe because pages are
 * line-aligned: 0x0A can be neither a UTF-8 continuation byte nor a GBK trail
 * byte, so a window boundary never splits a character.)
 *
 * The size+mtime in the key drops the entry the moment the file changes.
 */
const wideEncodingCache = new Map<string, TextEncoding>()
/** Bound on {@link wideEncodingCache} (a paged read is a handful of entries). */
const PAGE_ENCODING_CACHE_MAX = 64

/** One page of a large text file: whole lines, plus where to continue. */
export interface ReadPageResult {
  kind: 'text'
  text: string
  offset: number
  nextOffset: number
  eof: boolean
  size: number
  mtimeMs: number
  encoding: TextEncoding
}

/**
 * Read one byte window of a text file, trimmed back to the last newline so a
 * page is a whole number of lines — and, for a JSONL file, a whole number of
 * records.
 *
 * A window with no newline at all (one line longer than {@link PAGE_BYTES}) is
 * returned untrimmed: the client stitches consecutive pages back together and
 * gives up on a single record past its own bound.
 *
 * @param path - absolute, already resolved path.
 * @param offset - byte offset to start at (`0` for the first page).
 * @throws {SidebarError} fs-error for an unreadable path or a bad offset.
 */
export async function readPage(path: string, offset: number): Promise<ReadPageResult> {
  const info = await stat(path).catch((error: unknown) => {
    throw fileReadError(path, error)
  })
  if (info.isDirectory()) {
    // A dedicated code, not a generic fs failure: the client promotes the tab
    // to the plugin's folder window instead of rendering this as an error (a
    // chat folder link, a sidebar_open folder, a pasted directory path).
    throw new SidebarError('fs-directory', `"${path}" is a directory`, 400)
  }
  const size = info.size
  if (offset >= size) {
    return {
      kind: 'text',
      text: '',
      offset,
      nextOffset: size,
      eof: true,
      size,
      mtimeMs: info.mtimeMs,
      encoding: 'utf8',
    }
  }
  const handle = await open(path, 'r').catch((error: unknown) => {
    throw fileReadError(path, error)
  })
  try {
    const length = Math.min(PAGE_BYTES, size - offset)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    let slice = buffer.subarray(0, bytesRead)
    let nextOffset = offset + bytesRead
    const cacheKey = `${path}\u0000${size}\u0000${info.mtimeMs}`
    const locked = wideEncodingCache.get(cacheKey)
    if (nextOffset < size) {
      // Trim back to a line break so a page is a whole number of lines — and,
      // for JSONL, a whole number of records. Judged in the encoding's own
      // character width, because a naive byte search for 0x0A cuts UTF-16
      // characters in half (see lastLineBreakEnd). A window with no break at
      // all is returned untrimmed and stitched by the client.
      const lastBreak = lastLineBreakEnd(slice, locked ?? 'utf8')
      if (lastBreak >= 0) {
        slice = slice.subarray(0, lastBreak)
        nextOffset = offset + lastBreak
      }
    }
    const decoded = decodeTextBytes(slice, true)
    let encoding: TextEncoding
    let text: string
    if (locked !== undefined) {
      // A wide encoding the file already proved. Only offset 0 can carry a
      // BOM, and decodeTextBytes is the one that strips it, so page 0 keeps its
      // result while every later page decodes BOM-less under the locked verdict.
      encoding = locked
      text = offset === 0 && decoded !== null ? decoded.content : decodeTextAs(slice, locked)
    } else {
      encoding = decoded?.encoding ?? 'utf8'
      text = decoded?.content ?? decodeTextAs(slice, 'utf8')
      if (decoded !== null && isWideEncoding(decoded.encoding)) {
        if (wideEncodingCache.size >= PAGE_ENCODING_CACHE_MAX) {
          const oldest = wideEncodingCache.keys().next()
          if (!oldest.done) wideEncodingCache.delete(oldest.value)
        }
        wideEncodingCache.set(cacheKey, decoded.encoding)
      }
    }
    return {
      kind: 'text',
      text,
      offset,
      nextOffset,
      eof: nextOffset >= size,
      size,
      mtimeMs: info.mtimeMs,
      encoding,
    }
  } finally {
    await handle.close()
  }
}
