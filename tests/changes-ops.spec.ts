/**
 * Changes tab session-lens data layer: event-log folding into file
 * operations, plus a sanity pass over the shared diff/highlight engines
 * (their full behavior suites live in the standalone dsh-file-trace plugin).
 */
import { describe, expect, it } from 'vitest'
import { extractFileOps, groupByFile, knownContentBefore, parseReadLines } from '../src/client/changes/ops.ts'
import { diffLines, buildDiffSegments, coalesceInline, diffInline } from '../src/client/diff/rows.ts'
import { langOfPath, scanLine } from '../src/client/diff/highlight.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'

/** One synthetic session event. */
function ev(type: string, seq: number, time: number, data: Record<string, unknown>): SidebarSessionEvent {
  return { type, seq, time, data }
}

/** A tool/call event. */
function call(seq: number, name: string, callId: string, args: unknown, time = seq): SidebarSessionEvent {
  return ev('tool/call', seq, time, { name, callId, arguments: JSON.stringify(args) })
}

/** A tool/result event carrying one tool-result block with inner text. */
function result(seq: number, callId: string, text: string, isError = false, time = seq): SidebarSessionEvent {
  return ev('tool/result', seq, time, {
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', isError, content: [{ type: 'text', text }] }],
    },
  })
}

describe('extractFileOps', () => {
  it('seeds running ops from tool/call and settles them from tool/result', () => {
    const ops = extractFileOps([
      call(1, 'write', 'w1', { file_path: 'a.ts', content: 'body' }),
      result(2, 'w1', '<path>a.ts</path>\n<type>file</type>\n<content>\nbody\n</content>'),
    ])
    expect(ops).toHaveLength(1)
    expect(ops[0]!.running).toBe(false)
    expect(ops[0]!.isError).toBe(false)
    expect(ops[0]!.content).toBe('body')
  })

  it('captures the error text of an errored result for every kind', () => {
    const ops = extractFileOps([
      call(1, 'write', 'w', { file_path: 'a', content: 'x' }),
      result(2, 'w', '写入失败：目标只读', true),
      call(3, 'read', 'r', { file_path: 'b' }),
      result(4, 'r', 'cannot read "b": not found', true),
    ])
    expect(ops.every(op => op.isError && op.errorText !== undefined)).toBe(true)
    expect(ops.find(op => op.kind === 'read')?.errorText).toBe('cannot read "b": not found')
  })

  it('keeps a call without result as running, and reads capture their content', () => {
    const ops = extractFileOps([
      call(1, 'read', 'r1', { file_path: 'a.ts' }),
      result(2, 'r1', '<path>a.ts</path>\n<type>file</type>\n<content>\n1: hello\n\n(End of file - total 1 lines)\n</content>'),
      call(3, 'edit', 'e1', { file_path: 'c.ts', old_string: 'x', new_string: 'y' }),
    ])
    const read = ops.find(op => op.callId === 'r1')
    expect(read?.running).toBe(false)
    expect(read?.read).toContain('1: hello')
    const edit = ops.find(op => op.callId === 'e1')
    expect(edit?.running).toBe(true)
    expect(edit?.edit).toEqual({ oldString: 'x', newString: 'y' })
  })

  it('ignores non-file tools and unrelated results, newest first', () => {
    const ops = extractFileOps([
      call(1, 'pwsh', 'p', { command: 'ls' }),
      result(2, 'unknown-call', 'orphan'),
      call(3, 'read', 'r', { file_path: 'z.ts' }),
    ])
    expect(ops.map(op => op.callId)).toEqual(['r'])
  })

  it('groups by file newest-first and recovers prior write content', () => {
    const ops = extractFileOps([
      call(1, 'write', 'w1', { file_path: 'a.ts', content: 'first' }),
      call(2, 'write', 'w2', { file_path: 'a.ts', content: 'second' }),
      call(3, 'write', 'w3', { file_path: 'b.ts', content: 'x' }),
    ])
    expect([...groupByFile(ops).keys()]).toEqual(['b.ts', 'a.ts'])
    expect(knownContentBefore(ops, 'a.ts', ops.find(op => op.callId === 'w2')!)).toBe('first')
  })
})

describe('parseReadLines', () => {
  it('recovers real line numbers from the read envelope', () => {
    const lines = parseReadLines('<path>a.ts</path>\n<type>file</type>\n<content>\n10: x\n11: y\n\n(Showing lines 10-11 of 20. Use offset=12 to continue.)\n</content>')
    expect(lines).toEqual([{ line: 10, text: 'x' }, { line: 11, text: 'y' }])
  })
})

describe('ported diff/highlight engines (sanity)', () => {
  it('diffLines pairs a rewrite as mod and folds context into hunks', () => {
    const rows = diffLines('hello world', 'hello dsh')
    expect(rows.map(r => r.kind)).toEqual(['mod', 'mod'])
    const before = Array.from({ length: 6 }, (_, i) => ({ kind: 'context' as const, oldLine: i + 1, newLine: i + 1, text: 'c' + String(i) }))
    const change = [{ kind: 'mod' as const, oldLine: 7, newLine: 7, text: 'X' }]
    const after = Array.from({ length: 8 }, (_, i) => ({ kind: 'context' as const, oldLine: i + 8, newLine: i + 8, text: 'c' + String(i + 8) }))
    const segments = buildDiffSegments([...before, ...change, ...after], 3)
    expect(segments.map(s => s.kind)).toEqual(['fold', 'hunk', 'fold'])
  })

  it('coalesces the ported prefix/suffix inline diff into runs', () => {
    const { old: oldSide } = diffInline('hello world', 'hello dsh')
    expect(coalesceInline(oldSide)).toEqual([
      { text: 'hello ', changed: false },
      { text: 'world', changed: true },
    ])
  })

  it('highlights keywords and threads block-comment state', () => {
    expect(langOfPath('a.cpp')).toBe('cpp')
    const open = scanLine('/* header', 'cpp')
    expect(open.inBlock).toBe(true)
    const mid = scanLine(' * interior note', 'cpp', true)
    expect(mid.tokens).toEqual([{ text: ' * interior note', type: 'comment' }])
    const code = scanLine('int main() { return 42; } // done', 'cpp')
    expect(code.tokens).toContainEqual({ text: 'int', type: 'keyword' })
    expect(code.tokens).toContainEqual({ text: '42', type: 'number' })
    expect(code.tokens).toContainEqual({ text: '// done', type: 'comment' })
  })
})
