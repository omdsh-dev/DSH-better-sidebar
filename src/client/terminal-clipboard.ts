/**
 * Clipboard keys on the bottom terminal's xterm screen.
 *
 * The terminal convention this plugin follows is Windows Terminal's, not the
 * browser's: Ctrl/Cmd+C copies ONLY when there is a selection; with no
 * selection it falls through to xterm so the shell still receives SIGINT.
 * Ctrl/Cmd+V pastes, and the Ctrl+Shift+C / Ctrl+Shift+V spellings used by
 * terminal apps work too.
 *
 * Kept as a pure function over the two faces it touches so the policy is
 * testable without a real emulator (xterm needs canvas / ResizeObserver,
 * which jsdom does not provide).
 */

/** The slice of xterm the handler reads and drives. */
export interface TerminalClipboardTarget {
  hasSelection(): boolean
  getSelection(): string
  clearSelection(): void
  paste(data: string): void
}

/** The slice of `navigator.clipboard` the handler uses. */
export interface TerminalClipboardFace {
  writeText(text: string): Promise<void>
  readText(): Promise<string>
}

/**
 * Handle one xterm key event.
 *
 * @returns `false` when the key belongs to the clipboard and xterm must NOT
 *  also process it; `true` to let xterm handle the key unchanged.
 */
export function terminalClipboardKey(
  event: KeyboardEvent,
  terminal: TerminalClipboardTarget,
  clipboard: TerminalClipboardFace | undefined,
): boolean {
  if (event.type !== 'keydown') return true
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return true
  const key = event.key.toLowerCase()
  if (key === 'c') {
    // No selection means the user wants the shell's interrupt, not a copy.
    if (!terminal.hasSelection()) return true
    const text = terminal.getSelection()
    if (text === '') return true
    if (clipboard === undefined) return true
    event.preventDefault()
    void clipboard.writeText(text).then(() => { terminal.clearSelection() }).catch(() => {})
    return false
  }
  if (key === 'v') {
    if (clipboard === undefined) return true
    event.preventDefault()
    void clipboard.readText().then((text) => {
      if (text !== '') terminal.paste(text)
    }).catch(() => {})
    return false
  }
  return true
}
