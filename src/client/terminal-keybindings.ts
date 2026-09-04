/**
 * Terminal keyboard overrides kept outside TerminalView so their modifier
 * gates and side effects can be unit-tested without mounting xterm.
 */

/** The subset of xterm used by the selection-copy shortcut. */
export interface TerminalSelectionSource {
  hasSelection(): boolean
  getSelection(): string
}

/** Clipboard writer shape shared with dsh-client-ui-primitives. */
export type ClipboardWriter = (text: string) => Promise<boolean>

/**
 * Copy an active terminal selection on plain Ctrl+C.
 *
 * Returning false tells xterm not to translate the key into ETX/SIGINT. When
 * there is no selection (or another modifier is present), returning true
 * preserves the terminal's normal key handling.
 */
export function handleTerminalCopyKeyEvent(
  event: KeyboardEvent,
  terminal: TerminalSelectionSource,
  writeClipboard: ClipboardWriter,
): boolean {
  const isCopy = event.type === 'keydown'
    && event.ctrlKey
    && !event.shiftKey
    && !event.altKey
    && !event.metaKey
    && event.key.toLowerCase() === 'c'
    && terminal.hasSelection()

  if (!isCopy) return true

  event.preventDefault()
  event.stopPropagation()
  void writeClipboard(terminal.getSelection())
  return false
}
