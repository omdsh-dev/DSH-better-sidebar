/**
 * 宿主右侧面板展开态的共享轮询器（v0.25 稳态开销治理）。
 *
 * 早先每个 `useRightPanelOpen()` 消费者各建一条 500ms 的表、各做两趟全文档
 * `querySelectorAll`（本插件里有两个消费者：`Sidebar.tsx` 的会话头入口与
 * `dock-fallback.tsx` 的空白会话入口）。这里钉住四件事：
 * 1. 两个消费者只建**一条**表；
 * 2. 页面隐藏时表**根本不存在**（不是 tick 进来再早退）、也不读布局，回到可见补读一次；
 * 3. 全部卸载后表被清掉（引用计数归零）；
 * 4. 宿主改属性名时读成 `false`（失败方向安全：按钮照旧出现）。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { useRightPanelOpen } from '../src/client/sidebar/right-panel-open.ts'

setupReactAct()

/**
 * 账本式定时器：id 是假的，表建没建、还在不在都能直接断言，且测试不用等 500ms。
 * 账本里的条目即「还活着的表」（`clearInterval` 删除）。
 */
const intervals = new Map<number, () => void>()
let intervalSeq = 0

/** 「读布局」与「扫文档」的计数（poller 的两类开销）。 */
let layoutReads = 0
let documentQueries = 0

/** 所有挂载过的 root 与页面节点的清理器：用例半途失败也不会把订阅者留给下一条。 */
const mounted: Array<() => void> = []
const cleanups: Array<() => void> = []

/** 幂等的清理包装（renderRoot 的 unmount 不防重复调用）。 */
function once(fn: () => void): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    fn()
  }
}

/** 挂载并登记清理；返回容器与幂等卸载。 */
function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const view = renderRoot(node)
  const unmount = once(view.unmount)
  mounted.push(unmount)
  return { container: view.container, unmount }
}

/** 触发所有还活着的表（在 act 里调）。 */
function runIntervals(): void {
  for (const fn of [...intervals.values()]) fn()
}

/** 一个真实消费者：把 hook 的答案渲染到 DOM 上。 */
function Consumer({ label }: { label: string }): ReactElement {
  const open = useRightPanelOpen()
  return createElement('span', { 'data-consumer': label, 'data-open': String(open) }, label)
}

function openOf(container: HTMLElement, label: string): string | null {
  return container.querySelector(`[data-consumer="${label}"]`)?.getAttribute('data-open') ?? null
}

/**
 * 宿主角落控件的矩形（非零 → 可见）。
 * 宿主控件自带 rect 覆写（jsdom 没有布局），因此原型上的 `getBoundingClientRect`
 * spy 看不到它——「读布局」的计数在这里一起记。
 */
function hostRect(): DOMRect {
  layoutReads += 1
  return {
    x: 2000, y: 10, left: 2000, top: 10, width: 28, height: 28, right: 2028, bottom: 38,
    toJSON: () => ({}),
  } as DOMRect
}

/** 宿主的角落控件：展开态是**可见**的 `[data-sidebar-right-toggle]`。 */
function appendExpandedToggle(): void {
  const toggle = document.createElement('button')
  toggle.setAttribute('data-sidebar-right-toggle', 'true')
  toggle.getBoundingClientRect = hostRect
  document.body.append(toggle)
  cleanups.push(() => { toggle.remove() })
}

/** 隐藏/恢复页面：实现读 `document.visibilityState`。 */
function setPageHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
}

describe('useRightPanelOpen（共享 poller）', () => {
  beforeEach(() => {
    intervals.clear()
    layoutReads = 0
    documentQueries = 0
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => {
      const id = ++intervalSeq
      intervals.set(id, fn)
      return id
    }) as never)
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: number) => {
      intervals.delete(id)
    }) as never)
    // 「扫文档」= querySelectorAll，「读布局」= getBoundingClientRect。两条都只统计
    // poller 的读取（本用例里没有别的 DOM 读取方）。
    const originalQuery = document.querySelectorAll.bind(document)
    vi.spyOn(document, 'querySelectorAll').mockImplementation(((selector: string) => {
      documentQueries += 1
      return originalQuery(selector)
    }) as never)
    const originalRect = Element.prototype.getBoundingClientRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ): DOMRect {
      layoutReads += 1
      return originalRect.call(this)
    })
  })

  afterEach(() => {
    for (const unmount of mounted.splice(0).reverse()) unmount()
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    // 引用计数归零后表必须已经清掉：订阅者/表泄漏到下一条用例是真实 bug。
    expect(intervals.size, '卸载后不得留下任何周期表').toBe(0)
    Reflect.deleteProperty(document, 'hidden')
    Reflect.deleteProperty(document, 'visibilityState')
    vi.restoreAllMocks()
  })

  it('creates exactly one interval for two mounted consumers', () => {
    appendExpandedToggle()
    const view = mount(createElement('div', null,
      createElement(Consumer, { label: 'header' }),
      createElement(Consumer, { label: 'dock' }),
    ))
    expect(intervals.size, '两个消费者共享一条表').toBe(1)
    // 起表时立刻读一次：两个消费者在首帧就拿到真答案（不是等 500ms 后才对）。
    expect(openOf(view.container, 'header')).toBe('true')
    expect(openOf(view.container, 'dock')).toBe('true')
    const queriesBefore = documentQueries
    act(() => { runIntervals() })
    // 一个 tick = 一趟「收起态」查询 + 一趟「展开态」查询（收起态先问，命中即短路）；
    // 两个消费者不会各扫一遍。
    expect(documentQueries - queriesBefore, '一个 tick 只扫一趟文档').toBe(2)
  })

  it('holds no interval and reads nothing while hidden, then reads once on show', () => {
    // 先让共享缓存在可见状态下定成「收起」：宿主此刻没有展开态控件。
    const priming = mount(createElement(Consumer, { label: 'prime' }))
    expect(openOf(priming.container, 'prime')).toBe('false')
    priming.unmount()
    appendExpandedToggle()

    setPageHidden(true)
    layoutReads = 0
    documentQueries = 0
    const view = mount(createElement(Consumer, { label: 'dock' }))
    expect(intervals.size, '隐藏的页面没有要服务的版面：表根本不该建').toBe(0)
    expect(documentQueries, '隐藏时不扫文档（连首帧都不扫，读缓存）').toBe(0)
    expect(layoutReads, '隐藏时不读布局').toBe(0)
    expect(openOf(view.container, 'dock'), '隐藏期间保持上一次的答案').toBe('false')

    act(() => { runIntervals() })
    expect(documentQueries + layoutReads, '没有表，自然一次都不读').toBe(0)

    // 回到可见：立刻读一次（隐藏期间面板可能已经开合），并把表接回去。
    act(() => {
      setPageHidden(false)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(openOf(view.container, 'dock'), '补读必须落地').toBe('true')
    expect(documentQueries, '一次补读 = 一趟收起态 + 一趟展开态查询').toBe(2)
    expect(layoutReads, '只量展开态那一个元素').toBe(1)
    expect(intervals.size, '补读之后表回到账本上').toBe(1)
  })

  it('stops polling the moment the page goes hidden again', () => {
    appendExpandedToggle()
    mount(createElement(Consumer, { label: 'dock' }))
    expect(intervals.size).toBe(1)
    act(() => {
      setPageHidden(true)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(intervals.size, '隐藏即停表（不是 tick 里早退）').toBe(0)
    const reads = documentQueries + layoutReads
    act(() => { runIntervals() })
    expect(documentQueries + layoutReads, '停表之后一次都不读').toBe(reads)
  })

  it('clears the shared interval only after the last consumer unmounts', () => {
    appendExpandedToggle()
    const header = mount(createElement(Consumer, { label: 'header' }))
    const dock = mount(createElement(Consumer, { label: 'dock' }))
    expect(intervals.size, '两条挂载路径共用同一条表').toBe(1)
    header.unmount()
    expect(intervals.size, '还剩一个消费者，表必须留着').toBe(1)
    dock.unmount()
    expect(intervals.size, '引用计数归零 → 表清掉').toBe(0)
  })

  it('fails safe (false) when the host renames its attributes', () => {
    // 宿主改名的形态：两个属性一个都不认 → 必须读成「未展开」（不隐藏按钮）。
    const renamed = document.createElement('button')
    renamed.setAttribute('data-right-sidebar-collapse', 'true')
    renamed.getBoundingClientRect = hostRect
    document.body.append(renamed)
    cleanups.push(() => { renamed.remove() })
    const view = mount(createElement(Consumer, { label: 'dock' }))
    expect(openOf(view.container, 'dock'), '认不出来就读 false').toBe('false')
    act(() => { runIntervals() })
    expect(openOf(view.container, 'dock'), 'tick 之后仍是 false').toBe('false')
  })
})
