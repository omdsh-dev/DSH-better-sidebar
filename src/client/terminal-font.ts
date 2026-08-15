/**
 * Terminal font resolution: the user's custom font prefs (SidebarPrefs,
 * configured under the terminal card's secondary settings) turned into the
 * xterm options. Kept as a pure module (no DOM, no xterm) so the fallback
 * chain and clamping are unit-testable without mounting a terminal.
 */
import { clampTerminalFontSize, type SidebarPrefs } from '../prefs-shared.ts'

/** The built-in fallback stack when neither the user nor the theme sets one. */
export const DEFAULT_TERMINAL_FONT_FAMILY = '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

/**
 * Resolve the xterm font options for the given prefs.
 * @param prefs - the current side card preferences.
 * @param themeFontFamily - the app's theme code font (`--ds-font-family-code`
 *   token value, read live by the caller); undefined when the token is absent.
 * @returns the `fontFamily` / `fontSize` xterm options.
 */
export function resolveTerminalFont(
  prefs: SidebarPrefs,
  themeFontFamily: string | undefined,
): { fontFamily: string; fontSize: number } {
  const custom = prefs.terminalFontFamily.trim()
  return {
    fontFamily: custom !== '' ? custom : (themeFontFamily || DEFAULT_TERMINAL_FONT_FAMILY),
    fontSize: clampTerminalFontSize(prefs.terminalFontSize),
  }
}
