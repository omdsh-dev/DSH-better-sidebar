/**
 * Changes tab data layer: event-log folding into file operations, the
 * directory tree the Git lens renders its groups through, and a sanity pass
 * over the shared diff/highlight engines (their full behavior suites live in
 * the standalone dsh-file-trace plugin).
 */
import { describe, expect, it } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { extractFileOps, groupByFile, knownContentBefore, parseReadContent, parseReadLines } from '../src/client/changes/ops.ts'
import { buildChangeTree, type ChangeNode } from '../src/client/changes/change-tree.ts'
import { diffLines, buildDiffSegments, coalesceInline, diffInline } from '../src/client/diff/rows.ts'
import { langOfPath, scanLine } from '../src/client/diff/highlight.ts'
import type { GitStatusEntry } from '../src/client/api.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'

/** One synthetic session event. */
function ev(type: string, seq: number, time: number, data: Record<string, unknown>): SidebarSessionEvent {
  return { type, seq, time, data }
}

/** A tool/call event. */
function call(seq: number, name: string, callId: string, args: unknown, time = seq): SidebarSessionEvent {
  return ev('tool/call', seq, time, { name, callId, arguments: JSON.stringify(args) })
}

/** A tool/result event carrying one first-class tool-role message (the 0.1.7
 *  shape: result blocks and `isError` at the message's own top level). */
function result(seq: number, callId: string, text: string, isError = false, time = seq): SidebarSessionEvent {
  return ev('tool/result', seq, time, {
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      isError,
      content: [{ type: 'text', text }],
    },
  })
}

/** The retired 0.1.6 shape: a role-'user' message wrapping the result in one
 *  `tool-result` content block. Historical logs still carry it. */
function legacyResult(seq: number, callId: string, text: string, isError = false, time = seq): SidebarSessionEvent {
  return ev('tool/result', seq, time, {
    message: {
      role: 'user',
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', isError, content: [{ type: 'text', text }] }],
    },
  })
}

describe('parseReadContent', () => {
  it('strips the envelope and line-number prefixes but keeps blank lines', () => {
    const raw = [
      '<path>notes.md</path>',
      '<type>file</type>',
      '(Showing lines 1 to 4)',
      '<content>',
      '1: # Title',
      '2: ',
      '3: para one',
      '4: ',
      '</content>',
    ].join('\n')
    expect(parseReadContent(raw)).toBe('# Title\n\npara one')
  })

  it('returns the raw text unchanged when no <content> section is present', () => {
    expect(parseReadContent('plain text')).toBe('plain text')
  })
})

describe('extractFileOps', () => {
  it('resolves paths before grouping and finding earlier content', () => {
    const ops = extractFileOps([
      call(1, 'write', 'first', { file_path: 'src/package.json', content: 'first' }),
      call(2, 'edit', 'second', { path: '/repo/src/package.json', old_string: 'first', new_string: 'second' }),
      call(3, 'read', 'third', { filePath: 'tests/package.json' }),
    ], '/repo')
    expect([...groupByFile(ops).keys()]).toEqual(['/repo/tests/package.json', '/repo/src/package.json'])
    expect(groupByFile(ops).get('/repo/src/package.json')).toHaveLength(2)
    expect(knownContentBefore(ops, '/repo/src/package.json', ops.find(op => op.callId === 'second')!)).toBe('first')
  })

  it('resolves Windows relative paths and preserves absolute drive and UNC paths', () => {
    const ops = extractFileOps([
      call(1, 'read', 'relative', { file_path: 'src\\package.json' }),
      call(2, 'read', 'drive', { file_path: 'D:\\other\\package.json' }),
      call(3, 'read', 'network', { file_path: '\\\\server\\share\\package.json' }),
    ], 'C:\\repo')
    expect(ops.find(op => op.callId === 'relative')?.path).toBe('C:\\repo\\src\\package.json')
    expect(ops.find(op => op.callId === 'drive')?.path).toBe('D:\\other\\package.json')
    expect(ops.find(op => op.callId === 'network')?.path).toBe('\\\\server\\share\\package.json')
  })

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

  it('reads the tool/result message dsh-llm actually produces (producer round-trip)', () => {
    const message = createToolResultMessage({
      callId: ToolCallId('r'),
      content: [{ type: 'text', text: 'produced file body' }],
      isError: false,
    })
    const ops = extractFileOps([
      call(1, 'read', 'r', { file_path: 'a.ts' }),
      ev('tool/result', 2, 2, { message: message as unknown as Record<string, unknown> }),
    ])
    expect(ops[0]!.running).toBe(false)
    expect(ops[0]!.read).toBe('produced file body')
  })

  it('reads a LEGACY 0.1.6-era tool-result wrapper (historical logs keep that shape)', () => {
    const ops = extractFileOps([
      // No content in the model's arguments, so the settled result supplies it.
      call(1, 'write', 'w', { file_path: 'a' }),
      legacyResult(2, 'w', 'legacy write detail'),
      call(3, 'read', 'r', { file_path: 'b' }),
      legacyResult(4, 'r', 'cannot read "b": not found', true),
    ])
    expect(ops.find(op => op.kind === 'write')?.content).toBe('legacy write detail')
    expect(ops.find(op => op.kind === 'read')?.errorText).toBe('cannot read "b": not found')
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

describe('change tree (the Git lens reads its groups through it)', () => {
  /** One `git status` row from a path and its porcelain code. */
  const entry = (path: string, xy = ' M'): GitStatusEntry => ({ path, xy })

  /** A compact, assertion-friendly projection of one tree. */
  const shape = (nodes: readonly ChangeNode[]): unknown[] => nodes.map(node => node.kind === 'dir'
    ? { dir: node.name, path: node.path, changes: node.changes, children: shape(node.children) }
    : { file: node.name, path: node.path, letter: node.status.letter, tone: node.status.tone })

  it('keeps a single root-level file as one leaf', () => {
    expect(shape(buildChangeTree([entry('readme.md')]))).toEqual([
      { file: 'readme.md', path: 'readme.md', letter: 'M', tone: 'modified' },
    ])
  })

  it('nests a deep path and compresses its single-child chain into one row', () => {
    const tree = buildChangeTree([entry('src/client/changes/a.ts')])
    expect(shape(tree)).toEqual([
      {
        dir: 'src/client/changes',
        path: 'src/client/changes',
        changes: 1,
        children: [{ file: 'a.ts', path: 'src/client/changes/a.ts', letter: 'M', tone: 'modified' }],
      },
    ])
  })

  it('stops compressing where the path branches or a directory holds its own file', () => {
    // Two child directories: 'src' keeps its own row.
    expect(shape(buildChangeTree([entry('src/a/x.ts'), entry('src/b/y.ts')]))).toEqual([
      {
        dir: 'src',
        path: 'src',
        changes: 2,
        children: [
          { dir: 'a', path: 'src/a', changes: 1, children: [{ file: 'x.ts', path: 'src/a/x.ts', letter: 'M', tone: 'modified' }] },
          { dir: 'b', path: 'src/b', changes: 1, children: [{ file: 'y.ts', path: 'src/b/y.ts', letter: 'M', tone: 'modified' }] },
        ],
      },
    ])
    // A file AT this level: 'a' keeps its own row (and its file leads the child).
    expect(shape(buildChangeTree([entry('a/x.ts'), entry('a/b/y.ts')]))).toEqual([
      {
        dir: 'a',
        path: 'a',
        changes: 2,
        children: [
          { dir: 'b', path: 'a/b', changes: 1, children: [{ file: 'y.ts', path: 'a/b/y.ts', letter: 'M', tone: 'modified' }] },
          { file: 'x.ts', path: 'a/x.ts', letter: 'M', tone: 'modified' },
        ],
      },
    ])
  })

  it('orders directories before files, each by name case-insensitively', () => {
    const tree = buildChangeTree([
      entry('Zed.ts'), entry('B.ts'), entry('a.ts'), entry('zdir/f.ts'), entry('Adir/f.ts'),
    ])
    expect(shape(tree).map(node => (node as { dir?: string; file?: string }).dir ?? (node as { file: string }).file))
      .toEqual(['Adir', 'zdir', 'a.ts', 'B.ts', 'Zed.ts'])
  })

  it('mixes root-level files with nested paths and keeps same-named files apart', () => {
    expect(shape(buildChangeTree([
      entry('b/index.ts'), entry('index.ts'), entry('a/index.ts'),
    ]))).toEqual([
      { dir: 'a', path: 'a', changes: 1, children: [{ file: 'index.ts', path: 'a/index.ts', letter: 'M', tone: 'modified' }] },
      { dir: 'b', path: 'b', changes: 1, children: [{ file: 'index.ts', path: 'b/index.ts', letter: 'M', tone: 'modified' }] },
      { file: 'index.ts', path: 'index.ts', letter: 'M', tone: 'modified' },
    ])
  })

  it('carries every file porcelain status and counts the files under each row', () => {
    const tree = buildChangeTree([
      entry('src/a.ts', ' M'), entry('src/new.ts', '??'), entry('src/gone.ts', ' D'), entry('src/kept.ts', '  '),
    ])
    expect(shape(tree)).toEqual([
      {
        dir: 'src',
        path: 'src',
        changes: 3,
        children: [
          { file: 'a.ts', path: 'src/a.ts', letter: 'M', tone: 'modified' },
          { file: 'gone.ts', path: 'src/gone.ts', letter: 'D', tone: 'deleted' },
          { file: 'new.ts', path: 'src/new.ts', letter: 'U', tone: 'untracked' },
        ],
      },
    ])
  })

  it('pins the collation, so the order cannot move with the runtime locale', () => {
    // Mixed case + accents + non-letters: the comparator runs an explicit
    // 'en' base collation and breaks ties by code point. A bare
    // `localeCompare(other)` would follow the machine's ICU default and could
    // reorder the same change list on another machine.
    const names = ['b.ts', 'A.ts', 'ä.ts', 'Z.ts', 'a.ts', 'Ä.ts', '_x.ts', '1.ts']
    const order = (list: readonly string[]): string[] =>
      buildChangeTree(list.map(path => entry(path))).map(node => node.name)
    expect(order(names)).toEqual(['_x.ts', '1.ts', 'A.ts', 'a.ts', 'Ä.ts', 'ä.ts', 'b.ts', 'Z.ts'])
    // …and it is a TOTAL order: reversing the input cannot move a row.
    expect(order([...names].reverse())).toEqual(order(names))

    const dirs = ['Zdir/f.ts', 'adir/f.ts', 'Ädir/f.ts', '_dir/f.ts']
    const dirOrder = (list: readonly string[]): string[] =>
      buildChangeTree(list.map(path => entry(path))).map(node => node.name)
    expect(dirOrder(dirs)).toEqual(['_dir', 'adir', 'Ädir', 'Zdir'])
    expect(dirOrder([...dirs].reverse())).toEqual(dirOrder(dirs))

    // Why the pin is load-bearing: under Swedish collation 'ä' sorts AFTER
    // 'z', so an unpinned comparator would order this very list differently on
    // a machine whose runtime locale happens to be Swedish.
    expect(['z.ts', 'ä.ts'].sort((left, right) => left.localeCompare(right, 'sv', { sensitivity: 'base' })))
      .toEqual(['z.ts', 'ä.ts'])
  })

  it('returns no nodes for an empty or all-clean list', () => {
    expect(buildChangeTree([])).toEqual([])
    expect(buildChangeTree([entry('a.ts', '  '), entry('b.ts', '!!')])).toEqual([])
  })

  it('counts a repeated path once', () => {
    expect(shape(buildChangeTree([entry('a.ts'), entry('a.ts', '??')]))).toEqual([
      { file: 'a.ts', path: 'a.ts', letter: 'M', tone: 'modified' },
    ])
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
