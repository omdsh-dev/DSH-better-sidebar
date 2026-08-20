/**
 * OS-level "show in folder" / "open with default app" for the explorer
 * context menu. Everything spawns the platform's own opener detached (no
 * shell string interpolation — arguments pass as an array, so paths with
 * spaces or shell metacharacters cannot break out):
 *
 * - darwin: reveal → `open -R <path>` (Finder selects the row);
 *   open → `open <path>` (HTML lands in the default browser).
 * - win32: reveal → `explorer /select,<path>`; open → `cmd /c start ""`.
 *   explorer's exit code is meaningless (it reports 1 on success), so the
 *   spawn result is not consulted on Windows.
 * - linux: reveal has no portable "select the row" — the containing
 *   folder opens instead (`xdg-open <dir>`); open → `xdg-open <path>`.
 *
 * The route is conversation-scoped like every /sidebar route (loopback /
 * trusted-host fenced), and the target must be an absolute path that
 * actually exists — the same bar fs.write meets.
 */
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export type RevealMode = 'reveal' | 'open'

/** One spawn plan: the binary plus its full argument vector. */
function plan(mode: RevealMode, path: string, platform: NodeJS.Platform): { bin: string; args: string[] } {
  if (platform === 'darwin') {
    return mode === 'reveal'
      ? { bin: 'open', args: ['-R', path] }
      : { bin: 'open', args: [path] }
  }
  if (platform === 'win32') {
    return mode === 'reveal'
      ? { bin: 'explorer', args: [`/select,${path}`] }
      : { bin: 'cmd', args: ['/c', 'start', '""', path] }
  }
  return mode === 'reveal'
    ? { bin: 'xdg-open', args: [dirname(path)] }
    : { bin: 'xdg-open', args: [path] }
}

/**
 * Verify the target exists, then fire the platform opener detached. The
 * promise resolves once the spawn call itself succeeded (the opener keeps
 * running on its own); a spawn failure (missing binary) rejects.
 */
export async function revealPath(path: string, mode: RevealMode): Promise<{ ok: true }> {
  await stat(path) // throws ENOENT for missing targets → 400 at the route
  const { bin, args } = plan(mode, path, process.platform)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('spawn', () => { resolve() })
    child.unref()
  })
  return { ok: true }
}
