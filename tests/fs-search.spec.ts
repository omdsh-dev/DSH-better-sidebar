/**
 * fs-search: the host's recursive file-name search behind the editor side
 * panel's search box. Matches are case-insensitive name substrings, reported
 * RELATIVE to the root ('/'-separated); `.git` directories are skipped,
 * symlinked directories are never descended (cycle safety), and the
 * maxMatches/maxVisited budgets stop a runaway walk with `truncated: true`.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchFiles } from '../src/fs-search.ts'

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
      const result = await searchFiles(dir, 'util')
      expect(result).toEqual({ matches: ['src/util.ts'], truncated: false })
      // A multi-level match list is sorted and relative (never absolute).
      const md = await searchFiles(dir, '.md')
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
      expect((await searchFiles(dir, 'index.ts')).matches).toEqual(['src/Index.TS'])
      expect((await searchFiles(dir, 'INDEX.TS')).matches).toEqual(['src/Index.TS'])
      // Directory names match too (the client can hint where matches live).
      expect((await searchFiles(dir, 'SRC')).matches).toEqual(['src'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never descends into .git directories', async () => {
    const dir = makeFixture()
    try {
      // 'readme' would hit .git/objects/readme-pack if the walk entered .git.
      expect((await searchFiles(dir, 'readme')).matches).toEqual(['README.md'])
      expect((await searchFiles(dir, 'config')).matches).toEqual([])
      expect((await searchFiles(dir, '.git')).matches).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an empty (or whitespace) query matches nothing without walking', async () => {
    const dir = makeFixture()
    try {
      expect(await searchFiles(dir, '')).toEqual({ matches: [], truncated: false })
      expect(await searchFiles(dir, '   ')).toEqual({ matches: [], truncated: false })
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
      const result = await searchFiles(dir, 'util')
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
      const result = await searchFiles(dir, 'match', { maxMatches: 2 })
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
      const result = await searchFiles(dir, 'nomatch', { maxVisited: 3 })
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
      expect(await searchFiles(missing, 'x')).toEqual({ matches: [], truncated: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
