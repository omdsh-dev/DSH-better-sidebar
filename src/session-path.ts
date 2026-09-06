import { win32 } from 'node:path'

/** `\\wsl.localhost\<distro>` root of a Windows-hosted WSL workspace. */
const WSL_LOCALHOST_ROOT = /^\\\\wsl\.localhost\\([^\\]+)(?:\\|$)/i

/**
 * Reinterpret an already-absolute path in the namespace of one session.
 *
 * Windows treats `/foo` as rooted on the current drive, so `path.resolve()`
 * turns it into e.g. `C:\\foo`. That is wrong for a session whose cwd is a
 * WSL UNC path: in that namespace `/foo` means the distro's Linux `/foo`.
 * Git Bash / MSYS adds another session namespace where `/c/x` means
 * `C:\\x`. Project only those recognizable forms; drive paths, UNC paths,
 * non-Windows hosts and other slash-rooted Windows paths keep their existing
 * semantics.
 *
 * Workspace containment is intentionally NOT handled here. A projected path
 * such as `/tmp/x` can still be rejected later for lying outside the session
 * workspace; the important part is that it is checked in the session's
 * namespace before host filesystem resolution.
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
  if (match !== null) {
    const distroRoot = `\\\\wsl.localhost\\${match[1]}`
    const relative = target.slice(1).replace(/\//g, '\\')
    return win32.resolve(distroRoot, relative)
  }

  // Git Bash / MSYS maps a leading single-letter segment to a drive root:
  // `/e/project` = `E:\\project`. Keep WSL precedence above so `/e/...` in a
  // WSL session remains a Linux path inside that distro.
  const msys = /^\/([a-zA-Z])\//.exec(target)
  const drive = msys?.[1]
  if (drive !== undefined) {
    const driveRoot = `${drive.toUpperCase()}:\\`
    const relative = target.slice(3).replace(/\//g, '\\')
    return win32.resolve(driveRoot, relative)
  }

  return target
}
