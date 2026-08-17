/**
 * Client half of dsh-better-sidebar: resolves the user's "Side card"
 * preferences through the plugin's own fenced settings route, mounts the
 * right sidebar portal (inside an error boundary so a rendering failure
 * shows an error strip instead of a blank panel), registers the turn-tail
 * interception, and contributes the Side card settings section to the DSH
 * Settings shell. Requires the runtime's slots and sessions services; the
 * bundle itself is a module-table consumer only (react + ui-primitives +
 * xterm, all provided or inlined).
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context } from '../context-types.ts'
import { createSidebarStore } from './state.ts'
import { createBetterSidebarService, matchUrlTarget } from './service.ts'
import { resetChunks } from './chunk-loader.ts'
import { registerBuiltins } from './builtins/index.ts'
import { Sidebar } from './Sidebar.tsx'
import { RenderBoundary } from './RenderBoundary.tsx'
import { registerOpenPathInterception, registerTurnTailInterception } from './intercept.tsx'
import { registerLinkInterception } from './link-intercept.ts'
import { registerImeGuard } from './ime-guard.ts'
import { registerSettingsNavIcon } from './settings-nav-icon.ts'
import { loadPrefs } from './prefs.ts'
import { SideCardSection } from './SideCardSection.tsx'
import { api } from './api.ts'
import { LOCALE_NS, attachLocale, t, zh, en } from './locales.ts'
import css from './sidebar.module.css'
import './layout.css'

/** Services required before mounting (provided by the client runtime; the
 *  locale service backs the sidebar's copy — see locales.ts). */
export const inject = ['slots', 'sessions', 'connection', 'workspaces', 'locale']

/**
 * Error boundary over the sidebar tree (root scope): a render error in the
 * sidebar SHELL itself must never blank the page silently — the shared
 * RenderBoundary shows a dismissible error strip and logs the stack. The
 * per-tab scope (Sidebar.tsx) catches viewer/editor crashes first; this root
 * boundary stays as the last resort for Workbench/shell errors.
 */
/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots, sessions).
 */
export function apply(ctx: Context): void {
  // The sidebar follows the DSH i18n system: attach the locale service so
  // the module-level t()/isZh() resolve the Host-backed language preference
  // (and switch live — the Sidebar root subscribes to it), and register the
  // plugin's dictionaries into the shared locale registry. The disposers
  // run on fiber disposal, so re-activation (HMR) re-registers cleanly.
  attachLocale(ctx.locale)
  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
    const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
    return () => { offZh(); offEn() }
  }, 'dsh-better-sidebar: dictionaries')
  // One store instance per activation: production code creates it only here,
  // then hands it to the mounted panel and closes over it in the slot
  // registrations (the official createXXXStore() factory rule — no
  // module-level singleton).
  const sidebarStore = createSidebarStore()
  // The sidebar registry service: external plugins register tab types and
  // file previewers through `ctx.betterSidebar.registerTab/registerFileViewer`.
  // Published before the panel mounts so consumers injecting 'betterSidebar'
  // are ready by the time the sidebar renders.
  const service = createBetterSidebarService(sidebarStore)
  ctx.provide('betterSidebar', service)
  // Register the plugin's own built-in tabs and viewers through the same
  // service (eating our own dogfood). The disposer unregisters them on
  // fiber disposal (HMR-safe).
  ctx.effect(
    () => registerBuiltins(ctx, service),
    'dsh-better-sidebar: register built-in tabs and viewers',
  )
  // A failure anywhere in the client lifecycle must never take the app down
  // silently: log with the plugin prefix and pin a visible diagnostic strip
  // to the page so a blank panel is never the only symptom.
  const fail = (phase: string, error: unknown): void => {
    console.error(`[dsh-better-sidebar] ${phase} error:`, error)
    try {
      const bar = document.createElement('div')
      bar.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;'
        + 'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f2a1a1;background:#1b1b22;'
        + 'border:1px solid #f2a1a1;border-radius:8px;white-space:pre-wrap'
      bar.textContent = `[dsh-better-sidebar] ${phase} error: ${error instanceof Error ? error.message : String(error)}`
      document.body.appendChild(bar)
    } catch {
      // Nothing left to report with.
    }
  }
  try {
    // Fresh chunk state for this activation: invalidate any chunk factories
    // registered by a previous fiber (HMR) and drop the in-memory load cache
    // so the next lazy open re-fetches the current chunk scripts.
    resetChunks()
    ctx.effect(() => {
      let disposed = false
      let root: Root | undefined
      let host: HTMLDivElement | undefined
      void (async () => {
        // Resolve the user's side card prefs BEFORE the first session seeds,
        // so a brand-new conversation opens (or stays closed) at the chosen
        // width from first paint. A settings route failure falls back to the
        // schema defaults; the sidebar still mounts (a stalled wire gives up
        // after the timeout and mounts on the defaults).
        const prefs = await Promise.race([
          loadPrefs(api),
          new Promise<null>(resolve => { const timer = window.setTimeout(() => resolve(null), 2000) }),
        ])
        if (prefs !== null) sidebarStore.setPrefs(prefs)
        if (disposed) return
        try {
          host = document.createElement('div')
          host.setAttribute('data-dsh-better-sidebar', '')
          document.body.appendChild(host)
          root = createRoot(host)
          root.render(createElement(RenderBoundary, { className: css.boundaryError }, createElement(Sidebar, { ctx, store: sidebarStore })))
        } catch (error) {
          fail('mount', error)
        }
      })()
      return () => {
        disposed = true
        root?.unmount()
        host?.remove()
      }
    }, 'dsh-better-sidebar: sidebar mount')

    ctx.effect(
      () => {
        try {
          return registerTurnTailInterception(ctx, sidebarStore)
        } catch (error) {
          fail('interception', error)
          return undefined
        }
      },
      'dsh-better-sidebar: turn-tail interception',
    )

    ctx.effect(
      () => {
        try {
          return registerOpenPathInterception(ctx, sidebarStore)
        } catch (error) {
          fail('interception', error)
          return undefined
        }
      },
      'dsh-better-sidebar: open-path interception',
    )

    ctx.effect(
      () => {
        try {
          // External http(s) links in the chat/GUI open the sidebar instead
          // of a new window. Gated on the browserInterceptLinks MASTER pref,
          // the URL's protocol flag (browserInterceptHttp / Https — https
          // defaults OFF: most https sites refuse iframe embedding), and the
          // target tab's enable switch; Ctrl/Cmd+click always bypasses. The
          // target is the first registered tab whose `urlTarget` claims the
          // URL (enabled tabs only), else the built-in browser tab.
          const urlTargetOf = (url: URL): string | undefined => {
            const prefs = sidebarStore.getPrefs()
            const enabled = service.getTabs().filter(tab => prefs.tabsEnabled[tab.id] !== false)
            return matchUrlTarget(enabled, url)?.id
          }
          return registerLinkInterception({
            takeoverEnabled: (url) => {
              const prefs = sidebarStore.getPrefs()
              if (prefs.browserInterceptLinks === false) return false
              const protocolOn = url.protocol === 'https:'
                ? prefs.browserInterceptHttps !== false
                : prefs.browserInterceptHttp !== false
              if (!protocolOn) return false
              // A plugin claim is the target (already enabled-filtered);
              // otherwise the built-in browser must be enabled.
              return urlTargetOf(url) !== undefined || prefs.tabsEnabled['browser'] !== false
            },
            openInSidebar: (url) => {
              let title: string | undefined
              try { title = new URL(url).hostname } catch { /* keep the default title */ }
              const type = urlTargetOf(new URL(url)) ?? 'browser'
              ctx.betterSidebar?.openTab({ type, url, title })
            },
            selfOrigin: window.location.origin,
          })
        } catch (error) {
          fail('interception', error)
          return undefined
        }
      },
      'dsh-better-sidebar: link interception',
    )

    // The IME guard: composition keys (candidate arrows, confirm, cancel)
    // belong to the input method, never to page JS. Inlined third-party UI
    // (formerly Univer's office controls, #562 regression) has shipped
    // unguarded keydown handlers that hijack ArrowUp/ArrowDown and break
    // Chinese input; the document-capture guard neutralizes the whole class
    // before React or any native listener sees the event. Registered as
    // early as possible so no other capture-phase listener can win the
    // ordering race.
    ctx.effect(
      () => {
        try {
          return registerImeGuard()
        } catch (error) {
          fail('ime guard', error)
          return undefined
        }
      },
      'dsh-better-sidebar: IME composition guard',
    )

    // DSH 0.1.x does not yet carry an icon through the settings.section
    // registration contract: its shell renders a generic gear for every
    // external section. Mark only this plugin's localized nav row so
    // layout.css can paint the requested Side card SVG; the disposer clears
    // the marker for HMR / plugin disable.
    ctx.effect(
      () => registerSettingsNavIcon(() => t('settingsNav')),
      'dsh-better-sidebar: settings navigation icon',
    )

    // The "Side card" settings section: appears in the DSH Settings shell
    // once the shell's declaration is on the ledger (slots.inject waits for
    // it); the section reads/writes the prefs through the plugin's own
    // fenced settings route, keeps the shared store in sync, and renders the
    // declarative enable/disable inventory from the tab/viewer registry.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'better-sidebar',
      order: 100,
      label: () => t('settingsNav'),
      inject: () => ({ store: sidebarStore, service }),
    }, SideCardSection))
  } catch (error) {
    fail('load', error)
  }
}
