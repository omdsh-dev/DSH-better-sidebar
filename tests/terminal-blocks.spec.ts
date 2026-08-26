/**
 * Pure logic tests for the terminal block framework (tracker, row
 * extraction, selection attribution, insert payloads) — no xterm, the
 * buffer is a fake over the minimal structural contract.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  BLOCK_KEEP,
  TERMINAL_INSERT_LIMIT,
  TerminalBlockTracker,
  blockEndLine,
  blockForSelection,
  blockOutputText,
  blockSpanLines,
  blockStartLine,
  buildTerminalInsert,
  type TerminalBlock,
  type TerminalBlockBuffer,
  type TerminalBlockMarker,
} from '../src/client/terminal-blocks.ts'

/** A fake buffer row honoring the structural contract (trim + wrap flags). */
function line(text: string, wrapped = false): { isWrapped: boolean; translateToString: () => string } {
  return {
    isWrapped: wrapped,
    translateToString: (trimRight?: boolean) => (trimRight ? text.trimEnd() : text),
  }
}

/** A fake buffer: rows array → BlockBuffer (getLine clamps like xterm). */
function buffer(rows: string[], wraps: boolean[] = []): TerminalBlockBuffer {
  const lines = rows.map((text, i) => line(text, wraps[i] ?? false))
  return {
    get length() {
      return lines.length
    },
    getLine: (y: number) => (y >= 0 && y < lines.length ? lines[y] : undefined),
  }
}

function block(partial: Partial<TerminalBlock> = {}): TerminalBlock {
  return {
    id: 1,
    command: 'cmd',
    startRow: 0,
    endRow: null,
    finished: false,
    ...partial,
  }
}

describe('TerminalBlockTracker', () => {
  it('accumulates pending text and swallows control sequences', () => {
    const tracker = new TerminalBlockTracker()
    // Arrow keys (CSI), home, bracketed-paste markers — all stripped.
    tracker.onData('npm \x1b[A\x1b[B\x1b[H\x1b[200~install\x1b[201~', 0)
    expect(tracker.pending).toBe('npm install')
    // OSC title write swallowed (BEL-terminated).
    tracker.onData('\x1b]0;my title\x07', 0)
    expect(tracker.pending).toBe('npm install')
    // ST-terminated OSC (ESC \) and an unknown ESC sequence.
    tracker.onData('\x1b]2;other\x1b\\', 0)
    tracker.onData('\x1b7', 0)
    expect(tracker.pending).toBe('npm install')
  })

  it('applies backspace/DEL and drops other C0 controls', () => {
    const tracker = new TerminalBlockTracker()
    tracker.onData('abc\x7f', 0)
    expect(tracker.pending).toBe('ab')
    tracker.onData('\x08', 0)
    expect(tracker.pending).toBe('a')
    tracker.onData('\t\x07', 0) // tab + bell
    expect(tracker.pending).toBe('a')
  })

  it('keeps escape-mode state across chunks (split sequences)', () => {
    const tracker = new TerminalBlockTracker()
    tracker.onData('x\x1b[', 0)
    tracker.onData('Ay', 0)
    expect(tracker.pending).toBe('xy')
    tracker.onData('\x1b', 0)
    tracker.onData(']', 0)
    tracker.onData('title', 0)
    tracker.onData('\x07', 0)
    expect(tracker.pending).toBe('xy')
  })

  it('submits on Enter: creates a block anchored at the echo row', () => {
    const tracker = new TerminalBlockTracker()
    expect(tracker.current).toBeNull()
    tracker.onData('npm test\r', 10)
    expect(tracker.current).not.toBeNull()
    expect(tracker.current!.command).toBe('npm test')
    expect(tracker.current!.startRow).toBe(9)
    expect(tracker.current!.finished).toBe(false)
    expect(tracker.current!.endRow).toBeNull()
    expect(tracker.blocks).toHaveLength(1)
    expect(tracker.pending).toBe('')
  })

  it('closes the previous block when the next command submits', () => {
    const tracker = new TerminalBlockTracker()
    tracker.onData('npm test\r', 10)
    tracker.onData('git status\r', 15)
    expect(tracker.blocks).toHaveLength(2)
    const [first, second] = tracker.blocks
    expect(first!.command).toBe('npm test')
    expect(first!.finished).toBe(true)
    expect(first!.endRow).toBe(14)
    expect(second!.command).toBe('git status')
    expect(second!.finished).toBe(false)
    expect(second!.endRow).toBeNull()
    expect(second!.startRow).toBe(14)
  })

  it('ignores bare Enters (no empty blocks, previous block stays open)', () => {
    const tracker = new TerminalBlockTracker()
    tracker.onData('npm test\r', 10)
    tracker.onData('\r', 12)
    tracker.onData('\n', 13)
    expect(tracker.blocks).toHaveLength(1)
    expect(tracker.current!.finished).toBe(false)
    expect(tracker.current!.command).toBe('npm test')
  })

  it('splits multi-line pastes into one block per line', () => {
    const tracker = new TerminalBlockTracker()
    tracker.onData('echo a\recho b\r', 5)
    expect(tracker.blocks.map(b => b.command)).toEqual(['echo a', 'echo b'])
    expect(tracker.blocks[0]!.finished).toBe(true)
    expect(tracker.blocks[1]!.finished).toBe(false)
  })

  it('trims command whitespace and caps the block list', () => {
    const tracker = new TerminalBlockTracker()
    for (let i = 0; i < BLOCK_KEEP + 5; i++) {
      tracker.onData(`cmd ${i}\r`, i + 1)
    }
    expect(tracker.blocks).toHaveLength(BLOCK_KEEP)
    expect(tracker.blocks[0]!.command).toBe('cmd 5')
    expect(tracker.blocks[BLOCK_KEEP - 1]!.command).toBe(`cmd ${BLOCK_KEEP + 4}`)
  })
})

describe('blockOutputText', () => {
  it('returns the rows after the echo row (echo excluded)', () => {
    const buf = buffer(['~ % npm test', '✓ 3 passed', '✨ done'])
    const text = blockOutputText(buf, block({ startRow: 0, command: 'npm test' }))
    expect(text).toBe('✓ 3 passed\n✨ done')
  })

  it('respects a closed span (finished block)', () => {
    const buf = buffer(['~ % npm test', '✓ 3 passed', '~ % git status', 'clean'])
    const text = blockOutputText(buf, block({ startRow: 0, endRow: 2, finished: true }))
    expect(text).toBe('✓ 3 passed')
  })

  it('re-joins wrapped rows without a newline', () => {
    const buf = buffer(['first half of a long line', 'second half', 'next row'], [false, true, false])
    const text = blockOutputText(buf, block({ startRow: -10 }))
    expect(text).toBe('first half of a long linesecond half\nnext row')
  })

  it('strips trailing blank rows and trims the tail', () => {
    const buf = buffer(['out1', '', '   ', ''])
    const text = blockOutputText(buf, block({ startRow: -10 }))
    expect(text).toBe('out1')
  })

  it('peels a trailing row that ends with the pending next command', () => {
    const buf = buffer(['~ % npm test', '✓ 3 passed', '~ % git stat'], [false, false, false])
    const text = blockOutputText(buf, block({ startRow: 0 }), 'git stat')
    expect(text).toBe('✓ 3 passed')
  })

  it('keeps the pending row when it does not match (wrapped/mismatched)', () => {
    const buf = buffer(['~ % npm test', '✓ 3 passed', '~ % git status --long'])
    const text = blockOutputText(buf, block({ startRow: 0 }), 'git status')
    // Best-effort: no match → the row stays (documented behavior).
    expect(text).toBe('✓ 3 passed\n~ % git status --long')
  })

  it('returns empty for no output, out-of-range anchors, and a pending-only tail', () => {
    expect(blockOutputText(buffer(['~ % npm test']), block({ startRow: 0 }))).toBe('')
    expect(blockOutputText(buffer(['a', 'b']), block({ startRow: 100 }))).toBe('')
    // Only the pending echo row → everything is peeled.
    const buf2 = buffer(['~ % git stat'])
    expect(blockOutputText(buf2, block({ startRow: -10 }), 'git stat')).toBe('')
  })
})

describe('blockForSelection', () => {
  const blocks: TerminalBlock[] = [
    block({ id: 1, startRow: 0, endRow: 5, finished: true }),
    block({ id: 2, startRow: 5, endRow: 9, finished: true }),
    block({ id: 3, startRow: 9, endRow: null, finished: false }),
  ]

  it('attributes a row to its newest block and handles open spans', () => {
    expect(blockForSelection(blocks, 3)!.id).toBe(1)
    expect(blockForSelection(blocks, 5)!.id).toBe(2) // boundary: next block owns it
    expect(blockForSelection(blocks, 8)!.id).toBe(2)
    expect(blockForSelection(blocks, 9)!.id).toBe(3)
    expect(blockForSelection(blocks, 42)!.id).toBe(3) // open span extends
  })

  it('returns null for negative rows and rows above all blocks', () => {
    expect(blockForSelection(blocks, -1)).toBeNull()
    expect(blockForSelection(blocks, 0)).not.toBeNull()
    expect(blockForSelection([], 5)).toBeNull()
    expect(blockForSelection([block({ startRow: 0, endRow: 2 })], 3)).toBeNull()
  })
})

describe('buildTerminalInsert', () => {
  it('builds a fenced payload with the command as the info line', () => {
    expect(buildTerminalInsert('npm test', '✓ 3 passed')).toBe(
      '```$ npm test\n✓ 3 passed\n```',
    )
  })

  it('falls back to a bare fence when the command is unknown', () => {
    expect(buildTerminalInsert(undefined, 'hello')).toBe('```\nhello\n```')
    expect(buildTerminalInsert('  ', 'hello')).toBe('```\nhello\n```')
  })

  it('truncates the body over the limit with the ellipsis marker', () => {
    const insert = buildTerminalInsert('c', 'abcdefghij', { limit: 5 })
    expect(insert).toBe('```$ c\nabcde\n…\n```')
    expect(buildTerminalInsert('c', '', { limit: 5 })).toBe('```$ c\n\n```')
  })

  it('respects TERMINAL_INSERT_LIMIT by default', () => {
    const body = 'x'.repeat(TERMINAL_INSERT_LIMIT)
    const insert = buildTerminalInsert('c', body + 'y')
    expect(insert).toContain('```$ c\n')
    expect(insert).not.toContain('y')
    expect(insert).toContain('\n…\n')
    expect(insert.endsWith('```')).toBe(true)
  })
})
describe('markers (blockStartLine / blockEndLine / blockSpanLines)', () => {
  function marker(line: number, disposed = false): TerminalBlockMarker {
    return { line, isDisposed: disposed, dispose: vi.fn() }
  }

  it('prefers the live marker line over the index', () => {
    const b = block({ startRow: 0, marker: marker(27) })
    expect(blockStartLine(b)).toBe(27)
    // Trimmed out (marker disposed): the rows are gone — resolves to
    // +Infinity so every consumer treats the block as absent.
    const trimmed = block({ startRow: 0, marker: marker(0, true) })
    expect(blockStartLine(trimmed)).toBe(Number.POSITIVE_INFINITY)
    // Never attached: index fallback.
    expect(blockStartLine(block({ startRow: 9 }))).toBe(9)
  })

  it('blockEndLine is the next block’s start line, Infinity for the newest', () => {
    const a = block({ startRow: 0, marker: marker(4) })
    const b = block({ startRow: 10, marker: marker(16) })
    const c = block({ startRow: 20 })
    expect(blockEndLine([a, b, c], a)).toBe(16)
    expect(blockEndLine([a, b, c], c)).toBe(Number.POSITIVE_INFINITY)
    expect(blockEndLine([a], b)).toBe(Number.POSITIVE_INFINITY) // unknown block
  })

  it('blockSpanLines clamps into the live buffer and handles trims', () => {
    const a = block({ startRow: 0, marker: marker(4) })
    const b = block({ startRow: 10, marker: marker(16) })
    expect(blockSpanLines([a, b], a, 50)).toEqual({ start: 4, end: 16 })
    expect(blockSpanLines([a, b], b, 50)).toEqual({ start: 16, end: 50 })
    // Buffer shrank (trim overflowed): degraded to what remains.
    expect(blockSpanLines([a, b], a, 10)).toEqual({ start: 4, end: 10 })
    // Block fully trimmed out: empty span (start === end).
    const gone = block({ startRow: 0, marker: marker(0, true) })
    expect(blockSpanLines([gone], gone, 10)).toEqual({ start: 10, end: 10 })
  })

  it('blockForSelection resolves spans through markers (trim drift)', () => {
    const a = block({ startRow: 0, marker: marker(30), endRow: 40, finished: true })
    const b = block({ startRow: 40, marker: marker(45) })
    // Row indices drifted (scrollback trimmed), markers still accurate.
    expect(blockForSelection([a, b], 30)!.id).toBe(a.id)
    expect(blockForSelection([a, b], 44)!.id).toBe(b.id)
    expect(blockForSelection([a, b], 45)!.id).toBe(b.id)
    // A trimmed block is never attributed (its rows are gone).
    const gone = block({ startRow: 0, marker: marker(0, true) })
    expect(blockForSelection([gone], 0)).toBeNull()
    expect(blockForSelection([gone], 5)).toBeNull()
  })

  it('blockOutputText honors marker-resolved boundaries and endRow', () => {
    const buf = buffer(['@ ~ old rows', '@ ~ npm test', '✓ 3 passed', '@ ~ git status'])
    const moved = block({ startRow: 0, marker: marker(1), endRow: 3, finished: true })
    // The echo row is now line 1 (marker), output starts at 2.
    expect(blockOutputText(buf, moved)).toBe('✓ 3 passed')
    // endRow override (marker-resolved closed span).
    expect(blockOutputText(buf, block({ startRow: 1, endRow: 3 }), '', 3)).toBe('✓ 3 passed')
  })

  it('the tracker fires onSubmit per block and disposes dropped markers on cap', () => {
    const submitted: TerminalBlock[] = []
    const disposes: ReturnType<typeof vi.fn>[] = []
    const tracker = new TerminalBlockTracker((b) => {
      const dispose = vi.fn()
      disposes.push(dispose)
      b.marker = { line: b.startRow, isDisposed: false, dispose }
      submitted.push(b)
    })
    for (let i = 0; i < BLOCK_KEEP + 3; i++) tracker.onData(`c${i}\r`, i + 1)
    expect(submitted).toHaveLength(BLOCK_KEEP + 3)
    expect(submitted.at(-1)!.marker).toBeDefined()
    // Dropped blocks' markers were disposed (only the survivors stay).
    expect(disposes).toHaveLength(BLOCK_KEEP + 3)
    disposes.slice(0, 3).forEach(dispose => expect(dispose).toHaveBeenCalledTimes(1))
    disposes.slice(3).forEach(dispose => expect(dispose).not.toHaveBeenCalled())
  })
})
