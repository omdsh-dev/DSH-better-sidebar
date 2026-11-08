// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import {
  CENTER_COLUMN_REVALIDATE_MS,
  resolveCenterColumn,
} from '../src/client/center-column.ts'
import { useCenterColumn } from '../src/client/sidebar/use-center-column.ts'

setupReactAct()

interface Fixture {
  doc: Document
  col: HTMLDivElement
  slot: HTMLDivElement
}

function connectedColumn(doc = document.implementation.createHTMLDocument()): Fixture {
  const col = doc.createElement('div')
  const slot = doc.createElement('div')
  slot.dataset.slot = 'conversation'
  col.append(slot)
  doc.body.append(col)
  return { doc, col, slot }
}

// alpha.2 fixture: a real #root in the jsdom global document, because the
// contents-skip walk needs a live defaultView.getComputedStyle (inline
// `display: contents` on the wrapper). Build:
// #root > col > wrapper[display: contents] > host[data-slot="main.conversation"].
function alphaColumn(hostSlot: string): { col: HTMLDivElement; host: HTMLDivElement } {
  const root = document.createElement('div')
  root.id = 'root'
  const col = document.createElement('div')
  const wrapper = document.createElement('div')
  wrapper.style.display = 'contents'
  const host = document.createElement('div')
  host.dataset.slot = hostSlot
  wrapper.append(host)
  col.append(wrapper)
  root.append(col)
  document.body.append(root)
  return { col, host }
}

// The alpha fixtures append into the shared jsdom document; drop them so
// later tests' querySelector scans stay deterministic.
afterEach(() => {
  for (const root of document.body.querySelectorAll('div#root')) root.remove()
})
describe('center-column anchor keys (DSH 0.1.5-alpha.2)', () => {
  it('skips display:contents slot hosts above a main.conversation host', () => {
    const { col } = alphaColumn('main.conversation')
    expect(resolveCenterColumn(null, { now: () => 0 })).toBe(col)
  })

  it('still resolves the alpha.1 conversation key through the default selector', () => {
    const { col } = alphaColumn('conversation')
    expect(resolveCenterColumn(null, { now: () => 0 })).toBe(col)
  })
})

describe('center-column locator (issue #403)', () => {
  it('reuses a connected cached column without querying during the hot-path window', () => {
    const { doc, col, slot } = connectedColumn()
    let now = 0
    const query = vi.fn<() => Element | null>(() => slot)
    const options = { document: doc, query, now: () => now }

    expect(resolveCenterColumn(col, options)).toBe(col)
    now = CENTER_COLUMN_REVALIDATE_MS - 1
    expect(resolveCenterColumn(col, options)).toBe(col)
    expect(query).not.toHaveBeenCalled()
  })

  it('fully revalidates a connected cache at the 1.5s safety-net boundary', () => {
    const { doc, col, slot } = connectedColumn()
    let now = 0
    const query = vi.fn<() => Element | null>(() => slot)
    const options = { document: doc, query, now: () => now }

    expect(resolveCenterColumn(col, options)).toBe(col)
    expect(query).not.toHaveBeenCalled()

    now = CENTER_COLUMN_REVALIDATE_MS
    expect(resolveCenterColumn(col, options)).toBe(col)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('revalidates immediately when the html style signal changes', () => {
    const { doc, col, slot } = connectedColumn()
    let now = 0
    const query = vi.fn<() => Element | null>(() => slot)
    const options = { document: doc, query, now: () => now }

    expect(resolveCenterColumn(col, options)).toBe(col)
    expect(query).not.toHaveBeenCalled()

    doc.documentElement.style.setProperty('--dsh-sidebar-width', '320px')
    now = 1
    expect(resolveCenterColumn(col, options)).toBe(col)
    expect(query).toHaveBeenCalledTimes(1)

    // The same fingerprint is cheap again; one style change causes one full
    // validation instead of turning later streaming mutations into queries.
    now = 2
    expect(resolveCenterColumn(col, options)).toBe(col)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('queries and adopts the replacement as soon as the cached column detaches', () => {
    const first = connectedColumn()
    const stale = first.col
    stale.remove()
    const { col: replacement, slot } = connectedColumn(first.doc)
    const query = vi.fn<() => Element | null>(() => slot)

    expect(resolveCenterColumn(stale, { document: first.doc, query, now: () => 1 })).toBe(replacement)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('queries when no column has been cached yet', () => {
    const { doc, col, slot } = connectedColumn()
    const query = vi.fn<() => Element | null>(() => slot)

    expect(resolveCenterColumn(null, { document: doc, query, now: () => 0 })).toBe(col)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing or detached query result', () => {
    const doc = document.implementation.createHTMLDocument()
    expect(resolveCenterColumn(null, { document: doc, query: () => null, now: () => 0 })).toBeUndefined()

    const detachedCol = doc.createElement('div')
    const detachedSlot = doc.createElement('div')
    detachedCol.append(detachedSlot)
    expect(resolveCenterColumn(null, {
      document: doc,
      query: () => detachedSlot,
      now: () => 1,
    })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// useCenterColumn 的兜底重试阶梯（v0.25 稳态开销治理）
//
// 定位器本身没变（上面的用例钉住它）；变的是**谁来驱动它**：1.5s 的表原来无条件常驻，
// 而它的周期与 CENTER_COLUMN_REVALIDATE_MS 等长 → 每次 tick 都恰好到期，缓存命中的
// 「query-free 快速路径」永远走不到。现在：缓存到可用列即停表，列被摘掉（HMR / #root
// 换节点）才重新起表，MutationObserver 仍是恢复路径。
// ---------------------------------------------------------------------------

const resizeObservers: Element[] = []

class FakeResizeObserver {
  constructor(_callback: ResizeObserverCallback) { /* 只需要构造成功 */ }
  observe(target: Element): void { resizeObservers.push(target) }
  unobserve(): void { /* noop */ }
  disconnect(): void { /* noop */ }
}

/** 账本式定时器：`window.setInterval` 的 id 是假的，起没起表直接断言。 */
const timers = new Map<number, { fn: () => void; ms: number | undefined }>()
let timerSeq = 0

/** 确定性 rAF：只有 flushFrame() 才推进一帧（观察者回调是微任务，先 await 一拍）。 */
const frames = new Map<number, FrameRequestCallback>()
let frameSeq = 0

function flushFrame(): void {
  const callbacks = [...frames.values()]
  frames.clear()
  for (const callback of callbacks) callback(0)
}

function retryTables(): number {
  return [...timers.values()].filter(entry => entry.ms === 1500).length
}

const bottomElement = document.createElement('div')
/** 稳定的 ref 对象：每次渲染换新对象会让 useCenterColumn 的 effect 每帧重跑。 */
const bottomRef = { current: bottomElement }

function CenterColumnProbe(): ReactElement {
  useCenterColumn(bottomRef, true)
  return createElement('div')
}

/** 把上面的 alpha.2 fixture（#root > col > wrapper[contents] > host）建好。 */
function renderTrackedColumn(): { unmount: () => void; col: HTMLDivElement; root: HTMLElement } {
  const { col } = alphaColumn('main.conversation')
  const root = document.getElementById('root')
  if (root === null) throw new Error('missing element: #root fixture')
  const view = renderRoot(createElement(CenterColumnProbe))
  return { unmount: view.unmount, col, root }
}

/** 往**同一个** #root 里再塞一列（换节点，而不是新建一棵树）。 */
function appendTrackedColumn(root: HTMLElement): HTMLDivElement {
  const col = document.createElement('div')
  const wrapper = document.createElement('div')
  wrapper.style.display = 'contents'
  const host = document.createElement('div')
  host.dataset.slot = 'main.conversation'
  wrapper.append(host)
  col.append(wrapper)
  root.append(col)
  return col
}

describe('useCenterColumn retry ladder', () => {
  function withHarness(body: () => void | Promise<void>): Promise<void> {
    const originalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      const id = ++timerSeq
      timers.set(id, { fn, ms })
      return id
    }) as never)
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: number) => {
      timers.delete(id)
    }) as never)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameSeq, callback)
      return frameSeq
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    timers.clear()
    frames.clear()
    return Promise.resolve()
      .then(body)
      .finally(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
        if (originalResizeObserver === undefined) Reflect.deleteProperty(globalThis, 'ResizeObserver')
        else globalThis.ResizeObserver = originalResizeObserver
        timers.clear()
        frames.clear()
      })
  }

  it('never creates the 1.5s table while a column is cached', async () => {
    await withHarness(() => {
      const { unmount, col } = renderTrackedColumn()
      try {
        // 非空洞断言：首帧 locate() 真的采纳了这个列（ResizeObserver 挂在它上面），
        // 所以「没有周期表」不是因为压根没找到列。
        expect(resizeObservers, '列必须已被采纳').toContain(col)
        expect(retryTables(), '缓存到可用列就不该有周期表').toBe(0)
      } finally {
        unmount()
      }
    })
  })

  it('keeps the cached path free of document queries across streaming mutations', async () => {
    await withHarness(async () => {
      const { unmount } = renderTrackedColumn()
      try {
        const query = vi.spyOn(document, 'querySelector')
        // 流式输出：一串子节点增删落在 #root 里，每次都驱动一次 locate()。
        for (let index = 0; index < 5; index++) {
          const row = document.createElement('div')
          document.getElementById('root')!.append(row)
          await Promise.resolve()
          act(() => { flushFrame() })
          row.remove()
          await Promise.resolve()
          act(() => { flushFrame() })
        }
        expect(query, '列还在 → 缓存命中，一次 document.querySelector 都不该有').not.toHaveBeenCalled()
        expect(retryTables(), '列还在 → 兜底表也不该建').toBe(0)
      } finally {
        unmount()
      }
    })
  })

  it('restarts the table when the cached column detaches, and stops it on the new column', async () => {
    await withHarness(async () => {
      const { unmount, col, root } = renderTrackedColumn()
      try {
        expect(retryTables()).toBe(0)
        // HMR / 换节点：列被摘掉（观察者看到 #root 的 childList 变化）。
        col.remove()
        await Promise.resolve()
        act(() => { flushFrame() })
        expect(retryTables(), '没有可用列 → 慢速兜底表必须重新起').toBe(1)

        // 新列出现：观察者驱动的这一次 locate() 采纳它，兜底表随之停掉。
        appendTrackedColumn(root)
        await Promise.resolve()
        act(() => { flushFrame() })
        expect(retryTables(), '重新缓存到列 → 兜底表停掉').toBe(0)
      } finally {
        unmount()
      }
    })
  })
})
