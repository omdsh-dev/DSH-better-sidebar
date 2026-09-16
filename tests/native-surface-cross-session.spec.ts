/**
 * Cross-session opens at the native right-sidebar surface
 * (`src/client/native/surface.ts`).
 *
 * The runtime only adopts a session's rightbar store once that session has been
 * mounted; for a session whose store was never minted, `openTabIn()` /
 * `openResourceIn()` are silent no-ops — they write nothing and report nothing
 * back. Handing an off-screen session's open to them therefore LOSES it:
 * `place()` returns true, `enqueue()` never queues the entry, and the replay
 * subscribed to the session list never sees it.
 *
 * The queueing contract this file locks down is already the documented one:
 * `docs/external-plugin-guide.md` (§0 「跨会话打开」: 目标会话的右侧栏 store
 * 未挂载时，打开会排队到该会话上屏后重放) and AGENTS.md §3.10.
 */
import { describe, expect, it, vi } from 'vitest'
import { createNativeSurface } from '../src/client/native/surface.ts'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'

describe('createNativeSurface cross-session opens', () => {
  /** Mount a surface over a recording controller + a switchable session list. */
  const mount = (initial = 's1') => {
    const list = { current: initial }
    let notify: (() => void) | undefined
    const controller = {
      openTab: vi.fn(),
      openTabIn: vi.fn(),
      openResource: vi.fn(),
      openResourceIn: vi.fn(),
      close: vi.fn(),
    }
    const ctx = {
      get: () => controller,
      sessions: {
        list: {
          getSnapshot: () => ({ current: list.current }),
          subscribe: (fn: () => void) => {
            notify = fn
            return () => { notify = undefined }
          },
        },
      },
    }
    return {
      surface: createNativeSurface(ctx as never, createNativeTabRecords()),
      controller,
      /** Switch the on-screen session, then let the surface replay its queue. */
      switchTo: (sessionId: string) => {
        list.current = sessionId
        notify?.()
      },
    }
  }

  it('queues a tab open for an off-screen session instead of handing it to openTabIn()', () => {
    const { surface, controller, switchTo } = mount('s1')

    surface.openTab({ sessionId: 's2', kind: 'ego-browser:watch', params: {}, revealIfOpened: true })

    expect(controller.openTabIn).not.toHaveBeenCalled()
    expect(controller.openTab).not.toHaveBeenCalled()

    switchTo('s2')
    expect(controller.openTab).toHaveBeenCalledTimes(1)
    expect(controller.openTab).toHaveBeenCalledWith('ego-browser:watch', { params: {}, revealIfOpened: true })
    surface.dispose()
  })

  it('replays a queued tab open exactly once', () => {
    const { surface, controller, switchTo } = mount('s1')

    surface.openTab({ sessionId: 's2', kind: 'files', params: {}, revealIfOpened: true })
    switchTo('s2')
    switchTo('s2')

    expect(controller.openTab).toHaveBeenCalledTimes(1)
    surface.dispose()
  })

  it('keeps a queued tab open across an unrelated session switch', () => {
    const { surface, controller, switchTo } = mount('s1')

    surface.openTab({ sessionId: 's2', kind: 'files', params: {}, revealIfOpened: false })
    switchTo('s3')
    expect(controller.openTab).not.toHaveBeenCalled()

    switchTo('s2')
    expect(controller.openTab).toHaveBeenCalledTimes(1)
    surface.dispose()
  })

  it('queues a resource open for an off-screen session instead of handing it to openResourceIn()', () => {
    const { surface, controller, switchTo } = mount('s1')

    surface.openResource({
      sessionId: 's2',
      address: 'dsh-resource://file/session/s2/a.ts',
      line: 3,
      revealIfOpened: true,
    })

    expect(controller.openResourceIn).not.toHaveBeenCalled()
    expect(controller.openResource).not.toHaveBeenCalled()

    switchTo('s2')
    expect(controller.openResource).toHaveBeenCalledTimes(1)
    expect(controller.openResource).toHaveBeenCalledWith('dsh-resource://file/session/s2/a.ts', {
      params: { line: 3 },
      revealIfOpened: true,
    })
    surface.dispose()
  })

  it('still writes the on-screen session opens immediately', () => {
    const { surface, controller } = mount('s1')

    surface.openTab({ sessionId: 's1', kind: 'browser', params: { url: 'https://example.com' }, revealIfOpened: true })
    surface.openResource({ sessionId: 's1', address: 'dsh-resource://file/session/s1/a.ts', revealIfOpened: true })

    expect(controller.openTab).toHaveBeenCalledWith('browser', {
      params: { url: 'https://example.com' },
      revealIfOpened: true,
    })
    expect(controller.openResource).toHaveBeenCalledWith('dsh-resource://file/session/s1/a.ts', {
      revealIfOpened: true,
    })
    surface.dispose()
  })
})
