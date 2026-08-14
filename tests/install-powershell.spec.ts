import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const INSTALLER = resolve(ROOT, 'scripts/install.ps1')
const INSTALLER_URL = 'https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/scripts/install.ps1'
const tempDirs: string[] = []
const hasPwsh = process.platform === 'win32'
  && spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0

interface InstallerFixture {
  home: string
  path: string
  workspace: string
}

function createFixture(pnpmVersion: string): InstallerFixture {
  const root = mkdtempSync(join(tmpdir(), 'dshbs-install-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'web')
  const bin = join(root, 'bin')
  mkdirSync(profile, { recursive: true })
  mkdirSync(bin)
  const workspace = 'packages:\n  - .\n'
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), workspace)
  writeFileSync(join(bin, 'pnpm.cmd'), `@echo off\r\necho ${pnpmVersion}\r\n`)
  return {
    home,
    workspace,
    path: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  }
}

function runPowerShell(executable: string, args: string[], fixture: InstallerFixture) {
  return spawnSync(executable, ['-NoLogo', '-NoProfile', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_CMD: 'dsh',
      DSH_HOME: fixture.home,
      INSTALLER_PATH: INSTALLER,
      PATH: fixture.path,
    },
  })
}

function assertInMemoryInvocation(executable: string): void {
  const fixture = createFixture('10.34.5')
  const command = [
    '$bytes = [IO.File]::ReadAllBytes($env:INSTALLER_PATH)',
    '$script = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF)',
    '& ([scriptblock]::Create($script)) -Version 0.11.0 -DryRun',
  ].join('; ')
  const result = runPowerShell(executable, ['-Command', command], fixture)
  const output = `${result.stdout}\n${result.stderr}`

  expect(result.status, output).toBe(0)
  expect(output).toContain('dsh-better-sidebar@0.11.0')
  expect(output).toContain('[dry-run]')
  expect(output).not.toContain('False False')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('PowerShell installer entry points', () => {
  it('keeps the UTF-8 BOM required by Windows PowerShell 5.1 -File decoding', () => {
    expect(readFileSync(INSTALLER).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  })

  it('documents only BOM-safe in-memory invocation', () => {
    for (const file of ['README.md', 'README_EN.md', 'scripts/install.ps1']) {
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      expect(source, file).not.toMatch(new RegExp(`irm [^\\r\\n]*${INSTALLER_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\r\\n]*\\|\\s*iex`, 'i'))
      expect(source, file).not.toMatch(/\[scriptblock\]::Create\(\(irm\b/i)
      expect(source.match(/\.TrimStart\(\[char\]0xFEFF\)/g)?.length, file).toBeGreaterThanOrEqual(2)
    }
  })

  it('keeps the versioned installer usage example self-contained', () => {
    const source = readFileSync(INSTALLER, 'utf8')
    const versionedExample = source.slice(
      source.indexOf('#   # 指定版本 / 装完重启'),
      source.indexOf('#   # 本地保存后运行'),
    )

    expect(versionedExample).toContain(INSTALLER_URL)
    expect(versionedExample).toContain('.TrimStart([char]0xFEFF)')
    expect(versionedExample).toContain('-Version 0.10.2 -Restart')
  })

  it.runIf(process.platform === 'win32')('binds parameters when loaded into memory by Windows PowerShell 5.1', () => {
    assertInMemoryInvocation('powershell.exe')
  })

  it.runIf(hasPwsh)('binds parameters when loaded into memory by pwsh, when available', () => {
    assertInMemoryInvocation('pwsh')
  })

  it.runIf(process.platform === 'win32')('retains the Windows PowerShell 5.1 -File entry point', () => {
    const fixture = createFixture('10.34.5')
    const result = runPowerShell('powershell.exe', [
      '-ExecutionPolicy', 'Bypass', '-File', INSTALLER, '-Version', '0.11.0', '-DryRun',
    ], fixture)
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status, output).toBe(0)
    expect(output).toContain('dsh-better-sidebar@0.11.0')
    expect(output).toContain('[dry-run]')
  })

  it.runIf(process.platform === 'win32')('rejects pnpm 8 before changing the profile', () => {
    const fixture = createFixture('8.15.9')
    const workspacePath = join(fixture.home, 'profiles', 'web', 'pnpm-workspace.yaml')
    const result = runPowerShell('powershell.exe', [
      '-ExecutionPolicy', 'Bypass', '-File', INSTALLER, '-Version', '0.11.0', '-DryRun',
    ], fixture)
    const output = `${result.stdout}\n${result.stderr}`

    expect(result.status, output).toBe(1)
    expect(output).toContain('pnpm >= 10')
    expect(readFileSync(workspacePath, 'utf8')).toBe(fixture.workspace)
  })
})
