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
 * **全模块只有一份答案、一条表**（v0.25 的稳态开销治理）：早先每个消费者各建一条
 * 500ms 的表、各做两趟全文档 `querySelectorAll`（本文件 + `dock-fallback.tsx` 共两条），
 * 与挂载了多少个消费者成正比。现在订阅者只是引用计数——0 → 1 才起表并立刻读一次，
 * 1 → 0 就停表；消费者再多也只有一条表。
 *
 * **页面不可见时表本身不存在**（不是「tick 进来再早退」）：隐藏的页面没有要服务的
 * 版面，`visibilitychange` 回到可见时才立刻读一次并重新起表。
 */
import { useEffect, useState } from 'react'

/** 复核间隔：与备用入口的位置对齐同一节拍（500ms）。 */
const POLL_MS = 500

/** 共享的展开态答案；所有消费者读同一份。 */
let open = false

/** 当前订阅者；0 → 1 起表（并立刻读一次），1 → 0 停表。 */
const listeners = new Set<(next: boolean) => void>()

/** 全模块**唯一**的定时器：消费者再多也只有这一条。 */
let timer: ReturnType<typeof setInterval> | undefined

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

function stopTimer(): void {
  if (timer === undefined) return
  clearInterval(timer)
  timer = undefined
}

/** 起表；页面不可见时**不建表**（不是建了再早退）。 */
function startTimer(): void {
  if (timer !== undefined) return
  if (!pageVisible()) return
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
