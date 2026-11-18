/**
 * Project-wide CONTENT search and replace behind the files panel's search box
 * (the VS Code Search view analogue). This module owns four things:
 *
 * - **The query regex** ({@link compileGrepRegExp}): a fixed-string query is
 *   escaped and matched literally, `regex` mode compiles the user's own
 *   pattern, `wholeWord` wraps either in ASCII word-boundary lookarounds (CJK
 *   text has no `\w` neighbours, so the option simply does not constrain it),
 *   and `caseSensitive` decides the `i` flag. Matching is per LINE: a match
 *   never spans a line break, exactly like VS Code's default search mode.
 *
 * - **The files-to-include filter** ({@link compileGrepInclude}) — a positive
 *   glob matcher in the VS Code lineage. A pattern with no `/` matches the
 *   BASE NAME at any depth (`*.ts`), a pattern with `/` is anchored at the
 *   search root (`src/**`), `**` spans segments with a `**`-slash head
 *   matching zero or more of them (`src/**\/*.ts` also matches `src/a.ts`),
 *   `*`/`?` stay inside one segment, and a directory pattern claims everything
 *   below it (`src` includes `src/a.ts`). Matching folds case on win32 only,
 *   the filesystem's own notion — the same rule the exclude compiler follows.
 *
 * - **The walk** ({@link grepFiles}): files come from the repository's own
 *   index when the root sits inside a git worktree (`git ls-files -z
 *   --cached --others --exclude-standard`: tracked files plus untracked ones
 *   that .gitignore does not hide), and from a plain `opendir` walk otherwise.
 *   The walk keeps the SAME noise-directory skip list as the name search
 *   (`SKIP_DIR_NAMES`), never descends a symlinked directory or reports a
 *   symlink entry (cycle safety / no duplicate outside paths), skips binary
 *   files (`decodeTextBytes` says null) and files over the size budget, and
 *   honours the explorer's own exclude patterns through one compiled probe —
 *   an excluded directory is never entered and an excluded file never read.
 *
 * - **Replace** ({@link replaceInFiles}): every file the client shows a result
 *   for is re-read, its own byte encoding and line ending are preserved
 *   (`writeWorkspaceText` re-sniffs both before the atomic write), and the
 *   search's `mtimeMs` is the optimistic-concurrency gate — a file that
 *   changed on disk since the result was rendered is SKIPPED (reported back to
 *   the client) instead of being rewritten from a stale reading. Replacement
 *   text is literal in fixed-string mode (a `$1` stays `$1`) and gets JS
 *   group-reference semantics in regex mode.
 *
 * Every loop is bounded: `maxFiles` result files, `maxMatches` result rows,
 * `maxFileBytes` per file, `maxScannedBytes` per search, and `maxVisited`
 * directory entries (walk only). Hitting any of them reports
 * `truncated: true` so the panel can say the list is partial instead of
 * freezing the host on a runaway tree.
 */
import { lstat, opendir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExcludeTest } from './exclude-patterns.ts'
import { relativeExcludeProbe } from './exclude-patterns.ts'
import { writeWorkspaceText } from './fs-operations.ts'
import { runGit } from './git.ts'
import { resolveTarget } from './path-security.ts'
import { SKIP_DIR_NAMES } from './search-engines.ts'
import { decodeTextBytes } from './text-encoding.ts'

/** One highlighted match inside a result line (UTF-16 offsets). */
export interface GrepRange {
  start: number
  end: number
}

/** One matching LINE: its 1-based number, a bounded preview and every match on it. */
export interface GrepLineHit {
  line: number
  text: string
  ranges: GrepRange[]
}

/** One file with matches. `mtimeMs` is the replace conflict gate. */
export interface GrepFileHit {
  path: string
  mtimeMs: number
  matches: GrepLineHit[]
}

/** The `fs.grep` answer: files sorted by path, each line in document order. */
export interface GrepResult {
  files: GrepFileHit[]
  /** Every matched occurrence counted, including ones on lines dropped by the
   *  preview cap? No — only the occurrences this response reports. */
  matchesTotal: number
  /** A budget cut the walk short; the list is a prefix of the real answer. */
  truncated: boolean
}

/** Search switches the client's option toggles map onto. */
export interface GrepOptions {
  /** Files-to-include glob patterns (undefined = every file). The array is
   *  validated + compiled host-side, so the wire value stays `unknown`. */
  include?: unknown
  /** The compiled exclude probe: the explorer pref plus the user's
   *  files-to-exclude list, merged by the caller (one grammar, one matcher). */
  exclude?: ExcludeTest
  caseSensitive?: boolean
  wholeWord?: boolean
  /** Treat `query` as a JS regular expression instead of a fixed string. */
  regex?: boolean
  maxFiles?: number
  maxMatches?: number
  maxFileBytes?: number
  maxScannedBytes?: number
  maxVisited?: number
  signal?: AbortSignal
}

/** The default caps (tests inject smaller ones). */
export const GREP_DEFAULT_MAX_FILES = 200
export const GREP_DEFAULT_MAX_MATCHES = 2000
export const GREP_DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024
export const GREP_DEFAULT_MAX_SCANNED_BYTES = 128 * 1024 * 1024
export const GREP_DEFAULT_MAX_VISITED = 200_000

/** Preview budget for one result line (characters after the leading indent). */
const SNIPPET_CHARS = 300
/** Characters kept before the first match when the match sits past the cap. */
const SNIPPET_CONTEXT_BEFORE = 40

/** Pattern caps mirror the exclude compiler's (an oversized list is dropped). */
const INCLUDE_LIMIT = 64
const INCLUDE_MAX_LENGTH = 256

/** A user pattern that cannot be compiled (bad regex) — the route maps this
 *  to a 400 instead of reporting a plugin fault. */
export class GrepQueryError extends Error {}

/** Escape one fixed string for `new RegExp`. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile the options into one global RegExp.
 *
 * `wholeWord` uses ASCII word lookarounds instead of `\b`: `\b` would refuse
 * a pattern that begins or ends with punctuation (`@foo`), while `\w`
 * lookarounds are exactly "no identifier character on either side".
 *
 * @throws {GrepQueryError} when a regex query does not compile.
 */
export function compileGrepRegExp(
  query: string,
  options: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean } = {},
): RegExp {
  const body = options.regex === true ? query : escapeRegExp(query)
  const source = options.wholeWord === true ? `(?<!\\w)(?:${body})(?!\\w)` : body
  const flags = `g${options.caseSensitive === true ? '' : 'i'}`
  try {
    // The global `lastIndex` is reset by every caller before a line/file.
    return new RegExp(source, flags)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    throw new GrepQueryError(`invalid regular expression: ${why}`)
  }
}

/** One compiled files-to-include pattern. */
interface IncludePattern {
  /** 'name': test the base name; 'path': test the root-relative path (and
   *  every ancestor directory prefix); 'suffix' (`**\/x`): test either. */
  kind: 'name' | 'path' | 'suffix'
  regex: RegExp
}

/** Normalize one raw include pattern; undefined when it is unusable. */
function normalizeIncludePattern(raw: unknown): { kind: IncludePattern['kind']; body: string } | undefined {
  if (typeof raw !== 'string') return undefined
  let pattern = raw.trim().replace(/\\/g, '/')
  if (pattern.length > INCLUDE_MAX_LENGTH || pattern === '') return undefined
  while (pattern.startsWith('./')) pattern = pattern.slice(2)
  while (pattern.startsWith('/')) pattern = pattern.slice(1)
  while (pattern.endsWith('/')) pattern = pattern.slice(0, -1)
  if (pattern === '') return undefined
  let kind: IncludePattern['kind'] = 'name'
  if (pattern.startsWith('**/')) {
    kind = 'suffix'
    pattern = pattern.slice(3)
  }
  if (pattern === '') return undefined
  if (kind === 'name' && pattern.includes('/')) kind = 'path'
  return { kind, body: pattern }
}

/**
 * Translate an include glob body into an anchored RegExp. Unlike the exclude
 * compiler's subset, a `**` followed by `/` consumes ZERO OR MORE whole
 * segments — that is what makes `src/**\/*.ts` match `src/a.ts` as VS Code
 * does, while `**` elsewhere still spans anything (`src/**` ends the pattern
 * with `.*`).
 */
function includeGlobToRegExp(body: string, insensitive: boolean): RegExp {
  let out = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!
    if (char === '*') {
      if (body[index + 1] === '*') {
        if (body[index + 2] === '/') {
          out += '(?:.*/)?'
          index += 2
        } else {
          out += '.*'
          index += 1
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, insensitive ? 'i' : undefined)
}

/**
 * Compile the files-to-include list into one positive probe over an entry's
 * root-relative path and base name.
 *
 * @param raw - the wire `include` field (anything; validated).
 * @param platform - case-folding semantics (`'win32'` folds, like the exclude
 *  compiler).
 * @returns the probe, or undefined when nothing valid was declared (the
 *  no-include fast path that admits every file).
 */
export function compileGrepInclude(
  raw: unknown,
  platform: NodeJS.Platform | 'posix' = process.platform,
): ((relativePath: string, name: string) => boolean) | undefined {
  if (!Array.isArray(raw)) return undefined
  const compiled: IncludePattern[] = []
  for (const item of raw) {
    if (compiled.length >= INCLUDE_LIMIT) break
    const normalized = normalizeIncludePattern(item)
    if (normalized === undefined) continue
    compiled.push({ kind: normalized.kind, regex: includeGlobToRegExp(normalized.body, platform === 'win32') })
  }
  if (compiled.length === 0) return undefined

  const suffixHit = (segments: readonly string[], pattern: RegExp): boolean => {
    // The base name itself, then every trailing segment run (the exclude
    // compiler's suffix semantics), plus the same runs of every ancestor
    // prefix so `**/src` selects what lives under a `src` directory too.
    const last = segments[segments.length - 1]
    if (last !== undefined && pattern.test(last)) return true
    for (let start = 0; start < segments.length - 1; start += 1) {
      if (pattern.test(segments.slice(start).join('/'))) return true
    }
    for (let end = 1; end < segments.length; end += 1) {
      const prefix = segments.slice(0, end)
      for (let start = 0; start < prefix.length; start += 1) {
        if (pattern.test(prefix.slice(start).join('/'))) return true
      }
    }
    return false
  }

  return (relativePath, name) => {
    const segments = relativePath.split('/')
    for (const pattern of compiled) {
      if (pattern.kind === 'name') {
        if (pattern.regex.test(name)) return true
        // A no-slash pattern that names a DIRECTORY ("src") claims everything
        // below it, exactly what the reader means by typing it into "files to
        // include" — and the same shape the exclude grammar has (an excluded
        // name removes its whole subtree).
        for (let end = 0; end < segments.length - 1; end += 1) {
          if (pattern.regex.test(segments[end]!)) return true
        }
        continue
      }
      if (pattern.kind === 'path') {
        if (pattern.regex.test(relativePath)) return true
        // A directory pattern ("src", "build/*") selects everything below it.
        for (let end = 1; end < segments.length; end += 1) {
          if (pattern.regex.test(segments.slice(0, end).join('/'))) return true
        }
        continue
      }
      if (suffixHit(segments, pattern.regex)) return true
    }
    return false
  }
}

/** Every non-empty match of `regex` in one line, in order (bounded per line).
 *  The exec arrays are kept so a single-match replace can expand `$1`. */
function matchExecs(line: string, regex: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = []
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(line)) !== null) {
    if (match[0] === '') {
      // A zero-width match has nothing to highlight or replace. Advance by one
      // so the loop terminates (String.replace has the same rule).
      regex.lastIndex += 1
      if (regex.lastIndex > line.length) break
      continue
    }
    out.push(match)
    if (out.length >= 200) break
  }
  return out
}

/** Ranges of every non-empty match of `regex` in one line. */
function matchRanges(line: string, regex: RegExp): GrepRange[] {
  return matchExecs(line, regex).map(match => ({ start: match.index, end: match.index + match[0].length }))
}

/**
 * Expand a template's `$` substitutions for ONE match, with the semantics of
 * ECMAScript's `String.replace` (`$$`, `$&`, `` $` ``, `$'`, `$n`, `$<name>`).
 * A single-match replace slices the line by hand, so it cannot use the native
 * string replacement for group references; this reproduces it. Unknown tokens
 * stay literal, and an out-of-range `$nn` falls back to `$n` + the second
 * digit exactly like the native algorithm.
 */
function expandReplacement(template: string, match: RegExpExecArray, line: string): string {
  const groups = (match as RegExpExecArray & { groups?: Record<string, string | undefined> }).groups
  return template.replace(/\$([$&`']|\d{1,2}|<[^>]*>)/g, (whole: string, token: string) => {
    if (token === '$') return '$'
    if (token === '&') return match[0]
    if (token === '`') return line.slice(0, match.index)
    if (token === "'") return line.slice(match.index + match[0].length)
    if (token.startsWith('<')) {
      const name = token.slice(1, -1)
      // An unknown name is left literal, like the native substitution.
      return groups === undefined || !Object.hasOwn(groups, name) ? whole : groups[name] ?? ''
    }
    const index = Number(token)
    if (index > 0 && index < match.length) return match[index] ?? ''
    if (token.length === 2) {
      const first = Number(token[0])
      if (first > 0 && first < match.length) return `${match[first] ?? ''}${token[1]}`
    }
    return whole
  })
}

/**
 * Render one matching line into a bounded preview. The leading indentation is
 * dropped (it costs the width and says nothing), and when the first match
 * sits past the preview budget the window starts shortly BEFORE that match so
 * the row always shows what was matched. Ranges are shifted into the preview's
 * own coordinates; a leading ellipsis counts as one character.
 */
function snippetOf(line: string, ranges: readonly GrepRange[], lineNumber: number): GrepLineHit {
  const lead = line.length - line.trimStart().length
  const body = line.slice(lead)
  const shifted = ranges.map(range => ({ start: Math.max(0, range.start - lead), end: Math.max(0, range.end - lead) }))
  const first = shifted[0]
  let windowStart = 0
  if (first !== undefined && first.start > SNIPPET_CHARS - SNIPPET_CONTEXT_BEFORE) {
    windowStart = Math.max(0, first.start - SNIPPET_CONTEXT_BEFORE)
  }
  let text = body.slice(windowStart, windowStart + SNIPPET_CHARS)
  let out = shifted
    .map(range => ({ start: range.start - windowStart, end: range.end - windowStart }))
    .filter(range => range.start < text.length && range.end > 0)
    .map(range => ({ start: Math.max(0, range.start), end: Math.min(text.length, range.end) }))
  if (windowStart > 0) {
    text = `…${text}`
    out = out.map(range => ({ start: range.start + 1, end: range.end + 1 }))
  }
  return { line: lineNumber, text, ranges: out }
}

/** One `opendir` walk of the root: yields root-relative, '/'-separated files. */
async function* walkFiles(
  root: string,
  state: { visited: number; maxVisited: number; truncated: boolean },
  exclude: ((relativePath: string) => boolean) | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<{ relativePath: string; absolutePath: string }> {
  const skip = new Set(SKIP_DIR_NAMES)
  const walk = async function* (dir: string, relativeDir: string): AsyncGenerator<{ relativePath: string; absolutePath: string }> {
    const level = await opendir(dir).catch(() => undefined)
    if (level === undefined) return
    for await (const dirent of level) {
      if (signal?.aborted === true) return
      state.visited += 1
      if (state.visited > state.maxVisited) {
        state.truncated = true
        return
      }
      if (skip.has(dirent.name.toLowerCase())) continue
      const relativePath = relativeDir === '' ? dirent.name : `${relativeDir}/${dirent.name}`
      const absolutePath = join(dir, dirent.name)
      if (dirent.isSymbolicLink()) continue
      if (dirent.isDirectory()) {
        if (exclude !== undefined && exclude(relativePath)) continue
        yield* walk(absolutePath, relativePath)
        if (state.truncated) return
        continue
      }
      if (!dirent.isFile()) continue
      if (exclude !== undefined && exclude(relativePath)) continue
      yield { relativePath, absolutePath }
    }
  }
  yield* walk(root, '')
}

/**
 * The repository's own file inventory, or undefined when `root` is not a git
 * worktree (or git is unavailable / the listing exceeded the output cap).
 * `--cached --others --exclude-standard` is exactly "the files a developer
 * considers part of this workspace": tracked files, untracked files, and no
 * .gitignore'd noise. NUL framing keeps CJK / space paths verbatim.
 */
async function gitListedFiles(root: string): Promise<string[] | undefined> {
  try {
    const output = await runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 15_000)
    return output.split('\0').filter(path => path !== '')
  } catch {
    return undefined
  }
}

/** Resolve one relative git/walk path against the root (both use '/'). */
function absoluteOf(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

/** The base name of a '/'-separated relative path. */
function nameOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf('/')
  return cut === -1 ? relativePath : relativePath.slice(cut + 1)
}

/** Throw the abort error the JSON route recognises (it then writes no body). */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  const error = new Error('search aborted')
  error.name = 'AbortError'
  throw error
}

/**
 * Search `root` recursively for lines matching `query` (see the module
 * header for every switch and budget).
 *
 * @param root - absolute search root (the session cwd).
 * @param query - non-empty search text (later `regex` decides its shape).
 * @throws {GrepQueryError} for a regex query that does not compile.
 * @throws {AbortError} once `options.signal` is aborted.
 */
export async function grepFiles(root: string, query: string, options: GrepOptions = {}): Promise<GrepResult> {
  const empty: GrepResult = { files: [], matchesTotal: 0, truncated: false }
  if (query === '') return empty
  throwIfAborted(options.signal)
  const regex = compileGrepRegExp(query, options)
  const include = compileGrepInclude(options.include)
  const exclude = options.exclude === undefined ? undefined : relativeExcludeProbe(root, options.exclude)
  const maxFiles = options.maxFiles ?? GREP_DEFAULT_MAX_FILES
  const maxMatches = options.maxMatches ?? GREP_DEFAULT_MAX_MATCHES
  const maxFileBytes = options.maxFileBytes ?? GREP_DEFAULT_MAX_FILE_BYTES
  const maxScannedBytes = options.maxScannedBytes ?? GREP_DEFAULT_MAX_SCANNED_BYTES
  const maxVisited = options.maxVisited ?? GREP_DEFAULT_MAX_VISITED
  const signal = options.signal

  const files: GrepFileHit[] = []
  let matchesTotal = 0
  let scannedBytes = 0
  let truncated = false

  const state = { visited: 0, maxVisited, truncated: false }

  const candidates = async function* (): AsyncGenerator<{ relativePath: string; absolutePath: string }> {
    throwIfAborted(signal)
    const listed = await gitListedFiles(root)
    if (listed !== undefined) {
      if (listed.length > maxVisited) {
        state.truncated = true
        listed.length = maxVisited
      }
      for (const relativePath of listed) {
        throwIfAborted(signal)
        yield { relativePath, absolutePath: absoluteOf(root, relativePath) }
      }
      return
    }
    yield* walkFiles(root, state, exclude, signal)
  }

  for await (const candidate of candidates()) {
    throwIfAborted(signal)
    if (truncated || files.length >= maxFiles || matchesTotal >= maxMatches) {
      truncated = true
      break
    }
    const { relativePath, absolutePath } = candidate
    if (exclude !== undefined && exclude(relativePath)) continue
    if (include !== undefined && !include(relativePath, nameOf(relativePath))) continue
    const info = await lstat(absolutePath).catch(() => undefined)
    // Symlinks never become results: the walk already skips them and the git
    // inventory may still list one, so the regular-file test is the one rule.
    if (info === undefined || !info.isFile()) continue
    if (info.size > maxFileBytes) continue
    if (scannedBytes + info.size > maxScannedBytes) {
      truncated = true
      break
    }
    const bytes = await readFile(absolutePath).catch(() => undefined)
    if (bytes === undefined) continue
    scannedBytes += bytes.byteLength
    const decoded = decodeTextBytes(bytes)
    if (decoded === null) continue
    const matches: GrepLineHit[] = []
    const lines = decoded.content.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      throwIfAborted(signal)
      let line = lines[index]!
      if (line.endsWith('\r')) line = line.slice(0, -1)
      const ranges = matchRanges(line, regex)
      if (ranges.length === 0) continue
      matchesTotal += ranges.length
      matches.push(snippetOf(line, ranges, index + 1))
      if (matchesTotal >= maxMatches) {
        truncated = true
        break
      }
    }
    if (matches.length === 0) continue
    files.push({ path: relativePath, mtimeMs: info.mtimeMs, matches })
    if (files.length >= maxFiles) {
      truncated = true
      // Not "break": the loop head checks the flag and exits, keeping the
      // single exit point (and the flag already says the list is partial).
    }
  }

  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { files, matchesTotal, truncated: truncated || state.truncated }
}

/** One file the client asks to replace, with the mtime its result row showed.
 *  A per-file button sends just `path`; a per-MATCH button also sends the
 *  match's 1-based `line` and its 0-based `matchIndex` on that line, which
 *  narrows the write to that single occurrence. */
export interface GrepReplaceFile {
  path: string
  mtimeMs?: number
  /** Replace only the match on this 1-based line (with {@link matchIndex}). */
  line?: number
  /** The 0-based ordinal of the target match ON `line` (the order the result
   *  row's ranges carry). Ignored without `line`. */
  matchIndex?: number
}

/** The client's replace request (the same switches as its search). */
export interface GrepReplaceInput {
  cwd: string
  query: string
  replacement: string
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
  files: readonly GrepReplaceFile[]
  /** Per-file size guard, mirroring the search's (tests shrink it). */
  maxFileBytes?: number
}

/** One file the replace actually rewrote. */
export interface GrepReplaceFileResult {
  path: string
  replaced: number
}

/** One file the replace refused, and why. `changed` covers both a stale mtime
 *  and a per-match request whose occurrence no longer exists. */
export interface GrepReplaceSkip {
  path: string
  reason: 'changed' | 'missing' | 'binary' | 'too-large' | 'error'
  message?: string
}

/** The `fs.grepReplace` answer. */
export interface GrepReplaceResult {
  files: GrepReplaceFileResult[]
  replaced: number
  skipped: GrepReplaceSkip[]
}

/**
 * Replace the query in the named files. Three granularities ride the same
 * route:
 *
 * - a file entry WITHOUT `line` (and a call carrying every result file) is
 *   "replace all" — every match in that file (the Replace All button);
 * - one file entry without `line` replaces all matches in THAT file (the
 *   file group's per-file button);
 * - one file entry WITH `line` + `matchIndex` replaces exactly that occurrence
 *   (the per-match button). The span is re-derived from disk; if the file's
 *   matches moved (or the file changed), the entry is SKIPPED rather than
 *   guessed at.
 *
 * The write goes through `writeWorkspaceText`, so the file's own byte encoding
 * and line endings survive and the bytes land atomically. The search's
 * `mtimeMs` gate refuses a file that changed since the result was rendered
 * (`skipped.reason = 'changed'`) — the user re-runs the search and replaces
 * the fresh snapshot rather than silently rewriting unseen content.
 *
 * @throws {GrepQueryError} for a regex query that does not compile.
 */
export async function replaceInFiles(input: GrepReplaceInput): Promise<GrepReplaceResult> {
  const regex = compileGrepRegExp(input.query, input)
  // A pattern that matches the empty string would make `String.replace` insert
  // the replacement at every position of every file (and the count would not
  // describe what actually landed). Refuse it: this is an input mistake, not a
  // replacement anybody can review.
  regex.lastIndex = 0
  const emptyMatch = regex.test('')
  regex.lastIndex = 0
  if (emptyMatch) {
    throw new GrepQueryError('regular expression matches an empty string and cannot replace')
  }
  const maxFileBytes = input.maxFileBytes ?? GREP_DEFAULT_MAX_FILE_BYTES
  const files: GrepReplaceFileResult[] = []
  const skipped: GrepReplaceSkip[] = []
  let replaced = 0

  for (const file of input.files) {
    let absolute: string
    try {
      absolute = resolveTarget(input.cwd, file.path)
    } catch {
      skipped.push({ path: file.path, reason: 'missing' })
      continue
    }
    const info = await lstat(absolute).catch(() => undefined)
    if (info === undefined || !info.isFile()) {
      skipped.push({ path: file.path, reason: 'missing' })
      continue
    }
    if (file.mtimeMs !== undefined && info.mtimeMs !== file.mtimeMs) {
      skipped.push({ path: file.path, reason: 'changed' })
      continue
    }
    if (info.size > maxFileBytes) {
      skipped.push({ path: file.path, reason: 'too-large' })
      continue
    }
    const bytes = await readFile(absolute).catch(() => undefined)
    if (bytes === undefined) {
      skipped.push({ path: file.path, reason: 'missing' })
      continue
    }
    const decoded = decodeTextBytes(bytes)
    if (decoded === null) {
      skipped.push({ path: file.path, reason: 'binary' })
      continue
    }
    // The editor transports LF; matching the file's own CRLF bytes would put
    // `\r` inside every line's match context and a `$`-anchored regex would
    // never fire. Normalize, replace, and let the writer restore the EOL.
    const lf = decoded.content.replaceAll('\r\n', '\n')
    let count = 0
    let next: string
    if (file.line !== undefined) {
      // A per-MATCH replace: only the chosen occurrence changes. The match is
      // addressed by (line, ordinal) — exactly what the result row's ranges
      // carry — and re-derived here, so a file whose changes moved the matches
      // is refused below instead of replacing the wrong span.
      const lines = lf.split('\n')
      const at = file.line - 1
      const targetLine = lines[at]
      const hit = targetLine === undefined ? undefined : matchExecs(targetLine, regex)[file.matchIndex ?? 0]
      if (targetLine === undefined || hit === undefined) {
        // The row no longer matches disk (the file changed, or a previous
        // replace shifted the ordinals): skip rather than guess a span.
        skipped.push({ path: file.path, reason: 'changed' })
        continue
      }
      const inserted = input.regex === true ? expandReplacement(input.replacement, hit, targetLine) : input.replacement
      lines[at] = `${targetLine.slice(0, hit.index)}${inserted}${targetLine.slice(hit.index + hit[0].length)}`
      next = lines.join('\n')
      count = 1
    } else {
      regex.lastIndex = 0
      while (regex.exec(lf) !== null) {
        count += 1
        if (regex.lastIndex === 0) regex.lastIndex += 1
      }
      if (count === 0) continue
      regex.lastIndex = 0
      next = input.regex === true ? lf.replace(regex, input.replacement) : lf.replace(regex, () => input.replacement)
    }
    try {
      await writeWorkspaceText({ cwd: input.cwd, path: absolute, content: next, expectedMtimeMs: file.mtimeMs })
    } catch (error) {
      skipped.push({
        path: file.path,
        // A failed mtime gate is a changed file; every other refusal
        // (unrepresentable characters, disk failure) is its own report.
        reason: (error as { code?: string }).code === 'fs-conflict' ? 'changed' : 'error',
        message: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    files.push({ path: file.path, replaced: count })
    replaced += count
  }
  return { files, replaced, skipped }
}