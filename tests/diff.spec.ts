import { describe, expect, it } from 'vitest'
import { buildUnifiedDiff } from '../src/client/diff.ts'
import { parseUnifiedDiff } from '../src/client/DiffView.tsx'

describe('buildUnifiedDiff', () => {
  it('renders an appended-line change as a valid unified diff', () => {
    const d = buildUnifiedDiff([{
      path: 'G:/UnitySource/test.md',
      oldText: 'line1\nline2\nline3',
      newText: 'line1\nline2\nline3\nline4\nline5',
    }])
    const parsed = parseUnifiedDiff(d)
    const file = parsed.files[0]
    expect(file).toBeDefined()
    expect(file!.hunks.length).toBeGreaterThan(0)
    // The addition lines must be present.
    const addLines = file!.hunks.flatMap(h => h.lines).filter(l => l.kind === 'add').map(l => l.text)
    expect(addLines).toContain('line4')
    expect(addLines).toContain('line5')
  })

  it('renders a middle-line edit as a replace (del + add)', () => {
    const d = buildUnifiedDiff([{
      path: 'a/b.ts',
      oldText: 'const x = 1;\nconst y = 2;\nconst z = 3;\n',
      newText: 'const x = 1;\nconst y = 999;\nconst z = 3;\n',
    }])
    const parsed = parseUnifiedDiff(d)
    const file = parsed.files[0]
    expect(file).toBeDefined()
    const ops = file!.hunks.flatMap(h => h.lines)
    expect(ops.some(l => l.kind === 'del' && l.text === 'const y = 2;')).toBe(true)
    expect(ops.some(l => l.kind === 'add' && l.text === 'const y = 999;')).toBe(true)
  })

  it('renders a brand-new file (oldText null) as a full-file addition', () => {
    const d = buildUnifiedDiff([{ path: 'new.txt', oldText: null, newText: 'hello\nworld' }])
    const parsed = parseUnifiedDiff(d)
    const file = parsed.files[0]
    expect(file).toBeDefined()
    expect(file!.oldPath).toBe('/dev/null')
    const addLines = file!.hunks.flatMap(h => h.lines).filter(l => l.kind === 'add').map(l => l.text)
    expect(addLines).toEqual(['hello', 'world'])
  })

  it('handles multiple files in one diff', () => {
    const d = buildUnifiedDiff([
      { path: 'a.ts', oldText: 'x', newText: 'x\ny' },
      { path: 'b.ts', oldText: 'p\nq', newText: 'p\nr' },
    ])
    const parsed = parseUnifiedDiff(d)
    expect(parsed.files.length).toBe(2)
  })

  it('returns empty for identical texts', () => {
    const d = buildUnifiedDiff([{ path: 'a.ts', oldText: 'same', newText: 'same' }])
    expect(d).toBe('')
  })
})
