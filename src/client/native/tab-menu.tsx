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
  const chips = [...document.querySelectorAll<HTMLElement>('[data-dockkit-tab]')]
  const chip = chips.find(node => node.getAttribute('data-dockkit-tab') === tabId)
  const strip = chip?.closest('[data-dockkit-strip-tabs]')
  if (chip === undefined || strip === null || strip === undefined) return undefined
  const ids = [...strip.querySelectorAll<HTMLElement>('[data-dockkit-tab]')]
    .map(node => node.getAttribute('data-dockkit-tab'))
    .filter((id): id is string => id !== null && id !== '')
  return ids.includes(tabId) ? ids : undefined
}

/**
 * One row of the kit's menu. Class + tokens mirror the kit's own item metrics
 * (4px 7px, 12px, radius-md, hover fill) so the contributed rows read as part
 * of the same menu rather than as a plugin widget dropped into it.
 */
function row(
  action: string,
  label: string,
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
  const ids = stripOrderOf(props.tab.id)
  if (ids === undefined) return null
  const index = ids.indexOf(props.tab.id)
  const others = ids.filter(id => id !== props.tab.id)
  const left = index > 0 ? ids.slice(0, index) : []
  const right = ids.slice(index + 1)
  // Dismiss BEFORE closing: the menu belongs to the kit, and a row that leaves
  // it open leaves a menu floating over content the close may have replaced.
  const run = (targets: readonly string[]): void => {
    props.dismiss()
    for (const id of targets) props.close(id)
  }
  return (
    <>
      {row('closeOthers', t('closeOtherTabs'), others, run)}
      {row('closeLeft', t('closeLeftTabs'), left, run)}
      {row('closeRight', t('closeRightTabs'), right, run)}
      {row('closeAll', t('closeAllTabs'), ids, run)}
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
    { name: 'sidebar.right.tab.menu.item' },
    (owner: NativeTabMenuOwner) => <NativeTabMenuItems {...owner} close={close} />,
  ))
}
