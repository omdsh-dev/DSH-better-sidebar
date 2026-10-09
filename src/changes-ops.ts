import type { Context, SidebarSessionEvent } from './context-types.ts'
import { readPersistedSession } from './session-store.ts'
import { requireString, SidebarError } from './wire.ts'

const EVENTS_CAP = 4000
const WAIT_MS = 25_000

/** 返回会话文件工具事件，并让后续请求等待新的工具事件。 */
export function createChangesOpsApi(ctx: Context): (payload: unknown, signal?: AbortSignal) => Promise<{ events: SidebarSessionEvent[]; lastSeq: number }> {
  return async (payload, signal) => {
    const sessionId = requireString(payload, 'sessionId')
    const record = payload as { afterSeq?: unknown; wait?: unknown }
    const rawAfter = record.afterSeq
    if (rawAfter !== undefined && (typeof rawAfter !== 'number' || !Number.isSafeInteger(rawAfter) || rawAfter < -1)) {
      throw new SidebarError('bad-request', 'afterSeq must be an integer of at least -1')
    }
    if (record.wait !== undefined && typeof record.wait !== 'boolean') {
      throw new SidebarError('bad-request', 'wait must be a boolean')
    }
    const afterSeq = rawAfter ?? -1

    /** 读取运行中或已保存的会话日志，只保留游标之后的工具事件。 */
    const readWindow = async (): Promise<{ events: SidebarSessionEvent[]; lastSeq: number }> => {
      let events: readonly SidebarSessionEvent[] | undefined = ctx.sessions.get(sessionId)?.snapshotEvents()
      if (events === undefined) {
        const persistence = ctx.get('sessionPersistence')
        if (persistence !== undefined) {
          try {
            events = (await readPersistedSession(persistence, sessionId)).events
          } catch {
            // 尚未保存会话日志时，事件窗口为空。
          }
        }
      }
      const filtered = (events ?? []).filter(event => (event.type === 'tool/call' || event.type === 'tool/result') && event.seq > afterSeq)
      const window = filtered.length > EVENTS_CAP ? filtered.slice(-EVENTS_CAP) : filtered
      return { events: window, lastSeq: window.at(-1)?.seq ?? afterSeq }
    }

    if (record.wait !== true) return readWindow()

    const pending: SidebarSessionEvent[] = []
    let wake: (() => void) | undefined
    const notified = new Promise<void>(resolve => { wake = resolve })
    // 读取前订阅，确保读取期间追加的事件仍会唤醒请求。
    const dispose = ctx.on('session/event', (session, event) => {
      if ((session as { id?: unknown } | null)?.id !== sessionId || (event.type !== 'tool/call' && event.type !== 'tool/result') || event.seq <= afterSeq) return
      pending.push(event)
      if (pending.length > EVENTS_CAP) pending.shift()
      wake?.()
    })
    const timer = setTimeout(() => wake?.(), WAIT_MS)
    const abort = (): void => { wake?.() }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const initial = await readWindow()
      if (initial.events.length > 0 || signal?.aborted === true) return initial
      await notified
      const current = await readWindow()
      if (pending.length === 0) return current
      // 事件通知可能早于快照更新；合并通知中的事件，及时返回工具结果。
      const merged = new Map(current.events.map(event => [event.seq, event]))
      for (const event of pending) merged.set(event.seq, event)
      const events = [...merged.values()].sort((left, right) => left.seq - right.seq).slice(-EVENTS_CAP)
      return { events, lastSeq: events.at(-1)?.seq ?? afterSeq }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      dispose()
    }
  }
}
