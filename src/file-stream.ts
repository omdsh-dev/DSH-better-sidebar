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
): Promise<void> {
  // `node:http` boundary cast: the host hands the routes a real ServerResponse,
  // and the declaration graph deliberately cannot name it (see
  // context-types.ts). This is the one place the cast is needed.
  const node = res as unknown as ServerResponse
  const stream = createReadStream(path)
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
  res.writeHead(200, { ...headers, 'content-length': String(size) })
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
