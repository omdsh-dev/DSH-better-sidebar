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
import { existsSync, readFileSync } from 'node:fs'
import { posix as posixPath, win32 as winPath } from 'node:path'
import { parentOf } from './fs-tree.ts'
import { SidebarError } from './wire.ts'

/** Requests handed to the host process for external applications. */
export type OpenExternalRequest =
  | { action: 'reveal'; path: string }
  | { action: 'editor'; editor: BuiltinExternalEditor; path: string }
  | { action: 'url'; url: string }

/** Built-in editors whose Windows launch behavior is known by the host. */
export type BuiltinExternalEditor = 'vscode' | 'cursor'

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
  env?: NodeJS.ProcessEnv
  commandOptions?: Omit<WslCommandOptions, 'wsl'>
  spawn?: typeof spawn
  lookupEditorExecutable?: (editor: BuiltinExternalEditor, env: NodeJS.ProcessEnv) => string | undefined
}

/** True when this Linux host is backed by Windows Subsystem for Linux. */
export function isWslRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true
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
    // Termux (the dominant Node runtime reporting platform "android") has no
    // desktop file manager and no xdg-open; `termux-open` hands the path to
    // Android's system open-with chooser. Fall through to the parent dir like
    // Linux: Android has no select protocol either.
    case 'android': {
      const parent = parentOf(path)
      return { command: 'termux-open', args: [parent ?? path] }
    }
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
    // Termux: `termux-open-url` is the Android intent dispatcher for URLs
    // (termux-open would route through the content chooser first).
    case 'android':
      return { command: 'termux-open-url', args: [url] }
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

/** Remove Electron's Node-mode switch before starting any desktop application. */
export function externalProcessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/** 为内置编辑器生成本地文件协议地址。 */
function editorUrl(editor: BuiltinExternalEditor, filePath: string): string {
  const scheme = editor === 'vscode' ? 'vscode' : 'cursor'
  return `${scheme}://file/${filePath.replace(/\\/g, '/')}`
}

/** 按目标宿主平台验证并整理绝对文件路径。 */
function requireExternalPath(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    if (!winPath.isAbsolute(value)) throw new SidebarError('fs-error', `"${value}" is not an absolute path`, 400)
    return winPath.normalize(value)
  }
  if (!posixPath.isAbsolute(value)) throw new SidebarError('fs-error', `"${value}" is not an absolute path`, 400)
  return posixPath.resolve(value)
}

/** 从 Windows 协议注册命令中提取可执行文件路径。 */
function executableFromRegistryValue(value: string): string | undefined {
  const match = /^\s*(?:"([^"]+\.exe)"|(.+?\.exe))(?:\s|$)/i.exec(value)
  return match?.[1] ?? match?.[2]
}

/** 使用宿主环境展开注册命令里的 Windows 环境变量。 */
function expandWindowsEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (match, key: string) => env[key] ?? match)
}

/** 从常见安装目录、PATH 和协议注册项查找 Windows 编辑器。 */
function lookupWindowsEditorExecutable(editor: BuiltinExternalEditor, env: NodeJS.ProcessEnv): string | undefined {
  const appName = editor === 'vscode' ? 'Microsoft VS Code' : 'Cursor'
  const executable = editor === 'vscode' ? 'Code.exe' : 'Cursor.exe'
  const cliName = editor === 'vscode' ? 'code' : 'cursor'
  const candidates = [
    env.LOCALAPPDATA ? winPath.join(env.LOCALAPPDATA, 'Programs', appName, executable) : undefined,
    env.ProgramFiles ? winPath.join(env.ProgramFiles, appName, executable) : undefined,
    env['ProgramFiles(x86)'] ? winPath.join(env['ProgramFiles(x86)'], appName, executable) : undefined,
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && existsSync(candidate)) return candidate
  }

  for (const directory of (env.PATH ?? '').split(winPath.delimiter)) {
    const direct = winPath.join(directory, executable)
    if (existsSync(direct)) return direct
    for (const suffix of ['.exe', '.cmd', '.bat']) {
      if (existsSync(winPath.join(directory, `${cliName}${suffix}`))) {
        const adjacent = winPath.resolve(directory, '..', executable)
        if (existsSync(adjacent)) return adjacent
      }
    }
  }

  const protocol = editor === 'vscode' ? 'vscode' : 'cursor'
  const keys = [
    `HKCU\\Software\\Classes\\${protocol}\\shell\\open\\command`,
    `HKLM\\Software\\Classes\\${protocol}\\shell\\open\\command`,
  ]
  for (const key of keys) {
    try {
      const output = execFileSync('reg.exe', ['query', key, '/ve'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      const command = output.split(/\r?\n/).find(line => /REG_SZ/i.test(line))
      if (command === undefined) continue
      const registered = executableFromRegistryValue(command.slice(command.search(/REG_SZ/i) + 6))
      if (registered !== undefined) return expandWindowsEnv(registered, env)
    } catch {
      // 编辑器可能安装在其他用户目录，缺少当前注册项时继续查找。
    }
  }
  return undefined
}

/** 构造内置编辑器的宿主命令，找不到程序时返回协议处理命令。 */
export function editorCommand(
  editor: BuiltinExternalEditor,
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  options: {
    env?: NodeJS.ProcessEnv
    lookupExecutable?: (editor: BuiltinExternalEditor, env: NodeJS.ProcessEnv) => string | undefined
    commandOptions?: WslCommandOptions
  } = {},
): ExternalCommand {
  if (platform === 'win32') {
    const executable = (options.lookupExecutable ?? lookupWindowsEditorExecutable)(editor, options.env ?? process.env)
    if (executable !== undefined) return { command: executable, args: [filePath] }
  }
  return urlCommand(editorUrl(editor, filePath), platform, options.commandOptions)
}

/** Convert the built-in VSCode-family local-file URL to its Remote-WSL form.
 * A POSIX path produces `scheme://file//...`; keep one leading slash when it
 * moves behind the `wsl+<distro>` authority. Other custom schemes are left
 * alone and merely dispatched through the Windows protocol handler. */
export function wslRemoteEditorUrl(url: string, distroName: string): string {
  const match = /^(vscode(?:-insiders)?|cursor):\/\/file(\/\/.*)$/i.exec(url)
  if (match === null) return url
  const scheme = match[1]
  const remotePath = match[2]
  if (scheme === undefined || remotePath === undefined) return url
  const distro = distroName.trim()
  if (distro === '') {
    throw new SidebarError('internal', 'WSL_DISTRO_NAME is unavailable; cannot build a Remote-WSL editor URL', 500)
  }
  return `${scheme}://vscode-remote/wsl+${distro}${remotePath.slice(1)}`
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

function launchFailure(command: string, error: unknown, editor?: BuiltinExternalEditor): SidebarError {
  const target = editor === undefined ? `external opener "${command}"` : `${editor} via "${command}"`
  return new SidebarError('internal', `failed to launch ${target}: ${messageOf(error)}`, 500)
}

/**
 * Launch one external open action detached from the host. Success is reported
 * only after Node emits `spawn`; an ENOENT/permission failure now rejects the
 * route instead of being swallowed after `{ started: true }` was returned.
 */
export function launchExternal(
  request: OpenExternalRequest,
  options: LaunchExternalOptions = {},
): Promise<{ started: true }> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const wsl = options.wsl ?? (platform === 'linux' && isWslRuntime(env))
  const commandOptions: WslCommandOptions = { ...options.commandOptions, wsl }

  let spec: ExternalCommand
  let editor: BuiltinExternalEditor | undefined
  if (request.action === 'reveal') {
    spec = revealCommand(requireExternalPath(request.path, platform), platform, commandOptions)
  } else if (request.action === 'editor') {
    editor = request.editor
    const filePath = requireExternalPath(request.path, platform)
    if (wsl) {
      const url = wslRemoteEditorUrl(editorUrl(editor, filePath), options.distroName ?? env.WSL_DISTRO_NAME ?? '')
      spec = urlCommand(url, platform, commandOptions)
    } else {
      spec = editorCommand(editor, filePath, platform, {
        env,
        lookupExecutable: options.lookupEditorExecutable,
        commandOptions,
      })
    }
  } else {
    let url = validateExternalUrl(request.url)
    if (wsl) url = wslRemoteEditorUrl(url, options.distroName ?? env.WSL_DISTRO_NAME ?? '')
    spec = urlCommand(url, platform, commandOptions)
  }

  const spawnExternal = options.spawn ?? spawn
  let child: ReturnType<typeof spawn>
  try {
    child = spawnExternal(spec.command, spec.args, {
      detached: true,
      stdio: 'ignore',
      env: externalProcessEnv(env),
    })
  } catch (error) {
    return Promise.reject(launchFailure(spec.command, error, editor))
  }

  return new Promise((resolve, reject) => {
    child.once('spawn', () => { resolve({ started: true }) })
    child.once('error', (error) => { reject(launchFailure(spec.command, error, editor)) })
    child.unref()
  })
}
