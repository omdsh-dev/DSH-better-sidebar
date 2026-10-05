/**
 * fs-search: the host's recursive file-name search behind the editor side
 * panel's search box. Matches are case-insensitive name substrings, reported
 * RELATIVE to the root ('/'-separated); noise directories (`.git`,
 * `node_modules`, build caches) are skipped, symlinked directories are
 * never descended (cycle safety), and the maxMatches/maxVisited budgets
 * stop a runaway walk with `truncated: true`. `searchFiles` is the dispatch
 * the route calls (native engines first, this walk as fallback) — the walk
 * itself is pinned directly as `searchFilesPlain`, and the dispatch cases
 * below inject fake engines so no machine binary is required.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileExcludePatterns } from '../src/exclude-patterns.ts'
import { searchFiles, searchFilesPlain } from '../src/fs-search.ts'
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
  // The walk is pinned directly; the dispatch is exercised in its own block
  // below with injected engines. This hook keeps any accidental probe out of
  // these cases (CI has no fd, real machines may).
  beforeEach(() => {
    setEngineHooks({ prober: async () => [] })
  })

  afterEach(() => {
    resetEngines()
  })

  it('matches name substrings and reports root-relative /-separated paths', async () => {
    const dir = makeFixture()
    try {
      const result = await searchFilesPlain(dir, 'util')
      expect(result).toEqual({ matches: ['src/util.ts'], dirs: [], truncated: false })
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
      const dirHit = await searchFilesPlain(dir, 'SRC')
      // Directory names match too (the client can hint where matches live)…
      expect(dirHit.matches).toEqual(['src'])
      // …and they are reported as directories, so the list navigates the tree
      // instead of opening one as a file (`fs.read` refuses a directory).
      expect(dirHit).toEqual({ matches: ['src'], dirs: ['src'], truncated: false })
      expect((await searchFilesPlain(dir, 'util')).dirs).toEqual([])
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

  // A git worktree carries a `.git` FILE (a pointer to the real gitdir), not
  // a directory. It is VCS-internal noise exactly like the .git directory and
  // must never surface as a match — parity with fd's --exclude .git and rg's
  // '!**/.git' glob pair.
  it('never matches a worktree-style .git file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-'))
    try {
      writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt')
      writeFileSync(join(dir, 'util.ts'), 'code')
      expect(await searchFilesPlain(dir, '.git')).toEqual({ matches: [], dirs: [], truncated: false })
      expect((await searchFilesPlain(dir, 'util')).matches).toEqual(['util.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the exclude probe removes entries and stops descent (in lockstep with the tree)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-exclude-'))
    try {
      mkdirSync(join(dir, 'third_party', 'pkg'), { recursive: true })
      mkdirSync(join(dir, 'src'))
      writeFileSync(join(dir, 'third_party', 'pkg', 'index.ts'), 'dep')
      writeFileSync(join(dir, 'third_party', 'index.ts'), 'dep')
      writeFileSync(join(dir, 'src', 'index.ts'), 'code')
      writeFileSync(join(dir, 'debug.log'), 'log')
      const exclude = compileExcludePatterns(['third_party', '*.log'], dir)
      // Excluded names never match AND their subtrees are never walked.
      expect((await searchFiles(dir, 'index', { exclude })).matches).toEqual(['src/index.ts'])
      expect((await searchFiles(dir, 'log', { exclude })).matches).toEqual([])
      // A directory hit disappears with the exclusion (no dangling nav row).
      expect((await searchFiles(dir, 'third_party', { exclude })).dirs).toEqual([])
      // Without the probe the junk level matches and is descended.
      expect((await searchFiles(dir, 'index')).matches)
        .toEqual(['src/index.ts', 'third_party/index.ts', 'third_party/pkg/index.ts'])
      expect((await searchFiles(dir, 'third_party')).dirs).toEqual(['third_party'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never descends into node_modules or other noise directories', async () => {
    const dir = makeFixture()
    try {
      mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
      mkdirSync(join(dir, 'web', 'dist'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'left-pad', 'guide.md'), 'dep')
      writeFileSync(join(dir, 'web', 'dist', 'bundle.js'), 'build')
      writeFileSync(join(dir, 'web', 'app.ts'), 'src')
      // A match hidden behind node_modules / dist must not appear; project
      // files after those forests must still be reachable within budget.
      expect((await searchFilesPlain(dir, 'guide')).matches).toEqual(['docs/guide.md'])
      expect((await searchFilesPlain(dir, 'left-pad')).matches).toEqual([])
      expect((await searchFilesPlain(dir, 'bundle')).matches).toEqual([])
      expect((await searchFilesPlain(dir, 'app.ts')).matches).toEqual(['web/app.ts'])
      expect((await searchFilesPlain(dir, 'node_modules')).matches).toEqual([])
      expect((await searchFilesPlain(dir, 'dist')).matches).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an empty (or whitespace) query matches nothing without walking', async () => {
    const dir = makeFixture()
    try {
      expect(await searchFilesPlain(dir, '')).toEqual({ matches: [], dirs: [], truncated: false })
      expect(await searchFilesPlain(dir, '   ')).toEqual({ matches: [], dirs: [], truncated: false })
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
      expect(result).toEqual({ matches: ['src/util.ts'], dirs: [], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSymlink)('classifies a symlinked hit by its target (link to a directory is a directory)', async () => {
    const dir = makeFixture()
    try {
      symlinkSync(join(dir, 'src'), join(dir, 'src-link'))
      symlinkSync(join(dir, 'README.md'), join(dir, 'readme-link.md'))
      // `fs.read` stats through the link, so a link to a directory must be
      // reported as a directory row too; a link to a file stays a file hit.
      expect(await searchFilesPlain(dir, 'src-link')).toEqual({ matches: ['src-link'], dirs: ['src-link'], truncated: false })
      expect(await searchFilesPlain(dir, 'readme-link')).toEqual({ matches: ['readme-link.md'], dirs: [], truncated: false })
      // A dangling link cannot be classified, so it stays a plain entry.
      symlinkSync(join(dir, 'gone'), join(dir, 'dangling-link'))
      expect(await searchFilesPlain(dir, 'dangling-link')).toEqual({ matches: ['dangling-link'], dirs: [], truncated: false })
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
      expect(await searchFilesPlain(missing, 'x')).toEqual({ matches: [], dirs: [], truncated: false })
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
        // The engine contract already carries the dirs split.
        return { paths: ['src/util.ts', 'README.md'], dirs: [], truncated: false }
      },
    })
    expect(await searchFiles('/workspace', 'util')).toEqual({
      matches: ['README.md', 'src/util.ts'],
      dirs: [],
      truncated: false,
    })
  })

  // The dispatch must hand the engine the CALLER's budgets, not its own
  // defaults: the route's maxMatches is what caps the flat list.
  it('passes the caller budgets through to the engine', async () => {
    let seen: number | undefined
    setEngineHooks({
      prober: async () => [fakeFd],
      runner: async (_probe, _root, _query, maxMatches) => {
        seen = maxMatches
        return { paths: [], dirs: [], truncated: false }
      },
    })
    await searchFiles('/workspace', 'util', { maxMatches: 7 })
    expect(seen).toBe(7)
  })

  // #801: a directory hit must reach the client in `dirs` (it navigates the
  // tree) instead of being opened as a file. The engine output supplies the
  // split, and it has to survive the dispatch verbatim.
  it('forwards directory hits so the client navigates instead of opening them', async () => {
    setEngineHooks({
      prober: async () => [fakeFd],
      runner: async () => ({ paths: ['src', 'src/util.ts'], dirs: ['src'], truncated: false }),
    })
    expect(await searchFiles('/workspace', 'util')).toEqual({
      matches: ['src', 'src/util.ts'],
      dirs: ['src'],
      truncated: false,
    })
  })

  it('an empty query never touches the engines', async () => {
    let probed = false
    setEngineHooks({
      prober: async () => { probed = true; return [fakeFd] },
      runner: async () => ({ paths: [], dirs: [], truncated: false }),
    })
    expect(await searchFiles('/workspace', '   ')).toEqual({ matches: [], dirs: [], truncated: false })
    expect(probed).toBe(false)
  })

  it('caps engine output at maxMatches and reports truncated', async () => {
    setEngineHooks({
      prober: async () => [fakeFd],
      runner: async () => ({ paths: ['a', 'b', 'c'], dirs: [], truncated: true }),
    })
    expect(await searchFiles('/workspace', 'x', { maxMatches: 2 })).toEqual({
      matches: ['a', 'b'],
      dirs: [],
      truncated: true,
    })
  })

  // The engine's cap is a sentinel (maxMatches + 1), so a truncated run can
  // carry a directory row the slice just dropped. `dirs` is the DIRECTORY
  // SUBSET of `matches` (TreePanel's `dirHits` lookup depends on it), so the
  // dispatch re-derives it from what it kept.
  it('never reports a directory that the match slice dropped', async () => {
    setEngineHooks({
      prober: async () => [fakeFd],
      runner: async () => ({ paths: ['a-dir', 'a-file', 'b'], dirs: ['a-dir', 'b'], truncated: true }),
    })
    expect(await searchFiles('/workspace', 'x', { maxMatches: 2 })).toEqual({
      matches: ['a-dir', 'a-file'],
      dirs: ['a-dir'],
      truncated: true,
    })
  })

  // The user's exclude list is a property of the SEARCH, not of the walk: the
  // engines hand back a flat listing, so the dispatch post-filters it with the
  // same compiled probe. A matching row must vanish — and so must every row
  // under an excluded directory, which the walk could never have reported
  // (it never descended into one).
  it('applies the exclude probe to engine output (rows and their subtrees)', async () => {
    setEngineHooks({
      prober: async () => [fakeFd],
      runner: async () => ({
        paths: ['src/index.ts', 'third_party/index.ts', 'third_party/pkg/index.ts', 'debug.log'],
        dirs: ['third_party'],
        truncated: false,
      }),
    })
    const exclude = compileExcludePatterns(['third_party', '*.log'], '/workspace')
    expect(await searchFiles('/workspace', 'index', { exclude })).toEqual({
      matches: ['src/index.ts'],
      dirs: [],
      truncated: false,
    })
    // Without the probe the engine listing passes through untouched.
    expect((await searchFiles('/workspace', 'index')).matches)
      .toEqual(['debug.log', 'src/index.ts', 'third_party/index.ts', 'third_party/pkg/index.ts'])
  })

  it('falls back to the plain walk when the engine fails at runtime', async () => {
    const dir = makeFixture()
    try {
      setEngineHooks({
        prober: async () => [fakeFd],
        runner: async () => { throw new Error('engine exploded') },
      })
      expect(await searchFiles(dir, 'util')).toEqual({ matches: ['src/util.ts'], dirs: [], truncated: false })
      // The failed engine is disabled for the rest of the process.
      let attempts = 0
      setEngineHooks({
        runner: async () => { attempts += 1; return { paths: [], dirs: [], truncated: false } },
      })
      expect(await searchFiles(dir, 'util')).toEqual({ matches: ['src/util.ts'], dirs: [], truncated: false })
      expect(attempts).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses the plain walk when no engine is probed', async () => {
    const dir = makeFixture()
    try {
      setEngineHooks({ prober: async () => [] })
      expect(await searchFiles(dir, 'util')).toEqual({ matches: ['src/util.ts'], dirs: [], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
