/**
 * 空白会话专用的底部工作台开关（issue #698 / #623）。
 *
 * blank 会话里宿主不渲染会话头，本插件挂在 `header.utilities` 的入口随之不可达；
 * 这里把同一个开关以 `position: fixed` 放到宿主「Open right sidebar」按钮的**左侧紧邻**
 * （按该按钮的 rect 对齐，随窗口 resize 与 500ms 周期重对齐）。
 *
 * **相位不足以判定互斥**：相位是每 1s 轮询来的，而会话头的入口由宿主在它认为合适的
 * 时机渲染，两者之间必然有窗口；相位读取失败时还会按「非 blank」降级，一个从未成功
 * 读到的会话可能一直停在 blank。而两套入口在版面上是**同一个位置**——真同时在场就是
 * 精确重叠成一团。所以除了相位，再加一条与相位无关的兜底：**会话头那套入口只要真的
 * 在 DOM 里，备用入口就让位**（`data-dsh-bottom-toggle` 不在 `[data-dsh-dock-fallback]`
 * 内的那个）。
 */
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SidebarStore } from '../state.ts'
import { BottomDockToggle } from '../Sidebar.tsx'
import { useSessionPhase } from '../session-phase.ts'
import { useRightPanelOpen } from './right-panel-open.ts'
import css from '../sidebar.module.css'

/** 按钮尺寸与宿主展开按钮一致（28px），间距 8px。 */
const BUTTON_SIZE = 28
const GAP = 8

/** 让位时的搜索步长（像素）：够细以免跨过窄芯片，够粗以免几百次命中测试。 */
const STEP_PX = 4

/**
 * 整个槽位是否空着——**必须采样多个点**。
 *
 * 只测中心点是不够的：槽位宽 28px，中心空着不代表左右两边不压着邻居
 * （实测中心判空、box 却压在 Split/Fullscreen 上）。这里沿水平方向采 5 个点，
 * 全部未被占才算空。
 * @param left - 槽位左边（视口坐标）。
 * @param top - 槽位上边（视口坐标）。
 * @returns 整格都空时为 true。
 */
function slotFree(left: number, top: number): boolean {
  const cy = top + BUTTON_SIZE / 2
  for (const dx of [2, 8, BUTTON_SIZE / 2, BUTTON_SIZE - 8, BUTTON_SIZE - 2]) {
    if (slotOccupied(left + dx, cy)) return false
  }
  return true
}

/** 超过这个宽度就认为它是「背景板」而不是占位控件（不透明整行容器不算占位）。 *//** 超过这个宽度就认为它是「背景板」而不是占位控件（不透明整行容器不算占位）。 */
const MAX_OCCUPANT_W = 300

/**
 * 会话头那套入口现在是否在 DOM 里（备用入口自身不算）。
 * @returns 只要存在一个不在 `[data-dsh-dock-fallback]` 里的
 *  `[data-dsh-bottom-toggle]` 就为 true。
 */
function headerEntryPresent(): boolean {
  return [...document.querySelectorAll('[data-dsh-bottom-toggle]')]
    .some(element => element.closest('[data-dsh-dock-fallback]') === null)
}

/**
 * 该槽位是否被宿主的东西占着。
 *
 * **用命中测试，不猜宿主的 DOM 形状**：早先的版本把「占位」定义成
 * `button, [role="button"]`，而右侧栏的**页签芯片**未必是这两者——于是页签一多，
 * 让位会在芯片上停下来（tab 多的时候位置就错）。`elementsFromPoint` 直接把该点下面
 * 的整摞元素交出来，芯片、图标、文字都跑不掉，与宿主用什么标签、什么类名无关。
 *
 * 判定为「占着」的条件：这一摞里存在一个**不透明**或**可交互**的元素（我们自己的
 * 外壳、`html`/`body` 除外）。只负责排版的透明容器（会话头的 titleRow、面板的
 * tabStrip 外框等）不算。
 * @param cx - 槽位中心 x（视口坐标）。
 * @param cy - 槽位中心 y（视口坐标）。
 * @returns 被占时为 true。
 */
function slotOccupied(cx: number, cy: number): boolean {
  // jsdom（单测）没有命中测试，退回按元素 rect 判定；真实浏览器一律走命中测试。
  if (typeof document.elementsFromPoint !== 'function') return slotOccupiedByRect(cx, cy)
  const stack = document.elementsFromPoint(cx, cy)
  return stack.some((element) => {
    if (element.closest('[data-dsh-dock-fallback]') !== null) return false
    if (element === document.body || element === document.documentElement) return false
    if (element.matches('button, a, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="link"]')) return true
    // 不透明**小控件**（页签芯片的底、图标胶囊等）才算占位。整行的容器——会话头
    // 的 titleRow、面板的 tabStrip、面板本体——底也是不透明的，但它们只是背景板：
    // 把整行判成占位会让入口一路退到屏幕中间（实测退到 x=530）。
    const box = element.getBoundingClientRect()
    if (box.width > MAX_OCCUPANT_W) return false
    const background = getComputedStyle(element).backgroundColor
    return background !== '' && background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)'
  })
}

/**
 * 命中测试缺席时（jsdom）的占位判定：拿同排宿主按钮的 rect 做相交测试。
 * 真实浏览器不会走这条路径（见 {@link slotOccupied}）。
 * @param cx - 槽位中心 x（视口坐标）。
 * @param cy - 槽位中心 y（视口坐标）。
 * @returns 被占时为 true。
 */
function slotOccupiedByRect(cx: number, cy: number): boolean {
  return [...document.querySelectorAll('button, [role="button"]')]
    .filter(element => !element.hasAttribute('data-dsh-bottom-toggle'))
    .map(element => element.getBoundingClientRect())
    .filter(box => box.width > 4 && box.height > 4)
    .some(box => cx > box.left - GAP / 2 && cx < box.right + GAP / 2
      && cy > box.top && cy < box.bottom)
}

/**
 * 量本按钮应放的 top/left：贴在宿主「右侧栏角落控件」的**左侧空位**上。
 *
 * 三件事都不能靠猜：
 *
 * 1. **锚点要认控件的两种形态**——右侧栏关闭时它带 `data-sidebar-right-expand`，
 *    打开时该属性整个消失、同一座位换成 `data-sidebar-right-toggle`。只认前者会落到
 *    视口兜底坐标（`innerWidth - 44`），而那里正是宿主自己的角落按钮群。
 * 2. **让位不能让一个固定偏移**——宿主的角落控件是肩并肩一簇（实测打开态：
 *    `Split@2094 / Fullscreen@2130 / Collapse@2166`，各 28px、间隔 8px）。只往左挪
 *    `GAP + BUTTON_SIZE` 正好落在**下一个**按钮上（实测精确压住 Fullscreen 28x28px）。
 * 3. **占位与否要真的去问页面**——见 {@link slotOccupied}：页签芯片会把那一排填满，
 *    按角色筛元素是筛不干净的。
 *
 * 因此这里从锚点左侧起逐像素左移，取**最近的一个真的空着**的槽位；一直退到视口
 * 左缘仍被占时停在最左（宁可贴边，也不叠在宿主控件上）。
 * @returns 视口坐标下的 top/left。
 */
function measure(): { top: number; left: number } {
  const anchor = document.querySelector('[data-sidebar-right-expand], [data-sidebar-right-toggle]')
  if (anchor === null) return { top: 8, left: window.innerWidth - BUTTON_SIZE - GAP - 8 }
  const rect = anchor.getBoundingClientRect()
  const top = Math.max(4, rect.top + (rect.height - BUTTON_SIZE) / 2)
  let left = Math.max(4, rect.left - GAP - BUTTON_SIZE)
  for (let step = 0; step < 400; step++) {
    if (slotFree(left, top)) break
    left -= STEP_PX
    if (left <= 4) { left = 4; break }
  }
  return { top, left }
}

export function DockFallback({ store }: { store: SidebarStore }): ReactNode {
  const snapshot = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  const phase = useSessionPhase(snapshot.sessionId)
  const rightOpen = useRightPanelOpen()
  const [pos, setPos] = useState(measure)
  const [headerEntry, setHeaderEntry] = useState(headerEntryPresent)
  useEffect(() => {
    const onResize = (): void => {
      // 坐标没变就不换 state 对象：500ms 的周期重测在版面静止时不该引起重渲染。
      const next = measure()
      setPos(prev => (prev.top === next.top && prev.left === next.left ? prev : next))
      setHeaderEntry(headerEntryPresent())
    }
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
  // 兜底：相位说 blank、但会话头的入口确实在 DOM 里 —— 让位，绝不叠出第二套。
  if (headerEntry) return null
  // 宿主右侧面板展开时不渲染（里面那个按钮本身也会返回 null，这里连空壳一起省掉）：
  // 那个状态下右上角是宿主自己的一簇控件，没有本入口的容身之处。
  if (rightOpen) return null
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
