/**
 * 底部终端的「窗口保留」（window hold）协调。
 *
 * 背景：终端进程的存活由宿主决定——`webTerminals` 维护一组 holder，只有在
 * **没有任何 holder** 且静默超过 `unattendedTimeoutMs` 时才会回收进程。宿主
 * 自己的右侧栏终端 UI 会按「它自己的 tab 列表」反复调 `retainTabs(...)`，
 * 并在 dispose 时调 `retainTabs([])`；也就是说这个登记表是**最后写入者胜**，
 * 而不是叠加的。
 *
 * 因此只要本插件也拥有终端 tab，就必须把「宿主右侧栏的终端 + 本插件底部的
 * 终端」作为**并集**登记，并在宿主那轮同步调用之后重放一次：宿主插件在
 * `openTabs` 的订阅回调里同步登记，本插件把重放排进 microtask，于是同一轮
 * 变更里本插件总是后写，底部终端不会被误判为「未保留」而回收。
 *
 * 这一层刻意做成纯函数 + 注入式协调器（不 import cordis/宿主服务），便于单测；
 * 与 `ctx.webTerminals` / `ctx.sidebarRight.openTabs` 的实际接线见
 * `retention-host.ts`。
 */
import type { RetainedTerminalTab } from './types.ts'

/** 登记项的身份键：同一会话里的同一个 tab。 */
function keyOf(tab: RetainedTerminalTab): string {
  return `${tab.sessionId}\u0000${tab.tabId}`
}

/**
 * 合并两个来源的终端登记：宿主的右侧栏终端与本插件底部工作台的终端。
 * 同键以「本插件」为准（本插件的视图键不会与宿主的原生 tab id 相同，这里只是
 * 让合并幂等、结果稳定）。
 * @param hostTabs - 宿主右侧栏当前打开的终端 tab。
 * @param ownTabs - 本插件底部工作台当前打开的终端 tab。
 * @returns 去重后的并集（宿主在先，本插件在后）。
 */
export function mergeRetainedTerminals(
  hostTabs: readonly RetainedTerminalTab[],
  ownTabs: readonly RetainedTerminalTab[],
): RetainedTerminalTab[] {
  const merged = new Map<string, RetainedTerminalTab>()
  for (const tab of hostTabs) merged.set(keyOf(tab), tab)
  for (const tab of ownTabs) merged.set(keyOf(tab), tab)
  return [...merged.values()]
}

/** 协调器的注入面。 */
export interface TerminalRetentionSources {
  /** 宿主右侧栏当前打开的终端 tab。 */
  hostTabs(): readonly RetainedTerminalTab[]
  /** 本插件底部工作台当前打开的终端 tab（全部已缓存会话）。 */
  ownTabs(): readonly RetainedTerminalTab[]
  /** 订阅任一来源的变化；返回取消订阅。 */
  subscribe(listener: () => void): () => void
  /** 写入登记（`webTerminals.retainTabs`）。 */
  retain(tabs: readonly RetainedTerminalTab[]): void
  /** 调度一次重放；默认 microtask——必须晚于宿主插件在同一变更里的同步登记。 */
  schedule?(run: () => void): void
}

/** 重放协调器。 */
export interface TerminalRetention {
  /** 排一次重放（同一轮里多次调用只写一次）。 */
  assert(): void
  /** 停止订阅并撤销未执行的重放（不写空列表：撤销由宿主自己的生命周期负责）。 */
  dispose(): void
}

const defaultSchedule = (run: () => void): void => { queueMicrotask(run) }

/**
 * 建立保留协调器：订阅两个来源，任何一侧变化后按并集重放一次登记。
 * @param sources - 注入的读取/订阅/写入面（见 {@link TerminalRetentionSources}）。
 * @returns 协调器（`assert` 手动补写，`dispose` 收尾）。
 */
export function createTerminalRetention(sources: TerminalRetentionSources): TerminalRetention {
  const schedule = sources.schedule ?? defaultSchedule
  let pending = false
  let disposed = false

  const flush = (): void => {
    pending = false
    if (disposed) return
    sources.retain(mergeRetainedTerminals(sources.hostTabs(), sources.ownTabs()))
  }

  const assert = (): void => {
    if (disposed || pending) return
    pending = true
    schedule(flush)
  }

  const unsubscribe = sources.subscribe(assert)
  // 首次登记：激活时就把两边的现状写进去，不依赖任何一次变更。
  assert()

  return {
    assert,
    dispose: () => {
      disposed = true
      pending = false
      unsubscribe()
    },
  }
}
