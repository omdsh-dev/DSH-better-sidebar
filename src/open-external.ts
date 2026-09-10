/**
 * External open actions for the file tree's "open with" menu: hand a path to
 * the OS file manager (reveal/select) or launch a URL scheme's registered
 * handler (vscode://, cursor://, zed://, custom schemes).
 *
 * The client runs in a browser / DSH Desktop renderer where a raw `vscode://`
 * navigation is unreliable, so both actions fan out through this host route
 * and spawn the platform opener with an argv array (no shell interpolation).
 * WSL is special: Node reports `linux`, while the actual desktop handlers live
 * on Windows, so its commands cross the interop boundary explicitly.
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

/** Injectable WSL command seams keep the command builders pure in unit tests. */
export interface WslCommandOptions {
  wsl?: boolean
  toWindowsPath?: (path: string) => string
  windowsExecutable?: (path: string) => string
}

/** Runtime seams used only to make launch/error behavior testable off-host. */
export interface LaunchExternalOptions {
  platform?: NodeJS.Platform
  wsl?: boolean
  distroName?: string
  commandOptions?: Omit<WslCommandOptions, 'wsl'>
  spawn?: typeof spawn
}

/** True when this Linux host is backed by Windows Subsystem for Linux. */
export function isWslRuntime(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

/** Run WSL's built-in path translator by absolute path so
 * `appendWindowsPath=false` cannot make the helper disappear from PATH. */
function wslPath(mode: '-u' | '-w', value: string): string {
  const translated = execFileSync('/usr/bin/wslpath', [mode, value], { encoding: 'utf8' }).trim()
  if (translated === '') throw new Error(`wslpath returned no translation for ${value}`)
  return translated
}

/** Linux/WSL absolute path -> Windows path understood by Explorer. */
function windowsPathOf(path: string): string {
  return wslPath('-w', path)
}

/** Windows executable path -> its WSL mount path, without relying on PATH. */
function windowsExecutableOf(path: string): string {
  return wslPath('-u', path)
}

/** Reveal/select a path in the OS file manager. On plain Linux there is no
 * common select protocol — the containing directory is opened instead.
 * Under WSL the desktop file manager is Windows Explorer. */
export function revealCommand(
  path: string,
  platform: NodeJS.Platform = process.platform,
  options: WslCommandOptions = {},
): ExternalCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: ['-R', path] }
    // Explorer expects `/select,<path>` as one argument. Keep the spawn
    // shell-free: a command shell would reinterpret valid path characters.
    case 'win32':
      return { command: 'explorer.exe', args: [`/select,${path}`] }
    default: {
      if (options.wsl) {
        const toWindowsPath = options.toWindowsPath ?? windowsPathOf
        const windowsExecutable = options.windowsExecutable ?? windowsExecutableOf
        return {
          command: windowsExecutable('C:\\Windows\\explorer.exe'),
          args: [`/select,${toWindowsPath(path)}`],
        }
      }
      const parent = parentOf(path)
      return { command: 'xdg-open', args: [parent ?? path] }
    }
  }
}

/** Hand a custom-scheme URL to the OS protocol handler. WSL must dispatch to
 * Windows because the registered desktop handlers live on that side. */
export function urlCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  options: WslCommandOptions = {},
): ExternalCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] }
    // url.dll,FileProtocolHandler launches the registered protocol handler;
    // `cmd /c start "" <url>` is the fallback if rundll32 misbehaves.
    case 'win32':
      return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
    default:
      if (options.wsl) {
        const windowsExecutable = options.windowsExecutable ?? windowsExecutableOf
        return {
          command: windowsExecutable('C:\\Windows\\System32\\rundll32.exe'),
          args: ['url.dll,FileProtocolHandler', url],
        }
      }
      return { command: 'xdg-open', args: [url] }
  }
}

/** Convert the built-in VSCode-family local-file URL to its Remote-WSL form.
 * A POSIX path produces `scheme://file//...`; keep one leading slash when it
 * moves behind the `wsl+<distro>` authority. Other custom schemes are left
 * alone and merely dispatched through the Windows protocol handler. */
export function wslRemoteEditorUrl(url: string, distroName: string): string {
  const match = /^(vscode(?:-insiders)?|cursor):\/\/file(\/\/.*)$/i.exec(url)
  if (match === null) return url
  const distro = distroName.trim()
  if (distro === '') {
    throw new SidebarError('internal', 'WSL_DISTRO_NAME is unavailable; cannot build a Remote-WSL editor URL', 500)
  }
  return `${match[1]}://vscode-remote/wsl+${distro}${match[2].slice(1)}`
}

/** Validate a URL-scheme open target: a parseable custom-scheme URL (never
 * http/https — those would only dump the URL into a browser tab). */
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function launchFailure(command: string, error: unknown): SidebarError {
  return new SidebarError('internal', `failed to launch external opener "${command}": ${messageOf(error)}`, 500)
}

/**
 * Launch one external open action detached from the host. Success is reported
 * only after Node emits `spawn`; an ENOENT/permission failure now rejects the
 * route instead of being swallowed after `{ started: true }` was returned.
 */
export function launchExternal(
  action: OpenExternalAction,
  value: string,
  options: LaunchExternalOptions = {},
): Promise<{ started: true }> {
  const platform = options.platform ?? process.platform
  const wsl = options.wsl ?? (platform === 'linux' && isWslRuntime())
  const commandOptions: WslCommandOptions = { ...options.commandOptions, wsl }

  let spec: ExternalCommand
  if (action === 'reveal') {
    spec = revealCommand(requireAbsolute(value), platform, commandOptions)
  } else {
    let url = validateExternalUrl(value)
    if (wsl) url = wslRemoteEditorUrl(url, options.distroName ?? process.env.WSL_DISTRO_NAME ?? '')
    spec = urlCommand(url, platform, commandOptions)
  }

  const spawnExternal = options.spawn ?? spawn
  let child: ReturnType<typeof spawn>
  try {
    child = spawnExternal(spec.command, spec.args, { detached: true, stdio: 'ignore' })
  } catch (error) {
    return Promise.reject(launchFailure(spec.command, error))
  }

  return new Promise((resolve, reject) => {
    child.once('spawn', () => { resolve({ started: true }) })
    child.once('error', (error) => { reject(launchFailure(spec.command, error)) })
    child.unref()
  })
}
