/**
 * Built-in registration: the plugin registers its own tab pages and file
 * previewers through the same {@link BetterSidebarService} external plugins
 * use — eating its own dogfood. The descriptors live next to their feature
 * modules (tabs.tsx / viewers.tsx); this module only aggregates them and
 * owns the disposer lifecycle (cordis auto-invokes it on fiber disposal,
 * HMR-safe).
 */
import type { Context } from '../../context-types.ts'
import type { BetterSidebarService } from '../service.ts'
import { api } from '../api.ts'
import { createGithubInboxStore } from '../github-inbox.ts'
import { builtinTabs } from './tabs.tsx'
import { builtinViewers } from './viewers.tsx'

/**
 * Register all built-in tabs and viewers with the service. Returns a
 * disposer that unregisters everything (cordis auto-invokes it on fiber
 * disposal). The `ctx` is threaded into tab descriptors that need it
 * (EditorHost reads `ctx.betterSidebar` for file-viewer matching).
 */
export function registerBuiltins(ctx: Context, service: BetterSidebarService): () => void {
  // The GitHub inbox store is created here — once per activation — and
  // shared by the GitHub tab's badge hook and its view. Its polling timer
  // starts lazily on the first badge render, so a disabled GitHub tab never
  // polls; the disposer below stops the timer on fiber disposal (HMR-safe).
  const githubStore = createGithubInboxStore(api, service)
  const disposers: (() => void)[] = []
  for (const tab of builtinTabs(ctx, githubStore)) {
    disposers.push(service.registerTab(tab))
  }
  for (const viewer of builtinViewers()) {
    disposers.push(service.registerFileViewer(viewer))
  }
  return () => {
    for (const d of disposers) {
      try { d() } catch { /* already disposed */ }
    }
    githubStore.dispose()
  }
}
