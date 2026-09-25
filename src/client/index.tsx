/**
 * Client half of dsh-better-sidebar: resolves the user's "Side card"
 * preferences through the plugin's own fenced settings route, mounts the
 * right sidebar portal (inside an error boundary so a rendering failure
 * shows an error strip instead of a blank panel), and contributes the Side
 * card settings section to the DSH Settings shell. Requires the runtime's
 * slots and sessions services; the bundle itself is a module-table consumer
 * only (react + ui-primitives, all provided or inlined — the editor and
 * mermaid libraries arrive as lazy chunks).
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context } from '../context-types.ts'
import { createSidebarStore } from './state.ts'
import { createBetterSidebarService, matchUrlTarget } from './service.ts'
import { revalidateChunksOnReactivate, setChunkModuleSystem } from './chunk-loader.ts'
import { registerBuiltins } from './builtins/index.ts'
import { Sidebar } from './Sidebar.tsx'
import { RenderBoundary } from './RenderBoundary.tsx'
import { createNativeTabRecords } from './native/tab-adapter.tsx'
import { registerNativeSurface } from './native/index.ts'
import { registerBottomToggle } from './sidebar/bottom-toggle.tsx'
import { createNativeSurface } from './native/surface.ts'
import { isTargetAvailable, openInterceptedLink, registerLinkInterception, shouldTakeOverLink } from './link-intercept.ts'
import { registerImeGuard } from './ime-guard.ts'
import { registerSettingsNavIcon } from './settings-nav-icon.ts'
import { loadBootDecision } from './prefs.ts'
import { SideCardSection } from './SideCardSection.tsx'
import { api } from './api.ts'
import { LOCALE_NS, attachLocale, attachBetterLocale, t, zh, en } from './locales.ts'
import { loadChunk } from './chunk-loader.ts'
import css from './sidebar.module.css'
import './layout.css'

/** Services required before mounting (provided by the client runtime; the
 *  locale service backs the sidebar's copy — see locales.ts). `modules`
 *  (rc.8+) is the client module system the chunk loader resolves its
 *  externals through; `connection` (0.1.2-alpha.2+) is the Remote transport's
 *  recovery lifecycle the side chat's disconnect banner reads — Cordis guards
 *  service access without inject. */
export const inject = ['slots', 'sessions', 'locale', 'modules', 'connection']

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

  // Opt-in third-language support through @huanlin/dsh-plugin-better-locale.
  // When that plugin is installed, it publishes `ctx.betterLocale` (the
  // override store) and patches LocaleRuntime.prototype.lookup to consult
  // it. We mirror the same override awareness into the sidebar's own `t()`:
  // attachBetterLocale() makes t() consult the store's getOverride first,
  // so the sidebar's chrome (which bypasses ctx.locale and calls t()
  // directly) also switches to the override language. We also register
  // the ja dict with the better-locale store so external callers of
  // ctx.locale.lookup('betterSidebar', key) get the override text too.
  //
  // Activation-order-safe: ctx.get('betterLocale') is a non-reactive read
  // (cordis only re-evaluates declared `inject` deps). If better-locale
  // activates after better-sidebar, the initial read returns undefined.
  // We subscribe to the locale revision — better-locale bumps it on
  // activation (when a persisted override exists) and on every override
  // switch — and re-check ctx.get on each bump, attaching + registering
  // the ja dict once the store becomes available.
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    // Guards the async chunk registration below: a sync() re-run (or fiber
    // disposal) that lands while the chunk is still in flight must render
    // that registration moot.
    let generation = 0
    const sync = (): void => {
      generation += 1
      dispose?.()
      dispose = undefined
      const store = ctx.get('betterLocale') as
        | {
            readonly active: string | undefined
            getOverride(dshActive: string, ns: string, key: string): string | undefined
            isOverrideActive(dshActive: string): boolean
            register(ns: string, dicts: Record<string, Record<string, string>>): () => void
            subscribe(listener: () => void): () => void
          }
        | undefined
      attachBetterLocale(store)
      if (store !== undefined) {
        // The 19 override dictionaries ride the lazy `locale` chunk: until
        // it lands, the store has no betterSidebar entries and t() keeps
        // the zh/en chain; the store's own revision bump on register
        // re-renders the chrome once the dicts arrive.
        const myGeneration = generation
        void loadChunk('locale')
          .then(mod => {
            if (myGeneration !== generation) return
            dispose = store.register(LOCALE_NS, mod.localeDicts as Record<string, Record<string, string>>)
          })
          .catch(() => { /* the dicts stay unregistered; the zh/en chain runs */ })
      }
    }
    // Initial check (picks up the store if better-locale activated first).
    sync()
    // Re-check on every locale revision bump (better-locale bumps when it
    // activates with a persisted override, and when the user switches).
    const unsubscribe = ctx.locale.subscribe(sync)
    return () => {
      generation += 1
      unsubscribe()
      dispose?.()
      attachBetterLocale(undefined)
    }
  }, 'dsh-better-sidebar: better-locale lazy integration')
  // A failure anywhere in the client lifecycle must never take the app down
  // silently: log with the plugin prefix and pin a visible diagnostic strip
  // to the page so a blank panel is never the only symptom. This strip is
  // the last-resort reporter (no CSS module is reachable from here), so its
  // colors go through skin token chains with the previous hexes as the
  // chain tails — worst case (no skin tokens on the page) it renders
  // byte-identical to the old hardcoded bar, and any `--dsw-alias-*` skin
  // re-themes it (guide §12: no hardcoded colors).
  const fail = (phase: string, error: unknown): void => {
    console.error(`[dsh-better-sidebar] ${phase} error:`, error)
    try {
      const bar = document.createElement('div')
      bar.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;max-width:70vw;padding:8px 12px;'
        + 'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;'
        + 'color:var(--dsw-alias-state-error-primary,#f2a1a1);'
        + 'background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base,#1b1b22));'
        + 'border:1px solid var(--dsw-alias-state-error-primary,#f2a1a1);border-radius:8px;white-space:pre-wrap'
      bar.textContent = `[dsh-better-sidebar] ${phase} error: ${error instanceof Error ? error.message : String(error)}`
      document.body.appendChild(bar)
    } catch {
      // Nothing left to report with.
    }
  }
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
  // The native right-Sidebar surface: the plugin's content is registered as
  // DSH tab types (one per descriptor) and every open routes there, so the
  // right column belongs to the host and only the bottom workbench stays
  // plugin-owned. Both halves live for this fiber's lifetime.
  const nativeRecords = createNativeTabRecords()
  const nativeSurface = createNativeSurface(ctx, nativeRecords)
  service.setSurface(nativeSurface)
  ctx.effect(
    () => registerNativeSurface({
      ctx, store: sidebarStore, service, records: nativeRecords,
      reportFailure: (phase, error) => { fail(`native ${phase}`, error) },
    }),
    'dsh-better-sidebar: native right-Sidebar registrations',
  )
  // The bottom workbench's expand/collapse button in DSH's session header
  // (the header's corner seat belongs to the native sidebar's own control).
  ctx.effect(
    () => registerBottomToggle(ctx, sidebarStore),
    'dsh-better-sidebar: bottom-workbench toggle',
  )
  ctx.effect(
    () => () => { nativeSurface.dispose(); service.setSurface(undefined) },
    'dsh-better-sidebar: native right-Sidebar surface',
  )
  // Register the plugin's own built-in tabs and viewers through the same
  // service (eating our own dogfood). The disposer unregisters them on
  // fiber disposal (HMR-safe).
  ctx.effect(
    () => registerBuiltins(ctx, service),
    'dsh-better-sidebar: register built-in tabs and viewers',
  )
  try {
    // rc.8+ exposes the client module system as the `ctx.modules` service;
    // the chunk loader needs it to resolve its externals, so inject it
    // before anything can load a lazy chunk.
    setChunkModuleSystem(ctx.modules)
    // Fresh chunk state for this activation: drop per-test fixtures and
    // revalidate loaded chunk scripts against the bundle route's ETags —
    // unchanged chunks keep their resolved exports (no re-inject /
    // re-execute on HMR), changed ones are dropped for a clean re-fetch.
    void revalidateChunksOnReactivate()
    ctx.effect(() => {
      let disposed = false
      let root: Root | undefined
      let host: HTMLDivElement | undefined
      let mounted = false
      let bodyObserver: MutationObserver | undefined
      let hostCheckFrame: number | null = null
      const unmount = (): void => {
        if (!mounted) return
        mounted = false
        bodyObserver?.disconnect()
        bodyObserver = undefined
        if (hostCheckFrame !== null) {
          cancelAnimationFrame(hostCheckFrame)
          hostCheckFrame = null
        }
        root?.unmount()
        root = undefined
        host?.remove()
        host = undefined
      }
      /** Re-attach the host if the page (a desktop shell wrapper, SPA
       *  navigation, …) ever removes it from <body>. Cheap: childList only,
       *  no subtree, no attribute filtering. */
      const guardAnchor = (): void => {
        if (bodyObserver !== undefined) return
        bodyObserver = new MutationObserver(() => {
          if (host !== undefined && !document.body.contains(host)) {
            document.body.appendChild(host)
          }
        })
        bodyObserver.observe(document.body, { childList: true })
      }
      /** One-shot geometry self-check: if the host page transforms
       *  <html>/<body> itself (exotic shells), a fixed panel host would
       *  track the transformed box instead of the viewport. Flip the
       *  degraded mode and pin the host to the viewport every frame until
       *  the ancestor transform is actually gone. The normal path (no
       *  page-level transform) never runs the sync loop. */
      const scheduleHostCheck = (): void => {
        hostCheckFrame ??= requestAnimationFrame(() => {
          hostCheckFrame = null
          const layer = host?.querySelector<HTMLElement>('[data-dsh-panel-host]')
          if (layer === null || layer === undefined) return
          const rect = layer.getBoundingClientRect()
          const mismatched = Math.abs(rect.left) > 8 || Math.abs(rect.top) > 8
            || Math.abs(rect.width - window.innerWidth) > 8 || Math.abs(rect.height - window.innerHeight) > 8
          if (!mismatched) {
            layer.removeAttribute('data-dsh-panel-host-degraded')
            layer.style.transform = ''
            return
          }
          layer.setAttribute('data-dsh-panel-host-degraded', '')
          console.warn('[dsh-better-sidebar] panel host geometry mismatch — a page-level transform was detected; using degraded viewport sync')
          // Track our own compensating translation so the loop judges the
          // UNCORRECTED geometry: clearing degraded mode must wait for the
          // ancestor transform to actually disappear — the frame right after
          // our correction applies would otherwise look "fixed" and the
          // offset would return immediately (CR #232 P1).
          let applied = { x: 0, y: 0 }
          const sync = (): void => {
            const r = layer.getBoundingClientRect()
            const rawLeft = r.left - applied.x
            const rawTop = r.top - applied.y
            if (Math.abs(rawLeft) <= 1 && Math.abs(rawTop) <= 1
              && Math.abs(r.width - window.innerWidth) <= 1 && Math.abs(r.height - window.innerHeight) <= 1) {
              layer.removeAttribute('data-dsh-panel-host-degraded')
              layer.style.transform = ''
              return
            }
            const next = { x: -rawLeft, y: -rawTop }
            if (next.x !== applied.x || next.y !== applied.y) {
              applied = next
              layer.style.transform = `translate(${applied.x}px, ${applied.y}px)`
            }
            hostCheckFrame = requestAnimationFrame(sync)
          }
          hostCheckFrame = requestAnimationFrame(sync)
        })
      }
      const mount = (): void => {
        if (mounted || disposed) return
        try {
          host = document.createElement('div')
          host.setAttribute('data-dsh-better-sidebar', '')
          document.body.appendChild(host)
          root = createRoot(host)
          root.render(createElement(RenderBoundary, { className: css.boundaryError }, createElement(Sidebar, { ctx, store: sidebarStore })))
          mounted = true
          guardAnchor()
          scheduleHostCheck()
        } catch (error) {
          fail('mount', error)
        }
      }
      const sync = async (): Promise<void> => {
        if (disposed) return
        // Resolve the user's side card prefs and the external-disable flag
        // from ONE settings fetch BEFORE the first session seeds, so a
        // brand-new conversation opens (or stays closed) at the chosen width
        // from first paint. A settings route failure falls back to the schema
        // defaults; the sidebar still mounts (a stalled wire gives up after
        // the timeout and mounts on the defaults — the external-disable check
        // rides the same fetch, so one round trip covers both decisions).
        const decision = await Promise.race([
          loadBootDecision(api),
          new Promise<null>(resolve => { window.setTimeout(() => resolve(null), 2000) }),
        ])
        if (disposed) return
        if (decision !== null) {
          sidebarStore.setPrefs(decision.prefs)
          // Mutual exclusion with the dsh-web-ui family right panel: while the
          // aionui-panel provider is selected, the sidebar must not mount at
          // all. Re-evaluated on every settings-document update (live switch).
          sidebarStore.setSuspended(decision.suspended)
        }
        if (decision?.suspended) unmount()
        else mount()
      }
      // setPrefs and mount() run inside sync(); a rejection there would leave
      // the sidebar unmounted with a dead toggle as its only symptom.
      void sync().catch((error) => { fail('sync', error) })
      // Live re-evaluation: the runtime broadcasts settings-document updates
      // (the aionui card saves through the same document). Best effort —
      // deployments without the 'remote' service fall back to boot-time
      // evaluation only.
      const remote = ctx.get('remote') as { $on?: (event: string, listener: () => void) => () => void } | undefined
      const offRemote = remote?.$on?.('settings/document-updated', () => { void sync().catch((error) => { fail('sync', error) }) })
      return () => {
        disposed = true
        offRemote?.()
        unmount()
      }
    }, 'dsh-better-sidebar: sidebar mount')

    ctx.effect(
      () => {
        try {
          // External links are taken over ONLY when a registered tab type
          // claims the URL through `urlTarget` (and this sidebar is not
          // suspended); Ctrl/Cmd+click and non-http(s) / same-origin links
          // always bypass. Everything else is left to the host: since DSH
          // 0.1.7 the destination of a chat link is decided by the user's
          // `linkOpening` setting plus the host's own browser tab — a kind
          // the Web profile leaves disabled — so `preventDefault`ing an
          // unclaimed link would swallow it (the host's `MarkdownAnchor`
          // does not re-check `defaultPrevented`, and plugin-drawn markdown
          // — sidechat transcripts, editor previews, HTML previews, diff
          // panes — would lose the click entirely). Host-rendered chat prose
          // therefore goes back to the host's `openExternalLink`, and
          // plugin-drawn markdown to the anchor's own `window.open`.
          const urlTargetOf = (url: URL): string | undefined => {
            const prefs = sidebarStore.getPrefs()
            const enabled = service.getTabs().filter(tab => prefs.tabsEnabled[tab.id] !== false)
            return matchUrlTarget(enabled, url)?.id
          }
          return registerLinkInterception({
            takeoverEnabled: (url) => shouldTakeOverLink(url, {
              suspended: sidebarStore.getSuspended(),
              resolveTarget: urlTargetOf,
            }),
            openInSidebar: (url) => {
              openInterceptedLink(url, {
                resolveTarget: urlTargetOf,
                // Re-checked at open time: the claim above and this open are
                // separate turns, so the type may be gone (plugin unloaded,
                // switched off) by now.
                isAvailable: (type) => isTargetAvailable(
                  type,
                  service.getTabs(),
                  sidebarStore.getPrefs().tabsEnabled,
                ),
                sidebar: ctx.get('betterSidebar'),
              })
            },
            selfOrigin: window.location.origin,
          })
        } catch (error) {
          fail('interception', error)
          return () => {}
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
          return () => {}
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
