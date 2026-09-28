/**
 * 底部终端「窗口保留」协调的单测：并集计算、登记写入时机（必须晚于宿主自己
 * 那一轮同步写入，否则底部终端会被宿主判为未保留而回收）、以及 dispose 行为。
 */
import { describe, expect, it } from 'vitest'
import { createTerminalRetention, mergeRetainedTerminals } from '../src/client/terminal/retention.ts'
import type { RetainedTerminalTab } from '../src/client/terminal/types.ts'

const hostTab = (sessionId: string, tabId: string): RetainedTerminalTab =>
  ({ sessionId, tabId, contentId: `host:${tabId}`, kind: 'terminal' })
const ownTab = (sessionId: string, tabId: string): RetainedTerminalTab =>
  ({ sessionId, tabId, contentId: `own:${tabId}`, kind: 'terminal' })

describe('mergeRetainedTerminals', () => {
  it('unions the host right-Sidebar terminals and this plugin bottom terminals', () => {
    const merged = mergeRetainedTerminals(
      [hostTab('s1', 'right-1'), hostTab('s2', 'right-2')],
      [ownTab('s1', 'bottom-1')],
    )
    expect(merged.map(t => `${t.sessionId}/${t.tabId}`).sort()).toEqual(
      ['s1/bottom-1', 's1/right-1', 's2/right-2'],
    )
  })

  it('keeps one entry per (sessionId, tabId), this plugin winning a duplicate key', () => {
    const merged = mergeRetainedTerminals([hostTab('s1', 'same')], [ownTab('s1', 'same')])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.contentId).toBe('own:same')
  })

  it('handles either side being empty', () => {
    expect(mergeRetainedTerminals([], [])).toEqual([])
    expect(mergeRetainedTerminals([hostTab('s1', 'a')], [])).toHaveLength(1)
    expect(mergeRetainedTerminals([], [ownTab('s1', 'b')])).toHaveLength(1)
  })
})

describe('createTerminalRetention', () => {
  /** 手动调度的协调器 + 记录每次登记写入。 */
  function harness(): {
    writes: string[][]
    trigger(): void
    dispose(): void
    flush(): void
    setHost(tabs: RetainedTerminalTab[]): void
    setOwn(tabs: RetainedTerminalTab[]): void
    /** 模拟宿主插件在同一轮里的同步写入（只有它自己的终端）。 */
    hostWrite(): void
  } {
    let host: RetainedTerminalTab[] = []
    let own: RetainedTerminalTab[] = []
    const writes: string[][] = []
    const listeners = new Set<() => void>()
    const pending: (() => void)[] = []
    const retention = createTerminalRetention({
      hostTabs: () => host,
      ownTabs: () => own,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      retain: (tabs) => { writes.push(tabs.map(t => `${t.sessionId}/${t.tabId}`).sort()) },
      // 记录而不立即执行：测试自己决定何时「跑完这一轮微任务」。
      schedule: (run) => { pending.push(run) },
    })
    return {
      writes,
      trigger: () => { for (const listener of [...listeners]) listener() },
      dispose: () => retention.dispose(),
      flush: () => { for (const run of pending.splice(0)) run() },
      setHost: (tabs) => { host = tabs },
      setOwn: (tabs) => { own = tabs },
      hostWrite: () => { writes.push(host.map(t => `${t.sessionId}/${t.tabId}`).sort()) },
    }
  }

  it('registers the union once on activation (deferred to the scheduler)', () => {
    const h = harness()
    h.setHost([hostTab('s1', 'right-1')])
    h.setOwn([ownTab('s1', 'bottom-1')])
    h.trigger()
    expect(h.writes).toEqual([]) // 尚未跑调度器：一次同步调用都不该发生
    h.flush()
    expect(h.writes).toEqual([['s1/bottom-1', 's1/right-1']])
  })

  it('a single change coalesces into one write carrying both sides', () => {
    const h = harness()
    h.flush() // 初始化那一次
    h.setOwn([ownTab('s1', 'bottom-1')])
    h.trigger()
    h.trigger() // 同一轮里的第二次变化不再排队
    h.flush()
    expect(h.writes.at(-1)).toEqual(['s1/bottom-1'])
    h.setHost([hostTab('s1', 'right-1')])
    h.trigger()
    h.flush()
    expect(h.writes.at(-1)).toEqual(['s1/bottom-1', 's1/right-1'])
  })

  it("the union lands after the host plugin's own synchronous write", () => {
    const h = harness()
    h.setHost([hostTab('s1', 'right-1')])
    h.setOwn([ownTab('s1', 'bottom-1')])
    // 同一轮变更：宿主插件在订阅回调里同步写「只有它自己的终端」，本插件的重放
    // 被排到 microtask（调度器）里，因此总是后写——底部终端不会被误判为未保留。
    h.trigger()
    h.hostWrite()
    h.flush()
    expect(h.writes).toEqual([
      ['s1/right-1'],
      ['s1/bottom-1', 's1/right-1'],
    ])
  })

  it('stops writing after dispose (the host owns the teardown list)', () => {
    const h = harness()
    h.dispose()
    h.setOwn([ownTab('s1', 'bottom-1')])
    h.trigger()
    h.flush()
    expect(h.writes).toEqual([])
  })
})
