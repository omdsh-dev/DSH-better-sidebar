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
 */
import { useEffect, useState } from 'react'

/** 复核间隔：与备用入口的位置对齐同一节拍（500ms）。 */
const POLL_MS = 500

/**
 * 读取一次宿主右侧面板的展开态。
 *
 * **判据必须是「可见」，不能只是「在不在 DOM 里」**：实测宿主把两个角落控件都
 * 放在文档里（落屏时 `[data-sidebar-right-expand]` 与 `[data-sidebar-right-toggle]`
 * 各 1 个、面板明明已经展开），只有**可见性**才区分得开——展开时可见的是
 * Collapse（`data-sidebar-right-toggle`），收起时可见的是 Open（`data-sidebar-right-expand`）。
 * 早先按「属性在不在」判定会一直读成「没展开」，按钮于是照旧出现在宿主编簇旁边。
 * @returns 展开时为 true；`document` 缺席（SSR/极端环境）时为 false。
 */
function readRightPanelOpen(): boolean {
  if (typeof document === 'undefined') return false
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none'
  }
  return [...document.querySelectorAll('[data-sidebar-right-toggle]')].some(visible)
    && ![...document.querySelectorAll('[data-sidebar-right-expand]')].some(visible)
}

/**
 * 跟踪宿主右侧面板的展开态。
 * @returns 展开时为 true（首帧同步读取，之后每 500ms 复核一次）。
 */
export function useRightPanelOpen(): boolean {
  const [open, setOpen] = useState(readRightPanelOpen)
  useEffect(() => {
    const timer = setInterval(() => { setOpen(readRightPanelOpen()) }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [])
  return open
}
