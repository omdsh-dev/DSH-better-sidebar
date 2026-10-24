/**
 * The `path:line` suffix a file reference can carry, split back off.
 *
 * DSH's markdown link grammar (`parseFileLink` in
 * `packages/client/ui-primitives/src/markdown/file-link.ts`) understands ONE
 * line syntax: the GitHub-style fragment `path#L131` / `path#L131-L200`. A
 * destination without a `#` is taken as the file name VERBATIM, so the other
 * convention models actually write — `path:131`, the one compiler
 * diagnostics, `grep -n` and every terminal use — reaches the tab as a file
 * called `CMakeLists.txt:131`. The editor then reads a path that does not
 * exist and the sidebar says so (#826).
 *
 * The host owns that grammar and this plugin may not patch it, so the
 * correction happens where the plugin already turns a file ADDRESS into a tab
 * record: {@link fileParamsOf} in `native/index.ts`. Everything downstream
 * (the tab title, the viewer match, the read, the save, "open with") then sees
 * a real path, so there is nothing left to retry and nothing to remember.
 *
 * The trade is explicit: a file whose NAME really ends in `:<digits>` opened
 * FROM A CHAT LINK loses its suffix. Paths that come from the file tree, the
 * search box or the sidebar's own flows never pass through this module, and
 * `:` is not even a legal filename character on Windows.
 */

/** One line reference split off a path. */
export interface LineSpec {
  /** The path with the spec removed — the file the reference points at. */
  readonly path: string
  /** 1-based first line. */
  readonly line: number
  /** 1-based last line; equal to {@link line} unless the spec was a range. */
  readonly end: number
  /** 1-based column, when the spec carried one (`path:12:5`). */
  readonly column: number | undefined
}

/**
 * A trailing line spec: `:<line>`, `:<line>-<end>` or `:<line>:<column>`.
 *
 * Line numbers are 1-based with no leading zero, exactly as the host's own
 * fragment rule (`^L([1-9]\d*)`) — so `version:0` and a bare `:0` are file
 * names, not line references. The regex is anchored at the END of the string,
 * which is what keeps `data:2024.csv` and `C:` intact.
 */
const TRAILING_LINE_SPEC = /:([1-9]\d{0,8})(?:-([1-9]\d{0,8}))?(?::([1-9]\d{0,8}))?$/u

/**
 * Split a trailing `path:line` spec off a path.
 *
 * Rejected on purpose, because stripping them would break a path that is
 * already a valid file name: a spec with nothing in front of it (`:131`), a
 * one-character remainder (`C:131`, where `C` could only be a drive letter),
 * and an inverted range (`a.c:20-12`) — the host rejects that one too.
 * @param path - a path as a caller holds it, in either separator spelling.
 * @returns the path without the spec plus the line it named, or `undefined`
 * when the path carries no trailing line spec.
 */
export function splitTrailingLineSpec(path: string): LineSpec | undefined {
  const match = TRAILING_LINE_SPEC.exec(path)
  if (match === null) return undefined
  const head = path.slice(0, match.index)
  if (head.length < 2) return undefined
  const line = Number(match[1])
  const end = match[2] === undefined ? line : Number(match[2])
  if (end < line) return undefined
  return {
    path: head,
    line,
    end,
    column: match[3] === undefined ? undefined : Number(match[3]),
  }
}
