/**
 * Panel-toggle keyboard shortcuts: the document-level listener that toggles
 * the right sidebar (`shortcutPanel`) and the bottom terminal panel
 * (`shortcutTerminal`) from the user's Side card prefs. The combo grammar,
 * parsing, matching, and labels live in ./shortcut-combo.ts (import-free,
 * unit-tested separately).
 */
import { isNarrowWidth } from './breakpoints.ts'
import { matchesShortcut, isMacPlatform } from './shortcut-combo.ts'
import { toggleBottomPanel, togglePanel, type SidebarStore } from './state.ts'

/**
 * Register the panel-toggle shortcut listener on `document` (capture phase,
 * so it beats the app shell's own handlers; disposed with the fiber). The
 * prefs are read LIVE at event time — a settings commit re-binds instantly
 * with no re-registration. Keys pressed inside a shortcut-capture control
 * (`[data-dsh-shortcut-capture]`) are skipped: that input records its own
 * combo and must not toggle panels while the user rebinds.
 */
export function registerPanelShortcuts(store: SidebarStore): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return
    const target = event.target
    if (target instanceof Element && target.closest('[data-dsh-shortcut-capture]') !== null) return
    const isMac = isMacPlatform()
    const prefs = store.getPrefs()
    if (matchesShortcut(prefs.shortcutPanel, event, isMac)) {
      event.preventDefault()
      event.stopPropagation()
      store.reduce(togglePanel)
      return
    }
    if (matchesShortcut(prefs.shortcutTerminal, event, isMac)) {
      event.preventDefault()
      event.stopPropagation()
      // Narrow viewports merge the two workbenches into the one drawer;
      // the bottom panel does not exist there, so its shortcut toggles the
      // drawer instead of flipping an invisible state.
      const narrow = typeof window !== 'undefined' && isNarrowWidth(window.innerWidth)
      store.reduce(narrow ? togglePanel : toggleBottomPanel)
    }
  }
  document.addEventListener('keydown', onKeyDown, true)
  return () => { document.removeEventListener('keydown', onKeyDown, true) }
}
