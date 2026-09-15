/**
 * node-pty dependency loading for the host half (issue #140, plugin side).
 *
 * The terminal surfaces (UI tabs + model-facing terminal_* tools) need
 * node-pty, but the package must NEVER be imported statically at module
 * top level: a missing or broken install (pnpm 11's strict-dep-builds
 * skipping node-pty's install script, a pruned store entry, a failed
 * prebuilt-binary download…) would then fail the plugin module load and —
 * because a loader entry apply failure aborts the boot — take the whole
 * `dsh web` server down with it.
 *
 * Instead the host half loads node-pty lazily (synchronously, via
 * createRequire — the same resolution `ensureSpawnHelper` already uses in
 * production). When the load fails the plugin stays mounted in a degraded
 * state: the terminal tab shows a friendly error carrying a pasteable
 * repair command (see scripts/install.sh / install.ps1 `--repair`), and the
 * agent terminal tools are simply not registered.
 *
 * Version contract: the plugin must stay in sync with DSH core —
 * `@deepseek-ai/dsh-subprocess-local` declares `"node-pty": "^1.1.0"` in
 * its `dependencies`. Both sides then resolve the SAME pnpm store entry
 * (same range, same integrity → one native binding, no drift). Do NOT
 * switch to a fork (e.g. @lydell/node-pty) or a different range without
 * re-checking the core declaration.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as nodePtyNs from 'node-pty'
import { SidebarError } from './wire.ts'

/** The node-pty module surface the registries consume (spawn/kill/resize/…). */
export type NodePtyModule = typeof nodePtyNs

/**
 * The node-pty version range this plugin ships. MUST stay identical to the
 * range DSH core declares (`@deepseek-ai/dsh-subprocess-local`): the same
 * range keeps pnpm resolving both to one physical package.
 */
export const DSH_NODE_PTY_RANGE = '^1.1.0'

/**
 * The WebSocket close-code-1011 reason the host sends when node-pty is
 * unavailable. The client recognizes this exact marker and fetches the full
 * repair details from `/sidebar/api/terminal.deps` (a WS close reason is
 * capped at 123 bytes, so the command itself cannot ride the close frame).
 */
export const PTY_DEPS_MISSING = 'pty-deps-missing'

/** A require-compatible loader, injectable for tests. */
export type NodePtyRequire = (id: string) => unknown

const defaultRequire: NodePtyRequire = createRequire(import.meta.url)

type LoadResult = { ok: true; module: NodePtyModule } | { ok: false; cause: unknown }

let cached: LoadResult | undefined

/**
 * The DSH core package that declares `node-pty` in its own `dependencies`.
 * Its install always yields a working native binding for the current
 * platform (core cannot boot without it), so it is a reliable fallback
 * resolution context when the plugin's own copy is broken.
 */
const CORE_PTY_OWNER = '@deepseek-ai/dsh-subprocess-local'

/**
 * Candidate entry files of the DSH core package that declares `node-pty`.
 * Each yielded path is a resolvable module file usable as a `createRequire`
 * base. The plugin's own module graph usually reaches the core package
 * already (its peers resolve against the DSH host bundle at mount time);
 * the well-known install roots cover standalone layouts.
 */
function* coreEntryCandidates(): Generator<string> {
  try {
    yield createRequire(import.meta.url).resolve(CORE_PTY_OWNER)
  } catch {
    // not reachable from this module — fall through to the roots below
  }
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const pkgDir = join('node_modules', CORE_PTY_OWNER)
  yield join(home, pkgDir, 'lib', 'index.js')
  yield join(home, 'node_modules', '@deepseek-ai', 'dsh', pkgDir, 'lib', 'index.js')
  for (const globalRoot of wellKnownGlobalRoots()) {
    yield join(globalRoot, '@deepseek-ai', 'dsh', pkgDir, 'lib', 'index.js')
  }
}

/** Global node_modules roots worth probing on this machine. */
function* wellKnownGlobalRoots(): Generator<string> {
  // Node's own global module paths (covers npm/pnpm/yarn global installs).
  try {
    const nodeModule = defaultRequire('node:module') as { globalPaths?: string[] }
    for (const root of nodeModule.globalPaths ?? []) {
      if (root !== '') yield root
    }
  } catch {
    // ignore — the static roots below still apply
  }
  if (process.platform === 'win32') {
    const prefix = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    yield join(prefix, 'npm', 'node_modules')
  } else {
    yield '/usr/local/lib/node_modules'
    yield '/usr/lib/node_modules'
  }
}

/**
 * Resolve `node-pty` through the DSH core package that declares it. Returns
 * the loaded module, or null when no core-side copy is loadable. Never
 * throws: every candidate is isolated in try/catch.
 *
 * Each candidate entry anchors `node-pty` resolution at the core package's
 * own dependency graph, then the resolved absolute path is loaded through
 * `requireImpl` — so an injected failing loader disables the fallback too,
 * keeping the fully-degraded path testable.
 */
function loadNodePtyFromCore(requireImpl: NodePtyRequire = defaultRequire): NodePtyModule | null {
  for (const entry of coreEntryCandidates()) {
    if (!existsSync(entry)) continue
    try {
      const anchored = createRequire(entry)
      const ptyPath = anchored.resolve('node-pty')
      return requireImpl(ptyPath) as NodePtyModule
    } catch {
      // this candidate is unusable (broken binding, mismatched ABI…) — next
    }
  }
  return null
}

/**
 * Load node-pty once (synchronously) and cache the outcome. Returns null
 * when the package or its native binding cannot be loaded; the cause stays
 * queryable through {@link nodePtyLoadCause}. Never throws.
 *
 * On Linux the published node-pty tarball ships no prebuilt binaries (it
 * builds from source via node-gyp); when that build is skipped — pnpm 10+'s
 * strict-dep-builds without an `allowBuilds` approval, a pruned store entry,
 * or a missing C++ toolchain — the plugin's own copy stays unusable even
 * though the DSH core installed the same range correctly (issue #269). The
 * fallback chain re-resolves the dependency through the core package, which
 * satisfies the same `^1.1.0` range with a working platform binding.
 */
export function loadNodePty(requireImpl: NodePtyRequire = defaultRequire): NodePtyModule | null {
  if (cached === undefined) {
    try {
      cached = { ok: true, module: requireImpl('node-pty') as NodePtyModule }
    } catch (cause) {
      const fallback = loadNodePtyFromCore(requireImpl)
      cached = fallback !== null
        ? { ok: true, module: fallback }
        : { ok: false, cause }
    }
  }
  return cached.ok ? cached.module : null
}

/** The recorded load failure (undefined when the load succeeded or never ran). */
export function nodePtyLoadCause(): unknown {
  return cached !== undefined && !cached.ok ? cached.cause : undefined
}

/** Forget the cached outcome (tests only — a real reload is otherwise one-shot). */
export function resetNodePtyCache(): void {
  cached = undefined
}

/** Load node-pty or throw the canonical degraded-mode error (class-constructor default). */
export function loadRequiredNodePty(): NodePtyModule {
  const module = loadNodePty()
  if (module === null) {
    const cause = describeCause(nodePtyLoadCause())
    throw new SidebarError(
      'pty-deps-missing',
      `node-pty (${DSH_NODE_PTY_RANGE}) failed to load: ${cause} — run the repair command shown in the terminal tab`,
      503,
    )
  }
  return module
}

/** Resolve a directory to its physical location (symlinked/link: installs). */
function realDir(file: string): string {
  try {
    return dirname(realpathSync(file))
  } catch {
    return dirname(file)
  }
}

/** Walk up from `dir` looking for a DSH profile root (package.json + pnpm-workspace.yaml). */
function walkUp(dir: string, isRoot: (dir: string) => boolean): string | null {
  let current = dir
  for (let depth = 0; depth < 16; depth += 1) {
    if (isRoot(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/** Whether `dir` looks like a DSH profile root (the plugin lives under its node_modules). */
function isProfileRoot(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'pnpm-workspace.yaml'))
}

/**
 * Detect the DSH profile directory this plugin is installed into: the
 * nearest ancestor of the plugin module that carries both `package.json`
 * and `pnpm-workspace.yaml` (the profile root; the plugin resolves from the
 * profile's node_modules). Falls back to `$DSH_HOME/profiles/web` (the
 * standard web profile), then null.
 */
export function findProfileDir(fromFile: string = fileURLToPath(import.meta.url)): string | null {
  const detected = walkUp(realDir(fromFile), isProfileRoot)
  if (detected !== null) return detected
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const web = join(home, 'profiles', 'web')
  return isProfileRoot(web) ? realpathSync(web) : null
}

/** Whether `dir`'s package.json declares this plugin's name. */
function isPluginRoot(dir: string): boolean {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return false
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }
    return parsed.name === 'dsh-better-sidebar'
  } catch {
    return false
  }
}

/** The plugin package root (walk-up from the module; works for lib/ and src/ layouts). */
export function findPluginRoot(fromFile: string = fileURLToPath(import.meta.url)): string | null {
  return walkUp(realDir(fromFile), isPluginRoot)
}

/** Options for {@link buildRepairCommand}. */
export interface RepairCommandOptions {
  /** The plugin package root (where scripts/install.sh / install.ps1 live). */
  pluginRoot: string | null
  /** The detected profile directory (null → the standard `web` profile). */
  profileDir: string | null
  /** Platform override for tests; defaults to the live process. */
  platform?: NodeJS.Platform
}

/**
 * The pasteable repair command for a broken node-pty install: rerun the
 * plugin's own installer in `--repair` mode (idempotent: it re-writes the
 * profile's `allowBuilds: node-pty: true` and re-installs/rebuilds the
 * dependency). Falls back to DSH's plugin command when the scripts are not
 * shipped (exotic layouts).
 */
export function buildRepairCommand(options: RepairCommandOptions): { command: string; note?: string } {
  const { pluginRoot, profileDir } = options
  const platform = options.platform ?? process.platform
  const profileName = profileDir !== null ? basename(profileDir) : null
  const profileArg = profileName !== null
    ? (platform === 'win32' ? ` -Profile "${profileName}"` : ` --profile "${profileName}"`)
    : ''
  if (pluginRoot !== null) {
    if (platform === 'win32') {
      const script = join(pluginRoot, 'scripts', 'install.ps1')
      if (existsSync(script)) {
        return { command: `powershell -ExecutionPolicy Bypass -File "${script}" -Repair${profileArg}` }
      }
    } else {
      const script = join(pluginRoot, 'scripts', 'install.sh')
      if (existsSync(script)) {
        return { command: `bash "${script}" --repair${profileArg}` }
      }
    }
  }
  const name = profileName ?? 'web'
  return {
    command: `dsh plugin --profile "${name}" install`,
    note: 'If pnpm 11 blocked node-pty\'s build script, ensure `allowBuilds: node-pty: true` in the profile\'s pnpm-workspace.yaml (the plugin\'s scripts/install.sh / install.ps1 --repair does this automatically).',
  }
}

/** One-line human description of the recorded load cause. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/** Structured status served by the `/sidebar/api/terminal.deps` endpoint. */
export type NodePtyDepsStatus =
  | { ok: true }
  | {
    ok: false
    /** The require-time error message (module missing, native binding broken…). */
    cause: string
    /** The pasteable repair command (terminal/cmd). */
    command: string
    /** The detected profile name (null when undetected → the command defaults to web). */
    profile: string | null
    /** Optional supplementary hint (fallback command only). */
    note?: string
  }

/** Current node-pty dependency status (loaded vs degraded + repair info). */
export function depsStatus(options: { fromFile?: string } = {}): NodePtyDepsStatus {
  const module = loadNodePty()
  if (module !== null) return { ok: true }
  const pluginRoot = findPluginRoot(options.fromFile)
  const profileDir = findProfileDir(options.fromFile)
  const { command, note } = buildRepairCommand({ pluginRoot, profileDir })
  return {
    ok: false,
    cause: describeCause(nodePtyLoadCause()),
    command,
    profile: profileDir !== null ? basename(profileDir) : null,
    ...(note !== undefined ? { note } : {}),
  }
}
