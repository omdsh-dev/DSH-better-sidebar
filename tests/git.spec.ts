import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from '../src/client/diff/rows.ts'
import { checkout, parseLogLines, parseNumstat, parsePorcelainZ, repoRoots, status } from '../src/git.ts'

const execFileAsync = promisify(execFile)
const normalizePath = (path: string): string => path.replaceAll('\\', '/')
// macOS tmpdir() is the /var symlink while git reports the resolved
// /private/var prefix; on Windows TEMP is often the 8.3 short form
// (C:\Users\RUNNER~1\...) while git reports the long path. The NATIVE
// realpath resolves both aliasings (libuv canonicalizes on Windows via
// GetFinalPathNameByHandle, which expands 8.3 names) — canonicalize both
// sides before comparing.
const canonical = (path: string): string => normalizePath(realpathSync.native(path))

describe('git parsing', () => {
  it('discovers and selects direct child repositories under a workspace directory', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-better-sidebar-git-'))
    const first = join(workspace, 'first-repo')
    const second = join(workspace, 'second-repo')
    try {
      await Promise.all([mkdir(first), mkdir(second)])
      await Promise.all([
        execFileAsync('git', ['-C', first, 'init']),
        execFileAsync('git', ['-C', second, 'init']),
      ])

      await expect(repoRoots(workspace)).resolves.toEqual([canonical(first), canonical(second)])
      await expect(status(workspace, canonical(second))).resolves.toMatchObject({
        isRepo: true,
        root: canonical(second),
        repositories: [canonical(first), canonical(second)],
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('parses porcelain -z entries including renames', () => {
    const output = ['M  src/a.ts', ' M src/b.ts', '?? src/c.ts', 'R  src/new.ts', 'src/old.ts', ''].join('\0')
    const entries = parsePorcelainZ(output)
    expect(entries).toEqual([
      { path: 'src/a.ts', xy: 'M ' },
      { path: 'src/b.ts', xy: ' M' },
      { path: 'src/c.ts', xy: '??' },
      { path: 'src/new.ts', xy: 'R ' },
    ])
  })

  it('keeps untracked files inside new directories as individual rows (status --untracked-files=all)', () => {
    // status() runs with --untracked-files=all, so a new folder must surface
    // as one entry PER FILE (?? newdir/a.ts), never a collapsed ?? newdir/
    // row that has no diff and cannot be read (regression: new folders showed
    // as a single folder row whose diff tab failed with "is a directory").
    const output = ['?? newdir/a.ts', '?? newdir/sub/b.ts', ''].join('\0')
    expect(parsePorcelainZ(output)).toEqual([
      { path: 'newdir/a.ts', xy: '??' },
      { path: 'newdir/sub/b.ts', xy: '??' },
    ])
  })

  it('keeps untracked files inside new directories as individual rows (real git)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-git-status-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 't'], { cwd: root })
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root })
      mkdirSync(join(root, 'newdir'))
      writeFileSync(join(root, 'newdir', 'a.ts'), 'x')
      const result = await status(root)
      const paths = result.entries.map(entry => entry.path)
      expect(paths).toContain('newdir/a.ts')
      expect(paths.some(path => path.endsWith('/'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('caps status entries at the truncation limit (issue #369)', async () => {
    // A pathological untracked set — e.g. a repository discovered under a
    // home-directory cwd — must ship a bounded payload: the browser main
    // thread froze when one status response carried tens of thousands of
    // rows into response.json() and the unvirtualized change list.
    const root = mkdtempSync(join(tmpdir(), 'dsh-git-truncate-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      const many = join(root, 'many')
      mkdirSync(many)
      for (let index = 0; index <= 2_000; index += 1) writeFileSync(join(many, `f${index}.ts`), 'x')
      const result = await status(root)
      expect(result.entries).toHaveLength(2_000)
      expect(result.truncated).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves ordinary statuses untruncated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-git-untruncated-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(root, name), 'x')
      const result = await status(root)
      expect(result.entries).toHaveLength(3)
      expect(result.truncated).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shares one in-flight discovery scan between concurrent callers and caches the result (issue #369)', async () => {
    // The panel fires gitStatus/gitBranch/gitLog in parallel and then polls
    // every 2s; without sharing/caching, each call re-probed every visible
    // child directory of the cwd (the home-directory spawn storm of #369).
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-git-cache-'))
    const repo = join(workspace, 'a-repo')
    try {
      await mkdir(repo)
      await execFileAsync('git', ['-C', repo, 'init'])
      const first = repoRoots(workspace)
      // A second call while the first scan is still running joins it…
      expect(repoRoots(workspace)).toBe(first)
      const roots = await first
      expect(roots).toEqual([canonical(repo)])
      // …and once settled, the cached array (same reference) is served
      // without re-probing for the TTL window.
      await expect(repoRoots(workspace)).resolves.toBe(roots)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('parses log rows with unit separators (full hash + refs)', () => {
    const rows = parseLogLines(
      'abc1234\x1fFirst subject\x1fAlice\x1f2024-01-01 10:00:00 +0800\x1fabc1234def5678abc1234def5678abc1234def5678\x1fHEAD -> main, origin/main\n'
      + 'def5678\x1fSecond subject\x1fBob\x1f2024-01-02 10:00:00 +0800\x1fdef5678abc1234def5678abc1234def5678abc1234\x1f\n',
    )
    expect(rows).toEqual([
      {
        hash: 'abc1234',
        subject: 'First subject',
        author: 'Alice',
        date: '2024-01-01 10:00:00 +0800',
        hashFull: 'abc1234def5678abc1234def5678abc1234def5678',
        refs: 'HEAD -> main, origin/main',
      },
      {
        hash: 'def5678',
        subject: 'Second subject',
        author: 'Bob',
        date: '2024-01-02 10:00:00 +0800',
        hashFull: 'def5678abc1234def5678abc1234def5678abc1234',
        refs: '',
      },
    ])
  })

  it('parses a multi-file unified diff with aligned line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1234567..89abcde 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,4 +1,5 @@ section with @@ inside',
      ' line1',
      '-line2',
      '+line2b',
      ' context',
      '+trailing',
      'diff --git a/README.md b/README.md',
      'new file mode 100644',
      'index 0000000..1234567',
      '--- /dev/null',
      '+++ b/README.md',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '',
    ].join('\n')
    const parsed = parseUnifiedDiff(diff)
    expect(parsed.files).toHaveLength(2)
    const first = parsed.files[0]!
    expect(first.oldPath).toBe('a/src/a.ts')
    expect(first.newPath).toBe('b/src/a.ts')
    expect(first.binary).toBe(false)
    expect(first.hunks).toHaveLength(1)
    expect(first.hunks[0]!.oldStart).toBe(1)
    expect(first.hunks[0]!.newStart).toBe(1)
    expect(first.hunks[0]!.header).toBe(' section with @@ inside')
    expect(first.hunks[0]!.lines).toEqual([
      { kind: 'ctx', text: 'line1', oldNum: 1, newNum: 1 },
      { kind: 'del', text: 'line2', oldNum: 2, newNum: null },
      { kind: 'add', text: 'line2b', oldNum: null, newNum: 2 },
      { kind: 'ctx', text: 'context', oldNum: 3, newNum: 3 },
      { kind: 'add', text: 'trailing', oldNum: null, newNum: 4 },
    ])
    const second = parsed.files[1]!
    expect(second.oldPath).toBe('/dev/null')
    expect(second.hunks[0]!.lines[0]).toEqual({ kind: 'add', text: 'hello', oldNum: null, newNum: 1 })
    expect(second.hunks[0]!.lines[1]).toEqual({ kind: 'add', text: 'world', oldNum: null, newNum: 2 })
  })

  it('parses binary, deletion and no-newline markers', () => {
    const diff = [
      'diff --git a/img.png b/img.png',
      'index 111..222 100644',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    const parsed = parseUnifiedDiff(diff)
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[0]!.binary).toBe(true)
    // git prints no ---/+++ for the binary section: the name comes from its
    // own `Binary files …` line.
    expect(parsed.files[0]!.oldPath).toBe('a/img.png')
    expect(parsed.files[0]!.newPath).toBe('b/img.png')
    expect(parsed.files[0]!.hunks).toHaveLength(0)
    const gone = parsed.files[1]!
    expect(gone.newPath).toBe('/dev/null')
    expect(gone.hunks[0]!.lines).toEqual([
      { kind: 'del', text: 'one', oldNum: 1, newNum: null },
      { kind: 'del', text: 'two', oldNum: 2, newNum: null },
      { kind: 'meta', text: ' No newline at end of file', oldNum: null, newNum: null },
    ])
  })

  it('names mode/rename-only sections while keeping them hunkless', () => {
    // git prints no ---/+++ for these two shapes, so the paths come from the
    // section's own header lines; a section that reached the renderer without
    // a path drew a header with nothing but its badge.
    const parsed = parseUnifiedDiff([
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '',
    ].join('\n'))
    expect(parsed.files).toHaveLength(2)
    expect(parsed.files[0]!.oldPath).toBe('a/run.sh')
    expect(parsed.files[0]!.newPath).toBe('b/run.sh')
    expect(parsed.files[0]!.hunks).toHaveLength(0)
    expect(parsed.files[1]!.oldPath).toBe('old.ts')
    expect(parsed.files[1]!.newPath).toBe('new.ts')
    expect(parsed.files[1]!.hunks).toHaveLength(0)
  })

  it('parses an empty or junk diff into no files', () => {
    expect(parseUnifiedDiff('').files).toEqual([])
    expect(parseUnifiedDiff('no diff here\n').files).toEqual([])
  })

  it('never lets a branch operand reach git as an option (checkout)', async () => {
    // A caller-supplied branch name went into argv as a bare operand, so `-f`
    // was parsed as git's OPTION and force-discarded the worktree changes
    // (`--work-tree=…` redirected the checkout). The sentinel ends option
    // parsing — the same guard 4100e16 added to show / commitDiff / revert /
    // cherryPick, which missed this call.
    const root = mkdtempSync(join(tmpdir(), 'dsh-git-checkout-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: root })
      writeFileSync(join(root, 'a.txt'), 'committed\n')
      execFileSync('git', ['add', 'a.txt'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root })
      execFileSync('git', ['branch', 'other'], { cwd: root })
      writeFileSync(join(root, 'a.txt'), 'UNSAVED WORK\n')

      await expect(checkout(root, '-f')).rejects.toThrow()
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('UNSAVED WORK\n')

      await expect(checkout(root, '--work-tree=/elsewhere')).rejects.toThrow()
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('UNSAVED WORK\n')

      // The guard must not break the real operation.
      await checkout(root, 'other')
      expect(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim())
        .toBe('other')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * Issue #131: the per-path added/deleted line counts ride the EXISTING status
 * read (one batch, never one git process per file). The parser below is what
 * turns `git diff --numstat` answers into those numbers.
 */
describe('numstat line counts (#131)', () => {
  it('parses line-framed records into added/deleted per path', () => {
    expect(parseNumstat(['2\t0\tsrc/a.ts', '0\t3\tsrc/b.ts', ''].join('\n'))).toEqual(new Map([
      ['src/a.ts', { additions: 2, deletions: 0 }],
      ['src/b.ts', { additions: 0, deletions: 3 }],
    ]))
  })

  it('parses the production NUL framing (what status() actually runs)', () => {
    // `git diff --numstat -z` puts the counts and the path in NUL-framed
    // records, so a path with a newline or a quote stays lossless.
    expect(parseNumstat(['12\t4\tsrc/a.ts', '1\t1\todd\nname.ts', ''].join('\0'))).toEqual(new Map([
      ['src/a.ts', { additions: 12, deletions: 4 }],
      ['odd\nname.ts', { additions: 1, deletions: 1 }],
    ]))
  })

  it('reads a binary change as binary rather than as 0/0', () => {
    // git prints `-` for both counts: there are no line counts to report, and
    // a fabricated `0 0` would make a changed blob read as an empty change.
    expect(parseNumstat('-\t-\tassets/logo.png\0')).toEqual(new Map([
      ['assets/logo.png', { binary: true }],
    ]))
  })

  it('attributes a rename to the NEW path (plain and brace notations)', () => {
    expect(parseNumstat(['5\t1\told.txt => new.txt', ''].join('\n'))).toEqual(new Map([
      ['new.txt', { additions: 5, deletions: 1 }],
    ]))
    // The brace form keeps the unchanged prefix/suffix around the arrow.
    expect(parseNumstat(['3\t1\tsrc/{a => b}/x.ts', ''].join('\n'))).toEqual(new Map([
      ['src/b/x.ts', { additions: 3, deletions: 1 }],
    ]))
  })

  it('attributes a NUL-framed rename from its two name fields', () => {
    // In `-z` framing the origin and the new name are their own NUL fields
    // (origin first) — the format `status()` consumes.
    expect(parseNumstat('0\t0\t\0src/a/y.ts\0src/b/z.ts\0')).toEqual(new Map([
      ['src/b/z.ts', { additions: 0, deletions: 0 }],
    ]))
  })

  it('keeps a path that literally contains an arrow under NUL framing', () => {
    // `-z` framing never folds names into rename notation, so this is a real
    // file name and must stay attributable to itself.
    expect(parseNumstat('1\t0\ta => b.txt\0')).toEqual(new Map([
      ['a => b.txt', { additions: 1, deletions: 0 }],
    ]))
  })

  it('answers an empty map for empty or junk output', () => {
    expect(parseNumstat('')).toEqual(new Map())
    expect(parseNumstat('\0')).toEqual(new Map())
    expect(parseNumstat('not a numstat record\nanother one\n')).toEqual(new Map())
  })

  it('carries counts, the binary marker and the untracked absence through status()', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-git-counts-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 't'], { cwd: root })
      // Rename detection is a user config (diff.renames / status.renames);
      // pin it so this fixture means the same thing on every machine.
      execFileSync('git', ['config', 'diff.renames', 'true'], { cwd: root })
      execFileSync('git', ['config', 'status.renames', 'true'], { cwd: root })
      writeFileSync(join(root, 'tracked.txt'), 'one\ntwo\n')
      writeFileSync(join(root, 'renamed.txt'), 'same\n')
      execFileSync('git', ['add', '-A'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root })

      // ONE path changed on BOTH sides: one line staged, then one more in the
      // worktree — the entry must report the sum of the two readings.
      writeFileSync(join(root, 'tracked.txt'), 'one\ntwo\nthree\n')
      execFileSync('git', ['add', 'tracked.txt'], { cwd: root })
      writeFileSync(join(root, 'tracked.txt'), 'one\ntwo\nthree\nfour\n')
      // A staged rename: the counts belong to the new path.
      execFileSync('git', ['mv', 'renamed.txt', 'moved.txt'], { cwd: root })
      // A binary blob, and an untracked file git will not diff at all.
      writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 5]))
      execFileSync('git', ['add', 'blob.bin'], { cwd: root })
      writeFileSync(join(root, 'untracked.txt'), 'brand new\n')

      const result = await status(root)
      const byPath = new Map(result.entries.map(entry => [entry.path, entry]))
      expect(byPath.get('tracked.txt')).toEqual({
        path: 'tracked.txt', xy: 'MM', counts: { additions: 2, deletions: 0 },
      })
      expect(byPath.get('moved.txt')).toEqual({
        path: 'moved.txt', xy: 'R ', counts: { additions: 0, deletions: 0 },
      })
      expect(byPath.get('blob.bin')).toEqual({
        path: 'blob.bin', xy: 'A ', counts: { binary: true },
      })
      // No numstat row exists for an untracked file: the entry keeps no counts
      // at all, which is what the row renders as "new file".
      expect(byPath.get('untracked.txt')).toEqual({ path: 'untracked.txt', xy: '??' })
      expect(byPath.has('renamed.txt')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
