/**
 * 宿主右侧面板当前是否**展开**。
 *
 * 插件不拥有右侧栏（那是宿主 `ui-sidebar-right` 的地盘，插件只往里投 tab 类型与
 * tab 体），所以没有服务端的开关可读；宿主把状态打在自己的角落控件上：
 *
 * - **收起**时该座位是 `[data-sidebar-right-expand]`（aria-label「Open right sidebar」）；
 * - **展开**时那个属性整个消失，同一座位换成 `[data-sidebar-right-toggle]`
 *   （aria-label「Collapse right sidebar」），旁边还并排着 Split / Fullscreen。
 *
 * 两个条件都要求，是为了让**失败方向安全**：宿主哪天改了命名，这里读成 `false`
 * （= 不隐藏），按钮照旧出现、位置由 {@link ./dock-fallback.tsx} 的让位逻辑兜住；
 * 而不是读成「永远展开」把按钮永久藏掉。
 *
 * **全模块只有一份答案、一条表**（v0.25 的稳态开销治理）：订阅者只是引用计数——
 * 0 → 1 才建观察者与兜底表并立刻读一次，1 → 0 全拆掉；消费者再多也只有一份。
 *
 * **以事件为主、采样为辅**（本次修复）：宿主切换那两个属性、整块换控件、动画收尾
 * 都会立刻触发重读（见 {@link startObserving}），所以答案落在变化的那一帧，而不是
 * 落在下一次采样的拍点上——此前 500ms 轮询让底部面板按钮在展开动画结束后才消失、
 * 收起时又先闪回来一拍。兜底表降到 {@link POLL_MS}（1.5s），只服务「观察者拿不到
 * 信号」（宿主改名/搬家）这一种情形。
 *
 * **页面不可见时表本身不存在**（不是「tick 进来再早退」）：隐藏的页面没有要服务的
 * 版面，`visibilitychange` 回到可见时才立刻读一次并重新起表。
 */
import { useEffect, useState } from 'react'

/**
 * 兜底复核间隔。事件驱动为主（见 {@link observe}），这条表只在观察者拿不到
 * 变化时兜底：宿主换了属性名、把控件搬到另一个容器、或移除后又挂回来。
 */
const POLL_MS = 1_500

/** 共享的展开态答案；所有消费者读同一份。 */
let open = false

/** 当前订阅者；0 → 1 起表（并立刻读一次），1 → 0 停表。 */
const listeners = new Set<(next: boolean) => void>()

/** 全模块**唯一**的定时器：消费者再多也只有这一条。 */
let timer: ReturnType<typeof setInterval> | undefined

/** 宿主角落控件的观察者（0 → 1 个订阅者时建、1 → 0 时拆）。 */
let observer: MutationObserver | undefined

/** 真实浏览器里的 document；SSR / 极端环境缺席。 */
function pageDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document
}

/** 页面是否可见（document 缺席时按可见处理，与旧行为一致）。 */
function pageVisible(): boolean {
  const doc = pageDocument()
  return doc === undefined || doc.visibilityState !== 'hidden'
}

/** 读一次宿主角落控件：这个元素**可见**才算数（见 {@link readRightPanelOpen}）。 */
function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  const style = getComputedStyle(element)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

/**
 * 读取一次宿主右侧面板的展开态。
 *
 * **判据必须是「可见」，不能只是「在不在 DOM 里」**：实测宿主把两个角落控件都
 * 放在文档里（落屏时 `[data-sidebar-right-expand]` 与 `[data-sidebar-right-toggle]`
 * 各 1 个、面板明明已经展开），只有**可见性**才区分得开——展开时可见的是
 * Collapse（`data-sidebar-right-toggle`），收起时可见的是 Open（`data-sidebar-right-expand`）。
 * 早先按「属性在不在」判定会一直读成「没展开」，按钮于是照旧出现在宿主编簇旁边。
 *
 * **先问「收起态」再问「展开态」**：收起时可见的是 Open 控件（`expand`），一旦量到它
 * 就能立刻返回 `false` —— 展开态那批 toggle 一次都不用碰，而它们在 DOM 里始终存在，
 * 量它们纯属白做。只有当 expand 全都不可见时才轮到 toggle（`true` = 至少一个可见）。
 * 两趟各是一趟循环，不建临时数组，也不对没参与判定的元素读布局。
 * @returns 展开时为 true；`document` 缺席（SSR/极端环境）时为 false。
 */
function readRightPanelOpen(): boolean {
  const doc = pageDocument()
  if (doc === undefined) return false
  for (const element of doc.querySelectorAll('[data-sidebar-right-expand]')) {
    if (isVisible(element)) return false
  }
  for (const element of doc.querySelectorAll('[data-sidebar-right-toggle]')) {
    if (isVisible(element)) return true
  }
  return false
}

/** 读一次并广播——答案没变时连 `open` 都不动（订阅者的 setState 会自然 bail out）。 */
function publish(): void {
  const next = readRightPanelOpen()
  if (next === open) return
  open = next
  for (const listener of listeners) listener(next)
}

/** 宿主角落控件：同一座位在收起/展开两态之间换的是这两个属性之一。 */
const CORNER_ATTRS = ['data-sidebar-right-expand', 'data-sidebar-right-toggle', 'style', 'class', 'hidden']

/** 动画结束的监听器（挂在 document 的 capture 段，动画属于宿主的元素）。 */
const settleListeners = new Set<() => void>()

function reRead(): void {
  if (!pageVisible()) return
  publish()
}

/**
 * 事件驱动的复核（本模块此前只有 500ms 采样）。
 *
 * 采样只能「碰巧」读到翻转：展开动画进行中读到的一直是旧值，于是底部面板按钮
 * 要等动画结束后的下一拍才消失；收起时又可能在动画中途读成「已收起」，按钮
 * 提前闪回来一拍再消失。观察宿主真正改动的那几个属性，答案就在变化的当帧落地：
 *
 * - `attributes` + `attributeFilter`：宿主切换 `data-sidebar-right-expand` /
 *   `data-sidebar-right-toggle` 时就通知，`style`/`class`/`hidden` 覆盖用 CSS
 *   隐藏的那一路；
 * - `childList` + `subtree`：宿主整块换掉角落控件时通知；
 * - 捕获阶段的 `transitionend` / `animationend`：动画收尾再读一次，覆盖「属性
 *   早就翻转、可见性到动画结束才变」的情形。
 *
 * 兜底仍是 {@link POLL_MS} 那条表——观察者拿不到信号时（改名、搬家）靠它。
 */
function startObserving(): void {
  if (observer !== undefined) return
  const doc = pageDocument()
  if (doc === undefined || typeof MutationObserver === 'undefined') return
  observer = new MutationObserver(reRead)
  observer.observe(doc.body ?? doc.documentElement, {
    attributes: true,
    attributeFilter: CORNER_ATTRS,
    childList: true,
    subtree: true,
  })
  doc.addEventListener('transitionend', reRead, true)
  doc.addEventListener('animationend', reRead, true)
  settleListeners.add(reRead)
}

function stopObserving(): void {
  observer?.disconnect()
  observer = undefined
  const doc = pageDocument()
  if (doc === undefined || settleListeners.size === 0) return
  for (const listener of settleListeners) {
    doc.removeEventListener('transitionend', listener, true)
    doc.removeEventListener('animationend', listener, true)
  }
  settleListeners.clear()
}

function stopTimer(): void {
  stopObserving()
  if (timer === undefined) return
  clearInterval(timer)
  timer = undefined
}

/** 起表；页面不可见时**不建表**（不是建了再早退）。 */
function startTimer(): void {
  if (timer !== undefined) return
  if (!pageVisible()) return
  startObserving()
  timer = setInterval(publish, POLL_MS)
}

function onVisibilityChange(): void {
  if (!pageVisible()) {
    // 隐藏即停表：没有要服务的版面，让这条表彻底消失。
    stopTimer()
    return
  }
  if (listeners.size === 0) return
  // 回到可见：先补一次（隐藏期间面板可能已经开合），再把表接回去。
  publish()
  startTimer()
}

function subscribe(listener: (next: boolean) => void): () => void {
  const first = listeners.size === 0
  listeners.add(listener)
  if (first) {
    pageDocument()?.addEventListener('visibilitychange', onVisibilityChange)
    // 第一个消费者挂上时立刻读一次；隐藏的页面跳过（`open` 保持上一次的答案，
    // 回到可见时 onVisibilityChange 会补上）。
    if (pageVisible()) publish()
    startTimer()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    stopTimer()
    pageDocument()?.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

/**
 * 首帧同步读取（与旧实现同为渲染期读一次）：可见时读一次并更新共享缓存，但不广播——
 * 渲染期不能触发别人的更新，其他消费者各自的 state 会在下一次 tick 或订阅时对齐。
 * 页面不可见时直接用缓存，一次版都不量。
 */
function primeOpen(): boolean {
  if (!pageVisible()) return open
  open = readRightPanelOpen()
  return open
}

/**
 * 跟踪宿主右侧面板的展开态。
 * @returns 展开时为 true（首帧同步读取，之后由模块级共享 poller 每 500ms 复核；
 *  订阅者归零即停表，页面隐藏期间不起表）。
 */
export function useRightPanelOpen(): boolean {
  const [isOpen, setIsOpen] = useState(primeOpen)
  useEffect(() => subscribe(setIsOpen), [])
  return isOpen
}
