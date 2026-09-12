/**
 * The DSH resource-address grammar for files (`dsh-resource://file/…`).
 *
 * DSH's right Sidebar opens content by ADDRESS, and a file's address IS the
 * tab's content identity: the same address is the same tab. Two scopes exist:
 *
 * - `dsh-resource://file/session/<sessionId>/<path>` names a file by its path
 *   relative to that session's workspace root OR by its absolute path kept
 *   absolute inside the session scope (`src/a.ts` vs `/outside/a.ts` — the
 *   leading `/` survives; the host resolves it against the root it holds for
 *   the session);
 * - `dsh-resource://file/absolute/<path>` names a file by its absolute path
 *   with the leading `/` dropped (`absolute/home/me/x.txt`; Windows
 *   `absolute/C:/x/y.txt`; a UNC path keeps an empty first segment,
 *   `absolute//server/share/x.txt`). It carries no session. `fileAddressFor`
 *   no longer produces this scope on DSH 0.1.5-alpha.2, but it must keep
 *   parsing: legacy and third-party addresses still spell it.
 *
 * Every id and path segment is component-encoded, so a name carrying `#`, `?`
 * or a space survives the round trip; `:` stays literal so a drive letter
 * reads as written.
 *
 * The plugin parses these addresses itself instead of importing
 * `@deepseek-ai/dsh-util-workspace-path`: the client bundle's purity gate
 * forbids value-importing an unlisted `@deepseek-ai/*` package. This module
 * mirrors that package's implementation — `packages/util/workspace-path/src/file-address.ts`
 * and `fileAddressFor` in `packages/util/workspace-path/src/index.ts` in
 * DSH 0.1.5-alpha.2 (github.com/deepseek-ai/deepseek-harness, tag
 * `dsh-v0.1.5-alpha.2`) — and is pinned by tests/resource-address.spec.ts.
 */

/** The scheme and type every file address opens with. */
export const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/**
 * A file resource address, in one of two scopes.
 */
export type FileAddress =
  | {
    readonly scope: 'session'
    /** The session whose workspace root resolves the path. */
    readonly sessionId: string
    /** Absolute or workspace-relative `/`-separated path; empty for the workspace root itself. */
    readonly path: string
  }
  | {
    readonly scope: 'absolute'
    /** Absolute `/`-separated path: `/a/b` on POSIX, `C:/a/b` for a drive, `//server/share/a` for UNC. */
    readonly path: string
  }

/** Component-encode one id or path segment, keeping `:` literal for drive letters. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/** Encode a `/`-separated path segment by segment. */
function encodePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/')
}

/** Whether a decoded first path segment is a Windows drive (`C:`). */
function isDriveSegment(segment: string | undefined): boolean {
  return segment !== undefined && /^[A-Za-z]:$/.test(segment)
}

/**
 * Build the address of a file read through one session.
 * @param sessionId - the session whose workspace root resolves the path.
 * @param path - absolute or workspace-relative path; backslashes are normalized
 *   to `/`, and leading `./` prefixes are dropped (a leading `/` is KEPT: an
 *   absolute path stays absolute inside the session scope).
 * @returns the `dsh-resource://file/session/<sessionId>/<path>` address.
 */
export function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`
}

/**
 * Build the address of a file by its absolute path.
 * @param path - absolute path; backslashes are normalized to `/` and the leading `/`
 *   is dropped, except that a UNC path keeps one empty first segment.
 * @returns the `dsh-resource://file/absolute/<path>` address.
 */
export function absoluteFileAddress(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const unc = normalized.startsWith('//')
  const absolute = normalized.replace(/^\/+/, '')
  return `${FILE_ADDRESS_PREFIX}absolute/${unc ? '/' : ''}${encodePath(absolute)}`
}

/**
 * Read a file address back into its parts without resolving `.` or `..`.
 * Query and fragment suffixes are ignored; encoded path segments are decoded.
 * @param address - a candidate address.
 * @returns the parts, or `undefined` when the string is not a
 *   `dsh-resource://file/` URI in a known scope with a path, or a segment is
 *   not validly encoded.
 */
export function parseFileAddress(address: string): FileAddress | undefined {
  try {
    if (!address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
    const end = address.search(/[?#]/)
    const [scope, ...rest] = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split('/')
    if (scope === 'session') {
      const [id, ...segments] = rest
      if (id === undefined || id === '' || segments.length === 0) return undefined
      return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
    }
    if (scope === 'absolute') {
      // An empty first segment with more behind it is a UNC path's `//`; alone it is no path.
      const unc = rest[0] === '' && rest.length > 1
      const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent)
      if (segments.length === 0 || segments[0] === '') return undefined
      if (unc) return { scope, path: `//${segments.join('/')}` }
      return { scope, path: isDriveSegment(segments[0]) ? segments.join('/') : `/${segments.join('/')}` }
    }
    return undefined
  } catch {
    // `decodeURIComponent` throws URIError on a malformed escape.
    return undefined
  }
}

/** Whether a path is absolute in either spelling the host accepts. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\')
}

/**
 * The address for a path as a caller holds it: ALWAYS session-scoped. A
 * relative path, or an absolute path inside the session's workspace, becomes
 * the relative spelling; an absolute path outside it, or one whose workspace
 * root is unknown, keeps its absolute path in that session's address. (Mirror
 * of `fileAddressFor` — on alpha.2 this helper no longer produces the
 * `absolute` scope, though such addresses still parse.)
 * @param sessionId - the session the path is read in.
 * @param cwd - that session's workspace root, when known.
 * @param path - absolute or workspace-relative path, either separator spelling.
 * @returns the `dsh-resource://file/…` address.
 */
export function fileAddressFor(sessionId: string, cwd: string | undefined, path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (!isAbsolutePath(normalized)) return sessionFileAddress(sessionId, normalized)
  const root = cwd === undefined ? '' : cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '')
  if (root !== '' && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1))
  return sessionFileAddress(sessionId, normalized)
}
