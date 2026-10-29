/**
 * The worktree family of path bugs: #947 (a chat link into a worktree doubled
 * its path into an ENOENT) and #950 (the same relative path resolving to two
 * different checkouts, silently).
 *
 * Both come from ONE rule the plugin broke: a session-scoped file ADDRESS
 * (`dsh-resource://file/session/<sid>/<path>`) is built and read against the
 * session's stored header cwd — the host does it that way on both ends — while
 * the plugin's own filesystem routes follow the ACTIVE git worktree (#802).
 * A relative path in an address, re-resolved by a worktree-rooted reader,
 * therefore lands on `<worktree>/<the path the header cwd was stripped from>`
 * (ENOENT) or on the same-named file of another checkout (silent).
 *
 * The fix this spec pins: the address's base is the stored cwd, and the
 * address's path becomes ABSOLUTE at the boundary where the address is read,
 * so no worktree-rooted code downstream can re-base it.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addressBaseOf, resolveAddressPath } from '../src/client/address-base.ts'
import { fileParamsOf } from '../src/client/native/index.ts'
import { createNativeSurface } from '../src/client/native/surface.ts'
import { resolveSidebarPath } from '../src/client/paths.ts'
import { fileAddressFor, parseFileAddress } from '../src/client/resource-address.ts'
import { openClaimedNativeFile, openSidebarFile } from '../src/client/sidebar-file.ts'
import type { Context } from '../src/context-types.ts'

const IDENTITY = {
  GIT_AUTHOR_NAME: 'worktree-address-test',
  GIT_AUTHOR_EMAIL: 'test@dsh.invalid',
  GIT_COMMITTER_NAME: 'worktree-address-test',
  GIT_COMMITTER_EMAIL: 'test@dsh.invalid',
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...IDENTITY },
  })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout
}

/** One scratch checkout pair: the main workspace and a worktree INSIDE it. */
interface Fixture {
  /** The session's stored header cwd (the main checkout). */
  readonly repo: string
  /** The linked worktree the agent actually works in, nested under `repo`. */
  readonly worktree: string
  readonly cleanup: () => void
}

/**
 * `git worktree add <repo>/frontend/.worktrees/wt` — the layout #947 was
 * reported against, and the one that makes an address's stripped prefix
 * collide with the worktree root.
 */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worktree-address-'))
  const repoRaw = join(root, 'repo')
  const worktreeRaw = join(repoRaw, 'frontend', '.worktrees', 'wt')
  mkdirSync(join(repoRaw, 'src'), { recursive: true })
  // A same-named file in both checkouts: the silent half of the bug (#950).
  writeFileSync(join(repoRaw, 'src', 'a.ts'), 'main checkout\n')
  git(repoRaw, ['init', '-q'])
  git(repoRaw, ['checkout', '-q', '-b', 'main'])
  git(repoRaw, ['add', '-A'])
  git(repoRaw, ['commit', '-q', '-m', 'base'])
  mkdirSync(join(repoRaw, 'frontend', '.worktrees'), { recursive: true })
  git(repoRaw, ['worktree', 'add', '-q', '-b', 'agent', worktreeRaw])
  writeFileSync(join(worktreeRaw, 'src', 'a.ts'), 'worktree checkout\n')
  const repo = realpathSync.native(repoRaw)
  const worktree = realpathSync.native(worktreeRaw)
  return { repo, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

interface Harness {
  readonly ctx: Context
  /** Seeds handed to `ctx.betterSidebar.openTab`. */
  readonly opened: Record<string, unknown>[]
  /** Addresses handed to `ctx.sidebarRight.openResource`. */
  readonly resources: string[]
}

/**
 * A client context with one session at `cwd` plus the optional native faces.
 * @param cwd - the session list's stored header cwd.
 * @param claiming - whether a type other than this plugin's editor claims files.
 */
function makeCtx(cwd: string, claiming = false): Harness {
  const opened: Record<string, unknown>[] = []
  const resources: string[] = []
  const byId = { s1: { cwd } }
  const ctx = {
    // `subscribe` is what `createNativeSurface` keeps for its session pulse.
    sessions: { list: { getSnapshot: () => ({ byId }), subscribe: () => () => {} } },
    get: (name: string) => {
      if (name === 'sidebarRightTabs') {
        return claiming ? { candidates: () => [{ kind: 'drawio' }] } : { candidates: () => [{ kind: 'editor' }] }
      }
      if (name === 'sidebarRight') return { openResource: (address: string) => void resources.push(address) }
      if (name === 'betterSidebar') return { openTab: (seed: Record<string, unknown>) => void opened.push(seed) }
      return undefined
    },
  }
  return { ctx: ctx as unknown as Context, opened, resources }
}

/**
 * The native tab record a file address renders as. Typed through the seed
 * function's own parameter so this spec needs no un-exported host type.
 */
function infoOf(address: string): Parameters<typeof fileParamsOf>[0] {
  return {
    tab: { id: 'tab1', kind: 'editor', title: 'a.ts', contentId: address, navigation: { params: {} } },
  } as unknown as Parameters<typeof fileParamsOf>[0]
}

describe('address base (worktree sessions)', () => {
  it('addressBaseOf answers the stored session cwd, or nothing it does not know', () => {
    const { ctx } = makeCtx('/repo')
    expect(addressBaseOf(ctx, 's1')).toBe('/repo')
    expect(addressBaseOf(ctx, 'unknown-session')).toBeUndefined()
    expect(addressBaseOf(ctx, undefined)).toBeUndefined()
    expect(addressBaseOf({} as never, 's1')).toBeUndefined()
  })

  it('seeds an absolute path for an address whose base is the header cwd (#947)', () => {
    const fixture = makeFixture()
    try {
      const absolute = join(fixture.worktree, 'src', 'a.ts')
      // Exactly what the host builds for a chat link that names the worktree
      // file by its absolute path: the header cwd prefix is stripped and the
      // address carries a path relative to THAT base.
      const address = `dsh-resource://file/session/s1/frontend/.worktrees/wt/src/a.ts`
      expect(fileAddressFor('s1', fixture.repo, absolute)).toBe(address)
      expect(parseFileAddress(address)!.path).toBe('frontend/.worktrees/wt/src/a.ts')

      const seeded = fileParamsOf(infoOf(address), fixture.repo)
      expect(seeded).toEqual({ path: absolute })
      const seededPath = seeded?.path as string
      // The seed is absolute, so the tab body's worktree root cannot re-base
      // it — this is the whole fix.
      expect(resolveSidebarPath(fixture.worktree, seededPath)).toBe(absolute)
      expect(existsSync(seededPath)).toBe(true)
      // What the plugin used to do with the bare relative path: join it onto
      // the worktree root again and miss.
      expect(existsSync(join(fixture.worktree, 'frontend', '.worktrees', 'wt', 'src', 'a.ts'))).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  it('keeps the address-relative spelling when no base is known (no session context)', () => {
    const address = 'dsh-resource://file/session/s1/frontend/.worktrees/wt/src/a.ts?x=1'
    expect(fileParamsOf(infoOf(address))?.path).toBe('frontend/.worktrees/wt/src/a.ts')
    // The `path:line` spec still splits off the resolved path (#826).
    expect(fileParamsOf(infoOf('dsh-resource://file/session/s1/src/a.ts:42'), '/repo'))
      .toEqual({ path: '/repo/src/a.ts', title: 'a.ts', line: 42 })
  })

  it('spells the resolved path in the base separator style (one spelling per file)', () => {
    // The address grammar is `/`-separated on EVERY platform, so joining it
    // onto a Windows base must not leave `C:\repo\src/a.ts`: the file tree and
    // every `join`-based producer spell the same file `C:\repo\src\a.ts`, and
    // two spellings of one file are two tab identities (the editor's id and
    // dedupeKey are path-derived). CI caught exactly this on the Windows lane.
    expect(fileParamsOf(infoOf('dsh-resource://file/session/s1/src/a.ts'), 'C:\\repo'))
      .toEqual({ path: 'C:\\repo\\src\\a.ts' })
    expect(fileParamsOf(infoOf('dsh-resource://file/session/s1/src/a.ts'), '/repo'))
      .toEqual({ path: '/repo/src/a.ts' })
    // Relative intent resolves through the same rule; POSIX keeps the path
    // verbatim, because there `\` is a legal file-name character, not a
    // separator (`resolveSidebarPath` never folds on POSIX either).
    expect(resolveAddressPath('C:\\repo', 'src\\a.ts')).toBe('C:\\repo\\src\\a.ts')
    expect(resolveAddressPath('/repo', 'src/a.ts')).toBe('/repo/src/a.ts')
    expect(resolveAddressPath('/repo', 'a\\b.ts')).toBe('/repo/a\\b.ts')
  })

  it('keeps a UNC prefix when folding separators (Windows + WSL workspace)', () => {
    // A UNC root is ONE path root, not a separator run: folding its `\\` into
    // `\` left a drive-root-relative path, which the host then re-anchored on
    // its process drive with `path.resolve()` (`C:\wsl.localhost\...`), so
    // every file opened from a `\\wsl.localhost\<distro>\...` workspace failed
    // with ENOENT. The prefix must survive, only the body is re-spelled.
    const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
    const file = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\src\\a.ts'
    expect(resolveAddressPath(root, file)).toBe(file)
    expect(resolveAddressPath(root, 'src/a.ts')).toBe(file)
    // A forward-slash UNC spelling folds to the base style, prefix intact.
    expect(resolveAddressPath(root, '//wsl.localhost/Ubuntu/home/me/repo/src/a.ts')).toBe(file)
  })

  it('builds every plugin address on the session base, never on the caller root', () => {
    const fixture = makeFixture()
    try {
      const absolute = join(fixture.worktree, 'src', 'a.ts')
      const expected = fileAddressFor('s1', fixture.repo, absolute)
      const harness = makeCtx(fixture.repo, true)

      // `openSidebarFile` hands the claiming type the address …
      openSidebarFile(harness.ctx, 's1', absolute, { cwd: fixture.worktree })
      expect(harness.resources).toEqual([expected])
      // … and the seed its body derives from that address is the real file.
      expect(fileParamsOf(infoOf(harness.resources[0]!), fixture.repo)?.path).toBe(absolute)

      // A caller passing the worktree root (what `service.openTab` does after
      // #802) must not move the base: the same file keeps ONE address.
      expect(openClaimedNativeFile(harness.ctx, 's1', fixture.worktree, absolute)).toBe(true)
      expect(harness.resources[1]).toBe(expected)

      // The surface's own address builder follows the same rule.
      const surface = createNativeSurface(harness.ctx, {} as never)
      expect(surface.fileAddress('s1', fixture.worktree, absolute)).toBe(expected)
      expect(surface.fileAddress('s1', undefined, absolute)).toBe(expected)
    } finally {
      fixture.cleanup()
    }
  })

  it('resolves a relative path against the live root, and the stored cwd only as a fallback (#950)', () => {
    const fixture = makeFixture()
    try {
      // The tree, the routes and the editor's path input all use the live
      // worktree root, so a relative open from a plugin surface must too.
      const live = makeCtx(fixture.repo)
      openSidebarFile(live.ctx, 's1', 'src/a.ts', { cwd: fixture.worktree })
      expect(live.opened[0]!.path).toBe(join(fixture.worktree, 'src', 'a.ts'))

      // Without a caller root the stored cwd remains the documented fallback.
      const fallback = makeCtx(fixture.repo)
      openSidebarFile(fallback.ctx, 's1', 'src/a.ts')
      expect(fallback.opened[0]!.path).toBe(join(fixture.repo, 'src', 'a.ts'))
    } finally {
      fixture.cleanup()
    }
  })
})
