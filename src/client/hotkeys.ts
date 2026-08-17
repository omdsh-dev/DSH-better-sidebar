/**
 * VSCode-like panel-toggle keyboard shortcuts (macOS ⌘, elsewhere Ctrl):
 *
 *   ⌘B      toggle the host app shell's LEFT sidebar (ui-layout's
 *           `ctx.layout.toggleSidebar()`) — VSCode's "View: Toggle Side Bar
 *           Visibility";
 *   ⌘J      toggle the bottom panel — VSCode's "View: Toggle Panel";
 *   ⌘⇧J     toggle the bottom panel MAXIMIZED (fullscreen over the center
 *           column; closed opens fullscreen, fullscreen restores the drag
 *           height) — VSCode's "View: Toggle Maximized Panel";
 *   ⌘⌥B     toggle the right sidebar — the plugin's own panel, Option held
 *           so the plain ⌘B stays the host sidebar's binding.
 *
 * The listener is document-CAPTURE (like the IME guard), so it wins against
 * React's delegated handlers and any inlined third-party keydown code; a
 * matched combo is fully consumed (preventDefault + stopPropagation) — the
 * shortcut belongs to the sidebar, never to the focused editor / terminal /
 * composer, matching VSCode where ⌘B/⌘J work even while typing.
 *
 * Matching is PHYSICAL (`event.code`), not layout-dependent (`event.key`):
 * on the US layout Option+B reports the key value "∫", and non-Latin
 * layouts remap key values entirely — `code` stays the key the user
 * pressed everywhere.
 *
 * Guards:
 *  - IME composition (reuses {@link isImeComposition}): during
 *    Chinese/Japanese input every pressed key belongs to the input method;
 *  - AltGraph (Windows): AltGr reports ctrlKey+altKey, so typing AltGr+B on
 *    layouts that use it must not toggle the sidebar;
 *  - key repeat: a held combo toggles once, never per auto-repeat;
 *  - shift: ONLY ⌘⇧J is a shift binding — ⌘⇧B / ⌘⌥⇧B / ⌘⌥⇧J pass through;
 *  - narrow viewports: the bottom panel does not exist there (its tabs are
 *    merged into the right drawer), so the bottom toggles are no-ops there,
 *    mirroring the hidden bottom-panel toggle button. The left sidebar
 *    keeps its own semantics (the host's toggle flips the narrow
 *    re-expand override).
 */
import { isImeComposition } from './ime-guard.ts'
import { isNarrowWidth } from './breakpoints.ts'
import { toggleBottomMaximized, toggleBottomPanel, togglePanel, type SidebarStore } from './state.ts'

/** The panel a matched shortcut toggles. */
export type PanelHotkeyTarget = 'left' | 'right' | 'bottom' | 'maximize'

/** The subset of KeyboardEvent the matcher reads (pure: testable without DOM). */
export interface HotkeyEventLike {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  isComposing: boolean
  keyCode: number
  getModifierState?: (name: string) => boolean
}

/**
 * The pure decision: which panel (if any) this keydown toggles.
 * `'left'` for ⌘/Ctrl+B (the host sidebar), `'right'` for ⌘/Ctrl+⌥/Alt+B,
 * `'bottom'` for ⌘/Ctrl+J, `'maximize'` for ⌘/Ctrl+⇧/Shift+J, null
 * otherwise.
 */
export function matchPanelHotkey(event: HotkeyEventLike): PanelHotkeyTarget | null {
  if (event.repeat) return null
  if (isImeComposition(event)) return null
  if (!(event.metaKey || event.ctrlKey)) return null
  // AltGr = Ctrl+Alt on Windows: a character-producing AltGr chord is not
  // this shortcut (getModifierState is absent only in exotic engines, in
  // which case there is no AltGraph signal to misread).
  if (event.getModifierState?.('AltGraph') === true) return null
  // Shift is a binding ONLY as ⌘⇧J (maximize the bottom panel); every other
  // shift chord (⌘⇧B, ⌘⌥⇧B, ⌘⌥⇧J, …) passes through untouched.
  if (event.shiftKey) return !event.altKey && event.code === 'KeyJ' ? 'maximize' : null
  if (event.altKey) return event.code === 'KeyB' ? 'right' : null
  // Exact keys without Option: ⌘B = the host left sidebar, ⌘J = the bottom
  // panel — nothing else.
  if (event.code === 'KeyB') return 'left'
  if (event.code === 'KeyJ') return 'bottom'
  return null
}

/**
 * Register the document-level panel-toggle shortcuts. Returns the disposer
 * (HMR-safe; call through `ctx.effect`). `toggleLeftSidebar` is the host
 * app shell's sidebar transition (ui-layout's `ctx.layout.toggleSidebar`),
 * wired by the caller so this module stays DOM-free. Without a current
 * session the store's `reduce` is a strict no-op, so the shortcuts are
 * harmless before the first conversation is selected.
 */
export function registerPanelHotkeys(store: SidebarStore, toggleLeftSidebar: () => void): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = matchPanelHotkey(event)
    if (target === null) return
    // The bottom panel does not exist on narrow viewports: leave the key to
    // the page instead of flipping a dormant flag that would only surface
    // (uninvited) after the window widens.
    if ((target === 'bottom' || target === 'maximize') && isNarrowWidth(window.innerWidth)) return
    event.preventDefault()
    event.stopPropagation()
    if (target === 'left') {
      toggleLeftSidebar()
    } else if (target === 'maximize') {
      store.reduce(toggleBottomMaximized)
    } else {
      store.reduce(target === 'right' ? togglePanel : toggleBottomPanel)
    }
  }
  document.addEventListener('keydown', onKeyDown, true)
  return () => {
    document.removeEventListener('keydown', onKeyDown, true)
  }
}

/**
 * The display hint for one toggle shortcut (tooltip suffix). macOS spells
 * ⌘B / ⌘J / ⌘⇧J / ⌘⌥B; other platforms Ctrl+B / Ctrl+J / Ctrl+Shift+J /
 * Ctrl+Alt+B — all accepted by {@link matchPanelHotkey}.
 */
export function panelHotkeyHint(target: PanelHotkeyTarget): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  if (target === 'left') return mac ? '⌘B' : 'Ctrl+B'
  if (target === 'bottom') return mac ? '⌘J' : 'Ctrl+J'
  if (target === 'maximize') return mac ? '⌘⇧J' : 'Ctrl+Shift+J'
  return mac ? '⌘⌥B' : 'Ctrl+Alt+B'
}
