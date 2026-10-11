/**
 * fs-search: the host's recursive file search behind the editor side panel's
 * search box. Name queries match case-insensitive name substrings, reported
 * RELATIVE to the root ('/'-separated); a separator-carrying query matches
 * the root-relative PATH instead (names never contain separators); and a
 * query naming one path (absolute, `~/…`, `./x`, `../x`) is resolved through
 * the same primitive fs.read uses and stat'ed into a direct-open hit (#879).
 * Noise directories (`.git`, `node_modules`, build caches, worktree
 * forests) are skipped, symlinked directories are never descended (cycle
 * safety), and the maxMatches/maxVisited budgets stop a runaway walk with
 * `truncated: true`. `searchFiles` is the dispatch the route calls (native
 * engines for name queries, this walk for fragments and as fallback) — the
 * walk itself is pinned directly as `searchFilesPlain`, and the dispatch
 * cases below inject fake engines so no machine binary is required.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
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

/**
 * A file NAMED `back\slash.ts` (the backslash is part of the name, not a
 * separator) is creatable on POSIX only — NTFS rejects a backslash inside a
 * name. The probe keeps the backslash-is-a-name-character case below
 * runnable exactly where such a name can exist, mirroring `canSymlink`.
 */
const canBackslashName = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-probe-'))
  try {
    writeFileSync(join(dir, 'back\\slash.ts'), 'x')
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

  // #879: git worktree forests (both spellings — `.worktrees/` is the layout
  // DeepSeek Harness itself uses) and Python envs / bytecode caches burned
  // the whole visit budget on real projects before the walk ever reached
  // project files, leaving `truncated: true` on every query. They are noise
  // of exactly the node_modules class: never matched, never descended.
  it('never descends into worktree forests or language environment dirs', async () => {
    const dir = makeFixture()
    try {
      for (const noise of ['.worktrees', '.worktree', 'target', 'venv', '.venv', '__pycache__']) {
        mkdirSync(join(dir, noise, 'pkg'), { recursive: true })
        writeFileSync(join(dir, noise, 'pkg', 'guide.md'), 'noise')
      }
      expect((await searchFilesPlain(dir, 'guide')).matches).toEqual(['docs/guide.md'])
      expect((await searchFilesPlain(dir, 'worktrees')).matches).toEqual([])
      expect((await searchFilesPlain(dir, 'target')).matches).toEqual([])
      expect((await searchFilesPlain(dir, 'venv')).matches).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // #879 / #306: a query carrying a path separator can never hit an entry
  // NAME (names never contain separators), so such a query matches against
  // the entry's root-relative PATH instead — a pasted `records/exp1` finds
  // the file under any depth, which name matching structurally cannot.
  it('a separator-carrying query matches the root-relative path, case-insensitively', async () => {
    const dir = makeFixture()
    try {
      mkdirSync(join(dir, 'deep', 'records'), { recursive: true })
      writeFileSync(join(dir, 'deep', 'records', 'exp1.txt'), 'x')
      // Fragment at depth, plus a root-anchored fragment against the fixture.
      expect(await searchFilesPlain(dir, 'records/exp1')).toEqual({ matches: ['deep/records/exp1.txt'], dirs: [], truncated: false })
      expect(await searchFilesPlain(dir, 'docs/guide')).toEqual({ matches: ['docs/guide.md'], dirs: [], truncated: false })
      expect((await searchFilesPlain(dir, 'RECORDS/EXP1')).matches).toEqual(['deep/records/exp1.txt'])
      // A fragment can hit a DIRECTORY by its path; the dirs split survives.
      expect(await searchFilesPlain(dir, 'deep/records')).toEqual({
        matches: ['deep/records', 'deep/records/exp1.txt'],
        dirs: ['deep/records'],
        truncated: false,
      })
      // The noise fences still apply to path matching.
      mkdirSync(join(dir, 'node_modules', 'records'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'records', 'exp1.txt'), 'dep')
      expect((await searchFilesPlain(dir, 'records/exp1')).matches).toEqual(['deep/records/exp1.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // POSIX: a backslash is a legal NAME character, not a separator — the
  // separator predicate must stay platform-faithful or name queries for
  // such files silently lose engine eligibility (the dispatch case below
  // pins that half). Here the WALK must find the file by its literal name.
  it.skipIf(!canBackslashName)('matches a literal backslash in an entry name (POSIX name character)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-backslash-'))
    try {
      writeFileSync(join(dir, 'back\\slash.ts'), 'x')
      writeFileSync(join(dir, 'plain.ts'), 'x')
      expect((await searchFilesPlain(dir, 'back\\slash')).matches).toEqual(['back\\slash.ts'])
      expect((await searchFilesPlain(dir, 'slash')).matches).toEqual(['back\\slash.ts'])
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

  // #879: a query that IS an absolute path is an open-this-file gesture.
  // It can never match a NAME, so every engine/walk pass below is
  // guaranteed-empty while still burning the visit budget. The target is
  // stat'ed instead: the hit is the path as pasted (the client's
  // resolveSidebarPath passes absolute paths through, and the fs routes
  // reach any host-user path since the workspace fence came off).
  it('an absolute query stats its target instead of searching', async () => {
    const dir = makeFixture()
    try {
      let probed = false
      setEngineHooks({
        prober: async () => { probed = true; return [fakeFd] },
        runner: async () => ({ paths: ['engine-would-return-this'], dirs: [], truncated: false }),
      })
      const target = join(dir, 'src', 'util.ts')
      expect(await searchFiles(dir, target)).toEqual({ matches: [target], dirs: [], truncated: false })
      // A directory target is reported through the #801 contract: the row
      // navigates the tree instead of being opened as a file.
      const folder = join(dir, 'src')
      expect(await searchFiles(dir, folder)).toEqual({ matches: [folder], dirs: [folder], truncated: false })
      expect(probed).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an absolute query that matches nothing is an immediate empty result', async () => {
    const dir = makeFixture()
    try {
      let probed = false
      setEngineHooks({
        prober: async () => { probed = true; return [fakeFd] },
        runner: async () => ({ paths: ['engine-would-return-this'], dirs: [], truncated: false }),
      })
      // maxVisited: 1 pins immediacy: a fall-through to any walk would abort
      // the traversal at the first entry and answer truncated:true, so
      // truncated:false proves the miss was answered without walking.
      expect(await searchFiles(dir, join(dir, 'gone.md'), { maxVisited: 1 })).toEqual({ matches: [], dirs: [], truncated: false })
      expect(probed).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The direct-open spellings resolve through the SAME primitive fs.read
  // uses (`resolveTarget`), and the RESOLVED path comes back — not the pasted
  // spelling: shell completion appends a trailing separator, and the client
  // compares match rows exactly against tree paths that never carry one.
  // `./x` / `../x` resolve against the session cwd; `~` names the home
  // directory (#713 — the resolution primitive expands it).
  it('direct-path spellings resolve like fs.read and yield the resolved path', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-anchor-'))
    const dir = join(parent, 'workspace')
    mkdirSync(dir, { recursive: true })
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'util.ts'), 'code')
      mkdirSync(join(parent, 'sibling'), { recursive: true })
      writeFileSync(join(parent, 'sibling', 'note.md'), 'doc')
      setEngineHooks({ prober: async () => [] })

      // Trailing separators (directory and file spellings) resolve away.
      expect(await searchFiles(dir, `${join(dir, 'src')}/`)).toEqual({
        matches: [join(dir, 'src')], dirs: [join(dir, 'src')], truncated: false,
      })
      expect(await searchFiles(dir, `${join(dir, 'src', 'util.ts')}/`)).toEqual({
        matches: [join(dir, 'src', 'util.ts')], dirs: [], truncated: false,
      })
      // Dot-anchored spellings resolve against the session cwd…
      expect(await searchFiles(dir, './src/util.ts')).toEqual({
        matches: [join(dir, 'src', 'util.ts')], dirs: [], truncated: false,
      })
      // …including one level up, which lands outside the cwd — the same
      // reach the workspace fence removal granted every fs route.
      expect(await searchFiles(dir, '../sibling/note.md')).toEqual({
        matches: [join(parent, 'sibling', 'note.md')], dirs: [], truncated: false,
      })
      // `~` expands to the home directory (the resolution primitive's own
      // #713 behavior); the hit is the resolved home path.
      expect((await searchFiles(dir, '~')).dirs).toEqual([resolvePath(homedir())])
      // A missing `~`-anchored target is the same immediate empty.
      expect(await searchFiles(dir, '~/dsh-sidebar-no-such-entry')).toEqual({ matches: [], dirs: [], truncated: false })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  // The direct-path predicate must steal no NAME query: only `~` followed by
  // a separator (or a bare `~`) is a path gesture, and only a dot followed
  // by a separator is. Backup files (`util.ts~`), Office lock files
  // (`~$doc.docx`) and dotfiles (`.env`) are NAMES and keep the name path.
  it('tilde and dot spellings without a separator stay name queries', async () => {
    const dir = makeFixture()
    try {
      writeFileSync(join(dir, 'util.ts~'), 'backup')
      writeFileSync(join(dir, '~$lock.docx'), 'lock')
      writeFileSync(join(dir, '.env'), 'env')
      let probed = false
      setEngineHooks({
        prober: async () => { probed = true; return [fakeFd] },
        runner: async () => ({ paths: [], dirs: [], truncated: false }),
      })
      // Engine eligibility IS the assertion (the fake engine answers empty —
      // a successful engine never falls back to the walk).
      await searchFiles(dir, 'util.ts~')
      expect(probed).toBe(true)
      // The name matches are proven on the walk (no engine probed). The
      // probe result is process-cached, so the hook swap needs a reset
      // before the engine-less prober takes effect.
      resetEngines()
      setEngineHooks({ prober: async () => [] })
      expect((await searchFiles(dir, 'util.ts~')).matches).toEqual(['util.ts~'])
      expect((await searchFiles(dir, '~$lock')).matches).toEqual(['~$lock.docx'])
      expect((await searchFiles(dir, '.env')).matches).toEqual(['.env'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The engines are NAME matchers (fd takes --fixed-strings without
  // --full-path; rg's three globs match single path segments), so a path
  // fragment would come back empty from fd and root-anchored-only from rg.
  // The walk's path matching is the single semantics for fragments.
  it('a separator query never reaches the name-matching engines', async () => {
    const dir = makeFixture()
    try {
      let probed = false
      setEngineHooks({
        prober: async () => { probed = true; return [fakeFd] },
        runner: async () => ({ paths: ['engine-would-return-this'], dirs: [], truncated: false }),
      })
      expect((await searchFiles(dir, 'docs/guide')).matches).toEqual(['docs/guide.md'])
      expect(probed).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // POSIX: a backslash is a legal name character, so a backslash query
  // stays a NAME query and keeps engine eligibility. If the separator
  // predicate ever treats '\' as a separator on POSIX, the probe assert
  // turns this red (the fragment branch bypasses engines).
  it.skipIf(!canBackslashName)('a backslash query stays a name query on POSIX (engines stay eligible)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-backslash-'))
    try {
      writeFileSync(join(dir, 'back\\slash.ts'), 'x')
      let probed = false
      setEngineHooks({
        prober: async () => { probed = true; return [fakeFd] },
        runner: async () => ({ paths: ['back\\slash.ts'], dirs: [], truncated: false }),
      })
      expect((await searchFiles(dir, 'back\\slash')).matches).toEqual(['back\\slash.ts'])
      expect(probed).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // POSIX: the separator in a dot-anchored gesture must be one of the
  // PLATFORM's own separators. `.\notes` is a legal entry NAME (a dot, then
  // a backslash) — reading it as a direct-open path stats a path that cannot
  // exist, so the name query and its engine eligibility are both lost.
  it.skipIf(!canBackslashName)('a dot-prefixed POSIX name with a backslash stays a name query', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-search-dotbackslash-'))
    try {
      writeFileSync(join(dir, '.\\notes.md'), 'x')
      let probed = false
      setEngineHooks({
        prober: async () => { probed = true; return [fakeFd] },
        runner: async () => ({ paths: ['.\\notes.md'], dirs: [], truncated: false }),
      })
      expect((await searchFiles(dir, '.\\notes')).matches).toEqual(['.\\notes.md'])
      expect(probed).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
