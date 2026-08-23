import { describe, expect, it } from 'vitest'
import {
  gitBadgeOf, gitDecorations, gitKey, gitRelOf, owningRepo,
} from '../src/client/git-decor.ts'
import type { GitStatusResult } from '../src/client/api.ts'

/** A minimal status snapshot fixture. */
function status(entries: GitStatusResult['entries'], root = '/Users/me/code'): GitStatusResult {
  return { isRepo: true, branch: 'main', root, entries }
}

describe('gitBadgeOf', () => {
  it('prefers the index letter, then the worktree letter', () => {
    expect(gitBadgeOf({ path: 'a.ts', xy: 'M ' })).toBe('M')
    expect(gitBadgeOf({ path: 'a.ts', xy: ' M' })).toBe('M')
    expect(gitBadgeOf({ path: 'a.ts', xy: 'MM' })).toBe('M')
    expect(gitBadgeOf({ path: 'a.ts', xy: 'A ' })).toBe('A')
    expect(gitBadgeOf({ path: 'a.ts', xy: ' D' })).toBe('D')
  })

  it('maps untracked (??) to the "?" mark', () => {
    expect(gitBadgeOf({ path: 'new.ts', xy: '??' })).toBe('?')
  })
})

describe('gitKey / gitRelOf', () => {
  it('normalizes separators and casing for comparison keys', () => {
    expect(gitKey('src/A.ts')).toBe('src/a.ts')
    expect(gitKey('a\\b.ts')).toBe('a/b.ts')
  })

  it('derives repo-relative keys from absolute paths (and "" for the root)', () => {
    expect(gitRelOf('/Users/me/code', '/Users/me/code/src/main.ts')).toBe('src/main.ts')
    expect(gitRelOf('/Users/me/code', '/Users/me/code')).toBe('')
    expect(gitRelOf('C:\\Users\\me\\code', 'C:\\Users\\me\\code\\src\\a.ts')).toBe('src/a.ts')
  })

  it('returns undefined for paths outside the repo', () => {
    expect(gitRelOf('/Users/me/code', '/Users/other/x.ts')).toBe(undefined)
    expect(gitRelOf('/Users/me/code', '/Users/me/codex/y.ts')).toBe(undefined)
  })
})

describe('gitDecorations', () => {
  it('yields nothing outside a repo', () => {
    expect(gitDecorations({ isRepo: false, entries: [] })).toEqual({ badges: new Map(), dirtyDirs: new Set() })
  })

  it('maps one badge letter per changed path', () => {
    const { badges } = gitDecorations(status([
      { path: 'src/a.ts', xy: ' M' },
      { path: 'src/new.ts', xy: '??' },
      { path: 'old.ts', xy: ' D' },
    ]))
    expect(badges.get('src/a.ts')).toBe('M')
    expect(badges.get('src/new.ts')).toBe('?')
    expect(badges.get('old.ts')).toBe('D')
  })

  it('marks every ancestor directory of a changed file (untracked nested too)', () => {
    const { dirtyDirs } = gitDecorations(status([
      { path: 'src/deep/dir/new.ts', xy: '??' },
    ]))
    expect(dirtyDirs.has('src')).toBe(true)
    expect(dirtyDirs.has('src/deep')).toBe(true)
    expect(dirtyDirs.has('src/deep/dir')).toBe(true)
    expect(dirtyDirs.size).toBe(3)
  })

  it('keeps directories untouched when only the root file changes', () => {
    const { dirtyDirs } = gitDecorations(status([{ path: 'a.ts', xy: 'M ' }]))
    expect(dirtyDirs.size).toBe(0)
  })
})

describe('owningRepo', () => {
  const nested = new Map<string, GitStatusResult>([
    // The workspace root is NOT a repo; its children are.
    ['/Users/me', { isRepo: false, entries: [] }],
    ['/Users/me/code', status([{ path: 'src/a.ts', xy: ' M' }])],
    ['/Users/me/code/vendor', status([{ path: 'lib.ts', xy: '??' }], '/Users/me/code/vendor')],
  ])

  it('picks the deepest repo containing the path', () => {
    const repo = owningRepo(nested, '/Users/me/code/src/a.ts')
    expect(repo).not.toBe(undefined)
    expect(repo!.key).toBe('/Users/me/code')
    expect(repo!.root).toBe('/Users/me/code')
    // A path inside a nested repo resolves to THAT repo, not its parent.
    const vendor = owningRepo(nested, '/Users/me/code/vendor/lib.ts')
    expect(vendor!.key).toBe('/Users/me/code/vendor')
  })

  it('matches via the host-reported root when the fetch dir is deeper', () => {
    const repos = new Map<string, GitStatusResult>([
      ['/Users/me/code/src', status([{ path: 'src/a.ts', xy: 'M ' }], '/Users/me/code')],
    ])
    const repo = owningRepo(repos, '/Users/me/code/src/a.ts')
    expect(repo).not.toBe(undefined)
    expect(repo!.key).toBe('/Users/me/code/src')
    expect(repo!.root).toBe('/Users/me/code')
  })

  it('yields nothing when no repo contains the path', () => {
    expect(owningRepo(nested, '/Users/other/x.ts')).toBe(undefined)
    // Non-repo snapshots never match.
    const repos = new Map<string, GitStatusResult>([['/Users/me', { isRepo: false, entries: [] }]])
    expect(owningRepo(repos, '/Users/me/a.ts')).toBe(undefined)
  })
})
