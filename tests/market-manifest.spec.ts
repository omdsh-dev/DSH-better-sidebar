/**
 * DSH community-market compatibility guard: keeps the npm package inside the
 * "Host 接受什么" rules of dsh-community-market's
 * docs/install-and-uninstall.zh.md, so the catalog's verified npm install
 * target (repository_backlink) keeps passing for this package:
 *
 * - no `cordis` entry in dependencies / peerDependencies /
 *   optionalDependencies (the market preview hard-rejects the legacy Cordis
 *   runtime name in any of the three fields, even when optional),
 * - no install lifecycle scripts (preinstall / install / postinstall /
 *   prepare) in the **packed** manifest — the repo manifest legitimately
 *   keeps `prepare` for git-install builds; pnpm strips it from the published
 *   surface, and this guard verifies that stripped surface stays clean,
 * - a safe, bund-visible `dsh.bundle.patch` path (`./cordis.patch.yml`),
 * - a repository identity that normalizes to a credential-free HTTPS GitHub
 *   owner/repo URL (the catalog ↔ npm backlink comparison),
 * - an exact SemVer version (no ranges, no tags; a prerelease suffix is
 *   allowed — prerelease releases ride the npm `alpha` dist-tag and are not
 *   the market's verified `latest` install target until a stable cut).
 *
 * The packed-manifest checks run `pnpm pack` into a temp dir (the `prepare`
 * script rebuilds the gitignored lib/, like the release flow does).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  name: string
  version: string
  repository?: { type?: string; url?: string }
  engines?: { node?: string }
  dsh?: { bundle?: { patch?: string } }
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** The market's lifecycle-script reject list (install-and-uninstall.zh.md). */
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const

/** Exact SemVer: exactly three numeric segments, optional prerelease suffix
 *  (no range / tag — prerelease cuts publish under the npm `alpha` dist-tag). */
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

/** Read `package.json` from a fresh `pnpm pack` tarball (the publish surface). */
function packedManifest(): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'market-pack-'))
  try {
    // On Windows `pnpm` ships as a `.cmd` shim that `execFileSync` cannot
    // spawn directly (ENOENT). Run it through the shell so the same call
    // works on every platform; `tar` is available on all supported OSes.
    execFileSync('pnpm', ['pack', '--pack-destination', dir], { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' })
    // Never hand tar an absolute Windows path: Git Bash's GNU tar reads the
    // drive-letter colon as a remote-host spec ("Cannot connect to C:").
    // Run it from the pack dir with the bare tarball name instead.
    execFileSync('tar', ['-xzf', `${pkg.name}-${pkg.version}.tgz`, 'package/package.json'], { cwd: dir, stdio: 'pipe' })
    return JSON.parse(readFileSync(join(dir, 'package/package.json'), 'utf8')) as Record<string, unknown>
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('DSH community-market manifest compatibility', () => {
  it('declares no cordis entry in any dependency field (dependencies / peerDependencies / optionalDependencies)', () => {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const deps = pkg[field]
      if (deps === undefined) continue
      expect(Object.keys(deps), field).not.toContain('cordis')
    }
  })

  it('declares no install lifecycle scripts in the PACKED manifest (the published surface)', () => {
    const packed = packedManifest()
    const scripts = (packed.scripts as Record<string, string> | undefined) ?? {}
    for (const script of LIFECYCLE_SCRIPTS) {
      expect(scripts, script).not.toHaveProperty(script)
    }
  }, 180000)

  it('declares a safe bundle patch that exists inside the package', () => {
    const patch = pkg.dsh?.bundle?.patch
    expect(patch, 'dsh.bundle.patch').toBeDefined()
    const path = patch!
    expect(path.startsWith('./'), 'must be a relative path').toBe(true)
    const relative = path.slice(2)
    expect(relative).not.toBe('')
    expect(relative.startsWith('/')).toBe(false)
    expect(relative.includes('\\')).toBe(false)
    expect(relative.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..'))
      .toBe(true)
    expect(existsSync(resolve(ROOT, relative)), relative).toBe(true)
  })

  it('declares a repository identity the market can normalize to a credential-free HTTPS GitHub owner/repo URL', () => {
    const repository = pkg.repository
    expect(repository, 'repository').toBeDefined()
    const url = new URL(repository!.url!)
    expect(url.protocol).toBe('https:')
    expect(url.username).toBe('')
    expect(url.password).toBe('')
    expect(url.search).toBe('')
    expect(url.hash).toBe('')
    expect(url.hostname.toLowerCase()).toBe('github.com')
    expect(url.pathname.split('/').filter(Boolean)).toHaveLength(2)
  })

  it('declares an exact SemVer version (no range or tag; prerelease allowed for the alpha track)', () => {
    expect(pkg.version).toMatch(EXACT_SEMVER)
  })
})
