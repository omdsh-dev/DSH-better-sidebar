import { describe, expect, it } from 'vitest'
import { producedForClosing, resolveSidebarPath, selectProducedFiles } from '../src/client/produced-files.ts'

describe('produced-files derivation', () => {
  const diffResult = (path: string) => ({
    kind: 'tool-result', isError: false, callView: { card: 'diff', locations: [{ path }] },
  })
  const editResult = (path: string) => ({
    kind: 'tool-result', isError: false, callView: { card: 'generic', kind: 'edit', locations: [{ path }] },
  })

  it('collects diff/edit locations of the closing turn, first-seen order', () => {
    const nodes = [
      { kind: 'assistant', seq: 1, turn: 1 },
      diffResult('a.ts'),
      editResult('b.ts'),
      diffResult('a.ts'),
      { kind: 'assistant', seq: 2, turn: 1 },
    ]
    expect(producedForClosing(nodes, 2)).toEqual(['a.ts', 'b.ts'])
  })

  it('resets on user messages and turn changes', () => {
    const nodes = [
      { kind: 'assistant', seq: 1, turn: 1 },
      diffResult('old.ts'),
      { kind: 'user' },
      { kind: 'assistant', seq: 2, turn: 2 },
      diffResult('new.ts'),
      { kind: 'assistant', seq: 3, turn: 2 },
    ]
    expect(producedForClosing(nodes, 3)).toEqual(['new.ts'])
  })

  it('ignores reads, deletes, errors, and unknown cards', () => {
    const nodes = [
      { kind: 'assistant', seq: 1, turn: 1 },
      { kind: 'tool-result', isError: true, callView: { card: 'diff', locations: [{ path: 'x.ts' }] } },
      { kind: 'tool-result', isError: false, callView: { card: 'read', locations: [{ path: 'r.ts' }] } },
      { kind: 'tool-result', isError: false, callView: { card: 'generic', kind: 'delete', locations: [{ path: 'd.ts' }] } },
    ]
    expect(producedForClosing(nodes, 1)).toEqual([])
  })

  it('selector claims only when files exist', () => {
    expect(selectProducedFiles({ nodes: [{ kind: 'assistant', seq: 1, turn: 1 }], seq: 1 })).toBeNull()
    expect(selectProducedFiles({ nodes: [diffResult('a.ts'), { kind: 'assistant', seq: 1, turn: 1 }], seq: 1 })).toEqual(['a.ts'])
    expect(selectProducedFiles(null)).toBeNull()
  })

  it('resolves relative paths against the session cwd', () => {
    expect(resolveSidebarPath('/work/proj', 'src/a.ts')).toBe('/work/proj/src/a.ts')
    expect(resolveSidebarPath('/work/proj', '/abs/x.ts')).toBe('/abs/x.ts')
    expect(resolveSidebarPath(undefined, 'a.ts')).toBe('a.ts')
  })
})
