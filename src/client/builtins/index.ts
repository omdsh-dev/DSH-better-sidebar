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
import { hasHostTerminals } from '../terminal/terminal-tab.tsx'
import { builtinTabs } from './tabs.tsx'
import { builtinViewers } from './viewers.tsx'

/**
 * Register all built-in tabs and viewers with the service. Returns a
 * disposer that unregisters everything (cordis auto-invokes it on fiber
 * disposal). The `ctx` is threaded into tab descriptors that need it
 * (EditorHost reads `ctx.betterSidebar` for file-viewer matching).
 */
export function registerBuiltins(
  ctx: Context,
  service: BetterSidebarService,
): () => void {
  const disposers: (() => void)[] = []
  // 底部终端复用宿主的公开客户端终端服务；服务缺失的宿主（老版本）上不注册这个
  // 类型，免得 + 菜单里多出一个点开即报错的终端。
  const terminalHost = hasHostTerminals(ctx)
  for (const tab of builtinTabs()) {
    if (tab.bottomOnly === true && !terminalHost) continue
    disposers.push(service.registerTab(tab))
  }
  for (const viewer of builtinViewers()) {
    disposers.push(service.registerFileViewer(viewer))
  }
  return () => {
    for (const d of disposers) {
      try { d() } catch { /* already disposed */ }
    }
  }
}
