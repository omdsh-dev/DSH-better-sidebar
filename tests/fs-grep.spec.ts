/**
 * Content search and replace (src/fs-grep.ts) — the files panel's VS Code
 * Search view analogue.
 *
 * Pinned here:
 * - the query compilers (fixed string / case-sensitive / whole word / regex)
 *   and the files-to-include glob grammar (`*.ts` by base name, `src/**` by
 *   path, `src/**\/*.ts` matching direct children too, a directory pattern
 *   claiming its subtree);
 * - the walk: root-relative '/'-separated paths, noise directories skipped,
 *   binary and oversized files ignored, CRLF stripped from previews, exact
 *   match ranges in preview coordinates;
 * - every budget: maxFiles / maxMatches / maxScannedBytes report
 *   `truncated: true` instead of running away;
 * - replace: literal `$` in fixed mode, group references in regex mode, the
 *   file's own CRLF preserved, and the mtime gate refusing a file that changed
 *   since the result was rendered.
 *
 * The walk (not the git inventory) is what these temp trees exercise: a
 * mkdtemp directory is not a worktree, so `gitListedFiles` fails fast and the
 * plain opendir walk answers.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileExcludePatterns } from '../src/exclude-patterns.ts'
import { compileGrepInclude, compileGrepRegExp, grepFiles, GrepQueryError, replaceInFiles } from '../src/fs-grep.ts'
import { removeTree } from './temp-tree.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) removeTree(root)
})

/** A scratch tree covering matches, noise, binaries and CRLF content. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-grep-'))
  roots.push(dir)
  mkdirSync(join(dir, 'src', 'nested'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'src', 'app.ts'), [
    "import { foo } from './foo'",
    '  const target = foo(1)',
    'export const other = 2',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'src', 'nested', 'deep.ts'), '// target\nconst x = target\n')
  writeFileSync(join(dir, 'docs', 'guide.md'), '# guide\ntarget docs\n')
  writeFileSync(join(dir, 'src', 'crlf.txt'), 'target\r\nline\r\n')
  writeFileSync(join(dir, 'src', 'app.test.ts'), 'target test\n')
  // A substring-only hit (`targetVar`): the name search is not whole-word,
  // so this row proves the whole-word switch actually constrains the walk.
  writeFileSync(join(dir, 'src', 'word.ts'), 'const targetVar = 1\n')
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.ts'), 'target noise\n')
  writeFileSync(join(dir, 'bin.dat'), 'leading\0target\n')
  return dir
}

const pathsOf = (result: Awaited<ReturnType<typeof grepFiles>>): string[] => result.files.map(file => file.path)

describe('compileGrepRegExp', () => {
  const match = (query: string, line: string, options: Parameters<typeof compileGrepRegExp>[1]): string[] => {
    const regex = compileGrepRegExp(query, options)
    return [...line.matchAll(regex)].map(hit => hit[0])
  }

  it('matches a fixed string case-insensitively by default', () => {
    expect(match('FOO', 'foo Foo FOO', {})).toEqual(['foo', 'Foo', 'FOO'])
    expect(match('foo', 'foo Foo', { caseSensitive: true })).toEqual(['foo'])
  })

  it('escapes regex metacharacters in fixed mode', () => {
    expect(match('a.b', 'a.b axb', {})).toEqual(['a.b'])
  })

  it('compiles regex queries and rejects invalid ones', () => {
    expect(match('fo+', 'fo foo', { regex: true })).toEqual(['fo', 'foo'])
    expect(() => compileGrepRegExp('a(', { regex: true })).toThrow(GrepQueryError)
  })

  it('wholeWord refuses identifier neighbours', () => {
    expect(match('target', 'target targetVar x_target', { wholeWord: true })).toEqual(['target'])
    // A literal that starts with punctuation still matches (ASCII lookarounds,
    // not \b).
    expect(match('@foo', 'a @foo b', { wholeWord: true })).toEqual(['@foo'])
  })
})

describe('compileGrepInclude', () => {
  const has = (patterns: string[], relativePath: string): boolean =>
    compileGrepInclude(patterns, 'posix')?.(relativePath, relativePath.split('/').pop()!) ?? true

  it('matches a no-slash pattern against the base name at any depth', () => {
    expect(has(['*.ts'], 'src/app.ts')).toBe(true)
    expect(has(['*.ts'], 'deep/dir/app.ts')).toBe(true)
    expect(has(['*.ts'], 'src/app.js')).toBe(false)
  })

  it('anchors a path pattern at the root and lets ** span segments', () => {
    expect(has(['src/*.ts'], 'src/app.ts')).toBe(true)
    expect(has(['src/*.ts'], 'src/nested/deep.ts')).toBe(false)
    expect(has(['src/**'], 'src/nested/deep.ts')).toBe(true)
    // `**\/` also matches ZERO directories, like VS Code's globs.
    expect(has(['src/**/*.ts'], 'src/app.ts')).toBe(true)
    expect(has(['src/**/*.ts'], 'src/nested/deep.ts')).toBe(true)
    expect(has(['**/*.test.ts'], 'src/app.test.ts')).toBe(true)
    expect(has(['**/*.test.ts'], 'src/nested/app.test.ts')).toBe(true)
    expect(has(['**/*.test.ts'], 'src/app.ts')).toBe(false)
  })

  it('lets a directory pattern claim its whole subtree', () => {
    expect(has(['src'], 'src/app.ts')).toBe(true)
    expect(has(['src'], 'src/nested/deep.ts')).toBe(true)
    expect(has(['src'], 'docs/guide.md')).toBe(false)
    expect(has(['**/src'], 'deep/src/app.ts')).toBe(true)
  })

  it('folds case on win32 only', () => {
    expect(compileGrepInclude(['*.TS'], 'win32')?.('src/app.ts', 'app.ts')).toBe(true)
    expect(compileGrepInclude(['*.TS'], 'posix')?.('src/app.ts', 'app.ts')).toBe(false)
  })
})

describe('grepFiles', () => {
  it('groups matching lines by file, root-relative and sorted', async () => {
    const dir = makeFixture()
    const result = await grepFiles(dir, 'target')
    expect(pathsOf(result)).toEqual([
      'docs/guide.md', 'src/app.test.ts', 'src/app.ts', 'src/crlf.txt', 'src/nested/deep.ts', 'src/word.ts',
    ])
    expect(result.truncated).toBe(false)
    // node_modules and the NUL-bearing file never appear.
    expect(pathsOf(result)).not.toContain('node_modules/pkg/index.ts')
    expect(pathsOf(result)).not.toContain('bin.dat')
    for (const path of pathsOf(result)) expect(path.startsWith(dir)).toBe(false)
  })

  it('reports 1-based line numbers, trimmed previews and exact ranges', async () => {
    const dir = makeFixture()
    const result = await grepFiles(dir, 'target')
    const app = result.files.find(file => file.path === 'src/app.ts')!
    expect(app.mtimeMs).toBeGreaterThan(0)
    expect(app.matches).toHaveLength(1)
    const [hit] = app.matches
    expect(hit!.line).toBe(2)
    // Leading indentation is dropped and the range moves with it.
    expect(hit!.text).toBe('const target = foo(1)')
    expect(hit!.ranges).toEqual([{ start: 6, end: 12 }])
    expect(hit!.text.slice(6, 12)).toBe('target')
    // A CRLF file's preview never carries the CR.
    const crlf = result.files.find(file => file.path === 'src/crlf.txt')!.matches[0]!
    expect(crlf.text).toBe('target')
    expect(crlf.text.endsWith('\r')).toBe(false)
  })

  it('honours case sensitivity, whole word and regex', async () => {
    const dir = makeFixture()
    expect(pathsOf(await grepFiles(dir, 'TARGET', { caseSensitive: true }))).toEqual([])
    expect(pathsOf(await grepFiles(dir, 'TARGET'))).toContain('src/app.ts')
    // `targetVar` is a substring hit but not a whole-word one.
    expect(pathsOf(await grepFiles(dir, 'target'))).toContain('src/word.ts')
    expect(pathsOf(await grepFiles(dir, 'target', { wholeWord: true }))).not.toContain('src/word.ts')
    expect(pathsOf(await grepFiles(dir, 'target', { wholeWord: true }))).toContain('src/app.ts')
    const regex = await grepFiles(dir, 'tar+get', { regex: true })
    expect(pathsOf(regex)).toContain('src/app.ts')
  })

  it('applies files-to-include and the compiled files-to-exclude probe', async () => {
    const dir = makeFixture()
    expect(pathsOf(await grepFiles(dir, 'target', { include: ['*.md'] }))).toEqual(['docs/guide.md'])
    expect(pathsOf(await grepFiles(dir, 'target', { include: ['src/**/*.ts'] })))
      .toEqual(['src/app.test.ts', 'src/app.ts', 'src/nested/deep.ts', 'src/word.ts'])
    const exclude = compileExcludePatterns(['*.md', 'nested'], dir)
    expect(exclude).toBeDefined()
    expect(pathsOf(await grepFiles(dir, 'target', { exclude })))
      .toEqual(['src/app.test.ts', 'src/app.ts', 'src/crlf.txt', 'src/word.ts'])
  })

  it('ignores files above the per-file budget and stops at the scanned-byte budget', async () => {
    const dir = makeFixture()
    expect(pathsOf(await grepFiles(dir, 'target', { maxFileBytes: 4 }))).toEqual([])
    // The first file alone blows the search-wide budget: the answer is partial.
    const partial = await grepFiles(dir, 'target', { maxScannedBytes: 1 })
    expect(partial.truncated).toBe(true)
  })

  it('reports truncation when the match and file caps cut the walk', async () => {
    const dir = makeFixture()
    const one = await grepFiles(dir, 'target', { maxFiles: 1 })
    expect(one.files).toHaveLength(1)
    expect(one.truncated).toBe(true)
    const matches = await grepFiles(dir, 'target', { maxMatches: 1 })
    expect(matches.matchesTotal).toBe(1)
    expect(matches.truncated).toBe(true)
  })

  it('skips a symlinked entry (no duplicate rows, no cycle risk)', async () => {
    const dir = makeFixture()
    const link = join(dir, 'src', 'linked.ts')
    try {
      symlinkSync(join(dir, 'src', 'app.ts'), link)
    } catch {
      return // Windows without the symlink privilege: nothing to assert here.
    }
    const result = await grepFiles(dir, 'target')
    expect(pathsOf(result)).not.toContain('src/linked.ts')
  })

  it('throws an AbortError once the caller aborts', async () => {
    const dir = makeFixture()
    const controller = new AbortController()
    controller.abort()
    await expect(grepFiles(dir, 'target', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('replaceInFiles', () => {
  it('replaces every match and preserves the file line endings', async () => {
    const dir = makeFixture()
    const target = join(dir, 'src', 'crlf.txt')
    const before = readFileSync(target)
    const result = await replaceInFiles({
      cwd: dir,
      query: 'target',
      replacement: 'REPLACED',
      files: [{ path: 'src/crlf.txt' }],
    })
    expect(result.replaced).toBe(1)
    expect(result.files).toEqual([{ path: 'src/crlf.txt', replaced: 1 }])
    expect(result.skipped).toEqual([])
    const after = readFileSync(target)
    // CRLF is restored by the writer, not normalized to LF.
    expect(after.toString('utf8')).toBe('REPLACED\r\nline\r\n')
    expect(before.toString('utf8')).toBe('target\r\nline\r\n')
  })

  it('treats replacement text literally in fixed mode and as group refs in regex mode', async () => {
    const dir = makeFixture()
    const literal = await replaceInFiles({
      cwd: dir,
      query: 'target',
      replacement: '$1-literal',
      files: [{ path: 'docs/guide.md' }],
    })
    expect(literal.replaced).toBe(1)
    expect(readFileSync(join(dir, 'docs', 'guide.md'), 'utf8')).toContain('$1-literal')

    writeFileSync(join(dir, 'docs', 'guide.md'), 'id=42\n')
    const regex = await replaceInFiles({
      cwd: dir,
      query: 'id=(\\d+)',
      replacement: 'value=$1',
      regex: true,
      files: [{ path: 'docs/guide.md' }],
    })
    expect(regex.replaced).toBe(1)
    expect(readFileSync(join(dir, 'docs', 'guide.md'), 'utf8')).toBe('value=42\n')
  })

  it('refuses a file that changed on disk since the result was rendered', async () => {
    const dir = makeFixture()
    const result = await replaceInFiles({
      cwd: dir,
      query: 'target',
      replacement: 'nope',
      files: [{ path: 'src/app.ts', mtimeMs: 1 }],
    })
    expect(result.replaced).toBe(0)
    expect(result.skipped).toEqual([{ path: 'src/app.ts', reason: 'changed' }])
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toContain('target')
  })

  it('replaces every match in ONE file without touching the others', async () => {
    const dir = makeFixture()
    writeFileSync(join(dir, 'docs', 'guide.md'), 'target one\ntarget two\n')
    const result = await replaceInFiles({
      cwd: dir,
      query: 'target',
      replacement: 'done',
      files: [{ path: 'docs/guide.md' }],
    })
    expect(result.replaced).toBe(2)
    expect(result.files).toEqual([{ path: 'docs/guide.md', replaced: 2 }])
    expect(readFileSync(join(dir, 'docs', 'guide.md'), 'utf8')).toBe('done one\ndone two\n')
    // The sibling file the result list also showed was not named in THIS call.
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toContain('target')
  })

  it('replaces exactly one occurrence when line + matchIndex are given', async () => {
    const dir = makeFixture()
    writeFileSync(join(dir, 'src', 'multi.txt'), 'target target target\nsecond target\n')
    const result = await replaceInFiles({
      cwd: dir,
      query: 'target',
      replacement: 'X',
      files: [{ path: 'src/multi.txt', line: 1, matchIndex: 1 }],
    })
    expect(result.replaced).toBe(1)
    expect(result.files).toEqual([{ path: 'src/multi.txt', replaced: 1 }])
    expect(result.skipped).toEqual([])
    expect(readFileSync(join(dir, 'src', 'multi.txt'), 'utf8')).toBe('target X target\nsecond target\n')
  })

  it('expands group references for a single occurrence too', async () => {
    const dir = makeFixture()
    writeFileSync(join(dir, 'src', 'ids.txt'), 'id=42 id=7\n')
    const result = await replaceInFiles({
      cwd: dir,
      query: 'id=(\\d+)',
      replacement: 'v=$1',
      regex: true,
      files: [{ path: 'src/ids.txt', line: 1, matchIndex: 1 }],
    })
    expect(result.replaced).toBe(1)
    expect(readFileSync(join(dir, 'src', 'ids.txt'), 'utf8')).toBe('id=42 v=7\n')
  })

  it('skips a per-match entry whose occurrence no longer exists', async () => {
    const dir = makeFixture()
    writeFileSync(join(dir, 'src', 'multi.txt'), 'target\n')
    const before = readFileSync(join(dir, 'src', 'multi.txt'), 'utf8')
    const result = await replaceInFiles({
      cwd: dir,
      query: 'target',
      replacement: 'X',
      files: [{ path: 'src/multi.txt', line: 1, matchIndex: 3 }],
    })
    expect(result.replaced).toBe(0)
    expect(result.skipped).toEqual([{ path: 'src/multi.txt', reason: 'changed' }])
    expect(readFileSync(join(dir, 'src', 'multi.txt'), 'utf8')).toBe(before)
  })

  it('reports a missing or binary file instead of failing the whole batch', async () => {
    const dir = makeFixture()
    const result = await replaceInFiles({
      cwd: dir,
      query: 'target',
      replacement: 'x',
      files: [{ path: 'none.ts' }, { path: 'bin.dat' }],
    })
    expect(result.replaced).toBe(0)
    expect(result.skipped.map(skip => skip.reason)).toEqual(['missing', 'binary'])
  })

  it('surfaces a bad regex query instead of touching files', async () => {
    const dir = makeFixture()
    await expect(replaceInFiles({
      cwd: dir,
      query: 'a(',
      replacement: 'x',
      regex: true,
      files: [{ path: 'src/app.ts' }],
    })).rejects.toBeInstanceOf(GrepQueryError)
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toContain('target')
  })

  it('refuses a regex that matches the empty string (it would not be reviewable)', async () => {
    const dir = makeFixture()
    await expect(replaceInFiles({
      cwd: dir,
      query: 'a*',
      replacement: 'x',
      regex: true,
      files: [{ path: 'src/app.ts' }],
    })).rejects.toBeInstanceOf(GrepQueryError)
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toContain('target')
  })
})