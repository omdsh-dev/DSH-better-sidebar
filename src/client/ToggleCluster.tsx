/**
 * The expand/collapse cluster: bottom-panel glyph LEFT of the right-panel
 * glyph. Two homes share this tree:
 *
 *  - Inline, in `conversation.session.header.utilities` (same row as
 *    Session log) while a session header is painted. That is the official
 *    additive seat; the host flex-aligns us with the title row so we never
 *    sit on a different baseline than the shipped utilities.
 *  - Fixed, at the viewport's top-right, only while the header is hidden
 *    (blank hero / no session). The header entry unmounts in those states,
 *    so the body attribute this file sets drops and the floating cluster
 *    becomes the only affordance.
 *
 * The header seat is a CHILD slot of `conversation.session.header`, so
 * registration goes through `slots.inject` (same race as turn-tail).
 */
import { useCallback, useEffect, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import clsx from 'clsx'
import type { Context } from '../context-types.ts'
import { useNarrowViewport } from './breakpoints.ts'
import { IconPanelBottomOutline16, IconPanelRightOutline16 } from './icons.tsx'
import { t } from './locales.ts'
import {
  toggleBottomPanel, togglePanel,
  type SidebarState, type SidebarStore,
} from './state.ts'
import css from './sidebar.module.css'

/** Marks that the header-hosted cluster is mounted (layout.css / module CSS
 *  hide the floating fallback and drop the tab-strip reservation). */
export const HEADER_TOGGLE_ATTR = 'data-dsh-sidebar-in-header'

/** Injected business face: the shared store the buttons write. */
export interface HeaderToggleInjected {
  store: SidebarStore
}

/** Full slot props: the session kit plus the injected store. */
export type HeaderToggleProps = PropsRuntime<'conversation.session.header.utilities'> & HeaderToggleInjected

/** Shared two-button cluster. `fixed` pins to the viewport corner (hero /
 *  no-session fallback); `inline` sits in the header utilities row. */
export function ToggleCluster(props: {
  state: SidebarState | undefined
  store: SidebarStore
  narrow: boolean
  variant: 'fixed' | 'inline'
}): ReactNode {
  const { state, store, narrow, variant } = props
  const disabled = state === undefined
  const bottomOpen = state?.bottomOpen === true
  const panelOpen = state?.panelOpen === true
  return (
    <div
      className={clsx(css.toggleCluster, variant === 'fixed' && css.toggleClusterFixed)}
      data-dsh-sidebar-header-toggle={variant === 'inline' ? '' : undefined}
    >
      {!narrow && (
        <Tooltip
          label={disabled ? t('noSession') : bottomOpen ? t('collapseBottomPanel') : t('expandBottomPanel')}
          side="bottom"
          delayMs={500}
        >
          <button
            type="button"
            className={css.toggleButton}
            disabled={disabled}
            aria-label={disabled ? t('noSession') : bottomOpen ? t('collapseBottomPanel') : t('expandBottomPanel')}
            onClick={disabled ? undefined : () => { store.reduce(toggleBottomPanel) }}
          >
            <IconPanelBottomOutline16 />
          </button>
        </Tooltip>
      )}
      <Tooltip
        label={disabled ? t('noSession') : panelOpen ? t('collapse') : t('expand')}
        side="bottom"
        delayMs={500}
      >
        <button
          type="button"
          className={css.toggleButton}
          disabled={disabled}
          aria-label={disabled ? t('noSession') : panelOpen ? t('collapse') : t('expand')}
          onClick={disabled ? undefined : () => { store.reduce(togglePanel) }}
        >
          <IconPanelRightOutline16 />
        </button>
      </Tooltip>
    </div>
  )
}

/**
 * Header-utilities occupant: the same cluster, in flow next to Session log.
 * Sets {@link HEADER_TOGGLE_ATTR} for the lifetime of this mount so the
 * floating fallback (and the tab-strip reserved pad) hide.
 */
export function HeaderToggleCluster({ store }: HeaderToggleInjected): ReactNode {
  const snapshot = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  const narrow = useNarrowViewport()
  useEffect(() => {
    document.body.setAttribute(HEADER_TOGGLE_ATTR, '')
    return () => { document.body.removeAttribute(HEADER_TOGGLE_ATTR) }
  }, [])
  return <ToggleCluster state={snapshot.state} store={store} narrow={narrow} variant="inline" />
}

/**
 * Register the cluster on the session-header utilities list. The slot is a
 * child of `conversation.session.header`, so this waits for the declaration
 * (direct `slots.register` races it). Returns the inject disposer.
 */
export function registerHeaderToggle(ctx: Context, store: SidebarStore): () => void {
  return ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'better-sidebar-toggle',
    order: 100,
    inject: () => ({ store }),
  }, HeaderToggleCluster))
}
