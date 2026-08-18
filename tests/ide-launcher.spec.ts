/** Host IDE detection/launching: platform roots, stable ordering, and safe argv. */
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIdeLauncher, IdeLauncherError, type IdeSpawn } from '../src/ide-launcher.ts'

const temporary: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'better-sidebar-ide-'))
  temporary.push(root)
  return root
}

async function executable(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, 0o755)
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('IDE host detection', () => {
  it('detects PATH commands in stable catalog order', async () => {
    const root = await tempRoot()
    const bin = join(root, 'bin')
    await executable(join(bin, 'cursor'))
    await executable(join(bin, 'code'))
    const launcher = createIdeLauncher({
      platform: 'linux',
      env: { PATH: bin },
      home: root,
      recursiveRoots: [],
      flatpakRoots: [],
    })
    const ids = (await launcher.list()).map(ide => ide.id)
    expect(ids).toContain('vscode')
    expect(ids).toContain('cursor')
    expect(ids.indexOf('vscode')).toBeLessThan(ids.indexOf('cursor'))
  })

  it('detects a macOS app bundle even when its CLI is not on PATH', async () => {
    const home = await tempRoot()
    await mkdir(join(home, 'Applications', 'Visual Studio Code.app'), { recursive: true })
    const launcher = createIdeLauncher({
      platform: 'darwin',
      env: { PATH: '' },
      home,
      recursiveRoots: [],
    })
    expect(await launcher.list()).toContainEqual({ id: 'vscode', name: 'Visual Studio Code' })
  })

  it('detects Windows user installs without relying on shell aliases', async () => {
    const root = await tempRoot()
    const local = join(root, 'LocalAppData')
    const code = join(local, 'Programs', 'Microsoft VS Code', 'Code.exe')
    await mkdir(join(code, '..'), { recursive: true })
    await writeFile(code, '')
    const launcher = createIdeLauncher({
      platform: 'win32',
      env: { PATH: '', LOCALAPPDATA: local },
      home: root,
      recursiveRoots: [],
    })
    expect(await launcher.list()).toContainEqual({ id: 'vscode', name: 'Visual Studio Code' })
  })

  it('finds JetBrains Toolbox launchers with a bounded recursive scan', async () => {
    const root = await tempRoot()
    const toolbox = join(root, 'toolbox')
    await executable(join(toolbox, 'apps', 'IDEA-U', 'ch-0', '241.1', 'bin', 'idea.sh'))
    const launcher = createIdeLauncher({
      platform: 'linux',
      env: { PATH: join(root, 'empty-bin') },
      home: root,
      recursiveRoots: [{ path: toolbox, maxDepth: 8 }],
      flatpakRoots: [],
      scanBudget: 100,
    })
    expect(await launcher.list()).toContainEqual({ id: 'intellij', name: 'IntelliJ IDEA' })
  })

  it('recognizes Flatpak exports and launches through the flatpak executable', async () => {
    const root = await tempRoot()
    const bin = join(root, 'bin')
    const exports = join(root, 'flatpak-applications')
    await executable(join(bin, 'flatpak'))
    await mkdir(exports, { recursive: true })
    await writeFile(join(exports, 'dev.zed.Zed.desktop'), '[Desktop Entry]\n')
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const spawn = successfulSpawn(calls)
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    const launcher = createIdeLauncher({
      platform: 'linux',
      env: { PATH: bin },
      home: root,
      recursiveRoots: [],
      flatpakRoots: [exports],
      spawn,
    })
    expect(await launcher.list()).toContainEqual({ id: 'zed', name: 'Zed' })
    await launcher.open('zed', cwd)
    expect(calls).toEqual([{ command: join(bin, 'flatpak'), args: ['run', 'dev.zed.Zed', cwd] }])
  })
})

function successfulSpawn(calls: Array<{ command: string; args: readonly string[] }>): IdeSpawn {
  return ((
    command: Parameters<IdeSpawn>[0],
    args: Parameters<IdeSpawn>[1],
    options: Parameters<IdeSpawn>[2],
  ) => {
    expect(options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true })
    calls.push({ command, args })
    const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> }
    child.unref = vi.fn()
    queueMicrotask(() => { child.emit('spawn') })
    return child
  }) as unknown as IdeSpawn
}

describe('IDE host launching', () => {
  it('spawns a detected executable with the cwd as one argv item and no shell', async () => {
    const root = await tempRoot()
    const bin = join(root, 'bin')
    const command = join(bin, 'code')
    const cwd = join(root, 'workspace with spaces')
    await executable(command)
    await mkdir(cwd)
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const launcher = createIdeLauncher({
      platform: 'linux',
      env: { PATH: bin },
      home: root,
      recursiveRoots: [],
      flatpakRoots: [],
      spawn: successfulSpawn(calls),
    })
    await launcher.open('vscode', cwd)
    expect(calls).toEqual([{ command, args: [cwd] }])
  })

  it('uses macOS open -a with the detected bundle path', async () => {
    const home = await tempRoot()
    const app = join(home, 'Applications', 'Cursor.app')
    const cwd = join(home, 'work')
    await mkdir(app, { recursive: true })
    await mkdir(cwd)
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const launcher = createIdeLauncher({
      platform: 'darwin',
      env: { PATH: '' },
      home,
      recursiveRoots: [],
      spawn: successfulSpawn(calls),
    })
    await launcher.open('cursor', cwd)
    expect(calls).toEqual([{ command: '/usr/bin/open', args: ['-a', app, cwd] }])
  })

  it('rejects unsupported ids and missing working directories before spawning', async () => {
    const root = await tempRoot()
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const launcher = createIdeLauncher({
      platform: 'linux',
      env: { PATH: '' },
      home: root,
      recursiveRoots: [],
      flatpakRoots: [],
      spawn: successfulSpawn(calls),
    })
    await expect(launcher.open('not-an-ide', root)).rejects.toMatchObject({ code: 'ide-not-found' } satisfies Partial<IdeLauncherError>)
    await expect(launcher.open('vscode', join(root, 'missing'))).rejects.toMatchObject({ code: 'ide-open-failed' } satisfies Partial<IdeLauncherError>)
    expect(calls).toHaveLength(0)
  })
})
