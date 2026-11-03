/**
 * The one-shot landing RANGE that rides beside a line navigation.
 *
 * A file open carries a single 1-based line through the host's own navigation
 * parameter (`#826`), so the viewer can land the reader. The quote chip needs
 * one more fact — where the quoted span ENDS — and the host's parameter map
 * declares only `line` for a file resource. Rather than smuggle an undeclared
 * key through host-owned params (nothing validates them at run time, so it
 * would work right up until upstream tightened the shape), the end line rides
 * this module-level side channel: armed by the code opening the file, spent
 * once by the editor that lands on the line.
 *
 * The key is `${path}#${line}` — deliberately the SAME key the editor's own
 * landed-once journal uses, so re-navigation to a new line re-arms the flash
 * and a re-render of the same landing never replays it. Core bundle only (no
 * CodeMirror import): the flash itself lives in `quote-flash.ts`, which is
 * bundled with the editor chunk.
 */

/** Max armed ranges held at once; the oldest is dropped (a stale arm only
 *  loses a decoration, never the navigation). */
const MAX_ARMED = 32

const armed = new Map<string, number>()

function keyOf(path: string, line: number): string {
  return `${path}#${line}`
}

/**
 * Arm the flash end for the next landing on `path:line`.
 * @param path - the file's path (the same spelling the open carries).
 * @param line - the 1-based landing line.
 * @param lineEnd - the 1-based last line of the range; `undefined` clears a
 *   previously armed range for that landing.
 */
export function armLineEnd(path: string, line: number, lineEnd: number | undefined): void {
  const key = keyOf(path, line)
  if (lineEnd === undefined) {
    armed.delete(key)
    return
  }
  armed.delete(key)
  armed.set(key, lineEnd)
  while (armed.size > MAX_ARMED) {
    const oldest = armed.keys().next()
    if (oldest.done === true) break
    armed.delete(oldest.value)
  }
}

/**
 * Spend the armed end line for one landing (removing it, so the flash is one
 * shot per navigation).
 * @param path - the file's path.
 * @param line - the 1-based landing line the viewer is applying.
 * @returns the armed end line, or `undefined` when no range was armed.
 */
export function takeLineEnd(path: string, line: number): number | undefined {
  const key = keyOf(path, line)
  const end = armed.get(key)
  if (end === undefined) return undefined
  armed.delete(key)
  return end
}
