/**
 * Cross-platform "open" helpers for the sidebar explorer:
 *
 * - {@link openInFileManager} — reveal a file in the OS file manager
 *   (selecting it) or open a directory in place ("在资源管理器中打开");
 * - {@link openWithDefaultApp} — open a file with its default application.
 *
 * Every launch is fire-and-forget: the child is detached, window-hidden and
 * unref'd, and the caller resolves as soon as the spawn succeeded — it never
 * waits for the app to quit, and a failed launch (e.g. a bare Linux box
 * without xdg-open) surfaces as a readable SidebarError.
 *
 * Platform matrix:
 * - Windows: `explorer /select,<file>` reveals, `explorer <dir>` opens a
 *   directory, and `start "" <path>` opens with the default app. explorer and
 *   start re-parse the command line themselves, so paths are quoted manually
 *   (cmd.exe semantics) and passed verbatim.
 * - macOS: `open -R <file>` reveals in Finder, `open <path>` opens in place
 *   or with the default app.
 * - Linux/others: `xdg-open` is the desktop standard. It has no portable
 *   "select this file" verb, so revealing a file opens its containing
 *   directory instead (the file is one click away).
 */
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SidebarError } from './wire.ts'

/** Windows: wrap a path in double quotes for cmd.exe (double embedded quotes). */
function quoteWin(path: string): string {
  return `"${path.replace(/"/g, '""')}"`
}

/** A readable message for a failed opener launch (ENOENT = tool missing). */
function openErrorOf(command: string, error: NodeJS.ErrnoException): string {
  if (error.code === 'ENOENT') {
    return `cannot open: "${command}" is not available on this system`
  }
  return `cannot open: ${error.message}`
}

/**
 * Launch a detached, hidden, fire-and-forget process. Resolves once the
 * child has spawned (the caller never waits for the app to quit); rejects
 * with a SidebarError when the opener cannot be launched at all.
 */
function launch(command: string, args: string[]): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      // On Windows, cmd.exe/explorer re-parse the command line themselves, so
      // our manual quoting must reach them verbatim — Node's own quoting
      // would double-escape it.
      windowsVerbatimArguments: process.platform === 'win32',
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      reject(new SidebarError('open-error', openErrorOf(command, error), 500))
    })
    child.once('spawn', () => {
      child.unref()
      resolvePromise()
    })
  })
}

/** The target must exist before an external app can open it. */
async function ensureExists(path: string): Promise<void> {
  await stat(path).catch((error: unknown) => {
    throw new SidebarError('fs-error', `cannot open "${path}": ${error instanceof Error ? error.message : String(error)}`, 400)
  })
}

/**
 * Reveal a file in the OS file manager (selecting it), or open a directory
 * in place. `isDir` selects the verb (explorer /select vs open; `open -R`
 * vs `open`; parent dir vs dir for xdg-open).
 */
export async function openInFileManager(path: string, isDir: boolean): Promise<void> {
  await ensureExists(path)
  if (process.platform === 'win32') {
    // explorer is quirky: it joins and re-parses its arguments, so the
    // canonical `explorer /select,"C:\dir\file"` form is routed through
    // cmd.exe with the path quoted (directories open in place).
    return launch('cmd.exe', ['/c', 'explorer', isDir ? quoteWin(path) : `/select,${quoteWin(path)}`])
  }
  if (process.platform === 'darwin') {
    // `open -R` reveals (selects) the file in Finder; a directory just opens.
    return launch('open', isDir ? [path] : ['-R', path])
  }
  // Linux & friends: no portable "select the file" verb — open the containing
  // directory (the file is one click away); directories open in place.
  return launch('xdg-open', [isDir ? path : dirname(path)])
}

/** Open a file (or directory) with the OS default application. */
export async function openWithDefaultApp(path: string): Promise<void> {
  await ensureExists(path)
  if (process.platform === 'win32') {
    // `start` treats the FIRST quoted argument as its window TITLE, so an
    // explicit empty "" title must come before the quoted path.
    return launch('cmd.exe', ['/c', 'start', '""', quoteWin(path)])
  }
  if (process.platform === 'darwin') {
    return launch('open', [path])
  }
  return launch('xdg-open', [path])
}
