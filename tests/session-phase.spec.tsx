/**
 * 会话相位的 1s 轮询（v0.25 稳态开销治理）。
 *
 * 这条轮询每 tick 发一次 HTTP 请求，然后把**新解析出来的 JSON 对象**塞进 state ——
 * 一个开着不管的 blank 会话于是每秒重渲染一次；而且它不看页面可见性。这里钉住：
 * 1. 隐藏的页面不发请求，回到可见立刻补一次；
 * 2. 答案没变就不写 state（渲染次数不涨），但轮询本身仍在跑；
 * 3. 相位翻成非 blank 停表之后，「回到可见」不得把它唤醒。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { act } from 'react-dom/test-utils'
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { useSessionPhase } from '../src/client/session-phase.ts'
import { sessionPhase } from '../src/client/api.ts'

setupReactAct()

vi.mock('../src/client/api.ts', () => ({
  sessionPhase: vi.fn(async () => ({ blank: true })),
}))

/** 渲染次数：state 没变时 React 不该重跑组件体。 */
let renders = 0

function Probe({ sessionId }: { sessionId: string | undefined }): ReactElement {
  const phase = useSessionPhase(sessionId)
  renders += 1
  return createElement('span', {
    'data-phase': phase === undefined ? 'pending' : String(phase.blank),
  })
}

/** 让已发出的 promise 落地（假表下 1s 周期不会自己走）。 */
async function settle(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function phaseText(container: HTMLElement): string | null {
  return container.querySelector('[data-phase]')?.getAttribute('data-phase') ?? null
}

/** 隐藏/恢复页面：实现读 `document.hidden`。 */
function setPageHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  })
}

describe('useSessionPhase', () => {
  let unmount: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    renders = 0
    vi.mocked(sessionPhase).mockReset()
    vi.mocked(sessionPhase).mockImplementation(async () => ({ blank: true }))
  })

  afterEach(() => {
    act(() => { unmount?.() })
    unmount = undefined
    Reflect.deleteProperty(document, 'hidden')
    Reflect.deleteProperty(document, 'visibilityState')
    vi.useRealTimers()
  })

  it('does not write state when the phase answer is unchanged', async () => {
    const view = renderRoot(createElement(Probe, { sessionId: 's1' }))
    unmount = view.unmount
    await settle()
    expect(phaseText(view.container)).toBe('true')
    expect(vi.mocked(sessionPhase)).toHaveBeenCalledTimes(1)
    const rendersAfterFirstRead = renders

    // 一个 tick 一次 act：React 不会把 5 次 tick 的更新并成一批，因此「每秒重渲染一次」
    // 在旧实现下会实打实地涨 5 次。
    for (let tick = 0; tick < 5; tick++) await advance(1_000)
    expect(vi.mocked(sessionPhase), '轮询本身仍在跑').toHaveBeenCalledTimes(6)
    expect(renders, 'blank 没翻转 → 一次都不该重渲染').toBe(rendersAfterFirstRead)
    expect(phaseText(view.container)).toBe('true')
  })

  it('skips the fetch while the page is hidden and resumes on visibilitychange', async () => {
    setPageHidden(true)
    const view = renderRoot(createElement(Probe, { sessionId: 's1' }))
    unmount = view.unmount
    await settle()
    await advance(5_000)
    expect(vi.mocked(sessionPhase), '隐藏期间一次请求都不发').not.toHaveBeenCalled()
    expect(phaseText(view.container), '没读到就停在 pending').toBe('pending')

    act(() => {
      setPageHidden(false)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await settle()
    expect(vi.mocked(sessionPhase), '回到可见立刻补一次').toHaveBeenCalledTimes(1)
    expect(phaseText(view.container)).toBe('true')
  })

  it('does not wake a poller that already stopped on a non-blank phase', async () => {
    vi.mocked(sessionPhase).mockImplementation(async () => ({ blank: false }))
    const view = renderRoot(createElement(Probe, { sessionId: 's1' }))
    unmount = view.unmount
    await settle()
    expect(phaseText(view.container)).toBe('false')
    expect(vi.mocked(sessionPhase), '非 blank 即停表').toHaveBeenCalledTimes(1)
    const rendersAfterFirstRead = renders

    act(() => {
      setPageHidden(true)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    act(() => {
      setPageHidden(false)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await advance(3_000)
    expect(vi.mocked(sessionPhase), '停表之后不得被可见性事件唤醒').toHaveBeenCalledTimes(1)
    expect(renders).toBe(rendersAfterFirstRead)
  })

  it('degrades to non-blank when the route is unavailable', async () => {
    vi.mocked(sessionPhase).mockRejectedValue(new Error('unsupported'))
    const view = renderRoot(createElement(Probe, { sessionId: 's1' }))
    unmount = view.unmount
    await settle()
    expect(phaseText(view.container), '降级为非 blank').toBe('false')
    await advance(3_000)
    expect(vi.mocked(sessionPhase), '降级即停表').toHaveBeenCalledTimes(1)
  })
})
