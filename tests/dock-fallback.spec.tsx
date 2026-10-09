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
import { afterEach, describe, expect, it, vi } from 'vitest'
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

describe('dock fallback（空白会话入口）', () => {
  // 失败用例可能把 portal 节点留在 body 上：每个用例后清干净，避免串扰。
  afterEach(() => {
    for (const element of document.querySelectorAll('[data-dsh-dock-fallback]')) element.remove()
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
})
