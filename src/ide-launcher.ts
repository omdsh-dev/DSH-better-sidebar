/**
 * Host-side IDE discovery and launching.
 *
 * Detection deliberately happens on the DSH host, not in the browser:
 * browsers cannot safely enumerate local applications, and a remotely opened
 * DSH page must never pretend it can launch software on the viewer's laptop.
 * The launch route accepts only a catalog id and a session-derived cwd, so no
 * executable path, arbitrary argument, or shell string crosses the wire.
 */
import { constants } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { homedir as systemHomedir } from 'node:os'
import { join } from 'node:path'
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { IDE_CATALOG, isIdeId, type IdeId, type InstalledIde } from './ide-catalog.ts'

type Platform = NodeJS.Platform

interface LaunchTarget {
  ide: InstalledIde
  command: string
  args: (cwd: string) => string[]
}

interface RecursiveRoot {
  path: string
  maxDepth: number
}

/** Narrow spawn face so tests can observe the exact executable/argv safely. */
export type IdeSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Pick<ChildProcess, 'once' | 'unref'>

export interface IdeLauncherOptions {
  platform?: Platform
  env?: NodeJS.ProcessEnv
  home?: string
  spawn?: IdeSpawn
  now?: () => number
  cacheTtlMs?: number
  /** Test/embedded override; omitted uses the platform's standard roots. */
  recursiveRoots?: readonly RecursiveRoot[]
  /** Test/embedded override; omitted uses Flatpak's exported desktop roots. */
  flatpakRoots?: readonly string[]
  /** Hard cap across recursive discovery roots. */
  scanBudget?: number
}

/** Stable route error codes mapped to SidebarError by the host API. */
export class IdeLauncherError extends Error {
  constructor(
    readonly code: 'ide-not-found' | 'ide-open-failed',
    message: string,
  ) {
    super(message)
  }
}

interface IdeDefinition {
  id: IdeId
  commands: Partial<Record<Platform, readonly string[]>>
  macApps?: readonly string[]
  windowsPaths?: readonly string[]
  recursiveNames?: Partial<Record<Platform, readonly string[]>>
  flatpakIds?: readonly string[]
}

const DEFINITIONS: readonly IdeDefinition[] = [
  {
    id: 'vscode',
    commands: { darwin: ['code'], linux: ['code'], win32: ['Code.exe'] },
    macApps: ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app'],
    windowsPaths: [
      'LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe',
      'PROGRAMFILES/Microsoft VS Code/Code.exe',
      'PROGRAMFILES_X86/Microsoft VS Code/Code.exe',
    ],
    flatpakIds: ['com.visualstudio.code'],
  },
  {
    id: 'cursor',
    commands: { darwin: ['cursor'], linux: ['cursor'], win32: ['Cursor.exe'] },
    macApps: ['Cursor.app'],
    windowsPaths: [
      'LOCALAPPDATA/Programs/cursor/Cursor.exe',
      'LOCALAPPDATA/Programs/Cursor/Cursor.exe',
      'PROGRAMFILES/Cursor/Cursor.exe',
    ],
  },
  {
    id: 'windsurf',
    commands: { darwin: ['windsurf'], linux: ['windsurf'], win32: ['Windsurf.exe'] },
    macApps: ['Windsurf.app'],
    windowsPaths: [
      'LOCALAPPDATA/Programs/Windsurf/Windsurf.exe',
      'PROGRAMFILES/Windsurf/Windsurf.exe',
    ],
  },
  {
    id: 'zed',
    commands: { darwin: ['zed'], linux: ['zed'], win32: ['Zed.exe'] },
    macApps: ['Zed.app'],
    windowsPaths: ['LOCALAPPDATA/Programs/Zed/Zed.exe'],
    flatpakIds: ['dev.zed.Zed'],
  },
  {
    id: 'vscodium',
    commands: { darwin: ['codium'], linux: ['codium'], win32: ['VSCodium.exe'] },
    macApps: ['VSCodium.app'],
    windowsPaths: [
      'LOCALAPPDATA/Programs/VSCodium/VSCodium.exe',
      'PROGRAMFILES/VSCodium/VSCodium.exe',
    ],
    flatpakIds: ['com.vscodium.codium'],
  },
  {
    id: 'trae',
    commands: { darwin: ['trae'], linux: ['trae'], win32: ['Trae.exe'] },
    macApps: ['Trae.app'],
    windowsPaths: ['LOCALAPPDATA/Programs/Trae/Trae.exe'],
  },
  {
    id: 'intellij',
    commands: { darwin: ['idea'], linux: ['idea'], win32: ['idea64.exe'] },
    macApps: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app'],
    recursiveNames: { linux: ['idea.sh'], win32: ['idea64.exe'], darwin: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app'] },
    flatpakIds: ['com.jetbrains.IntelliJ-IDEA-Ultimate', 'com.jetbrains.IntelliJ-IDEA-Community'],
  },
  {
    id: 'webstorm',
    commands: { darwin: ['webstorm'], linux: ['webstorm'], win32: ['webstorm64.exe'] },
    macApps: ['WebStorm.app'],
    recursiveNames: { linux: ['webstorm.sh'], win32: ['webstorm64.exe'], darwin: ['WebStorm.app'] },
    flatpakIds: ['com.jetbrains.WebStorm'],
  },
  {
    id: 'pycharm',
    commands: { darwin: ['pycharm'], linux: ['pycharm'], win32: ['pycharm64.exe'] },
    macApps: ['PyCharm.app', 'PyCharm CE.app'],
    recursiveNames: { linux: ['pycharm.sh'], win32: ['pycharm64.exe'], darwin: ['PyCharm.app', 'PyCharm CE.app'] },
    flatpakIds: ['com.jetbrains.PyCharm-Professional', 'com.jetbrains.PyCharm-Community'],
  },
  {
    id: 'goland',
    commands: { darwin: ['goland'], linux: ['goland'], win32: ['goland64.exe'] },
    macApps: ['GoLand.app'],
    recursiveNames: { linux: ['goland.sh'], win32: ['goland64.exe'], darwin: ['GoLand.app'] },
    flatpakIds: ['com.jetbrains.GoLand'],
  },
  {
    id: 'clion',
    commands: { darwin: ['clion'], linux: ['clion'], win32: ['clion64.exe'] },
    macApps: ['CLion.app'],
    recursiveNames: { linux: ['clion.sh'], win32: ['clion64.exe'], darwin: ['CLion.app'] },
    flatpakIds: ['com.jetbrains.CLion'],
  },
  {
    id: 'rider',
    commands: { darwin: ['rider'], linux: ['rider'], win32: ['rider64.exe'] },
    macApps: ['Rider.app'],
    recursiveNames: { linux: ['rider.sh'], win32: ['rider64.exe'], darwin: ['Rider.app'] },
    flatpakIds: ['com.jetbrains.Rider'],
  },
  {
    id: 'android-studio',
    commands: { darwin: ['studio'], linux: ['studio'], win32: ['studio64.exe'] },
    macApps: ['Android Studio.app'],
    windowsPaths: ['PROGRAMFILES/Android/Android Studio/bin/studio64.exe'],
    recursiveNames: { linux: ['studio.sh'], win32: ['studio64.exe'], darwin: ['Android Studio.app'] },
    flatpakIds: ['com.google.AndroidStudio'],
  },
  {
    id: 'xcode',
    commands: {},
    macApps: ['Xcode.app'],
  },
  {
    id: 'visual-studio',
    commands: { win32: ['devenv.exe'] },
    windowsPaths: [
      'PROGRAMFILES/Microsoft Visual Studio/2022/Community/Common7/IDE/devenv.exe',
      'PROGRAMFILES/Microsoft Visual Studio/2022/Professional/Common7/IDE/devenv.exe',
      'PROGRAMFILES/Microsoft Visual Studio/2022/Enterprise/Common7/IDE/devenv.exe',
      'PROGRAMFILES_X86/Microsoft Visual Studio/2019/Community/Common7/IDE/devenv.exe',
      'PROGRAMFILES_X86/Microsoft Visual Studio/2019/Professional/Common7/IDE/devenv.exe',
      'PROGRAMFILES_X86/Microsoft Visual Studio/2019/Enterprise/Common7/IDE/devenv.exe',
    ],
  },
  {
    id: 'sublime-text',
    commands: { darwin: ['subl'], linux: ['subl', 'sublime_text'], win32: ['sublime_text.exe'] },
    macApps: ['Sublime Text.app'],
    windowsPaths: [
      'PROGRAMFILES/Sublime Text/sublime_text.exe',
      'PROGRAMFILES_X86/Sublime Text/sublime_text.exe',
    ],
    flatpakIds: ['com.sublimetext.three'],
  },
]

const NAME_BY_ID = new Map<IdeId, string>(IDE_CATALOG.map(ide => [ide.id, ide.name]))

function publicIde(id: IdeId): InstalledIde {
  return { id, name: NAME_BY_ID.get(id) ?? id }
}

async function exists(path: string, executable: boolean): Promise<boolean> {
  try {
    if (executable) await access(path, constants.X_OK)
    else await stat(path)
    return true
  } catch {
    return false
  }
}

function pathEntries(platform: Platform, env: NodeJS.ProcessEnv): string[] {
  const separator = platform === 'win32' ? ';' : ':'
  const fromEnv = (env.PATH ?? env.Path ?? env.path ?? '').split(separator).filter(Boolean)
  if (platform === 'linux') fromEnv.push('/usr/local/bin', '/usr/bin', '/snap/bin')
  if (platform === 'darwin') fromEnv.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  return [...new Set(fromEnv)]
}

async function commandTarget(
  definition: IdeDefinition,
  platform: Platform,
  env: NodeJS.ProcessEnv,
): Promise<LaunchTarget | undefined> {
  const commands = definition.commands[platform] ?? []
  for (const directory of pathEntries(platform, env)) {
    for (const command of commands) {
      const candidate = join(directory, command)
      if (await exists(candidate, platform !== 'win32')) {
        return { ide: publicIde(definition.id), command: candidate, args: cwd => [cwd] }
      }
    }
  }
  return undefined
}

function macAppRoots(home: string): string[] {
  // User applications first: Toolbox and user-local installs should win over
  // a stale machine-wide copy of the same IDE.
  return [join(home, 'Applications'), '/Applications', '/System/Applications']
}

async function macAppTarget(definition: IdeDefinition, home: string): Promise<LaunchTarget | undefined> {
  for (const root of macAppRoots(home)) {
    for (const name of definition.macApps ?? []) {
      const app = join(root, name)
      if (await exists(app, false)) {
        return {
          ide: publicIde(definition.id),
          command: '/usr/bin/open',
          args: cwd => ['-a', app, cwd],
        }
      }
    }
  }
  return undefined
}

function expandWindowsPath(template: string, env: NodeJS.ProcessEnv): string | undefined {
  const slash = template.indexOf('/')
  const key = slash === -1 ? template : template.slice(0, slash)
  const rest = slash === -1 ? '' : template.slice(slash + 1)
  const base = key === 'PROGRAMFILES_X86'
    ? env['ProgramFiles(x86)'] ?? env.PROGRAMFILES_X86
    : env[key]
  return base === undefined || base === '' ? undefined : join(base, ...rest.split('/'))
}

async function windowsTarget(definition: IdeDefinition, env: NodeJS.ProcessEnv): Promise<LaunchTarget | undefined> {
  for (const template of definition.windowsPaths ?? []) {
    const candidate = expandWindowsPath(template, env)
    if (candidate !== undefined && await exists(candidate, false)) {
      return { ide: publicIde(definition.id), command: candidate, args: cwd => [cwd] }
    }
  }
  return undefined
}

function defaultRecursiveRoots(platform: Platform, env: NodeJS.ProcessEnv, home: string): RecursiveRoot[] {
  if (platform === 'darwin') {
    return [
      { path: join(home, 'Applications', 'JetBrains Toolbox'), maxDepth: 5 },
      { path: join(home, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'apps'), maxDepth: 7 },
    ]
  }
  if (platform === 'win32') {
    return [
      ...(env.LOCALAPPDATA ? [{ path: join(env.LOCALAPPDATA, 'JetBrains', 'Toolbox', 'apps'), maxDepth: 8 }] : []),
      ...(env.ProgramFiles ? [{ path: join(env.ProgramFiles, 'JetBrains'), maxDepth: 5 }] : []),
      ...(env['ProgramFiles(x86)'] ? [{ path: join(env['ProgramFiles(x86)'], 'JetBrains'), maxDepth: 5 }] : []),
    ]
  }
  return [
    { path: join(home, '.local', 'share', 'JetBrains', 'Toolbox', 'apps'), maxDepth: 8 },
    { path: '/opt', maxDepth: 5 },
  ]
}

/**
 * Find only known basenames inside narrow install roots. The node budget and
 * depth limit keep a surprising /opt or Toolbox layout from turning a menu
 * click into an unbounded filesystem crawl.
 */
async function scanKnownNames(
  roots: readonly RecursiveRoot[],
  wanted: ReadonlySet<string>,
  budget: number,
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  let visited = 0
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth < 0 || visited >= budget || found.size >= wanted.size) return
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited >= budget || found.size >= wanted.size) return
      visited += 1
      const candidate = join(path, entry.name)
      const key = entry.name.toLowerCase()
      if (wanted.has(key) && !found.has(key)) {
        found.set(key, candidate)
        // An .app directory is already the launch target; its deep bundle
        // contents cannot contain another relevant product.
        if (key.endsWith('.app')) continue
      }
      if (entry.isDirectory()) await walk(candidate, depth - 1)
    }
  }
  for (const root of roots) await walk(root.path, root.maxDepth)
  return found
}

function defaultFlatpakRoots(home: string): string[] {
  return [
    join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications'),
    '/var/lib/flatpak/exports/share/applications',
  ]
}

async function flatpakTarget(
  definition: IdeDefinition,
  roots: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<LaunchTarget | undefined> {
  if ((definition.flatpakIds?.length ?? 0) === 0) return undefined
  let flatpak: string | undefined
  for (const directory of pathEntries('linux', env)) {
    const candidate = join(directory, 'flatpak')
    if (await exists(candidate, true)) { flatpak = candidate; break }
  }
  if (flatpak === undefined) return undefined
  for (const id of definition.flatpakIds ?? []) {
    for (const root of roots) {
      if (await exists(join(root, `${id}.desktop`), false)) {
        return {
          ide: publicIde(definition.id),
          command: flatpak,
          args: cwd => ['run', id, cwd],
        }
      }
    }
  }
  return undefined
}

function recursiveTarget(
  definition: IdeDefinition,
  platform: Platform,
  found: ReadonlyMap<string, string>,
): LaunchTarget | undefined {
  for (const name of definition.recursiveNames?.[platform] ?? []) {
    const candidate = found.get(name.toLowerCase())
    if (candidate === undefined) continue
    if (platform === 'darwin' && name.toLowerCase().endsWith('.app')) {
      return {
        ide: publicIde(definition.id),
        command: '/usr/bin/open',
        args: cwd => ['-a', candidate, cwd],
      }
    }
    return { ide: publicIde(definition.id), command: candidate, args: cwd => [cwd] }
  }
  return undefined
}

async function detectTargets(options: Required<Pick<IdeLauncherOptions, 'platform' | 'env' | 'home' | 'scanBudget'>> & IdeLauncherOptions): Promise<Map<IdeId, LaunchTarget>> {
  const { platform, env, home } = options
  const roots = options.recursiveRoots ?? defaultRecursiveRoots(platform, env, home)
  const wantedNames = new Set<string>()
  for (const definition of DEFINITIONS) {
    for (const name of definition.recursiveNames?.[platform] ?? []) wantedNames.add(name.toLowerCase())
  }
  const recursive = wantedNames.size === 0
    ? new Map<string, string>()
    : await scanKnownNames(roots, wantedNames, options.scanBudget)
  const flatpakRoots = options.flatpakRoots ?? defaultFlatpakRoots(home)
  const targets = new Map<IdeId, LaunchTarget>()
  for (const definition of DEFINITIONS) {
    const target = (platform === 'darwin' ? await macAppTarget(definition, home) : undefined)
      ?? (platform === 'win32' ? await windowsTarget(definition, env) : undefined)
      ?? await commandTarget(definition, platform, env)
      ?? recursiveTarget(definition, platform, recursive)
      ?? (platform === 'linux' ? await flatpakTarget(definition, flatpakRoots, env) : undefined)
    if (target !== undefined) targets.set(definition.id, target)
  }
  return targets
}

async function launchDetached(spawn: IdeSpawn, target: LaunchTarget, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const child = spawn(target.command, target.args(cwd), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve()
    })
  })
}

export interface IdeLauncher {
  /** Installed IDEs in stable catalog order; executable paths stay private. */
  list(): Promise<InstalledIde[]>
  /** Open one session directory in an installed, allowlisted IDE. */
  open(id: string, cwd: string): Promise<void>
}

/** Create one host-lifetime detector with a short cache shared by all sessions. */
export function createIdeLauncher(input: IdeLauncherOptions = {}): IdeLauncher {
  const options = {
    ...input,
    platform: input.platform ?? process.platform,
    env: input.env ?? process.env,
    home: input.home ?? systemHomedir(),
    scanBudget: input.scanBudget ?? 5000,
  }
  const spawn = input.spawn ?? (nodeSpawn as IdeSpawn)
  const now = input.now ?? Date.now
  const ttl = input.cacheTtlMs ?? 30_000
  let cache: { expires: number; targets: Map<IdeId, LaunchTarget> } | undefined
  let pending: Promise<Map<IdeId, LaunchTarget>> | undefined

  const targets = async (force = false): Promise<Map<IdeId, LaunchTarget>> => {
    if (!force && cache !== undefined && cache.expires > now()) return cache.targets
    if (!force && pending !== undefined) return pending
    const request = detectTargets(options).then((detected) => {
      cache = { expires: now() + ttl, targets: detected }
      return detected
    }).finally(() => {
      if (pending === request) pending = undefined
    })
    pending = request
    return request
  }

  return {
    async list() {
      const detected = await targets()
      return IDE_CATALOG
        .filter(ide => detected.has(ide.id))
        .map(ide => ({ id: ide.id, name: ide.name }))
    },
    async open(id, cwd) {
      if (!isIdeId(id)) throw new IdeLauncherError('ide-not-found', `unsupported IDE "${id}"`)
      const info = await stat(cwd).catch(() => undefined)
      if (info?.isDirectory() !== true) {
        throw new IdeLauncherError('ide-open-failed', `working directory is unavailable: ${cwd}`)
      }
      let target = (await targets()).get(id)
      // A menu can remain open while an app is installed/uninstalled. Retry
      // discovery once before declaring the selected product unavailable.
      if (target === undefined) target = (await targets(true)).get(id)
      if (target === undefined) {
        throw new IdeLauncherError('ide-not-found', `${publicIde(id).name} is not installed on the DSH host`)
      }
      try {
        await launchDetached(spawn, target, cwd)
      } catch (error) {
        throw new IdeLauncherError(
          'ide-open-failed',
          `cannot open ${target.ide.name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  }
}
