/**
 * The native tab menu's close-family actions: the rows Chrome's tab menu has
 * that the docking kit's own menu does not (the kit contributes "Close").
 *
 * They are contributed through the host's PUBLIC seat for exactly this —
 * `sidebar.right.tab.menu.item` (a list slot whose owner share is
 * `{ tab, dismiss }`) — so the rows render inside the kit's own menu, in
 * registration order, and every row dismisses that menu itself.
 *
 * The one thing the seat does not hand over is the PANE: `TabRecord` is
 * `{ id, kind, contentId, title }`, so neither "which strip am I in" nor
 * "where in that strip" is in the contract. Closing neighbours is meaningful
 * only against the strip, so the order is read from the kit's own chips —
 * `[data-dockkit-tab]` inside `[data-dockkit-strip-tabs]`, the same stable
 * semantic attributes the equal-width rules anchor on (never a CSS-module
 * class name). Two panes are two strips, so the lookup resolves the clicked
 * chip's closest strip, not the first one in the page.
 *
 * Failure mode, by design: when that lookup does not resolve (a host version
 * that renames the attributes, a chip rendered outside a strip), the rows
 * render NOTHING. The kit's own "Close" is still there, so the menu never
 * degrades into a dead row, and the plugin never guesses a scope (a
 * session-wide "close others" would close the other pane's tabs).
 */
import type { ReactNode } from 'react'
import type { Context } from '../../context-types.ts'
import { visibleNativePanel } from './visible-panel.ts'
import { closeAllIcon, closeLeftIcon, closeOthersIcon, closeRightIcon } from '../close-family-icons.tsx'
import { t } from '../locales.ts'
import css from '../sidebar.module.css'

/**
 * The owner share the host hands to each `sidebar.right.tab.menu.item` entry.
 * Structural on purpose: only the fields this menu reads.
 */
export interface NativeTabMenuOwner {
  /** The tab whose menu is open. */
  readonly tab: { readonly id: string }
  /** Close the menu. Every acting row must call it (the menu is the kit's). */
  readonly dismiss: () => void
}

/** What the rows need from the plugin shell. */
export interface NativeTabMenuDeps {
  /** Close one tab of the on-screen session (the host's own close, recorded). */
  readonly close: (tabId: string) => void
}

/**
 * The tab ids of the strip that holds `tabId`, in strip order.
 *
 * @param tabId - the tab whose menu is open.
 * @returns its strip's ids left-to-right, or `undefined` when the tab is not
 *   inside a distinguishable strip (the rows then render nothing).
 */
export function stripOrderOf(tabId: string): string[] | undefined {
  const panel = visibleNativePanel(document)
  if (panel === undefined) return undefined
  const chips = [...panel.querySelectorAll<HTMLElement>('[data-dockkit-tab]')]
    .filter(node => node.getAttribute('data-dockkit-tab') === tabId)
  if (chips.length !== 1) return undefined
  const strip = chips[0]?.closest('[data-dockkit-strip-tabs]')
  if (strip == null || !panel.contains(strip)) return undefined
  const ids = [...strip.querySelectorAll<HTMLElement>('[data-dockkit-tab]')]
    .map(node => node.getAttribute('data-dockkit-tab'))
  if (ids.some(id => id === null || id === '') || new Set(ids).size !== ids.length) return undefined
  return ids as string[]
}

/**
 * One row of the kit's menu. Class + tokens mirror the kit's own item metrics
 * (4px 7px, 12px, radius-md, hover fill) so the contributed rows read as part
 * of the same menu rather than as a plugin widget dropped into it.
 */
function row(
  action: string,
  label: string,
  icon: ReactNode,
  targets: readonly string[],
  run: (targets: readonly string[]) => void,
): ReactNode {
  return (
    <button
      key={action}
      type="button"
      role="menuitem"
      className={css.nativeTabMenuItem}
      data-dsh-better-sidebar-tab-menu-action={action}
      disabled={targets.length === 0}
      onClick={() => { run(targets) }}
    >
      <span className={css.nativeTabMenuIcon} aria-hidden="true">{icon}</span>
      {label}
    </button>
  )
}

/**
 * The four close-family rows, scoped to the right-clicked tab's own strip.
 *
 * @param props - the host's owner share plus the plugin's close face.
 * @returns the rows, or `null` when the strip cannot be resolved.
 */
export function NativeTabMenuItems(props: NativeTabMenuOwner & NativeTabMenuDeps): ReactNode {
  const panel = visibleNativePanel(document)
  const session = panel?.getAttribute('data-sidebar-right-session')
  const ids = stripOrderOf(props.tab.id)
  if (panel === undefined || ids === undefined) return null
  const source = [...panel.querySelectorAll<HTMLElement>('[data-dockkit-tab]')]
    .find(chip => chip.getAttribute('data-dockkit-tab') === props.tab.id)
    ?.closest('[data-dockkit-strip-tabs]')
  const pane = source?.getAttribute('data-dockkit-strip-tabs')
  if (pane == null || pane === '') return null
  const index = ids.indexOf(props.tab.id)
  const others = ids.filter(id => id !== props.tab.id)
  const left = index > 0 ? ids.slice(0, index) : []
  const right = ids.slice(index + 1)
  // Dismiss BEFORE closing: the menu belongs to the kit, and a row that leaves
  // it open leaves a menu floating over content the close may have replaced.
  const run = (targets: readonly string[]): void => {
    const valid = (): boolean => visibleNativePanel(document) === panel
      && panel.getAttribute('data-sidebar-right-session') === session
    // Dismiss and close handlers are synchronous extension points: either can
    // move tabs, replace strips or switch sessions. Resolve original pane identity
    // after each callback, not a stale element or just an unchanged tab order.
    const originalPane = (): HTMLElement | undefined => {
      if (!valid()) return undefined
      const strips = [...panel.querySelectorAll<HTMLElement>('[data-dockkit-strip-tabs]')]
        .filter(strip => strip.getAttribute('data-dockkit-strip-tabs') === pane)
      return strips.length === 1 ? strips[0] : undefined
    }
    const belongs = (id: string, strip: HTMLElement): boolean => {
      const chips = [...panel.querySelectorAll<HTMLElement>('[data-dockkit-tab]')]
        .filter(chip => chip.getAttribute('data-dockkit-tab') === id)
      return chips.length === 1 && chips[0]?.closest('[data-dockkit-strip-tabs]') === strip
    }
    props.dismiss()
    const current = stripOrderOf(props.tab.id)
    const strip = originalPane()
    if (strip === undefined || !belongs(props.tab.id, strip)
      || current === undefined || current.length !== ids.length
      || !current.every((id, index) => id === ids[index])) return
    for (const id of targets) {
      const live = originalPane()
      if (live === undefined) break
      // Expected removals are allowed; a pending target moved to a sibling is
      // not. Skip it rather than following its id across pane boundaries.
      if (belongs(id, live)) props.close(id)
    }
  }
  return (
    <>
      {/* The kit's own "Close" sits above these rows; the rule keeps the
          single-tab action apart from the four bulk ones, so the group reads
          as "here is the family" rather than one long list of "Close …". */}
      <div className={css.nativeTabMenuSeparator} role="separator" aria-orientation="horizontal" />
      {row('closeOthers', t('closeOtherTabs'), closeOthersIcon, others, run)}
      {row('closeLeft', t('closeLeftTabs'), closeLeftIcon, left, run)}
      {row('closeRight', t('closeRightTabs'), closeRightIcon, right, run)}
      {row('closeAll', t('closeAllTabs'), closeAllIcon, ids, run)}
    </>
  )
}

/**
 * Contribute the rows into the host's tab menu.
 *
 * Registered through `ctx.slots.inject`, like the body/title seats: the
 * registration has to wait for the slot's declaration (the native seat
 * declares its slots before it provides its services, so a
 * declaration-triggered registration can fire while the context is still
 * missing pieces).
 *
 * @param ctx - the client context (slot registry + `ctx.sidebarRight`).
 * @returns the disposer for the registration.
 */
export function registerNativeTabMenu(ctx: Context): () => void {
  // The controller is probed at CLICK time, not registration time: the service
  // arrives late on a real profile, and a row must never throw into the host's
  // menu (a missing service makes the click a no-op).
  const close = (tabId: string): void => {
    try {
      const controller = ctx.get('sidebarRight') as unknown as { close?: (id: string) => void } | undefined
      controller?.close?.(tabId)
    } catch {
      // No controller on this page: closing is impossible, not an error.
    }
  }
  return ctx.slots.inject('sidebar.right.tab.menu.item', () => ctx.slots.register(
    {
      name: 'sidebar.right.tab.menu.item',
      // List slots are addressed by `id`, not by `key`: the host refuses a
      // registration without one (`list slot "…" requires options.id`) — and
      // a fake context that only mirrors `name` hides exactly that failure
      // until a real mount. The id is this entry's identity in the list.
      id: 'dsh-better-sidebar:close-family',
    },
    (owner: NativeTabMenuOwner) => <NativeTabMenuItems {...owner} close={close} />,
  ))
}
