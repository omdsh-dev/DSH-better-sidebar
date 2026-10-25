/**
 * One rule for "is this tab type switched on", shared by every surface that
 * asks: the service's `isTabEnabled`, the Side card settings page, the
 * external-link interceptor and the + menu.
 *
 * The prefs map is authoritative whenever it has an opinion — an explicit
 * `tabsEnabled[id]` entry (true or false) is the user's own answer. With no
 * entry, the DESCRIPTOR decides: `defaultEnabled: false` means the type ships
 * off (opt-in pages such as `changes-session`), and an absent flag means on,
 * which is the shape every type registered before the flag existed has.
 *
 * A descriptor that is not registered reads as enabled on purpose: callers
 * that need to know whether the type EXISTS ask the registry separately, and
 * folding both questions into one boolean would turn "not registered yet" into
 * "disabled by the user".
 */

/** The slice of a tab descriptor the enable rule reads. */
export interface TabEnableShape {
  id: string
  /** Ship-off flag: `false` keeps the type off until the user enables it. */
  defaultEnabled?: boolean
}

/** Resolve one tab type's enable switch (`undefined` descriptor = enabled). */
export function isTabTypeEnabled(
  tab: TabEnableShape | undefined,
  tabsEnabled: Record<string, boolean>,
): boolean {
  if (tab === undefined) return true
  const explicit = tabsEnabled[tab.id]
  return explicit !== undefined ? explicit : tab.defaultEnabled !== false
}
