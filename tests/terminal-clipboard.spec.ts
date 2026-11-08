/**
 * Clipboard key policy for the bottom terminal (issue #1103).
 *
 * Ctrl/Cmd+C copies ONLY when xterm has a selection; with no selection the
 * event is left to xterm, which sends SIGINT. Ctrl/Cmd+V pastes. The policy is
 * a pure function because jsdom cannot open a real xterm emulator.
 */
import { describe, expect, it, vi } from 'vitest'
import { terminalClipboardKey, type TerminalClipboardFace, type TerminalClipboardTarget } from '../src/client/terminal-clipboard.ts'

function key(name: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: 'keydown',
    key: name,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent
}

function target(selection: string | null): TerminalClipboardTarget & { pasted: string[] } {
  const pasted: string[] = []
  return {
    hasSelection: () => selection !== null,
    getSelection: () => selection ?? '',
    clearSelection: vi.fn(),
    paste: (data: string) => { pasted.push(data) },
    pasted,
  }
}

function clipboard(text = 'pasted'): TerminalClipboardFace {
  return {
    writeText: vi.fn(async () => {}),
    readText: vi.fn(async () => text),
  }
}

describe('terminal clipboard keys', () => {
  it('leaves an unmodified key to xterm', () => {
    const term = target('selected')
    const clip = clipboard()
    expect(terminalClipboardKey(key('c', { ctrlKey: false }), term, clip)).toBe(true)
    expect(clip.writeText).not.toHaveBeenCalled()
  })

  it('copies a selection and prevents xterm from sending SIGINT', async () => {
    const term = target('one\ntwo')
    const clip = clipboard()
    const event = key('c')
    expect(terminalClipboardKey(event, term, clip)).toBe(false)
    expect(clip.writeText).toHaveBeenCalledWith('one\ntwo')
    expect(event.preventDefault).toHaveBeenCalled()
    await Promise.resolve()
    expect(term.clearSelection).toHaveBeenCalled()
  })

  it('does NOT copy when there is no selection: the shell keeps Ctrl+C', () => {
    const term = target(null)
    const clip = clipboard()
    const event = key('c')
    expect(terminalClipboardKey(event, term, clip)).toBe(true)
    expect(clip.writeText).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('pastes the clipboard into xterm', async () => {
    const term = target(null)
    const clip = clipboard('echo hi')
    const event = key('v')
    expect(terminalClipboardKey(event, term, clip)).toBe(false)
    expect(event.preventDefault).toHaveBeenCalled()
    await Promise.resolve()
    expect(term.pasted).toEqual(['echo hi'])
  })

  it('accepts the Ctrl+Shift terminal spelling and Cmd on macOS', () => {
    const term = target('cmd-c')
    const clip = clipboard()
    expect(terminalClipboardKey(key('C', { shiftKey: true }), term, clip)).toBe(false)
    expect(clip.writeText).toHaveBeenCalledWith('cmd-c')
    expect(terminalClipboardKey(key('c', { ctrlKey: false, metaKey: true }), target('meta-c'), clip)).toBe(false)
  })

  it('does not hijack AltGr / Alt-modified keys', () => {
    const term = target('selected')
    const clip = clipboard()
    expect(terminalClipboardKey(key('c', { altKey: true }), term, clip)).toBe(true)
    expect(clip.writeText).not.toHaveBeenCalled()
  })

  it('falls back to xterm when the clipboard API is unavailable', () => {
    expect(terminalClipboardKey(key('c'), target('selected'), undefined)).toBe(true)
    expect(terminalClipboardKey(key('v'), target(null), undefined)).toBe(true)
  })

  it('does not paste an empty clipboard', async () => {
    const term = target(null)
    expect(terminalClipboardKey(key('v'), term, clipboard(''))).toBe(false)
    await Promise.resolve()
    expect(term.pasted).toEqual([])
  })
})
