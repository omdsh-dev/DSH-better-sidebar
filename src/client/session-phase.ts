/**
 * 会话相位的客户端读取（issue #698 / #623）。
 *
 * blank 会话里宿主不渲染会话头，插件的会话头入口随之不可达；客户端据此在输入区渲染
 * 备用入口，并在会话脱离 blank（发出第一条消息）后退场、把入口还给会话头。
 *
 * 判定来自插件 host 半区的只读路由（与会话对象同源），**不做任何 DOM 探测**。
 * 轮询策略：仅在 blank 期间每 1s 重取一次；翻转为非 blank（发出第一条消息）即停止；
 * 路由/宿主不支持时按非 blank 降级（入口留在会话头，行为与今天一致）。
 *
 * 两条稳态约束（v0.25 的稳态开销治理）：
 * - **页面不可见时不发请求**（隐藏的标签页没有要服务的相位），回到可见时由
 *   `visibilitychange` 立刻补一次；
 * - **值没变就不写 state**：相位对象每次都是新的 JSON，无条件 `setPhase(next)` 会让
 *   一个开着不管的 blank 会话每秒重渲染一次。只有 `blank` 真的翻转才提交。
 */
import { useEffect, useRef, useState } from 'react'
import { sessionPhase, type SessionPhase } from './api.ts'

/** 轮询间隔：blank 是一次性状态（发一条消息即翻转），无需更快。 */
const POLL_MS = 1_000

/**
 * 跟踪一个会话的 blank 相位。
 * @param sessionId - 当前会话（undefined 时不读取，返回 undefined）。
 * @returns 相位；尚未读到时为 undefined（调用方应视为非 blank，先不渲染备用入口）。
 */
export function useSessionPhase(sessionId: string | undefined): SessionPhase | undefined {
  const [phase, setPhase] = useState<SessionPhase | undefined>(undefined)
  // 最近一次提交过的相位：轮询读回来的都是**新解析的 JSON 对象**，靠 state 自己没法
  // 「同值不写」（`setPhase(updater)` 返回同一个对象时 React 仍可能重跑一次组件体）。
  const pushedRef = useRef<SessionPhase | undefined>(undefined)
  useEffect(() => {
    if (sessionId === undefined) {
      pushedRef.current = undefined
      setPhase(undefined)
      return
    }
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = (): void => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    /** 只有 `blank` 真的翻转才提交（见 pushedRef 的注释）。 */
    const push = (next: SessionPhase): void => {
      const previous = pushedRef.current
      if (previous !== undefined && previous.blank === next.blank) return
      pushedRef.current = next
      setPhase(next)
    }
    const tick = (): void => {
      // 页面不可见时不发请求（相位是 blank 期间的一次性探测，隐藏的页面没有服务对象）。
      if (document.hidden) return
      sessionPhase(sessionId).then((next) => {
        if (!alive) return
        push(next)
        if (!next.blank) stop()
      }).catch(() => {
        // 路由/宿主不支持：按非 blank 降级（不渲染备用入口，入口留在会话头）。
        if (!alive) return
        push({ blank: false })
        stop()
      })
    }
    // 回到可见立刻补一次；已经停表（相位已定：非 blank / 已降级）就不再唤醒。
    const onVisibilityChange = (): void => {
      if (!document.hidden && timer !== undefined) tick()
    }
    void tick()
    timer = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      alive = false
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [sessionId])
  return phase
}
