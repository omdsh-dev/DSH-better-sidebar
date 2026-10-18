/**
 * 空白会话的底部入口（issue #698 / #623）。
 *
 * 判定来自插件 host 半区的 `session.phase` 路由（与宿主会话列表投影同一规则），客户端
 * 不做任何 DOM 探测。这里用 vi.mock 替换该路由的客户端封装，钉住三件事：
 * 1. `blank` → 渲染右上角备用入口（`position: fixed`，紧邻宿主「Open right sidebar」按钮，
 *    位置由该按钮的 rect 对齐），且点击写 store（`bottomOpen` 翻转）；
 * 2. 非 `blank` → 整个不渲染（入口只有会话头里那一套）；
 * 3. 尚未读到相位（undefined）→ 不渲染（先不闪备用入口）。
 *
 * 备用入口经 portal 挂在 `document.body`（脱离面板宿主的层叠上下文），断言/点击都从
 * document 出发；afterEach 清理 body 上的残留，避免跨用例串扰。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the primitive-carrying sidebar graph loads.
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { DockFallback } from '../src/client/sidebar/dock-fallback.tsx'
import { sessionPhase } from '../src/client/api.ts'
import { createSidebarStore } from '../src/client/state.ts'

setupReactAct()

vi.mock('../src/client/api.ts', () => ({
  sessionPhase: vi.fn(async () => ({ blank: true })),
}))

/** 把 mock 的返回改成指定相位。 */
function phaseIs(blank: boolean): void {
  vi.mocked(sessionPhase).mockImplementation(async () => ({ blank }))
}

/** 现场改为「相位读取永远挂起」。 */
function phasePending(): void {
  vi.mocked(sessionPhase).mockImplementation(() => new Promise(() => { /* 挂起 */ }))
}

function renderDockFallback(): { unmount: () => void; store: ReturnType<typeof createSidebarStore> } {
  const store = createSidebarStore()
  store.setSession('s1')
  const view = renderRoot(createElement(DockFallback, { store }))
  return { unmount: view.unmount, store }
}

/** 备用入口经 portal 挂在 body 上，因此点击/断言都从 document 出发。 */
function clickFallbackToggle(): void {
  const element = document.querySelector('[data-dsh-dock-fallback] [data-dsh-bottom-toggle]')
  if (element === null) throw new Error('missing element: fallback bottom toggle')
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/**
 * 周期表账本：`setInterval` 被换成记账的假表，测试因此不用真的等 500ms，
 * 也能直接断言「这条表到底建没建」。`clearInterval` 一起换掉（id 是假的）。
 */
const intervals = new Map<number, { fn: () => void; ms: number | undefined }>()
let intervalSeq = 0

/** 触发所有指定间隔的周期表回调（在 act 里调）。 */
function runIntervals(ms: number): void {
  for (const entry of [...intervals.values()]) {
    if (entry.ms === ms) entry.fn()
  }
}

/** 隐藏/恢复页面：实现分别读 `document.hidden` 与 `document.visibilityState`。 */
function setPageHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
}

/**
 * 命中测试桩：每次调用计数并返回给定的「占位栈」。
 * @returns 还原函数（必须在 finally 里调）。
 */
function stubHitTest(stack: () => Element[]): { hits: () => number; reset: () => void; restore: () => void } {
  const original = document.elementsFromPoint
  const spy = vi.fn(() => stack())
  Object.defineProperty(document, 'elementsFromPoint', { configurable: true, writable: true, value: spy })
  return {
    hits: () => spy.mock.calls.length,
    reset: () => { spy.mockClear() },
    restore: () => {
      if (original === undefined) Reflect.deleteProperty(document, 'elementsFromPoint')
      else Object.defineProperty(document, 'elementsFromPoint', { configurable: true, writable: true, value: original })
    },
  }
}

/** 宿主角落锚点（收起形态），rect 固定在指定位置。 */
function appendAnchor(left: number, top = 10): HTMLButtonElement {
  const anchor = document.createElement('button')
  anchor.setAttribute('data-sidebar-right-expand', 'true')
  anchor.getBoundingClientRect = () => ({
    x: left, y: top, left, top, width: 28, height: 28, right: left + 28, bottom: top + 28,
    toJSON: () => ({}),
  }) as DOMRect
  document.body.append(anchor)
  return anchor
}

/** 等相位（与其它异步 mock）落地。 */
async function settle(): Promise<void> {
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
}

describe('dock fallback（空白会话入口）', () => {
  beforeEach(() => {
    intervals.clear()
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      const id = ++intervalSeq
      intervals.set(id, { fn, ms })
      return id
    }) as never)
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: number) => {
      intervals.delete(id)
    }) as never)
  })

  // 失败用例可能把 portal 节点留在 body 上：每个用例后清干净，避免串扰。
  afterEach(() => {
    for (const element of document.querySelectorAll('[data-dsh-dock-fallback]')) element.remove()
    Reflect.deleteProperty(document, 'hidden')
    Reflect.deleteProperty(document, 'visibilityState')
    vi.restoreAllMocks()
  })

  it('renders the fallback entry and flips the bottom workbench through the store', async () => {
    const { unmount, store } = renderDockFallback()
    try {
      await vi.waitFor(() => {
        expect(document.querySelector('[data-dsh-dock-fallback]'), '备用入口容器').not.toBeNull()
      })
      expect(document.querySelector('[data-dsh-bottom-toggle]'), '底部入口').not.toBeNull()
      expect(store.getSnapshot().state?.bottomOpen).toBe(false)

      clickFallbackToggle()
      expect(store.getSnapshot().state?.bottomOpen).toBe(true)
    } finally {
      unmount()
    }
  })

  it('renders nothing once the session is no longer blank', () => {
    phaseIs(false)
    const { unmount } = renderDockFallback()

    expect(document.querySelector('[data-dsh-dock-fallback]'), '非 blank 不该有备用入口').toBeNull()
    unmount()
  })

  it('renders nothing before the first phase read settles', () => {
    phasePending()
    const { unmount } = renderDockFallback()

    expect(document.querySelector('[data-dsh-dock-fallback]'), '相位未知时先不渲染').toBeNull()
    unmount()
  })

  // 相位是**轮询**来的（blank 期间每 1s 一次），而会话头的入口由宿主在它认为合适的
  // 时机渲染：两者之间必然存在窗口——更糟的是相位读取失败时按「非 blank」降级、但从未
  // 成功过一次的会话也可能一直停在 blank。凭相位判定「会话头不可达」因此不够：
  // 备用入口与会话头入口在版面上是**同一个位置**（都紧邻宿主「Open right sidebar」），
  // 两个都在时会精确重叠成一团。所以再加一条与相位无关的兜底：会话头那套入口只要
  // 真的在 DOM 里，备用入口就让位。
  it('yields to the session header entry whenever the host is rendering it', async () => {
    phaseIs(true) // 相位仍说 blank —— 正是会重叠的那种不一致
    const header = document.createElement('div')
    header.innerHTML = '<button data-dsh-bottom-toggle aria-label="Expand bottom panel"></button>'
    document.body.append(header)
    const { unmount } = renderDockFallback()
    try {
      // 等相位真的落地（否则断言只是在「还没读到相位」上白过）。
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
      expect(vi.mocked(sessionPhase), '相位必须已经读过一次').toHaveBeenCalled()
      expect(document.querySelector('[data-dsh-dock-fallback]'), '会话头入口在场时备用入口必须让位').toBeNull()
      expect(
        document.querySelectorAll('[data-dsh-bottom-toggle]'),
        '整页仍然只有一个底部入口',
      ).toHaveLength(1)
    } finally {
      unmount()
      header.remove()
    }
  })

  // 定位逻辑现在只服务**收起态**（右侧栏收起时宿主的角落只有「Open right sidebar」
  // 一个按钮）。让位仍是逐个槽位试探：万一宿主的收起态角落也并排了别的东西，
  // 固定偏移会正好落在**下一个**按钮上。
  it('keeps stepping left until the slot is free of host buttons', async () => {
    phaseIs(true)
    const rect = (left: number, top: number) => () => ({
      x: left, y: top, left, top, width: 28, height: 28, right: left + 28, bottom: top + 28,
      toJSON: () => ({}),
    }) as DOMRect
    // 宿主锚点（打开形态）在 500；紧邻左侧 464..492 上已经站着 Fullscreen。
    const anchor = document.createElement('button')
    anchor.setAttribute('data-sidebar-right-expand', 'true')
    anchor.getBoundingClientRect = rect(500, 10)
    const fullscreen = document.createElement('button')
    fullscreen.setAttribute('aria-label', 'Fullscreen')
    fullscreen.getBoundingClientRect = rect(464, 10)
    document.body.append(anchor, fullscreen)
    const { unmount } = renderDockFallback()
    try {
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
      const shell = document.querySelector<HTMLElement>('[data-dsh-dock-fallback]')
      expect(shell, '空白会话里备用入口应当在').not.toBeNull()
      // 464 被占 → 4px 步长退到第一个整格都不碰 Fullscreen(464..492) 的槽位 432
      // （右缘采样点 432+26=458 ≤ 460）。停在 464 就是压在 Fullscreen 上。
      expect(shell!.style.left, '占位时必须继续左移，不能停在 Fullscreen 上').toBe('432px')
    } finally {
      unmount()
      anchor.remove()
      fullscreen.remove()
    }
  })

  // 占位判定走命中测试而不是角色筛选：该点下面整摞元素只要有不透明的小控件就算占着。
  // 这里把命中测试桩成「前两个槽位被盖住」，断言入口继续左移。
  it('steps past tab chips that are not buttons (hit-test occupancy)', async () => {
    phaseIs(true)
    const rect = (left: number, top: number) => () => ({
      x: left, y: top, left, top, width: 28, height: 28, right: left + 28, bottom: top + 28,
      toJSON: () => ({}),
    }) as DOMRect
    const anchor = document.createElement('button')
    anchor.setAttribute('data-sidebar-right-expand', 'true')
    anchor.getBoundingClientRect = rect(500, 10)
    document.body.append(anchor)
    // 一个「芯片」：不是 button，但有背景色 → 命中测试必须判它占位。
    const chip = document.createElement('div')
    chip.setAttribute('data-test-chip', 'true')
    chip.style.backgroundColor = 'rgb(40, 40, 40)'
    document.body.append(chip)
    const original = document.elementsFromPoint
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      writable: true,
      value: (x: number) => (x > 430 ? [chip] : []),
    })
    const { unmount } = renderDockFallback()
    try {
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
      const shell = document.querySelector<HTMLElement>('[data-dsh-dock-fallback]')
      expect(shell, '空白会话里备用入口应当在').not.toBeNull()
      // 桩的命中测试说 x > 430 都被芯片盖住 → 右缘采样点(left+26) 必须 ≤ 430，即 left ≤ 404。
      expect(shell!.style.left, '被页签占位时必须继续左移').toBe('404px')
    } finally {
      unmount()
      anchor.remove()
      chip.remove()
      Object.defineProperty(document, 'elementsFromPoint', { configurable: true, writable: true, value: original })
    }
  })

  // 用户定的规则：**宿主右侧面板展开时不显示这个按钮**。那个状态下宿主右上角
  // 本来就是自己的一簇控件（Split / Fullscreen / Collapse right sidebar），入口挤进去
  // 只会跟它们打架 —— 干脆不出现。这条规则同时把「展开态该把入口摆哪儿」整个问题去掉，
  // 让位/命中测试那套只需要服务收起态。
  it('renders no entry while the host right panel is expanded', async () => {
    phaseIs(true)
    // 可见的 Collapse 控件（rect 非零）＝ 右侧栏展开；收起态的 Open 控件不可见。
    const hostToggle = document.createElement('button')
    hostToggle.setAttribute('data-sidebar-right-toggle', 'true')
    hostToggle.setAttribute('aria-label', 'Collapse right sidebar')
    hostToggle.getBoundingClientRect = () => ({
      x: 2000, y: 10, left: 2000, top: 10, width: 28, height: 28, right: 2028, bottom: 38,
      toJSON: () => ({}),
    }) as DOMRect
    document.body.append(hostToggle)
    const { unmount } = renderDockFallback()
    try {
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
      expect(document.querySelector('[data-dsh-dock-fallback]'), '右侧栏展开时不该有备用入口').toBeNull()
      expect(document.querySelector('[data-dsh-bottom-toggle]'), '右侧栏展开时不该有底部入口').toBeNull()
    } finally {
      unmount()
      hostToggle.remove()
    }
  })

  it('degrades to nothing when the host route is unavailable', async () => {
    vi.mocked(sessionPhase).mockRejectedValue(new Error('unsupported'))
    const { unmount } = renderDockFallback()
    try {
      // 路由/宿主不支持：按非 blank 降级（不渲染备用入口，入口留在会话头）。
      await vi.waitFor(() => {
        expect(vi.mocked(sessionPhase)).toHaveBeenCalled()
      })
      expect(document.querySelector('[data-dsh-dock-fallback]'), '降级时不渲染备用入口').toBeNull()
    } finally {
      unmount()
    }
  })

  // ==== 稳态开销（v0.25 回归：常驻轮询、隐藏页面、无界走查）====
  // 500ms 周期表原来注册在早退之前：一个正常（非 blank）会话里组件始终返回 null，
  // 表却一直在跑，每次还带一遍最多 400 步的命中测试退让走查。

  it('does not create the realign interval in a non-blank session', async () => {
    phaseIs(false)
    const anchor = appendAnchor(500)
    const hit = stubHitTest(() => [])
    const { unmount } = renderDockFallback()
    try {
      await settle()
      expect(vi.mocked(sessionPhase), '相位必须已经读过一次').toHaveBeenCalled()
      expect(document.querySelector('[data-dsh-dock-fallback]')).toBeNull()
      // 组件返回 null，但页面里仍有一条 500ms 表（DockFallback 自己也订阅的
      // 右侧面板展开态共享 poller）。判别点不是「表的总数」而是「有没有人测量」：
      // 让位走查是这条表唯一会读布局的动作。
      const atMount = hit.hits()
      act(() => { runIntervals(500) })
      expect(hit.hits(), '非 blank 会话里重对齐表不该存在，更不该测量').toBe(atMount)
    } finally {
      unmount()
      hit.restore()
      anchor.remove()
    }
  })

  it('does not measure on the 500ms tick while the page is hidden', async () => {
    phaseIs(true)
    const anchor = appendAnchor(500)
    const hit = stubHitTest(() => [])
    const { unmount } = renderDockFallback()
    try {
      await settle()
      expect(document.querySelector('[data-dsh-dock-fallback]'), '相位已读到 blank').not.toBeNull()
      // 切到后台：相位是隐藏前读到的，入口仍在渲染（渲染条件本身不看可见性）。
      act(() => {
        setPageHidden(true)
        document.dispatchEvent(new Event('visibilitychange'))
      })
      const atMount = hit.hits()
      act(() => { runIntervals(500) })
      expect(hit.hits(), '隐藏期间的 tick 不得测量').toBe(atMount)
    } finally {
      unmount()
      hit.restore()
      anchor.remove()
    }
  })

  it('re-measures exactly once when the page becomes visible again', async () => {
    phaseIs(true)
    const anchor = appendAnchor(500)
    const hit = stubHitTest(() => [])
    const { unmount } = renderDockFallback()
    try {
      await settle()
      act(() => {
        setPageHidden(true)
        document.dispatchEvent(new Event('visibilitychange'))
      })
      hit.reset()
      act(() => {
        setPageHidden(false)
        document.dispatchEvent(new Event('visibilitychange'))
      })
      // 槽位空着时一次 measure() 采样 5 个点（slotFree 的 5 个 dx），即 5 次命中测试。
      expect(hit.hits(), '回到可见必须立刻补测一次，且只补一次').toBe(5)
      // 周期表还在：再走一个 tick 就再测一次（隐藏时它是空转的，不是被拆掉的）。
      act(() => { runIntervals(500) })
      expect(hit.hits(), '恢复后周期表必须继续跑').toBe(10)
    } finally {
      unmount()
      hit.restore()
      anchor.remove()
    }
  })

  it('bounds the retreat walk at 100 steps (400px)', async () => {
    phaseIs(true)
    const anchor = appendAnchor(500)
    // 一个「整排都被占着」的页面：每个采样点都被同一个不透明芯片盖住。
    const chip = document.createElement('div')
    chip.style.backgroundColor = 'rgb(40, 40, 40)'
    document.body.append(chip)
    const hit = stubHitTest(() => [chip])
    const { unmount } = renderDockFallback()
    try {
      await settle()
      hit.reset()
      act(() => { runIntervals(500) })
      // 走查每步的**第一个**采样点就被占 → 一次 tick 恰好 100 次命中测试。
      expect(hit.hits(), '让位走查必须封顶在 100 步（400px）').toBe(100)
      const shell = document.querySelector<HTMLElement>('[data-dsh-dock-fallback]')
      // 锚点在 500、按钮 28px、间距 8px → 起点 464；100 步 × 4px = 400px → 64。
      // 旧上限（400 步）会一路退到视口左缘并停成 4px。
      expect(shell!.style.left, '耗尽上限后停在 464 - 400，而不是视口左缘').toBe('64px')
    } finally {
      unmount()
      hit.restore()
      anchor.remove()
      chip.remove()
    }
  })
})
