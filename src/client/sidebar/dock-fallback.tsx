/**
 * 空白会话专用的底部工作台开关（issue #698 / #623）。
 *
 * blank 会话里宿主不渲染会话头，本插件挂在 `header.utilities` 的入口随之不可达；
 * 这里把同一个开关以 `position: fixed` 放到宿主「Open right sidebar」按钮的**左侧紧邻**
 * （按该按钮的 rect 对齐，随窗口 resize 与 500ms 周期重对齐）。只在 blank 相位渲染，
 * 因此与会话头里的入口天然互斥——同一面板任何时刻只有一套入口。
 */
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SidebarStore } from '../state.ts'
import { BottomDockToggle } from '../Sidebar.tsx'
import { useSessionPhase } from '../session-phase.ts'
import css from '../sidebar.module.css'

/** 按钮尺寸与宿主展开按钮一致（28px），间距 8px。 */
const BUTTON_SIZE = 28
const GAP = 8

/** 量宿主展开按钮的位置，返回本按钮应放的 top/left。 */
function measure(): { top: number; left: number } {
  const expand = document.querySelector('[data-sidebar-right-expand]')
  if (expand === null) return { top: 8, left: window.innerWidth - BUTTON_SIZE - GAP - 8 }
  const rect = expand.getBoundingClientRect()
  return {
    top: Math.max(4, rect.top + (rect.height - BUTTON_SIZE) / 2),
    left: Math.max(4, rect.left - GAP - BUTTON_SIZE),
  }
}

export function DockFallback({ store }: { store: SidebarStore }): ReactNode {
  const snapshot = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  const phase = useSessionPhase(snapshot.sessionId)
  const [pos, setPos] = useState(measure)
  useEffect(() => {
    const onResize = (): void => setPos(measure())
    window.addEventListener('resize', onResize)
    const timer = setInterval(onResize, 500)
    return () => {
      window.removeEventListener('resize', onResize)
      clearInterval(timer)
    }
  }, [])
  // 相位判定在组件内部完成：非 blank（或尚未读到）时整个不渲染 ——
  // 会话头里的入口此时是唯一一套。
  if (phase === undefined || !phase.blank) return null
  // portal 到 body：面板宿主（z 20-30）的层叠上下文压不过会话头，按钮会被 titleRow
  // 拦截点击。40 高于 AppFrame(20) 与会话头、低于 DSH 浮层(100+)。
  return createPortal(
    <span
      className={css.dockFallback}
      data-dsh-dock-fallback
      style={{ top: pos.top, left: pos.left }}
    >
      <BottomDockToggle store={store} />
    </span>,
    document.body,
  )
}
