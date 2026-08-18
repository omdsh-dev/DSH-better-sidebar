/**
 * pty-deps unit tests (issue #140, plugin side): lazy node-pty loading,
 * profile/plugin-root discovery, and the pasteable repair command — the
 * degraded mode the terminal tab enters when node-pty cannot load, instead
 * of the whole plugin (and `dsh web`) failing to boot.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildRepairCommand,
  depsStatus,
  DSH_NODE_PTY_RANGE,
  findPluginRoot,
  findProfileDir,
  loadNodePty,
  loadRequiredNodePty,
  nodePtyLoadCause,
  resetNodePtyCache,
} from '../src/pty-deps.ts'
import { SidebarError } from '../src/wire.ts'

/** A throw-only require: node-pty missing or its native binding broken. */
const failingRequire = (): never => { throw new Error('Cannot find package node-pty') }

describe('loadNodePty', () => {
  beforeEach(() => { resetNodePtyCache() })

  it('loads the real node-pty module in this repository', () => {
    const mod = loadNodePty()
    expect(mod).not.toBeNull()
    expect(typeof mod?.spawn).toBe('function')
  })

  it('returns null and records the cause when the require throws', () => {
    expect(loadNodePty(failingRequire)).toBeNull()
    expect((nodePtyLoadCause() as Error).message).toBe('Cannot find package node-pty')
  })

  it('caches the first outcome (a later working require does not override)', () => {
    expect(loadNodePty(failingRequire)).toBeNull()
    expect(loadNodePty(() => ({ spawn: () => undefined }))).toBeNull()
    resetNodePtyCache()
    expect(loadNodePty(() => ({ spawn: () => undefined }))).not.toBeNull()
  })

  it('loadRequiredNodePty throws the canonical degraded-mode error', () => {
    loadNodePty(failingRequire)
    let thrown: unknown
    try {
      loadRequiredNodePty()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SidebarError)
    expect((thrown as SidebarError).code).toBe('pty-deps-missing')
    expect((thrown as SidebarError).status).toBe(503)
  })
})

describe('buildRepairCommand', () => {
  let root: string
  let pluginRoot: string
  let profileDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pty-deps-'))
    pluginRoot = join(root, 'plugin')
    profileDir = join(root, 'profiles', 'web')
    mkdirSync(join(pluginRoot, 'scripts'), { recursive: true })
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(pluginRoot, 'scripts', 'install.sh'), '#!/usr/bin/env bash\n')
    writeFileSync(join(pluginRoot, 'scripts', 'install.ps1'), '# ps1\n')
  })

  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('posix: bash installer with --repair and the detected profile', () => {
    const { command, note } = buildRepairCommand({ pluginRoot, profileDir, platform: 'darwin' })
    expect(command).toBe(`bash "${join(pluginRoot, 'scripts', 'install.sh')}" --repair --profile "web"`)
    expect(note).toBeUndefined()
  })

  it('posix: omits --profile when the profile could not be detected', () => {
    const { command } = buildRepairCommand({ pluginRoot, profileDir: null, platform: 'linux' })
    expect(command).toBe(`bash "${join(pluginRoot, 'scripts', 'install.sh')}" --repair`)
  })

  it('win32: powershell -ExecutionPolicy Bypass with -Repair and -Profile', () => {
    const { command } = buildRepairCommand({ pluginRoot, profileDir, platform: 'win32' })
    const expected = join(pluginRoot, 'scripts', 'install.ps1')
    expect(command).toBe(`powershell -ExecutionPolicy Bypass -File "${expected}" -Repair -Profile "web"`)
  })

  it('falls back to the dsh plugin command when the plugin scripts are unavailable', () => {
    const bareRoot = join(root, 'bare')
    mkdirSync(bareRoot)
    const { command, note } = buildRepairCommand({ pluginRoot: bareRoot, profileDir, platform: 'darwin' })
    expect(command).toBe('dsh plugin --profile "web" install')
    expect(note).toContain('allowBuilds')
  })

  it('falls back to the dsh plugin command (default web) when nothing is detectable', () => {
    const { command } = buildRepairCommand({ pluginRoot: null, profileDir: null, platform: 'darwin' })
    expect(command).toBe('dsh plugin --profile "web" install')
  })
})

describe('findProfileDir / findPluginRoot', () => {
  let root: string
  let moduleFile: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pty-deps-'))
    // A fake plugin module deep inside the profile's pnpm node_modules.
    const pkgRoot = join(root, 'profiles', 'web', 'node_modules', '.pnpm', 'dsh-better-sidebar@0.0.0', 'node_modules', 'dsh-better-sidebar')
    const libDir = join(pkgRoot, 'lib')
    mkdirSync(libDir, { recursive: true })
    writeFileSync(join(root, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }))
    writeFileSync(join(root, 'profiles', 'web', 'pnpm-workspace.yaml'), '')
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'dsh-better-sidebar' }))
    moduleFile = join(libDir, 'index.js')
    writeFileSync(moduleFile, '')
  })

  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('walks up from the plugin module to the profile root (pnpm-workspace.yaml)', () => {
    expect(findProfileDir(moduleFile)).toBe(realpathSync(join(root, 'profiles', 'web')))
  })

  it('walks up to the plugin package root by package.json name', () => {
    expect(findPluginRoot(moduleFile)).toBe(realpathSync(join(root, 'profiles', 'web', 'node_modules', '.pnpm', 'dsh-better-sidebar@0.0.0', 'node_modules', 'dsh-better-sidebar')))
  })

  it('falls back to $DSH_HOME/profiles/web when no ancestor looks like a profile', () => {
    const home = join(root, 'home')
    const web = join(home, 'profiles', 'web')
    mkdirSync(web, { recursive: true })
    writeFileSync(join(web, 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }))
    writeFileSync(join(web, 'pnpm-workspace.yaml'), '')
    // A bare module path with no profile-like ancestor (the walk-up must miss).
    const bareModule = join(root, 'elsewhere', 'lib', 'index.js')
    mkdirSync(dirname(bareModule), { recursive: true })
    writeFileSync(bareModule, '')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      expect(findProfileDir(bareModule)).toBe(realpathSync(web))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('depsStatus', () => {
  let root: string
  let moduleFile: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pty-deps-'))
    const pkgRoot = join(root, 'profiles', 'web', 'node_modules', '.pnpm', 'dsh-better-sidebar@0.0.0', 'node_modules', 'dsh-better-sidebar')
    mkdirSync(join(pkgRoot, 'scripts'), { recursive: true })
    mkdirSync(join(pkgRoot, 'lib'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'web', 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }))
    writeFileSync(join(root, 'profiles', 'web', 'pnpm-workspace.yaml'), '')
    writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'dsh-better-sidebar' }))
    writeFileSync(join(pkgRoot, 'scripts', 'install.sh'), '#!/usr/bin/env bash\n')
    moduleFile = join(pkgRoot, 'lib', 'index.js')
    writeFileSync(moduleFile, '')
    resetNodePtyCache()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    resetNodePtyCache()
  })

  it('reports ok:true when node-pty loads', () => {
    expect(depsStatus({ fromFile: moduleFile })).toEqual({ ok: true })
  })

  it('reports the cause, the repair command and the profile when the load fails', () => {
    loadNodePty(failingRequire)
    const status = depsStatus({ fromFile: moduleFile })
    expect(status.ok).toBe(false)
    if (status.ok) throw new Error('unreachable')
    expect(status.cause).toBe('Cannot find package node-pty')
    const script = realpathSync(join(root, 'profiles', 'web', 'node_modules', '.pnpm', 'dsh-better-sidebar@0.0.0', 'node_modules', 'dsh-better-sidebar', 'scripts', 'install.sh'))
    expect(status.command).toBe(`bash "${script}" --repair --profile "web"`)
    expect(status.profile).toBe('web')
  })
})

describe('DSH sync contract', () => {
  it('the declared node-pty range stays identical to DSH core (dsh-subprocess-local ^1.1.0)', () => {
    expect(DSH_NODE_PTY_RANGE).toBe('^1.1.0')
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(pkg.dependencies['node-pty']).toBe(DSH_NODE_PTY_RANGE)
  })
})
