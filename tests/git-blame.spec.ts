/**
 * `git blame` for the editor's hover tooltip (issue #212) and `git diff HEAD`
 * for its change gutter — both exercised against the REAL git binary, because
 * the failure paths are the interesting half: an untracked file, a directory
 * outside any repository, and a path git cannot resolve must all answer with
 * an empty result instead of an exception (the hover tooltip then shows
 * nothing and the editing surface is never disturbed).
 *
 * The porcelain parser is additionally pinned on output captured from a real
 * run, which is where the two shapes that matter come from: an UNCOMMITTED
 * line (all-zero hash, "Not Committed Yet") and the SECOND line of one commit,
 * for which git emits only the header and the content line — the author,
 * time and summary must be carried forward from the first line of that commit.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { blame, diff, diffHead, parseBlamePorcelain } from '../src/git.ts'
import { gitLineKinds } from '../src/client/editor-git-gutter.ts'

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh temporary directory (removed after the test). */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/** A temporary repository with one committed file, deterministic identity. */
function repo(files: Record<string, string>): string {
  const root = tempDir('dsh-better-sidebar-blame-')
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'ada@example.com')
  git('config', 'user.name', 'Ada')
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content)
    git('add', '--', name)
  }
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'feat: add files'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2024-01-02T03:04:05+0800',
      GIT_COMMITTER_DATE: '2024-01-02T03:04:05+0800',
    },
  })
  return root
}

/** `git blame --porcelain -L 1,3 -- a.txt` captured from a real run: line 1 is
 *  a worktree edit, lines 2 and 3 are one commit (line 3 abbreviated). */
const REAL_PORCELAIN = [
  '0000000000000000000000000000000000000000 1 1 1',
  'author Not Committed Yet',
  'author-mail <not.committed.yet>',
  'author-time 1704136000',
  'author-tz +0800',
  'committer Not Committed Yet',
  'committer-mail <not.committed.yet>',
  'committer-time 1704136000',
  'committer-tz +0800',
  'summary Version of a.txt from a.txt',
  'previous 9433ffd0f069d4c3d8c31f4ba81ac2ec99a266df a.txt',
  'filename a.txt',
  '\tONE',
  '9433ffd0f069d4c3d8c31f4ba81ac2ec99a266df 2 2 2',
  'author Ada',
  'author-mail <ada@example.com>',
  'author-time 1704135845',
  'author-tz +0800',
  'committer Ada',
  'committer-mail <ada@example.com>',
  'committer-time 1704135845',
  'committer-tz +0800',
  'summary feat: add a',
  'boundary',
  'filename a.txt',
  '\ttwo',
  '9433ffd0f069d4c3d8c31f4ba81ac2ec99a266df 3 3',
  '\tthree',
  '',
].join('\n')

describe('git blame --porcelain parsing', () => {
  it('reads one row per line, with the author, the offset-stamped date and the summary', () => {
    const rows = parseBlamePorcelain(REAL_PORCELAIN)
    expect(rows.map(row => row.line)).toEqual([1, 2, 3])
    expect(rows[1]).toEqual({
      line: 2,
      hash: '9433ffd0f069d4c3d8c31f4ba81ac2ec99a266df',
      author: 'Ada',
      // Epoch 1704135845 is 2024-01-02T03:04:05+08:00 — the AUTHOR's zone, so
      // the value does not drift with the machine's timezone.
      date: '2024-01-02T03:04:05+08:00',
      summary: 'feat: add a',
    })
  })

  it('carries the commit metadata forward for the abbreviated repeat', () => {
    // git emits only `<hash> <orig> <final>` for the 2nd+ line of one commit.
    const rows = parseBlamePorcelain(REAL_PORCELAIN)
    expect(rows[2]).toMatchObject({ line: 3, author: 'Ada', summary: 'feat: add a', date: '2024-01-02T03:04:05+08:00' })
  })

  it('keeps git\u2019s uncommitted placeholder honest (all-zero hash)', () => {
    const [first] = parseBlamePorcelain(REAL_PORCELAIN)
    expect(first).toMatchObject({
      line: 1,
      hash: '0'.repeat(40),
      author: 'Not Committed Yet',
      summary: 'Version of a.txt from a.txt',
      date: '2024-01-02T03:06:40+08:00',
    })
  })

  it('is empty for empty output and never throws on unknown framing', () => {
    expect(parseBlamePorcelain('')).toEqual([])
    expect(parseBlamePorcelain('fatal: no such path\n')).toEqual([])
    expect(parseBlamePorcelain('author Ada\n\tloose content\n')).toEqual([])
  })
})

describe('blame() against the real git binary', () => {
  it('blames a committed line range', async () => {
    const root = repo({ 'a.txt': 'one\ntwo\nthree\n' })
    const rows = await blame(root, join(root, 'a.txt'), 2, 3)
    expect(rows.map(row => row.line)).toEqual([2, 3])
    for (const row of rows) {
      expect(row.author).toBe('Ada')
      expect(row.summary).toBe('feat: add files')
      expect(row.hash).toMatch(/^[0-9a-f]{40}$/)
      expect(row.hash).not.toMatch(/^0+$/)
      // The commit was authored at 2024-01-02T03:04:05+0800.
      expect(row.date).toBe('2024-01-02T03:04:05+08:00')
    }
  })

  it('answers empty for an untracked file (git exits 128)', async () => {
    const root = repo({ 'a.txt': 'one\n' })
    writeFileSync(join(root, 'fresh.txt'), 'brand new\n')
    await expect(blame(root, join(root, 'fresh.txt'), 1, 1)).resolves.toEqual([])
  })

  it('answers empty outside any repository', async () => {
    const dir = tempDir('dsh-better-sidebar-norepo-')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    await expect(blame(dir, join(dir, 'a.txt'), 1, 1)).resolves.toEqual([])
  })

  it('answers empty when the path itself does not resolve', async () => {
    const root = repo({ 'a.txt': 'one\n' })
    await expect(blame(root, join(root, 'missing.txt'), 1, 1)).resolves.toEqual([])
  })
})

describe('diffHead() (the editor gutter\u2019s change source)', () => {
  it('reports BOTH sides of a partly staged file, which the two-sided diff() splits', async () => {
    const root = repo({ 'a.txt': 'one\ntwo\nthree\n' })
    writeFileSync(join(root, 'a.txt'), 'ONE\ntwo\nthree\n')
    execFileSync('git', ['-C', root, 'add', '--', 'a.txt'])
    writeFileSync(join(root, 'a.txt'), 'ONE\nTWO\nthree\n')

    const [unstaged, staged] = await Promise.all([
      diff(root, 'a.txt', false),
      diff(root, 'a.txt', true),
    ])
    // Each side alone misses half of the file's uncommitted change.
    expect(unstaged).toContain('+TWO')
    expect(unstaged).not.toContain('+ONE')
    expect(staged).toContain('+ONE')
    expect(staged).not.toContain('+TWO')

    const union = await diffHead(root, join(root, 'a.txt'))
    expect(union).toContain('-one')
    expect(union).toContain('+ONE')
    expect(union).toContain('-two')
    expect(union).toContain('+TWO')
  })

  it('returns nothing for a clean file', async () => {
    const root = repo({ 'a.txt': 'one\ntwo\nthree\n' })
    await expect(diffHead(root, 'a.txt')).resolves.toBe('')
    await expect(diffHead(root, join(root, 'a.txt'))).resolves.toBe('')
  })

  it('falls back to the index when HEAD is not born yet', async () => {
    const dir = tempDir('dsh-better-sidebar-unborn-')
    execFileSync('git', ['-C', dir, 'init', '-q'])
    writeFileSync(join(dir, 'n.txt'), 'n\n')
    execFileSync('git', ['-C', dir, 'add', '--', 'n.txt'])
    // `git diff HEAD` cannot answer here (bad revision); the index against the
    // empty tree is the unborn-HEAD shape of the same question.
    const patch = await diffHead(dir, join(dir, 'n.txt'))
    expect(patch).toContain('new file mode')
    expect(patch).toContain('+n')
  })

  it('never reports an untracked file (the status store marks those)', async () => {
    const root = repo({ 'a.txt': 'one\n' })
    writeFileSync(join(root, 'fresh.txt'), 'brand new\n')
    await expect(diffHead(root, join(root, 'fresh.txt'))).resolves.toBe('')
  })
})

describe('real git output → gutter line classes (end to end)', () => {
  it('maps a real partly staged patch onto the worktree lines', async () => {
    // The parser fixtures above are hand-written; this one runs the real
    // binary so the hunk framing, the pairing and the "context is untouched"
    // rule are pinned against git itself, not against my idea of git.
    const root = repo({ 'a.txt': 'one\ntwo\nthree\n' })
    writeFileSync(join(root, 'a.txt'), 'ONE\ntwo\nthree\n')
    execFileSync('git', ['-C', root, 'add', '--', 'a.txt'])
    writeFileSync(join(root, 'a.txt'), 'ONE\nTWO\nthree\n')

    const kinds = gitLineKinds(await diffHead(root, join(root, 'a.txt')))
    expect([...kinds.entries()].sort((left, right) => left[0] - right[0]))
      .toEqual([[1, 'mod'], [2, 'mod']])
  })

  it('maps a real deletion onto the line above the gap', async () => {
    const root = repo({ 'a.txt': 'one\ntwo\nthree\nfour\n' })
    writeFileSync(join(root, 'a.txt'), 'one\nthree\nfour\n')
    const kinds = gitLineKinds(await diffHead(root, join(root, 'a.txt')))
    expect([...kinds.entries()]).toEqual([[1, 'del']])
  })
})
