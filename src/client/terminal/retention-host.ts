/**
 * 保留协调器的宿主接线：把 `ctx.webTerminals`（登记写入）与
 * `ctx.sidebarRight.openTabs`（宿主右侧栏终端）+ 本插件 store（底部终端）
 * 接成 `createTerminalRetention` 需要的三件事。
 *
 * 来源读取全部是结构探测：任何一个面不存在（老宿主、宿主插件被停用）时该来源
 * 记为空集，协调器退化为「只登记自己能登记的那部分」，绝不因此抛错。
 */
import type { Context } from '../../context-types.ts'
import type { SidebarState, SidebarStore, SidebarTab } from '../state.ts'
import { TERMINAL_KIND } from './kind.ts'
import { createTerminalRetention, type TerminalRetention } from './retention.ts'
import type { RetainedTerminalTab, TerminalStore, TerminalTabMeta, WebTerminalsFace } from './types.ts'

/** `ctx.sidebarRight` 里本插件用到的部分：打开的 tab 快照。 */
interface SidebarRightOpenTabs {
  openTabs?: TerminalStore<readonly unknown[]>
}

/** 宿主右侧栏 tab 记录里本插件依赖的字段。 */
interface HostTabRecord {
  sessionId?: unknown
  tabId?: unknown
  contentId?: unknown
  kind?: unknown
}

/** 遍历一棵底部工作台 split 树里的全部 tab。 */
function eachTab(node: SidebarState['bottomSplits'], visit: (tab: SidebarTab) => void): void {
  if (node.kind === 'leaf') {
    for (const tab of node.tabs) visit(tab)
    return
  }
  for (const child of node.children) eachTab(child, visit)
}

/** 本插件所有已缓存会话里的底部终端 tab（宿主按 contentId 反查绑定）。 */
function ownTerminalTabs(store: SidebarStore): RetainedTerminalTab[] {
  const out: RetainedTerminalTab[] = []
  for (const [sessionId, state] of store.getSessionStates()) {
    eachTab(state.bottomSplits, (tab) => {
      if (tab.type !== TERMINAL_KIND) return
      const meta = tab.meta as TerminalTabMeta | undefined
      out.push({
        sessionId,
        tabId: tab.id,
        // 尚未挂载的 tab 还没有宿主绑定，用 tab id 占位即可：宿主反查不到绑定
        // 会直接跳过它（不会误保留，也不会误回收别人的终端）。
        contentId: meta?.contentId ?? tab.id,
        kind: TERMINAL_KIND,
      })
    })
  }
  return out
}

/** 宿主右侧栏当前打开的终端 tab。 */
function hostTerminalTabs(sidebarRight: SidebarRightOpenTabs | undefined): RetainedTerminalTab[] {
  const snapshot = sidebarRight?.openTabs?.getSnapshot()
  if (snapshot === undefined) return []
  const out: RetainedTerminalTab[] = []
  for (const raw of snapshot) {
    const tab = raw as HostTabRecord
    if (tab.kind !== TERMINAL_KIND) continue
    const { sessionId, tabId, contentId } = tab
    if (typeof sessionId !== 'string' || typeof tabId !== 'string' || typeof contentId !== 'string') continue
    out.push({ sessionId, tabId, contentId, kind: TERMINAL_KIND })
  }
  return out
}

/**
 * 订阅宿主终端服务与本插件 store，按并集维护窗口保留登记。
 * 宿主服务缺失时返回 no-op。
 * @param ctx - 客户端 Context。
 * @param store - 本插件的侧边栏 store（底部工作台状态与订阅）。
 * @returns 协调器；`dispose` 停止订阅（调度器已经写下的登记留给宿主生命周期处理）。
 */
export function attachTerminalRetention(ctx: Context, store: SidebarStore): TerminalRetention | undefined {
  const terminals = ctx.get('webTerminals') as unknown as WebTerminalsFace | undefined
  if (terminals === undefined || typeof terminals.retainTabs !== 'function') return undefined
  const sidebarRight = ctx.get('sidebarRight') as unknown as SidebarRightOpenTabs | undefined

  return createTerminalRetention({
    hostTabs: () => hostTerminalTabs(sidebarRight),
    ownTabs: () => ownTerminalTabs(store),
    subscribe: (listener) => {
      const offStore = store.subscribe(listener)
      const offHost = sidebarRight?.openTabs?.subscribe(listener)
      return () => {
        offStore()
        offHost?.()
      }
    },
    retain: (tabs) => { terminals.retainTabs(tabs) },
  })
}
