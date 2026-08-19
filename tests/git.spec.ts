import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from '../src/client/DiffView.tsx'
import { parseLogLines, parsePorcelainZ } from '../src/git.ts'

describe('git parsing', () => {
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
    expect(parsed.files[0]!.hunks).toHaveLength(0)
    const gone = parsed.files[1]!
    expect(gone.newPath).toBe('/dev/null')
    expect(gone.hunks[0]!.lines).toEqual([
      { kind: 'del', text: 'one', oldNum: 1, newNum: null },
      { kind: 'del', text: 'two', oldNum: 2, newNum: null },
      { kind: 'meta', text: ' No newline at end of file', oldNum: null, newNum: null },
    ])
  })

  it('keeps mode/rename-only sections hunkless', () => {
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
    expect(parsed.files[0]!.oldPath).toBe('')
    expect(parsed.files[0]!.hunks).toHaveLength(0)
    expect(parsed.files[1]!.hunks).toHaveLength(0)
  })

  it('parses an empty or junk diff into no files', () => {
    expect(parseUnifiedDiff('').files).toEqual([])
    expect(parseUnifiedDiff('no diff here\n').files).toEqual([])
  })
})
