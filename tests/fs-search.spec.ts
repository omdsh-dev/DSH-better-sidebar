/**
 * fs-search: the host's recursive file-name search behind the editor side
 * panel's search box. Matches are case-insensitive name substrings, reported
 * RELATIVE to the root ('/'-separated); `.git` directories are skipped,
 * symlinked directories are never descended (cycle safety), and the
 * maxMatches/maxVisited budgets stop a runaway walk with `truncated: true`.
 */
import { describe, afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchFilesPlain, searchFiles } from '../src/fs-search.ts'
import type { EngineProbe } from '../src/search-engines.ts'
import { resetEngines, setEngineHooks } from '../src/search-engines.ts'

/**
 * Symlink creation needs extra privileges on Windows; the symlink case skips
 * there rather than fails (mirror of the fs-tree symlink spec).
 */
const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-probe-'))
  try {
    symlinkSync('target', join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

/** A scratch tree: nested matches, a .git dir, and unrelated noise. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'docs'))
  mkdirSync(join(dir, '.git'))
  mkdirSync(join(dir, '.git', 'objects'))
  writeFileSync(join(dir, 'README.md'), 'readme')
  writeFileSync(join(dir, 'src', 'Index.TS'), 'code')
  writeFileSync(join(dir, 'src', 'util.ts'), 'code')
  writeFileSync(join(dir, 'docs', 'guide.md'), 'doc')
  writeFileSync(join(dir, '.git', 'config'), 'git-internal')
  writeFileSync(join(dir, '.git', 'objects', 'readme-pack'), 'git-internal')
  return dir
}

describe('fs-search', () => {
  it('matches name substrings and reports root-relative /-separated paths', async () => {
    const dir = makeFixture()
    try {
      const result = await searchFilesPlain(dir, 'util')
      expect(result).toEqual({ matches: ['src/util.ts'], truncated: false })
      // A multi-level match list is sorted and relative (never absolute).
      const md = await searchFilesPlain(dir, '.md')
      expect(md.truncated).toBe(false)
      expect(md.matches).toEqual(['README.md', 'docs/guide.md'])
      for (const match of md.matches) {
        expect(match.startsWith(dir)).toBe(false)
        expect(match).not.toContain('\\')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('matches case-insensitively on the entry name', async () => {
    const dir = makeFixture()
    try {
      expect((await searchFilesPlain(dir, 'index.ts')).matches).toEqual(['src/Index.TS'])
      expect((await searchFilesPlain(dir, 'INDEX.TS')).matches).toEqual(['src/Index.TS'])
      // Directory names match too (the client can hint where matches live).
      expect((await searchFilesPlain(dir, 'SRC')).matches).toEqual(['src'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never descends into .git directories', async () => {
    const dir = makeFixture()
    try {
      // 'readme' would hit .git/objects/readme-pack if the walk entered .git.
      expect((await searchFilesPlain(dir, 'readme')).matches).toEqual(['README.md'])
      expect((await searchFilesPlain(dir, 'config')).matches).toEqual([])
      expect((await searchFilesPlain(dir, '.git')).matches).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A git worktree carries a `.git` FILE (a pointer to the real gitdir),
  // not a directory. It is VCS-internal noise exactly like the .git
  // directory and must never surface as a match — parity with fd's
  // --exclude .git and rg's '!**/.git' glob.
  it('never matches a worktree-style .git file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-'))
    try {
      writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt')
      writeFileSync(join(dir, 'util.ts'), 'code')
      expect(await searchFilesPlain(dir, '.git')).toEqual({ matches: [], truncated: false })
      expect((await searchFilesPlain(dir, 'util')).matches).toEqual(['util.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an empty (or whitespace) query matches nothing without walking', async () => {
    const dir = makeFixture()
    try {
      expect(await searchFilesPlain(dir, '')).toEqual({ matches: [], truncated: false })
      expect(await searchFilesPlain(dir, '   ')).toEqual({ matches: [], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSymlink)('does not descend into symlinked directories (cycle safety)', async () => {
    const dir = makeFixture()
    try {
      // A link back to the root would loop forever if descended; a link to
      // src would duplicate its matches. Neither must be entered.
      symlinkSync(dir, join(dir, 'loop'))
      symlinkSync(join(dir, 'src'), join(dir, 'src-link'))
      const result = await searchFilesPlain(dir, 'util')
      expect(result).toEqual({ matches: ['src/util.ts'], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops with truncated: true when the match budget is exceeded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-cap-'))
    try {
      for (let index = 0; index < 5; index += 1) {
        writeFileSync(join(dir, `match-${index}.txt`), 'x')
      }
      const result = await searchFilesPlain(dir, 'match', { maxMatches: 2 })
      expect(result.truncated).toBe(true)
      expect(result.matches.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stops with truncated: true when the visited budget is exceeded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-visited-'))
    try {
      for (let index = 0; index < 5; index += 1) {
        writeFileSync(join(dir, `file-${index}.txt`), 'x')
      }
      // The walk visits more entries than the budget allows and gives up.
      const result = await searchFilesPlain(dir, 'nomatch', { maxVisited: 3 })
      expect(result.truncated).toBe(true)
      expect(result.matches).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an unreadable root yields no matches instead of throwing', async () => {
    const dir = makeFixture()
    try {
      const missing = join(dir, 'does-not-exist')
      expect(await searchFilesPlain(missing, 'x')).toEqual({ matches: [], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** The fs.search dispatch: engine-first with the plain walk as fallback. */
describe('fs-search dispatch', () => {
  const fakeFd: EngineProbe = { engine: 'fd', binary: '/fake/fd' }

  afterEach(() => {
    resetEngines()
  })

  it('routes to the probed engine and normalizes its output', async () => {
    setEngineHooks({
      prober: async () => [fakeFd],
      runner: async (_probe, _root, query) => {
        expect(query).toBe('util')
        return { paths: ['src/util.ts', 'README.md'], truncated: false }
      },
    })
    expect(await searchFiles('/workspace', 'util')).toEqual({
      matches: ['README.md', 'src/util.ts'],
      truncated: false,
    })
  })

  it('an empty query never touches the engines', async () => {
    let probed = false
    setEngineHooks({
      prober: async () => { probed = true; return [fakeFd] },
      runner: async () => ({ paths: [], truncated: false }),
    })
    expect(await searchFiles('/workspace', '   ')).toEqual({ matches: [], truncated: false })
    expect(probed).toBe(false)
  })

  it('caps engine output at maxMatches and reports truncated', async () => {
    setEngineHooks({
      prober: async () => [fakeFd],
      runner: async () => ({ paths: ['a', 'b', 'c'], truncated: true }),
    })
    expect(await searchFiles('/workspace', 'x', { maxMatches: 2 })).toEqual({
      matches: ['a', 'b'],
      truncated: true,
    })
  })

  it('falls back to the plain walk when the engine fails at runtime', async () => {
    const dir = makeFixture()
    try {
      setEngineHooks({
        prober: async () => [fakeFd],
        runner: async () => { throw new Error('engine exploded') },
      })
      expect(await searchFiles(dir, 'util')).toEqual({ matches: ['src/util.ts'], truncated: false })
      // The failed engine is disabled for the rest of the process.
      let attempts = 0
      setEngineHooks({
        runner: async () => { attempts += 1; return { paths: [], truncated: false } },
      })
      expect(await searchFiles(dir, 'util')).toEqual({ matches: ['src/util.ts'], truncated: false })
      expect(attempts).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses the plain walk when no engine is probed', async () => {
    const dir = makeFixture()
    try {
      setEngineHooks({ prober: async () => [] })
      expect(await searchFiles(dir, 'util')).toEqual({ matches: ['src/util.ts'], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an aborted search skips both the engine retry and the walk', async () => {
    const dir = makeFixture()
    const controller = new AbortController()
    controller.abort()
    try {
      setEngineHooks({
        prober: async () => [fakeFd],
        runner: async () => { throw new Error('search aborted') },
      })
      expect(await searchFiles(dir, 'util', {}, controller.signal)).toEqual({
        matches: [],
        truncated: false,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
