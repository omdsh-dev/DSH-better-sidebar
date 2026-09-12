/**
 * Terminal Ctrl+C selection-copy regression tests (issue #465): copying an
 * active selection must not send ETX to the shell, while every non-matching
 * key path remains under xterm's normal handling.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  handleTerminalCopyKeyEvent,
  type TerminalSelectionSource,
} from '../src/client/terminal-keybindings.ts'

function keyboardEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    type: 'keydown',
    key: 'c',
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent
}

function terminal(selected: boolean, text = 'selected output'): TerminalSelectionSource {
  return {
    hasSelection: vi.fn(() => selected),
    getSelection: vi.fn(() => text),
  }
}

describe('handleTerminalCopyKeyEvent', () => {
  it.each(['c', 'C'])('copies an active selection for Ctrl+%s and prevents xterm from sending ETX', (key) => {
    const event = keyboardEvent({ key })
    const source = terminal(true)
    const writeClipboard = vi.fn(async () => true)

    expect(handleTerminalCopyKeyEvent(event, source, writeClipboard)).toBe(false)
    expect(writeClipboard).toHaveBeenCalledWith('selected output')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('leaves Ctrl+C to xterm when there is no selection', () => {
    const event = keyboardEvent()
    const source = terminal(false)
    const writeClipboard = vi.fn(async () => true)

    expect(handleTerminalCopyKeyEvent(event, source, writeClipboard)).toBe(true)
    expect(writeClipboard).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it.each([
    ['keyup', { type: 'keyup' }],
    ['missing Ctrl', { ctrlKey: false }],
    ['Shift', { shiftKey: true }],
    ['Alt', { altKey: true }],
    ['Meta', { metaKey: true }],
    ['another key', { key: 'v' }],
  ] satisfies Array<[string, Partial<KeyboardEvent>]>)('does not intercept %s', (_name, overrides) => {
    const event = keyboardEvent(overrides)
    const source = terminal(true)
    const writeClipboard = vi.fn(async () => true)

    expect(handleTerminalCopyKeyEvent(event, source, writeClipboard)).toBe(true)
    expect(writeClipboard).not.toHaveBeenCalled()
  })
})
