/**
 * "Reveal in file manager" for the sidebar explorer — the VSCode
 * "Reveal in Finder / Reveal in File Explorer" gesture, implemented with the
 * OS's own reveal commands:
 *   - macOS (darwin): `open -R <path>` — reveals the file/dir in Finder.
 *   - Windows (win32): `explorer.exe /select,<path>` — reveals the item in
 *     File Explorer with it selected ("Reveal in File Explorer" in VSCode's
 *     Windows copy).
 *   - Linux / other POSIX: `xdg-open <dir>` — opens the containing folder.
 *     There is no portable pre-select flag across file managers, so a FILE
 *     opens its parent and a DIRECTORY opens itself.
 *
 * The launcher is spawned detached and unref'ed: `open` / `explorer.exe` /
 * `xdg-open` all hand off to the desktop session and return, so the server
 * must never block on them. `revealCommandFor` is pure (platform-injected)
 * for unit tests; `revealInFileManager` is the thin spawn wrapper the API
 * route calls.
 */
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'

/** One reveal launcher command line. */
export interface RevealCommand {
  cmd: string
  args: string[]
}

/**
 * The launcher command for one path, by platform. `isDir` matters only on
 * the xdg-open fallback (a directory opens itself, a file opens its parent);
 * `open -R` and `explorer.exe /select,` select both files and directories.
 */
export function revealCommandFor(
  path: string,
  isDir: boolean,
  platform: NodeJS.Platform = process.platform,
): RevealCommand {
  if (platform === 'darwin') return { cmd: 'open', args: ['-R', path] }
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [`/select,${path}`] }
  return isDir ? { cmd: 'xdg-open', args: [path] } : { cmd: 'xdg-open', args: [dirname(path)] }
}

/** One spawn outcome. */
export interface RevealResult {
  ok: boolean
  /** Present only when the launcher failed to spawn. */
  error?: string
}

/**
 * Launch the platform reveal command for `path` without blocking the server.
 * The child is detached + unref'ed so the API request returns immediately and
 * the launcher (which hands off to the desktop) never keeps the process open.
 */
export function revealInFileManager(
  path: string,
  isDir: boolean,
  platform: NodeJS.Platform = process.platform,
): Promise<RevealResult> {
  const { cmd, args } = revealCommandFor(path, isDir, platform)
  return new Promise<RevealResult>((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.once('error', (error) => {
      resolvePromise({ ok: false, error: error.message })
    })
    // 'spawn' fires once the process is actually launched; unref'ing then lets
    // the server exit/continue without waiting for the launcher to finish.
    child.once('spawn', () => {
      child.unref()
      resolvePromise({ ok: true })
    })
  })
}
