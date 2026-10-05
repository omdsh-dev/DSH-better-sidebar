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
