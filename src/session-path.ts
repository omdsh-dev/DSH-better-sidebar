import { win32 } from 'node:path'

/** `\\wsl.localhost\<distro>` root of a Windows-hosted WSL workspace. */
const WSL_LOCALHOST_ROOT = /^\\\\wsl\.localhost\\([^\\]+)(?:\\|$)/i

/**
 * Reinterpret an already-absolute path in the namespace of one session.
 *
 * Windows treats `/foo` as rooted on the current drive, so `path.resolve()`
 * turns it into e.g. `C:\\foo`. That is wrong for a session whose cwd is a
 * WSL UNC path: in that namespace `/foo` means the distro's Linux `/foo`.
 * Project only that unambiguous combination onto the matching distro root;
 * drive paths, UNC paths, ordinary Windows sessions and non-Windows hosts
 * keep their existing semantics.
 *
 * Workspace containment is intentionally NOT handled here. A projected path
 * such as `/tmp/x` can still be rejected later for lying outside the session
 * workspace; the important part is that it is checked as WSL `/tmp/x`, not
 * silently redirected to `C:\\tmp\\x`.
 */
export function resolveSessionPath(
  cwd: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32' || !/^\/(?!\/)/.test(target)) return target

  // Session cwd can be spelled with either separator style. Normalize only
  // for detection; the returned host path is always canonical win32 UNC.
  const normalizedCwd = cwd.replace(/\//g, '\\')
  const match = WSL_LOCALHOST_ROOT.exec(normalizedCwd)
  if (match === null) return target

  const distroRoot = `\\\\wsl.localhost\\${match[1]}`
  const relative = target.slice(1).replace(/\//g, '\\')
  return win32.resolve(distroRoot, relative)
}
