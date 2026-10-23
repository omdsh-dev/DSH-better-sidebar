/**
 * One-shot file streaming for the plugin's raw byte routes.
 *
 * Every read-only byte route used to `readFile()` and hand the whole buffer to
 * `res.end()`, which put a hard ceiling on the response and made the host's
 * memory grow with the file. Streaming removes both: the bytes go from disk to
 * socket through a bounded pipe, so a 10 GB image downloads through the same
 * constant-memory path as a 10 KiB one.
 *
 * The one genuinely tricky part is WHERE the header is written. `writeHead`
 * commits the response: an error after it can no longer become the plugin's
 * JSON error envelope, and the client would see a `200` with a truncated body.
 * So the stream is opened and awaited FIRST — `open` rejects for ENOENT /
 * EACCES / EISDIR before a single header goes out — and only then does the
 * status line commit. Failures after that point (the file changed under us,
 * the client aborted) destroy the socket, which is the only honest signal left.
 */
import { createReadStream } from 'node:fs'
import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { SidebarHttpResponse } from './context-types.ts'
import { SidebarError } from './wire.ts'

/** One satisfiable byte window, inclusive on both ends (`start <= end < size`). */
export interface ByteRange {
  start: number
  end: number
}

/**
 * Parse one `Range` request header against the file's size.
 *
 * Only the SINGLE-range form is honoured. A multi-range request
 * (`bytes=0-1,4-5`) is not a byte stream any more — it would need a multipart
 * body — so it is answered with the whole file (200), which is exactly what a
 * media element falls back to.
 *
 * @returns the window to send (206), `'unsatisfiable'` when the header asked
 *  for a window past EOF (the caller answers 416 with `content-range: bytes
 *  *\/size`), or `undefined` when there is nothing to honour (no header, a
 *  malformed one, or a unit other than bytes) — the caller then sends 200.
 */
export function byteRangeOf(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | undefined {
  if (header === undefined) return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null) return undefined
  const [, rawStart = '', rawEnd = ''] = match
  // `bytes=-` names no range at all; anything else that found no digits is a
  // spelling we refuse to guess about.
  if (rawStart === '' && rawEnd === '') return undefined
  if (size === 0) return 'unsatisfiable'
  // A suffix range (`bytes=-500`) counts back from EOF; a missing end is EOF.
  const suffix = rawStart === ''
  const start = suffix ? Math.max(0, size - Number(rawEnd)) : Number(rawStart)
  const end = suffix || rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined
  if (start >= size) return 'unsatisfiable'
  if (start > end) return undefined
  return { start, end }
}

/**
 * Stream one file into the response with the given headers.
 *
 * The caller keeps ownership of every header except `content-length`, which is
 * derived from `size` here: browsers need it for a download's progress bar,
 * and the routes always have a fresh `stat` at hand.
 *
 * @param path - absolute path of the file to send (already fenced by the caller).
 * @param size - the file's size in bytes, from the same `stat` the caller ran.
 * @param res - the response face.
 * @param headers - status/type/disposition headers, written verbatim.
 * @param range - a window from {@link byteRangeOf}: the response becomes a 206
 *  with `content-range` and `content-length` restated for that window, which is
 *  what makes a `<video>` seek instead of buffering to EOF.
 * @throws {SidebarError} fs-error when the file cannot be opened — thrown
 *  BEFORE the header commits, so the caller's `writeError` still produces a
 *  proper envelope. After that this function never throws: the response is
 *  already committed and the connection is destroyed instead.
 */
export async function streamFileToResponse(
  path: string,
  size: number,
  res: SidebarHttpResponse,
  headers: Record<string, string>,
  range?: ByteRange,
): Promise<void> {
  // `node:http` boundary cast: the host hands the routes a real ServerResponse,
  // and the declaration graph deliberately cannot name it (see
  // context-types.ts). This is the one place the cast is needed.
  const node = res as unknown as ServerResponse
  const stream = range === undefined ? createReadStream(path) : createReadStream(path, { start: range.start, end: range.end })
  try {
    await once(stream, 'open')
  } catch (error: unknown) {
    stream.destroy()
    throw new SidebarError(
      'fs-error',
      `cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`,
      400,
    )
  }
  if (range === undefined) {
    res.writeHead(200, { ...headers, 'content-length': String(size) })
  } else {
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': String(range.end - range.start + 1),
    })
  }
  try {
    await pipeline(stream, node)
  } catch {
    // Either the peer went away or the source failed mid-flight. The status
    // line is already on the wire, so there is no envelope to write and no
    // recovery to attempt — tear the socket down and let the client's own
    // download UI report the truncation.
    node.destroy()
  }
}
