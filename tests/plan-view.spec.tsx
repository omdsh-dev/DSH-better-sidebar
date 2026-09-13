/**
 * The Plan page: the revision selector, the per-revision status header, and
 * the document body — all riding the mocked `plans.events` poll. The fold it
 * reads is covered by plans-ops.spec; what is pinned here is the page's own
 * behaviour: which revision is on screen, what the header says, what a newly
 * presented revision does to a manual pick, that an answer carrying no
 * revisions never wipes the list already on screen — and that such an answer
 * still clears a failed load.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { PlanView } from '../src/client/plans/PlanView.tsx'
import { PLAN_CHANGED_EVENT, type PlanEntry, type PlanList } from '../src/plan-events.ts'
import { api } from '../src/client/api.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'
import type { Context } from '../src/context-types.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

/** One revision, as the host would fold it out of the session's plan rows. */
function entryOf(callId: string, seq: number, plan: string, status: PlanEntry['status'] = 'pending'): PlanEntry {
  const title = plan.split('\n')[0]!.replace(/^#+\s*/, '')
  return { callId, seq, time: 1_700_000_000_000 + seq * 1_000, title, body: plan, status }
}

/** Serve a fixed list through the route (the page renders what it is handed). */
function mockPlans(entries: readonly PlanEntry[]): void {
  const list: PlanList = [...entries]
  vi.spyOn(api, 'plansEvents').mockImplementation(async () => list)
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
    mockPlans([entryOf('p1', 1, '# 重构方案\n\n第一步。')])
    const { container, root } = mount()
    try {
      await flush()
      expect(options(container)).toEqual(['v1 · 重构方案'])
      expect(container.textContent).toContain(t('planStatusPending'))
      // A body-only string: the title also renders inside the <option>, so
      // asserting on the heading would pass even with no document at all.
      expect(container.textContent).toContain('第一步。')
      expect(container.textContent).toContain(t('planCopy'))
    } finally {
      act(() => { root.unmount() })
    }
  })

  it('offers every revision oldest-first and lands on the newest', async () => {
    mockPlans([
      entryOf('p1', 1, '# 第一版\n\n旧正文。', 'unadopted'),
      entryOf('p2', 3, '# 第二版\n\n新正文。'),
    ])
    const { container, root } = mount()
    try {
      await flush()
      expect(options(container)).toEqual(['v1 · 第一版', 'v2 · 第二版'])
      const select = container.querySelector('select')!
      expect(select.value).toBe('p2')
      // Body strings, not titles — the titles are already on screen in the
      // <option> labels, which is what made the old assertions vacuous.
      expect(container.textContent).toContain('新正文')
      expect(container.textContent).not.toContain('旧正文')
      // The settled first revision keeps its own state; the new one is pending.
      expect(container.textContent).toContain(t('planStatusPending'))
    } finally {
      act(() => { root.unmount() })
    }
  })

  it('switching the selector shows that revision and its state', async () => {
    mockPlans([
      entryOf('p1', 1, '# 第一版\n\n旧正文。', 'approved'),
      entryOf('p2', 3, '# 第二版\n\n新正文。'),
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
    const first: PlanList = [entryOf('p1', 1, '# 第一版\n\n旧正文。')]
    const second: PlanList = [...first, entryOf('p2', 3, '# 第二版\n\n新正文。')]
    let call = 0
    vi.spyOn(api, 'plansEvents').mockImplementation(async () => (call++ === 0 ? first : second))
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
    mockPlans([entryOf('p1', 1, '# 复制我\n\n正文。')])
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

  it('keeps the revisions on screen when a poll answers with none', async () => {
    // "The log is unreadable right now" is not "this session has no plans":
    // blanking the list would throw away an archive the reader is looking at,
    // and the next readable poll would not bring it back on its own.
    const entries: PlanList = [entryOf('p1', 1, '# 第一版\n\n旧正文。')]
    let call = 0
    vi.spyOn(api, 'plansEvents').mockImplementation(async () => {
      // The first answer lands the revision; every later one is empty.
      return call++ === 0 ? entries : []
    })
    const { container, root } = mount()
    try {
      await flush()
      expect(container.querySelector('select')!.value).toBe('p1')
      act(() => { window.dispatchEvent(new Event(PLAN_CHANGED_EVENT)) })
      await flush()
      expect(container.querySelector('select')).not.toBeNull()
      expect(container.textContent).toContain('旧正文')
    } finally {
      act(() => { root.unmount() })
    }
  })

  it('clears a failed load once any answer arrives, an empty one included', async () => {
    // A rejected poll says "could not read"; the empty answer that follows is a
    // successful "no plans" — which is most sessions. Leaving the flag set
    // would keep the error on screen long after the host recovered.
    const plansEvents = vi.spyOn(api, 'plansEvents')
    plansEvents.mockRejectedValueOnce(new Error('offline'))
    const { container, root } = mount()
    try {
      await flush()
      expect(container.textContent).toContain(t('planLoadError'))
      plansEvents.mockResolvedValue([])
      act(() => { window.dispatchEvent(new Event(PLAN_CHANGED_EVENT)) })
      await flush()
      expect(container.textContent).toContain(t('planEmpty'))
      expect(container.textContent).not.toContain(t('planLoadError'))
    } finally {
      act(() => { root.unmount() })
    }
  })
})
