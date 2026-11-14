/**
 * 会话相位的客户端读取（issue #698 / #623）。
 *
 * blank 会话里宿主不渲染会话头，插件的会话头入口随之不可达；客户端据此在输入区渲染
 * 备用入口，并在会话脱离 blank（发出第一条消息）后退场、把入口还给会话头。
 *
 * 判定来自插件 host 半区的只读路由（与会话对象同源），**不做任何 DOM 探测**。
 * 轮询策略：仅在 blank 期间重取——首次 1s，相位没变则退避（×1.5，上限 5s）；翻转为非 blank
 * （发出第一条消息）即停止；路由/宿主不支持时按非 blank 降级（入口留在会话头，行为与今天一致）。
 *
 * 两条稳态约束（v0.25 的稳态开销治理）：
 * - **页面不可见时不发请求**（隐藏的标签页没有要服务的相位），回到可见时由
 *   `visibilitychange` 立刻补一次；
 * - **值没变就不写 state**：相位对象每次都是新的 JSON，无条件 `setPhase(next)` 会让
 *   一个开着不管的 blank 会话每秒重渲染一次。只有 `blank` 真的翻转才提交。
 */
import { useEffect, useRef, useState } from 'react'
import { sessionPhase, type SessionPhase } from './api.ts'

/** 首次与「刚回到前台」的轮询间隔：用户刚发出第一条消息时入口要尽快退场。 */
const POLL_MS = 1_000
/** 相位没变时的退避上限：开着不管的 blank 会话每 5s 才探一次（原先恒为 1s）。 */
const MAX_POLL_MS = 5_000
/** 每次「没变」把间隔乘以这个系数，直到 {@link MAX_POLL_MS}。 */
const BACKOFF = 1.5

/**
 * 跟踪一个会话的 blank 相位。
 *
 * 自调度（setTimeout）而不是 setInterval：上一次请求落地后才排下一次；页面隐藏时**不挂任何定时器**，
 * 回到可见（或窗口重新获得焦点）立刻补一次并把间隔重置回 {@link POLL_MS}。
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
    let done = false
    let inFlight = false
    let delay = POLL_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const clear = (): void => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    }
    const finish = (): void => {
      done = true
      clear()
    }
    /** 只有 `blank` 真的翻转才提交（见 pushedRef 的注释）。 */
    const push = (next: SessionPhase): void => {
      const previous = pushedRef.current
      if (previous !== undefined && previous.blank === next.blank) return
      pushedRef.current = next
      setPhase(next)
    }
    const arm = (): void => {
      clear()
      // 隐藏的页面不挂定时器；done 之后（非 blank / 已降级）不再排。
      if (!alive || done || document.hidden) return
      timer = setTimeout(tick, delay)
    }
    const tick = (): void => {
      clear()
      if (!alive || done || inFlight || document.hidden) return
      inFlight = true
      sessionPhase(sessionId).then((next) => {
        inFlight = false
        if (!alive) return
        const unchanged = pushedRef.current !== undefined && pushedRef.current.blank === next.blank
        push(next)
        if (!next.blank) { finish(); return }
        delay = unchanged ? Math.min(MAX_POLL_MS, Math.round(delay * BACKOFF)) : POLL_MS
        arm()
      }).catch(() => {
        // 路由/宿主不支持：按非 blank 降级（不渲染备用入口，入口留在会话头）。
        inFlight = false
        if (!alive) return
        push({ blank: false })
        finish()
      })
    }
    // 回到可见/重新聚焦：立刻补一次并回到快节奏；已经停表就不再唤醒。
    const wake = (): void => {
      if (document.hidden) { clear(); return }
      if (done) return
      delay = POLL_MS
      tick()
    }
    tick()
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => {
      alive = false
      clear()
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
    }
  }, [sessionId])
  return phase
}
