/**
 * 会话相位的客户端读取（issue #698 / #623）。
 *
 * blank 会话里宿主不渲染会话头，插件的会话头入口随之不可达；客户端据此在输入区渲染
 * 备用入口，并在会话脱离 blank（发出第一条消息）后退场、把入口还给会话头。
 *
 * 判定来自插件 host 半区的只读路由（与会话对象同源），**不做任何 DOM 探测**。
 * 轮询策略：仅在 blank 期间每 1s 重取一次；翻转为非 blank（发出第一条消息）即停止；
 * 路由/宿主不支持时按非 blank 降级（入口留在会话头，行为与今天一致）。
 */
import { useEffect, useState } from 'react'
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
  useEffect(() => {
    if (sessionId === undefined) {
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
    const tick = (): void => {
      sessionPhase(sessionId).then((next) => {
        if (!alive) return
        setPhase(next)
        if (!next.blank) stop()
      }).catch(() => {
        // 路由/宿主不支持：按非 blank 降级（不渲染备用入口，入口留在会话头）。
        if (!alive) return
        setPhase({ blank: false })
        stop()
      })
    }
    void tick()
    timer = setInterval(tick, POLL_MS)
    return () => {
      alive = false
      stop()
    }
  }, [sessionId])
  return phase
}
