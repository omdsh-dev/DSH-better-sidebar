/**
 * The inline "Featured plugins" tab for the plugins page.
 *
 * The full `dsh-featured` plugin owns the rich tab (catalog browser, search,
 * README details). Peer plugins integrate through this tiny entry: it
 * registers one `plugins.tab` slot that offers the one-click install of the
 * full plugin, and yields to it once loaded. Three window flags keep the
 * contract across plugins, so exactly one tab shows up no matter how many
 * integrations are active:
 *
 *  - `__DSH_FEATURED_APPLIED__` — an inline entry already registered; later
 *    inline entries do nothing.
 *  - `__DSH_FEATURED_FULL__` — the full plugin's client is loaded; inline
 *    entries back off immediately.
 *  - `__DSH_FEATURED_ENTRY__` — this entry's disposer, so the full plugin
 *    can unregister a late inline entry (it re-checks after activation).
 *
 * The tab replaces itself on install: the full plugin registers the same
 * slot id, and the slot framework swaps the component in place. Joining
 * does not promise a listing: what shows up in the featured catalog is
 * decided by the skillpie.cn curation flow.
 *
 * @module dsh-better-sidebar/featured-entry
 */
import { createElement } from 'react'
import type { Context } from '../context-types.ts'
import { t } from './locales.ts'
import styles from './FeaturedSection.module.css'

/** The slot id the full plugin reuses to replace this entry's tab. */
const FEATURED_TAB_ID = 'dsh-plugins-plugin'

/** The npm package the button installs (the full featured plugin). */
const FEATURED_PACKAGE = 'dsh-featured'

/** One install request as the plugins page expects it. */
interface FeaturedInstallTarget {
  spec: string
  registry?: string
  title: string
  version: string
}

/** The plugins page hands every tab component its owner actions. */
export interface FeaturedSectionProps {
  /** Install without the package form (the page's own confirmed action). */
  install?: (target: FeaturedInstallTarget) => void
  /** Open one package's detail view (part of the tab contract; unused here). */
  openPackage?: (packageName: string) => void
}

/** Window flags shared with the full plugin and peer inline entries. */
interface FeaturedFlags {
  __DSH_FEATURED_APPLIED__?: boolean
  __DSH_FEATURED_FULL__?: boolean
  __DSH_FEATURED_ENTRY__?: { dispose: () => void } | undefined
}

/** Launch the full-version install; a refused dialog is reported, never thrown. */
export function launchOf(props: FeaturedSectionProps): void {
  if (typeof props.install !== 'function') return
  try {
    props.install({ spec: FEATURED_PACKAGE, title: t('featuredTabLabel'), version: '' })
  } catch (error) {
    console.warn(`[dsh-better-sidebar] featured plugins install failed:`, error)
  }
}

/** The tab body: a short pitch plus the full-version action when installable. */
export function FeaturedSection(props: FeaturedSectionProps) {
  return createElement(
    'div',
    { className: styles.body },
    createElement('p', { className: styles.desc }, t('featuredEntryDesc')),
    typeof props.install === 'function'
      ? createElement('button', { type: 'button', className: styles.action, onClick: () => launchOf(props) }, t('featuredInstallFull'))
      : null,
  )
}

/**
 * Register the inline featured entry on the client context.
 * @returns the disposer that unregisters the tab and restores the flags.
 */
export function installFeaturedEntry(ctx: Context): () => void {
  if (typeof window === 'undefined') return () => {}
  const flags = window as unknown as FeaturedFlags
  if (flags.__DSH_FEATURED_APPLIED__) return () => {}
  flags.__DSH_FEATURED_APPLIED__ = true
  if (flags.__DSH_FEATURED_FULL__) {
    // The full plugin is already loaded: back off so exactly one tab stays.
    return () => { flags.__DSH_FEATURED_APPLIED__ = false }
  }
  let disposed = false
  let offTab: (() => void) | undefined
  const disposer = (): void => {
    if (disposed) return
    disposed = true
    offTab?.()
    flags.__DSH_FEATURED_ENTRY__ = undefined
    flags.__DSH_FEATURED_APPLIED__ = false
  }
  try {
    offTab = ctx.slots.inject('plugins.tab', () => ctx.slots.register({
      name: 'plugins.tab',
      id: FEATURED_TAB_ID,
      order: 100,
      label: () => t('featuredTabLabel'),
    }, FeaturedSection))
  } catch (error) {
    console.error('[dsh-better-sidebar] featured entry error:', error)
    flags.__DSH_FEATURED_APPLIED__ = false
    return () => {}
  }
  // The full plugin unregisters late inline entries through this hook.
  flags.__DSH_FEATURED_ENTRY__ = { dispose: disposer }
  return disposer
}
