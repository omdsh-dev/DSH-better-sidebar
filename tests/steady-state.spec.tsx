/**
 * 稳态开销门禁（跨模块，v0.25「0.24 之后就会卡」那一类回归的看守）。
 *
 * 背景：v0.25 起原生 tab 一律 `keepMounted`，**每个访问过的 body 都是永久的**，
 * 于是任何「没人看得见却仍在跑」的周期工作都会乘上访问过的页签数并活到整页结束。
 * 单模块用例各自盯着自己的 hook；这里只问一个跨模块的问题：**把真实的壳挂起来、
 * 什么都不给看时，它手里还握着多少会自己跑起来的东西**。
 *
 * 三条断言来自用户确认的门禁口径（定时器 / 强制布局 / 请求计数）：
 *   1. **定时器**：非 blank 会话里挂载壳，只允许存在**一条** 500ms 表（共享的宿主
 *      右侧面板轮询器），且**不得**存在 5s 表（会话根的每 tab 轮询已被收敛成
 *      「按会话 + 可见性」）；页面隐藏时那条 500ms 表也必须消失。
 *   2. **强制布局**：blank 会话的兜底入口在非 blank 会话里渲染 `null`，它的
 *      500ms 重对齐表因此不得存在——判据是「没人读布局」：宿主角落控件在场
 *      （`measure()` 能走到让位走查）时，命中测试次数必须为 0。
 *   3. **请求**：底部工作台收起时，壳自己不得发 `session.cwd`（宿主那个解析器
 *      每次未命中要 spawn `git` 并回扫 4 000 条事件）。
 *
 * 最后一节是**定时器清单**：客户端所有 `setInterval(` 站点都是显式登记的，新增
 * 一个未登记的周期任务就会红——这是为「新写的轮询忘了门控」留的绊线。
 */
// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

import { Sidebar } from '../src/client/Sidebar.tsx'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'

// ── 账本：定时器 ────────────────────────────────────────────────────────────
/** 活着的表：id → 延迟与回调。id 是假的，因此用例不用等 500ms，也不会漏表。 */
const intervals = new Map<number, { delay: number; run: () => void }>()
let intervalSeq = 0

/** 活着的表按延迟归类（`live500=1` 这类断言直接读它）。 */
function liveByDelay(): Record<number, number> {
  const out: Record<number, number> = {}
  for (const entry of intervals.values()) out[entry.delay] = (out[entry.delay] ?? 0) + 1
  return out
}

/** 触发所有活着的表（在 act 里调）。 */
function runLiveIntervals(times: number): void {
  for (let i = 0; i < times; i++) for (const entry of [...intervals.values()]) entry.run()
}

// ── 账本：强制布局与请求 ────────────────────────────────────────────────────
let hitTests = 0
const requests: string[] = []

const cleanups: Array<() => void> = []
const mountedRoots: Array<() => void> = []

/** 宿主角落控件（收起态）：`readRightPanelOpen()` 读它，`measure()` 也锚在它上。 */
function appendHostCorner(): void {
  const expand = document.createElement('button')
  expand.setAttribute('data-sidebar-right-expand', 'true')
  // jsdom 没有布局：控件自己给 rect，`measure()` 的让位走查才会真的走起来。
  expand.getBoundingClientRect = (): DOMRect => ({
    x: 2000, y: 10, left: 2000, top: 10, width: 28, height: 28, right: 2028, bottom: 38,
    toJSON: () => ({}),
  }) as DOMRect
  document.body.append(expand)
  cleanups.push(() => { expand.remove() })
}

/** 页面可见性：jsdom 里 `hidden` 与 `visibilityState` 必须一起覆写。 */
function setPageHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

interface MountedShell {
  store: SidebarStore
  unmount: () => void
}

/** 挂真实 `Sidebar` 壳：真实 store + service，最小假 ctx（同 sidebar-crash 的形态）。 */
function mountShell(): MountedShell {
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  const sessionId = `steady-${intervalSeq}-${Math.random().toString(36).slice(2, 8)}`
  store.setSession(sessionId)
  const localeSnapshot = { active: 'en' }
  // cwd 在场：会话根解析因此不需要向宿主问一次才有答案。
  const sessionsSnapshot = { byId: { [sessionId]: { cwd: '/tmp' } } }
  const mounted = { getSnapshot: () => sessionId, subscribe: () => () => {} }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar'
      ? service
      : name === 'sidebarRight' ? { mounted } : undefined,
  }
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx: ctx as never, store })) })
  let unmounted = false
  const unmount = (): void => {
    if (unmounted) return
    unmounted = true
    act(() => { root.unmount() })
    container.remove()
  }
  mountedRoots.push(unmount)
  return { store, unmount }
}

afterEach(() => {
  for (const unmount of mountedRoots.splice(0).reverse()) unmount()
  for (const run of cleanups.splice(0).reverse()) run()
  intervals.clear()
  requests.length = 0
  hitTests = 0
  document.body.innerHTML = ''
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** 装上三本账：定时器 / 命中测试 / 请求。 */
function installLedgers(): void {
  vi.stubGlobal('setInterval', ((handler: () => void, delay?: number) => {
    const id = ++intervalSeq
    intervals.set(id, { delay: Number(delay) || 0, run: handler })
    return id as never
  }) as never)
  vi.stubGlobal('clearInterval', ((id: number) => { intervals.delete(id) }) as never)
  // jsdom 没有命中测试：给一个空栈（= 槽位空着，让位走查立刻收手）。
  ;(document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => {
    hitTests += 1
    return []
  }
  vi.stubGlobal('fetch', ((input: unknown) => {
    const url = String(typeof input === 'string'
      ? input
      : input instanceof URL ? input.href : (input as { url?: string })?.url ?? input)
    requests.push(url)
    const value = url.includes('session.phase')
      ? { blank: false } // 会话有内容：兜底入口整条不渲染
      : { sessionId: 's', cwd: '/tmp', root: '/tmp', parent: null }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) })
  }) as never)
}

/** 让已 resolve 的相位/请求走完一轮微任务。 */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('steady state: the shell holds no work for things nobody can see', () => {
  it('keeps one 500ms table, no session-root poller, and reads no layout', async () => {
    installLedgers()
    appendHostCorner()
    const { unmount } = mountShell()
    await flush()

    const live = liveByDelay()
    expect(live[500] ?? 0, 'exactly the shared right-panel poller may tick at 500ms').toBe(1)
    expect(live[5000] ?? 0, 'the collapsed workbench must not hold a session-root poller').toBe(0)
    expect(
      requests.filter(url => url.includes('session.cwd')),
      'nothing visible ⇒ no host cwd resolution (each miss spawns git)',
    ).toHaveLength(0)

    const hitsBefore = hitTests
    act(() => { runLiveIntervals(4) })
    expect(
      hitTests - hitsBefore,
      'the blank-session fallback renders null here, so its realign walk must not run',
    ).toBe(0)

    unmount()
    expect(intervals.size, 'unmounting the shell must stop every timer it owns').toBe(0)
  })

  it('holds no 500ms table at all while the page is hidden', async () => {
    installLedgers()
    appendHostCorner()
    const { unmount } = mountShell()
    await flush()
    expect(liveByDelay()[500] ?? 0).toBe(1)

    act(() => { setPageHidden(true) })
    expect(liveByDelay()[500] ?? 0, 'a hidden page must not keep the shared poller armed').toBe(0)

    act(() => { setPageHidden(false) })
    expect(liveByDelay()[500] ?? 0, 'becoming visible again re-arms it').toBe(1)
    unmount()
  })

  it('re-arms the shared table and nothing else when the page becomes visible again', async () => {
    installLedgers()
    appendHostCorner()
    const { unmount } = mountShell()
    await flush()
    act(() => { setPageHidden(true) })
    expect(liveByDelay()[500] ?? 0).toBe(0)
    act(() => { setPageHidden(false) })
    expect(liveByDelay()[500] ?? 0, 'becoming visible again re-arms exactly the shared table').toBe(1)
    expect(liveByDelay()[5000] ?? 0, 'and nothing else').toBe(0)
    unmount()
  })
})

// ── 定时器清单（静态绊线） ──────────────────────────────────────────────────
/**
 * 客户端每一个 `setInterval(` 站点都必须在这里登记，并写明「它什么时候停」。
 * 新增周期任务而不更新本清单 → 红；登记了门控词却从代码里删掉门控 → 也红。
 */
const TIMER_LEDGER: Array<{ file: string; gate: string; why: string }> = [
  {
    file: 'use-session-root.ts',
    gate: 'visible',
    why: '按会话引用计数的 5s 轮询：只在 ≥1 个可见订阅者时存在，document.hidden 停表',
  },
  {
    file: 'sidebar/right-panel-open.ts',
    gate: 'visibilitychange',
    why: '宿主右侧面板展开态：全模块一条共享表，隐藏即 clearInterval',
  },
  {
    file: 'sidebar/use-center-column.ts',
    gate: 'retry',
    why: '中心列定位兜底：仅在「一列都没有」时 armed，命中即停（观察者仍是恢复路径）',
  },
  {
    file: 'sidebar/dock-fallback.tsx',
    gate: 'document.hidden',
    why: '空白会话兜底入口的重对齐：只在入口真的渲染时建表',
  },
  {
    file: 'ui/git-status.ts',
    gate: 'visible',
    why: 'git 状态：30s 基线 + 退档，仅有可见的 poll:true 消费者时持有表',
  },
  {
    file: 'JobsDrawer.tsx',
    gate: 'visible',
    why: '任务耗时文本：抽成自持 state 的 memo 组件，仅在抽屉可见时走秒',
  },
  {
    file: 'session-phase.ts',
    gate: 'document.hidden',
    why: 'blank 相位：仅相位未定期间，隐藏时跳过请求，翻成非 blank 即停表',
  },
  {
    file: 'use-polling.ts',
    gate: 'enabled',
    why: '全插件唯一的轮询引擎：每个调用点都以 enabled 表达可见性',
  },
]

/** `src/client` 下的 .ts/.tsx（跳过惰性 chunk 目录：它们不是常驻面；跳过
 * `*.generated.ts`：构建产出的资产（如内联的 mermaid UMD）不是手写源码）。 */
function clientSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'chunks') continue
      clientSources(path, out)
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.generated.ts')) {
      out.push(path)
    }
  }
  return out
}

describe('steady state: the recurring-timer inventory is explicit', () => {
  // vitest 的 jsdom 环境里 `import.meta.url` 不是 file: URL，用 cwd（仓库根）拼。
  const root = join(process.cwd(), 'src/client')

  it('every setInterval site is declared with the condition that stops it', () => {
    const sites = clientSources(root)
      .filter(path => readFileSync(path, 'utf8').includes('setInterval('))
      // 清单里的键一律用 POSIX 分隔的包内相对路径：`slice(root.length)` 在
      // Windows 上会留下前导反斜杠（`\JobsDrawer.tsx`）而两边永不相等。
      .map(path => relative(root, path).split(sep).join('/'))
      .sort()
    expect(
      sites,
      'a new recurring timer must be declared in TIMER_LEDGER with the condition that stops it',
    ).toEqual([...TIMER_LEDGER].map(entry => entry.file).sort())
  })

  it('every declared site still carries its gate token (the ledger cannot rot)', () => {
    for (const entry of TIMER_LEDGER) {
      const source = readFileSync(join(root, entry.file), 'utf8')
      expect(
        source.includes(entry.gate),
        `${entry.file} is declared as gated by "${entry.gate}" (${entry.why}) but no longer mentions it`,
      ).toBe(true)
    }
  })
})
