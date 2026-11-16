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
import { createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Context } from '../context-types.ts'
import { createSidebarStore } from './state.ts'
import { createBetterSidebarService, matchUrlTarget } from './service.ts'
import { disposeSidechatSurfaces } from './sidechat-surface.ts'
import { revalidateChunksOnReactivate, setChunkModuleSystem } from './chunk-loader.ts'
import { registerBuiltins } from './builtins/index.ts'
import { Sidebar } from './Sidebar.tsx'
import { WindowHost, registerWindowSidebarSurface } from './windows/index.ts'
import { RenderBoundary } from './RenderBoundary.tsx'
import { createNativeTabRecords } from './native/tab-adapter.tsx'
import { registerNativeSurface } from './native/index.ts'
import { createNativeGuideCatalog } from './native/guide-catalog.ts'
import { registerBottomToggle } from './sidebar/bottom-toggle.tsx'
import { ContextDiagnosticsHost, createContextDiagnosticsHost, registerContextDiagnosticsUI } from './context-diagnostics-ui.tsx'
import { createNativeSurface } from './native/surface.ts'
import { isTargetAvailable, openInterceptedLink, registerLinkInterception, shouldTakeOverLink } from './link-intercept.ts'
import { registerImeGuard } from './ime-guard.ts'
import { registerQuoteSource } from './selection-quote.ts'
import { IconSideCardNav } from './icons.tsx'
import { registerChatMarkdownMentions } from './chat-mentions.ts'
import type { SettingsSectionIconOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { awaitBootDecision, type BootDecision } from './prefs.ts'
import { SideCardSection } from './SideCardSection.tsx'
import { api, call } from './api.ts'
import { insertReferenceOrText } from './conversation-draft.ts'
import { openSelectionSidechat } from './selection-sidechat.tsx'
import { seedSidechatDraft } from './sidechat-draft.ts'
import { selectionSettingsOf } from '../selection-settings.ts'
import { serializeClueToken } from '../clues/context/tokens.ts'
import { setClueSelectionActionContext, setClueSelectionActionStarter, setSelectionMenuSettings } from './clues/selection-actions.tsx'
import { createClueActionRefreshWatcher, type ClueActionDraftStatus, type ClueActionRefreshResult } from './clues/action-refresh.ts'
import { invalidateClueAgentSave, type ClueClientResourceInput } from './clues/api.ts'
import { LOCALE_NS, attachLocale, attachLocaleDicts, t, zh, en } from './locales.ts'
import { loadChunk } from './chunk-loader.ts'

/** Official host languages whose dictionaries ride the lazy `locale` chunk. */
const LAZY_LOCALES = new Set(['ja', 'de', 'es', 'fr', 'pt', 'ru'])
import { registerGithubSourceClient } from './clues/sources/github/index.tsx'
import { registerFeishuSourceClient } from './clues/sources/feishu/index.tsx'
import { appDateTime } from './clues/sources/feishu/time.ts'
import { installClueInputTriggers } from './clues/mentions.ts'
import { insertClueReferenceSpan, insertClueSelectionReference, setClueNoticeSink } from './clues/insert.ts'
import { clueMentionsCopy, feishuClientLabels } from './clues/locale-copy.ts'
import { notifyClue } from './clues/notify.ts'
import { resolveWorkspaceIdForSession } from './clues/workspace-id.ts'
import { openClueReference } from './clues/open-reference.ts'
import css from './sidebar.module.css'
import './layout.css'

/** Services required before mounting (provided by the client runtime; the
 *  locale service backs the sidebar's copy — see locales.ts). `modules`
 *  (rc.8+) is the client module system the chunk loader resolves its
 *  externals through; `connection` (0.1.2-alpha.2+) is the Remote transport's
 *  recovery lifecycle the side chat's disconnect banner reads — Cordis guards
 *  service access without inject.
 *
 *  `remote` / `remote.session` (0.1.7) are the Host Remote namespace the
 *  "open in app" adapter calls (`canOpenWorkspacePath` /
 *  `workspacePathApplications` / `openWorkspacePath`). BOTH entries are
 *  required: Cordis validates the nested property access
 *  (`ctx.get('remote').session`) against the inject list, and a missing
 *  entry throws `cannot get property "remote.session" without inject` —
 *  which, thrown from a render path, blanks the whole sidebar panel. */
export const inject = ['slots', 'sessions', 'locale', 'modules', 'connection', 'remote', 'remote.session']

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

  // The official host languages beyond zh/en ride the lazy `locale` chunk:
  // fetched the first time the host is on one of them, then registered into
  // the shared registry (so `ctx.locale.bind('betterSidebar')` resolves too)
  // and handed to `t()`. Registration bumps the locale revision, which
  // re-renders the sidebar root once the dictionaries land.
  ctx.effect(() => {
    let disposed = false
    let offDicts: (() => void) | undefined
    const sync = (): void => {
      if (offDicts !== undefined || disposed) return
      const active = ctx.locale.getSnapshot().active.toLowerCase().split('-')[0]!
      if (!LAZY_LOCALES.has(active)) return
      offDicts = () => {}
      void loadChunk('locale')
        .then(mod => {
          if (disposed) return
          // Attach before registering: register() notifies subscribers, and the
          // sidebar's revision snapshot must already see the new dictionaries.
          const dicts = mod.localeDicts as Record<string, Record<string, string>>
          attachLocaleDicts(dicts)
          const offs = Object.entries(dicts).map(([id, dict]) => ctx.locale.register(LOCALE_NS, id, dict))
          offDicts = () => { for (const off of offs) off() }
        })
        .catch(() => { offDicts = undefined })
    }
    sync()
    const unsubscribe = ctx.locale.subscribe(sync)
    return () => {
      disposed = true
      unsubscribe()
      offDicts?.()
      attachLocaleDicts({})
    }
  }, 'dsh-better-sidebar: lazy locale dictionaries')
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
  ctx.effect(() => () => { disposeSidechatSurfaces(service) }, 'dsh-better-sidebar: sidechat surface adapters')
  ctx.effect(() => registerChatMarkdownMentions(ctx), 'dsh-better-sidebar: chat Markdown mentions')
  // The shared draft-insert helpers (file tree / Tab) report refusals through
  // the plugin's ONE visible notice sink. Without this wiring they fell back
  // to console.warn and the user never saw why an insert failed.
  ctx.effect(() => {
    setClueNoticeSink(notifyClue)
    return () => { setClueNoticeSink(undefined) }
  }, 'dsh-better-sidebar: clue notice sink')
  // The unified window host's records live with the service; the React host is
  // mounted ONCE in the root tree below (never per tab body), and disposing the
  // service drops any open window. (Each mounted window's layer registration is
  // released by FloatingWindow's own unmount effect.)
  ctx.effect(() => () => { service.windowHost.dispose() }, 'dsh-better-sidebar: window host')
  // Clue client surfaces (S3/S4/S5). The host half publishes the catalogue and
  // the `clues.*` methods; the browser half registers the source glyphs, the
  // structured format renderers and the two `@` trigger sources through the
  // ONE face on the service. Every registration owns its effect disposer, so an
  // HMR reload cannot leave a duplicate display or renderer behind.
  ctx.effect(
    () => registerGithubSourceClient(service.clues),
    'dsh-better-sidebar: github clue client',
  )
  ctx.effect(
    () => registerFeishuSourceClient(service.clues, {
      // The live getter keeps every visible label following the locale without
      // a re-registration; `subscribe` additionally re-registers the renderers
      // so an open window re-renders with the new copy.
      labels: feishuClientLabels,
      formatDateTime: value => appDateTime(value),
      subscribe: listener => ctx.locale.subscribe(listener),
    }),
    'dsh-better-sidebar: feishu clue client',
  )
  // The composer's `@` sources. Workspace resolution is the authoritative
  // session → workspace lookup (never a cwd guess); refusals surface as the
  // plugin's own visible notice instead of a silent no-op.
  ctx.effect(
    () => installClueInputTriggers(ctx, {
      face: service.clues,
      resolveWorkspaceId: session => resolveWorkspaceIdForSession(ctx, session.sessionId),
      onNotice: message => { notifyClue(message) },
      openReference: reference => openClueReference(ctx, reference),
      // Every user-visible refusal follows the active locale. The copy is
      // created ONCE here but its stale-prone strings are lazy getters (insert
      // notices), so a locale switch reaches the next candidate round without
      // re-installing the trigger sources. (Model-facing projection labels
      // minted inside the codec stay stable English metadata.)
      copy: clueMentionsCopy(),
      // A not-yet-stored search hit is ensured on pick; this tail applies the
      // chip with the ORIGINAL pick-time detect span/draftRev, so an edit or
      // submission during the ensure keeps the draft untouched.
      insertReference: (reference, session, span) =>
        insertClueReferenceSpan(ctx, session.sessionId, reference, span),
    }),
    'dsh-better-sidebar: clue @ sources',
  )
  // The native right-Sidebar surface: the plugin's content is registered as
  // DSH tab types (one per descriptor) and every open routes there, so the
  // right column belongs to the host and only the bottom workbench stays
  // plugin-owned. Both halves live for this fiber's lifetime.
  const nativeRecords = createNativeTabRecords()
  // One live catalog of host guide cards, shared by the start-page takeover
  // and the settings inventory. It subscribes to the host tab registry and is
  // released with this activation.
  const nativeGuide = createNativeGuideCatalog(ctx)
  ctx.effect(() => () => { nativeGuide.dispose() }, 'dsh-better-sidebar: native guide catalog')
  const nativeSurface = createNativeSurface(ctx, nativeRecords, (tab, sessionId) => {
    service.getTab(tab.type)?.onClose?.(tab, { sessionId })
  })
  service.setSurface(nativeSurface)
  // The optional dsh-context diagnostics: ONE controller per activation. It
  // re-proves the optional runtime faces itself, so the plugin needs no new
  // inject entry; it is threaded explicitly into the three consumers (the two
  // host slots by closure, the plugin's own React tree through the provider,
  // and the native tab bodies through the native surface's deps). On a
  // deployment without dsh-context it reports `available: false` and every
  // entry point stays absent.
  const diagnostics = createContextDiagnosticsHost(ctx)
  ctx.effect(
    () => registerNativeSurface({
      ctx, store: sidebarStore, service, records: nativeRecords, diagnostics,
      guideCatalog: nativeGuide.catalog,
      reportFailure: (phase, error) => { fail(`native ${phase}`, error) },
    }),
    'dsh-better-sidebar: native right-Sidebar registrations',
  )
  ctx.effect(
    () => registerWindowSidebarSurface(ctx, service.windowHost),
    'dsh-better-sidebar: retained window native destinations',
  )
  ctx.effect(() => {
    let active = true
    const refresh = createClueActionRefreshWatcher<ClueClientResourceInput>({
      sessions: ctx.sessions,
      readDrafts: () => call<readonly ClueActionDraftStatus[]>('clues.drafts.list', {}),
      invalidate: invalidateClueAgentSave,
    })
    let savedPrefs = sidebarStore.getSnapshot().prefs
    const publishSettings = (): void => {
      savedPrefs = sidebarStore.getSnapshot().prefs
      setSelectionMenuSettings(selectionSettingsOf(savedPrefs), () => ctx.locale.getSnapshot().active)
    }
    publishSettings()
    const offSettings = sidebarStore.subscribe(() => { if (sidebarStore.getSnapshot().prefs !== savedPrefs) publishSettings() })
    setClueSelectionActionContext({ onInsert: async input => {
      if (input.target === 'side') {
        if (input.sessionId === undefined) return false
        const { childId } = await api.sidechatStart(input.sessionId)
        seedSidechatDraft(childId, input.clueId === undefined ? input.reference?.text ?? input.insert
          : serializeClueToken('clue', input.clueId) + '\n\n' + input.selection)
        openSelectionSidechat(ctx, input.sessionId, childId)
        return true
      }
      const inserted = input.sessionId !== undefined && (input.clueId === undefined
        ? insertReferenceOrText(ctx, input.sessionId, input.reference ?? { label: input.selection.slice(0, 80), text: input.insert })
        : insertClueSelectionReference(ctx, input.sessionId, { clueId: input.clueId, selection: input.selection, label: input.reference?.label }))
      if (!inserted) notifyClue(t('clueInsertFailed'))
      return inserted
    } })
    setClueSelectionActionStarter(async request => {
      const result = await call<ClueActionRefreshResult & { prompt?: string }>('clues.actions.start', { ...request })
      if (!active) return result
      if (result.prompt !== undefined) {
        const { childId } = await api.sidechatStart(request.sessionId)
        if (!active) return result
        seedSidechatDraft(childId, result.prompt)
        openSelectionSidechat(ctx, request.sessionId, childId)
        refresh.track(request, { ...result, deliveryId: childId })
      } else {
        refresh.track(request, result)
        if (request.target === 'side' && result.deliveryId !== undefined) openSelectionSidechat(ctx, request.sessionId, result.deliveryId)
      }
      return result
    })
    return () => { active = false; offSettings(); refresh.dispose(); setClueSelectionActionContext(null); setClueSelectionActionStarter(undefined) }
  }, 'dsh-better-sidebar: selection action insert and direct submit')
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
  ctx.effect(
    () => registerContextDiagnosticsUI(ctx, diagnostics),
    'dsh-better-sidebar: context diagnostics surfaces',
  )
  // The controller holds a child fiber (its runtime-face integration) and a
  // pending-open timer; releasing both is what keeps a disabled plugin — and a
  // hot reload that activates a fresh one — from leaving the old one behind.
  ctx.effect(() => () => { diagnostics.dispose() }, 'dsh-better-sidebar: context diagnostics controller')
  // Register the plugin's own built-in tabs and viewers through the same
  // service (eating our own dogfood). The disposer unregisters them on
  // fiber disposal (HMR-safe).
  ctx.effect(
    () => registerBuiltins(ctx, service),
    'dsh-better-sidebar: register built-in tabs and viewers',
  )
  // The quote chip's input-trigger source ("add selection to conversation"):
  // it answers chip clicks (open the quoted lines) and send-time
  // serialization. Waits briefly for the host's input-trigger service; without
  // it the popup keeps #1052's plain reference chip.
  ctx.effect(
    () => registerQuoteSource(ctx),
    'dsh-better-sidebar: quote-chip input-trigger source',
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
      // Settings updates can start a sync while an earlier one is still in
      // flight. Every sync gets a newer generation, and an answer may only
      // apply when it is not older than the last applied one: the boot
      // read's late continuation must never overwrite a decision a later
      // settings update already adopted.
      let syncGeneration = 0
      let appliedGeneration = 0
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
          // Viewport height units are scaled by CSS zoom even though the
          // fixed inset width still fits the viewport. Only normalize that
          // expected height; rect/offset ratios would also hide real transforms.
          const expectedHeight = (): number => {
            let zoom = 1
            for (let node: HTMLElement | null = layer; node !== null; node = node.parentElement) {
              const value = Number.parseFloat(getComputedStyle(node).zoom)
              if (Number.isFinite(value) && value > 0) zoom *= value
            }
            return window.innerHeight * zoom
          }
          const rect = layer.getBoundingClientRect()
          const mismatched = Math.abs(rect.left) > 8 || Math.abs(rect.top) > 8
            || Math.abs(rect.width - window.innerWidth) > 8 || Math.abs(rect.height - expectedHeight()) > 8
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
              && Math.abs(r.width - window.innerWidth) <= 1 && Math.abs(r.height - expectedHeight()) <= 1) {
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
          root.render(createElement(
            RenderBoundary,
            { className: css.boundaryError },
            createElement(
              ContextDiagnosticsHost,
              { controller: diagnostics },
              createElement(
                Fragment,
                null,
                createElement(Sidebar, { ctx, store: sidebarStore }),
                // The public window host is a ROOT-level singleton: every
                // `ctx.betterSidebar.windows.open()` renders here, so native
                // tab bodies (which stay mounted forever) never duplicate it.
                createElement(WindowHost, { host: service.windowHost, formats: service.clues }),
              ),
            ),
          ))
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
        // defaults. A stalled wire gives up after the first-paint budget and
        // mounts on the defaults, but the SAME read's eventual answer is
        // still adopted — a late answer must not strand the store on its
        // defaults (#1159). The external-disable check rides the same fetch,
        // so one round trip covers both decisions.
        const generation = ++syncGeneration
        const apply = (decision: BootDecision): void => {
          if (disposed || generation < appliedGeneration) return
          appliedGeneration = generation
          sidebarStore.setPrefs(decision.prefs)
          // Mutual exclusion with the dsh-web-ui family right panel: while the
          // aionui-panel provider is selected, the sidebar must not mount at
          // all. Re-evaluated on every settings-document update (live switch).
          sidebarStore.setSuspended(decision.suspended)
          if (decision.suspended) unmount()
          else mount()
        }
        const decision = await awaitBootDecision(api, apply)
        if (disposed) return
        if (decision !== null) {
          apply(decision)
          return
        }
        // First paint on the defaults. A late answer may already have applied
        // (its continuation can win the microtask race), and a newer sync's
        // answer may have too — both already chose mounted / unmounted.
        if (generation > appliedGeneration) mount()
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

    // The settings nav icon, contributed through the shell's own slot. The
    // contract addresses an icon by the section id (an unmatched id never
    // renders) and says the shell keeps its default glyph when none is
    // registered — so filling the slot REPLACES the fallback. The old
    // marker-and-CSS-mask replacement is gone with it: under the current shell
    // the nav icon is wrapped in a span, the stale `> svg:first-child` rule
    // stopped hiding the fallback and the row painted two glyphs.
    ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
      name: 'settings.section.icon',
      id: 'better-sidebar',
      order: 100,
      label: () => t('settingsNav'),
    }, ({ size }: SettingsSectionIconOwnerProps) => createElement(IconSideCardNav, { size })))

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
      inject: () => ({ store: sidebarStore, service, guideCatalog: nativeGuide.catalog }),
    }, SideCardSection))
  } catch (error) {
    fail('load', error)
  }
}
