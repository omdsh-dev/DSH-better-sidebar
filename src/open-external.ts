/**
 * External open actions for the file tree's "open with" menu: hand a path to
 * the OS file manager (reveal/select) or launch a URL scheme's registered
 * handler (vscode://, cursor://, zed://, custom schemes).
 *
 * The client runs in a browser / DSH Desktop renderer where a raw `vscode://`
 * navigation is unreliable, so both actions fan out through this host route
 * and spawn the platform opener with an argv array (no shell interpolation).
 * The command builders are pure — the platform is injectable — so every
 * per-platform branch is unit-testable without spawning anything.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parentOf, requireAbsolute } from './fs-tree.ts'
import { SidebarError } from './wire.ts'

/** The two external open actions the route accepts. */
export type OpenExternalAction = 'reveal' | 'url'

/** One platform opener invocation (argv array — never a shell string). */
export interface ExternalCommand {
  command: string
  args: string[]
}

/** True when the host runs inside WSL: a Linux kernel with Windows interop.
 *  "Reveal in the OS file manager" must then go to the Windows side — there
 *  is no Linux desktop file manager here (and usually no xdg-open). */
export function isWslRuntime(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

/** Translate a WSL absolute path to the Windows form Explorer understands:
 *  `\\wsl.localhost\<distro>\…` for the Linux filesystem, `C:\…` for /mnt/c. */
function windowsPathOf(path: string): string {
  const out = execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim()
  if (out === '') throw new Error(`wslpath returned no Windows path for ${path}`)
  return out
}

/** A Linux-path → Windows-path translator (injectable so the builder below
 *  stays pure — the real translator shells out to `wslpath`). */
export type WindowsPathTranslator = (path: string) => string

/** Reveal/select a path in the OS file manager. On plain Linux there is no
 *  common select protocol — the containing directory is opened instead
 *  (KISS). Under WSL the opener is the Windows Explorer, fed a translated
 *  path so the entry is selected exactly like the win32 branch. `wsl` and
 *  `toWindows` default to non-WSL so the builder stays pure; the launch
 *  route injects `isWslRuntime()` and the real translator. */
export function revealCommand(
  path: string,
  platform: NodeJS.Platform = process.platform,
  wsl: boolean = false,
  toWindows: WindowsPathTranslator = windowsPathOf,
): ExternalCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: ['-R', path] }
    // Explorer expects `/select,<path>` as one argument. Keep the spawn
    // shell-free: a command shell would reinterpret valid path characters.
    case 'win32':
      return { command: 'explorer.exe', args: [`/select,${path}`] }
    default: {
      if (wsl) {
        return { command: 'explorer.exe', args: [`/select,${toWindows(path)}`] }
      }
      const parent = parentOf(path)
      return { command: 'xdg-open', args: [parent ?? path] }
    }
  }
}

/** Hand a custom-scheme URL to the OS protocol handler. */
export function urlCommand(url: string, platform: NodeJS.Platform = process.platform): ExternalCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] }
    // url.dll,FileProtocolHandler launches the registered protocol handler;
    // `cmd /c start "" <url>` is the fallback if rundll32 misbehaves.
    case 'win32':
      return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
    default:
      return { command: 'xdg-open', args: [url] }
  }
}

/** Validate a URL-scheme open target: a parseable custom-scheme URL (never
 *  http/https — those would only dump the URL into a browser tab). */
export function validateExternalUrl(raw: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new SidebarError('bad-request', 'url must be a custom-scheme URL')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SidebarError('bad-request', 'invalid url')
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    throw new SidebarError('bad-request', 'only custom-scheme urls can be opened externally')
  }
  return raw
}

/**
 * Launch one external open action and return immediately (detached, no
 * stdio). Spawn failures are reported through the child's 'error' event —
 * by then the route already returned, so the event is swallowed (the OS
 * dialog about a missing handler is the user-visible outcome either way).
 */
export function launchExternal(action: OpenExternalAction, value: string): { started: true } {
  const platform = process.platform
  const wsl = platform === 'linux' && isWslRuntime()
  const spec = action === 'reveal'
    ? revealCommand(requireAbsolute(value), platform, wsl)
    : urlCommand(validateExternalUrl(value), platform)
  // WSL: the .exe opener runs through Windows interop — keep the Windows
  // system dirs on PATH even when the host was started with a slim PATH.
  const env = wsl && spec.command.endsWith('.exe')
    ? { ...process.env, PATH: `${process.env.PATH ?? ''}:/mnt/c/WINDOWS:/mnt/c/WINDOWS/System32` }
    : process.env
  const child = spawn(spec.command, spec.args, { env, detached: true, stdio: 'ignore' })
  child.on('error', () => { /* opener missing/denied: handled by the OS */ })
  child.unref()
  return { started: true }
}
