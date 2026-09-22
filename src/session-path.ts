import { readFileSync, statSync } from 'node:fs'
import { win32 } from 'node:path'

/** `\\wsl.localhost\<distro>` root of a Windows-hosted WSL workspace. */
const WSL_LOCALHOST_ROOT = /^\\\\wsl\.localhost\\([^\\]+)(?:\\|$)/i

/**
 * `<...>\.dsh\remote-workspaces\<host-key>\<workspace>` mirror root of a
 * dsh-remote session. The captured group is the mirror root itself: the
 * local directory that mirrors one remote workspace.
 */
const REMOTE_MIRROR_ROOT = /^(.*\\\.dsh\\remote-workspaces\\[^\\]+\\[^\\]+)(?:\\|$)/i

/** Metadata file dsh-remote writes at the root of every mirror directory. */
const REMOTE_META_FILE = '.dsh-remote-meta.json'

/** One cached mirror metadata read, invalidated by the file's mtime. */
interface RemoteMetaEntry {
  mtimeMs: number
  /** The remote workspace path (POSIX), or undefined when unusable. */
  remotePath: string | undefined
}

/**
 * Mirror metadata cache. `resolveSessionPath` is synchronous and sits on
 * every filesystem request, so the metadata is read synchronously and
 * memoized per mirror root; an mtime change re-reads it.
 */
const remoteMetaCache = new Map<string, RemoteMetaEntry>()

/**
 * The remote workspace path a mirror root stands for, or undefined when the
 * directory carries no usable metadata. Failures are swallowed on purpose:
 * an unreadable or malformed meta file must leave the caller's path alone
 * rather than break the request.
 */
function remotePathOf(mirrorRoot: string): string | undefined {
  const metaFile = win32.join(mirrorRoot, REMOTE_META_FILE)
  let mtimeMs: number
  try {
    mtimeMs = statSync(metaFile).mtimeMs
  } catch {
    remoteMetaCache.delete(mirrorRoot)
    return undefined
  }
  const cached = remoteMetaCache.get(mirrorRoot)
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.remotePath

  let remotePath: string | undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(metaFile, 'utf8'))
    const value = (parsed as { remotePath?: unknown } | null)?.remotePath
    // Only POSIX-rooted remote paths can be projected; a Windows remote
    // (drive path) needs no reinterpretation and is left to the caller.
    remotePath = typeof value === 'string' && value.startsWith('/') ? value : undefined
  } catch {
    remotePath = undefined
  }
  remoteMetaCache.set(mirrorRoot, { mtimeMs, remotePath })
  return remotePath
}

/**
 * The POSIX path segments of `target` relative to `base`, or undefined when
 * `target` does not lie under `base`. Both are remote (POSIX) paths, so the
 * comparison is case-SENSITIVE and separator handling is plain '/'.
 */
function relativeUnderPosix(base: string, target: string): string | undefined {
  const normalize = (value: string): string => value.replace(/\/+$/, '')
  const root = normalize(base)
  if (target === root) return ''
  if (!target.startsWith(`${root}/`)) return undefined
  return target.slice(root.length + 1)
}

/**
 * Reinterpret an already-absolute path in the namespace of one session.
 *
 * Windows treats `/foo` as rooted on the current drive, so `path.resolve()`
 * turns it into e.g. `C:\\foo`. That is wrong for a session whose cwd is a
 * WSL UNC path: in that namespace `/foo` means the distro's Linux `/foo`.
 * It is equally wrong for a dsh-remote mirror session, whose cwd is a local
 * directory (`...\\.dsh\\remote-workspaces\\<host>\\<workspace>`) standing in
 * for a remote POSIX workspace: there `/srv/app/src/a.ts` means the mirrored
 * file, not `C:\\srv\\app\\src\\a.ts` (which does not exist — the symptom is
 * `ENOENT ... realpath 'C:\\Users\\...'`).
 *
 * Project only those unambiguous combinations onto the matching root; drive
 * paths, UNC paths, ordinary Windows sessions and non-Windows hosts keep
 * their existing semantics.
 *
 * Workspace containment is intentionally NOT handled here. A projected path
 * such as `/tmp/x` can still be rejected later for lying outside the session
 * workspace; the important part is that it is checked as WSL `/tmp/x`, not
 * silently redirected to `C:\\tmp\\x`. For a mirror session a remote path
 * OUTSIDE the mirrored workspace (e.g. `/etc/hosts`) is deliberately left
 * unprojected, so it keeps failing the containment check instead of being
 * mapped to an unrelated local file.
 */
export function resolveSessionPath(
  cwd: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32' || !/^\/(?!\/)/.test(target)) return target

  // Session cwd can be spelled with either separator style. Normalize only
  // for detection; the returned host path is always canonical win32.
  const normalizedCwd = cwd.replace(/\//g, '\\')

  const wsl = WSL_LOCALHOST_ROOT.exec(normalizedCwd)
  if (wsl !== null) {
    const distroRoot = `\\\\wsl.localhost\\${wsl[1]}`
    const relative = target.slice(1).replace(/\//g, '\\')
    return win32.resolve(distroRoot, relative)
  }

  // A dsh-remote mirror: map the remote workspace path onto the local mirror
  // root. Only paths inside the mirrored workspace are projected.
  const mirror = REMOTE_MIRROR_ROOT.exec(normalizedCwd)
  if (mirror !== null) {
    const mirrorRoot = mirror[1]!
    const remotePath = remotePathOf(mirrorRoot)
    if (remotePath !== undefined) {
      const relative = relativeUnderPosix(remotePath, target)
      if (relative !== undefined) {
        return relative === '' ? win32.resolve(mirrorRoot) : win32.resolve(mirrorRoot, relative.replace(/\//g, '\\'))
      }
    }
  }

  return target
}
