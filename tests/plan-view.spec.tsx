/**
 * The Plan page: the revision selector, the per-revision status header, and
 * the document body — all riding the mocked `plans.events` poll. The fold
 * itself is covered by plans-ops.spec; what is pinned here is the page's own
 * behaviour: which revision is on screen, what the header says, and what a
 * newly presented revision does to a manual pick.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { PlanView } from '../src/client/plans/PlanView.tsx'
import { PLAN_CHANGED_EVENT } from '../src/plan-events.ts'
import { api } from '../src/client/api.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'
import type { Context, SidebarSessionEvent } from '../src/context-types.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

/** One exit_plan_mode tool/call (the model presenting a plan). */
function planCall(seq: number, callId: string, plan: string): SidebarSessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: 1_700_000_000_000 + seq * 1_000,
    data: { name: 'exit_plan_mode', callId, arguments: JSON.stringify({ plan }) },
  }
}

/** The review outcome for one plan (isError = the user kept planning). */
function planResult(seq: number, callId: string, isError: boolean): SidebarSessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 1_700_000_000_000 + seq * 1_000,
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', isError, content: [{ type: 'text', text: isError ? 'keep planning' : 'approved' }] }],
      },
    },
  }
}

/** Serve the log through the route's own delta contract (the host floors an
 *  absent cursor at -1, so a seq-0 log still ships). */
function mockPlans(events: readonly SidebarSessionEvent[]): void {
  vi.spyOn(api, 'plansEvents').mockImplementation(async (_scope, afterSeq) => {
    const cursor = afterSeq ?? -1
    const shipped = events.filter(event => event.seq > cursor)
    return { events: [...shipped], lastSeq: shipped.at(-1)?.seq ?? cursor }
  })
}

function fakeContext(): Context {
  return { get: () => undefined } as unknown as Context
}

function mount(): { container: HTMLElement; root: Root } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => {
    root.render(createElement(PlanView, {
      ctx: fakeContext(),
      store: createSidebarStore(),
      scope: { sessionId: 'session', cwd: '/repo' },
      tab: { id: 'plan', type: 'plan', title: 'Plan' },
      visible: true,
    }))
  })
  return { container, root }
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

/** The revision labels the selector offers, in order. */
function options(container: HTMLElement): string[] {
  return [...container.querySelectorAll('option')].map(option => option.textContent ?? '')
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('PlanView', () => {
  it('shows the empty state while the session has no plan', async () => {
    mockPlans([])
    const { container, root } = mount()
    try {
      await flush()
      expect(container.textContent).toContain(t('planEmpty'))
      expect(container.textContent).toContain(t('planEmptyDesc'))
      expect(container.querySelector('select')).toBeNull()
    } finally {
      act(() => { root.unmount() })
    }
  })

  it('renders the plan, its heading and its pending status', async () => {
    mockPlans([planCall(1, 'p1', '# 重构方案\n\n第一步。')])
    const { container, root } = mount()
    try {
      await flush()
      expect(options(container)).toEqual(['v1 · 重构方案'])
      expect(container.textContent).toContain(t('planStatusPending'))
      expect(container.textContent).toContain('重构方案')
      expect(container.textContent).toContain(t('planCopy'))
    } finally {
      act(() => { root.unmount() })
    }
  })

  it('offers every revision oldest-first and lands on the newest', async () => {
    mockPlans([
      planCall(1, 'p1', '# 第一版'),
      planResult(2, 'p1', true),
      planCall(3, 'p2', '# 第二版'),
    ])
    const { container, root } = mount()
    try {
      await flush()
      expect(options(container)).toEqual(['v1 · 第一版', 'v2 · 第二版'])
      const select = container.querySelector('select')!
      expect(select.value).toBe('p2')
      expect(container.textContent).toContain('第二版')
      expect(container.textContent).not.toContain('第一版。')
      // The settled first revision keeps its own state; the new one is pending.
      expect(container.textContent).toContain(t('planStatusPending'))
    } finally {
      act(() => { root.unmount() })
    }
  })

  it('switching the selector shows that revision and its state', async () => {
    mockPlans([
      planCall(1, 'p1', '# 第一版\n\n旧正文。'),
      planResult(2, 'p1', false),
      planCall(3, 'p2', '# 第二版\n\n新正文。'),
    ])
    const { container, root } = mount()
    try {
      await flush()
      const select = container.querySelector('select')!
      // React tracks the value node-side; go through the prototype setter so
      // the change event is not swallowed as a no-op.
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
      act(() => {
        setValue.call(select, 'p1')
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(select.value).toBe('p1')
      expect(container.textContent).toContain(t('planStatusApproved'))
      expect(container.textContent).toContain('旧正文')
    } finally {
      act(() => { root.unmount() })
    }
  })

  it('a newly presented revision takes the page back to the newest', async () => {
    mockPlans([planCall(1, 'p1', '# 第一版\n\n旧正文。')])
    const { container, root } = mount()
    try {
      await flush()
      const select = container.querySelector('select')!
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
      act(() => {
        setValue.call(select, 'p1')
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })

      // The model presents a second revision; the push feed relays it (the
      // page listens on the window, since it lives in a lazy chunk).
      mockPlans([planCall(1, 'p1', '# 第一版\n\n旧正文。'), planCall(3, 'p2', '# 第二版\n\n新正文。')])
      act(() => { window.dispatchEvent(new Event(PLAN_CHANGED_EVENT)) })
      await flush()

      expect(container.querySelector('select')!.value).toBe('p2')
      expect(container.textContent).toContain('新正文')
    } finally {
      act(() => { root.unmount() })
    }
  })

  it('copies the plan source, not the rendered document', async () => {
    const written = vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(true)
    mockPlans([planCall(1, 'p1', '# 复制我\n\n正文。')])
    const { container, root } = mount()
    try {
      await flush()
      const button = [...container.querySelectorAll('button')]
        .find(candidate => candidate.textContent === t('planCopy'))!
      await act(async () => { button.click() })
      expect(written).toHaveBeenCalledWith('# 复制我\n\n正文。')
      expect(container.textContent).toContain(t('copied'))
    } finally {
      act(() => { root.unmount() })
    }
  })
})
