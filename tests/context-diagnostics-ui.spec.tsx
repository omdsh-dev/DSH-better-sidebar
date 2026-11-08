/**
 * The optional dsh-context diagnostics UI (context-diagnostics-ui.tsx): the
 * two surfaces the plugin contributes to the HOST — the session header's
 * utilities control and the frame-wide `shell.overlay` alert — and the rules
 * that make them safe.
 *
 * Contract pinned here:
 * - every entry point is gated on the controller's `available` (dsh-context
 *   absent, or present WITHOUT its keyed tab body, hides all three instead of
 *   offering a dead control), and `busy` disables them all (one open at a
 *   time);
 * - the header control re-checks the session it was drawn for against the
 *   session really on screen (`ctx.sidebarRight.mounted`) at CLICK time: a
 *   header left over from the previous conversation must not navigate;
 * - the alert is gated on the ERROR only — an open already in flight when the
 *   capability went away must still report why it failed — and dismissing it
 *   is the controller's own `dismissError()`, never a timer;
 * - the controller is threaded PER ACTIVATION (provider prop, injected bag):
 *   one provider unmounting must never clear another's store.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct } from './test-utils.ts'
import {
  ContextDiagnosticsAlert,
  ContextDiagnosticsButton,
  ContextDiagnosticsHost,
  registerContextDiagnosticsUI,
} from '../src/client/context-diagnostics-ui.tsx'
import { attachLocale } from '../src/client/locales.ts'
import type { Context } from '../src/context-types.ts'
import type {
  ContextDiagnosticTarget,
  ContextDiagnostics,
  ContextDiagnosticsSnapshot,
} from '../src/client/context-diagnostics.ts'

setupReactAct()

/** The host locale service face `attachLocale` needs: pin the zh chain. */
function attachZhLocale(): void {
  attachLocale({ getSnapshot: () => ({ active: 'zh' }) })
}

/** A controller double: the snapshot is driven by the test, not by a host. */
function makeController(initial: ContextDiagnosticsSnapshot) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const opens: ContextDiagnosticTarget[] = []
  const dismissals: number[] = []
  const controller: ContextDiagnostics = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open: (target: ContextDiagnosticTarget) => { opens.push(target) },
    dismissError: () => {
      dismissals.push(1)
      publish({ available: snapshot.available, busy: snapshot.busy })
    },
    dispose: () => {},
  }
  const publish = (next: ContextDiagnosticsSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  return { controller, publish, opens, dismissals }
}

/** One captured slot registration (the options the plugin registered with). */
interface Registration {
  name: string
  id?: string
  order?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the host's own untyped inject
  inject?: (...args: any[]) => Record<string, unknown>
  component?: unknown
}

/** The host's slot ledger as this module uses it: inject fires, register is kept. */
function makeSlots() {
  const registrations: Registration[] = []
  const slots = {
    inject: (_key: string, callback: () => () => void) => callback(),
    register: (options: Registration, component: unknown) => {
      const entry: Registration = { ...options, component }
      registrations.push(entry)
      return () => {
        const index = registrations.indexOf(entry)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
  }
  return { registrations, slots }
}

/** A context whose native right column reports one on-screen session. */
function makeCtx(mounted: string | undefined): Context {
  return {
    get: (name: string) => (name === 'sidebarRight' ? { mounted: { getSnapshot: () => mounted, subscribe: () => () => {} } } : undefined),
  } as unknown as Context
}

/** One slot entry of a ledger, by its id. */
function entryOf(ledger: Registration[], id: string): Registration {
  const entry = ledger.find(candidate => candidate.id === id)
  if (entry === undefined) throw new Error(`no registration for ${id}`)
  return entry
}

/** The element the ledger's entry renders for one slot session. */
function elementOf(ledger: Registration[], sessionId = 's1'): ReactNode {
  const entry = entryOf(ledger, 'dsh-better-sidebar:context-diagnostics')
  if (entry.inject === undefined) throw new Error('the entry carries no inject')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the module's own slot component
  const Component = entry.component as (props: any) => ReactNode
  return createElement(Component, entry.inject(sessionId) as Record<string, unknown>)
}

/** The entry point's control, or null when the surface hides itself. */
function entryButton(container: HTMLElement, kind: string): HTMLButtonElement | null {
  return container.querySelector(`button[data-dsh-ctx-entry="${kind}"]`)
}

beforeEach(() => { attachZhLocale() })

afterEach(() => {
  attachLocale(undefined)
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

describe('registerContextDiagnosticsUI', () => {
  it('contributes one header entry and one overlay entry, both in the plugin\'s id space', () => {
    const slots = makeSlots()
    const fake = makeController({ available: true, busy: false })
    const dispose = registerContextDiagnosticsUI(
      { ...makeCtx('s1'), slots: slots.slots } as unknown as Context,
      fake.controller,
    )

    expect(slots.registrations.map(entry => entry.name).sort())
      .toEqual(['conversation.session.header.utilities', 'shell.overlay'])
    for (const entry of slots.registrations) {
      expect(entry.id).toBe('dsh-better-sidebar:context-diagnostics')
      expect(entry.order).toBe(20)
    }
    // The disposer releases both entries (HMR / plugin disable).
    dispose()
    expect(slots.registrations).toHaveLength(0)
  })

  it('registers into both slot keys through slots.inject (a late declaration still lands)', () => {
    const injected: string[] = []
    const ctx = {
      ...makeCtx('s1'),
      slots: {
        inject: (key: string, callback: () => () => void) => {
          injected.push(key)
          return callback()
        },
        register: () => () => {},
      },
    } as unknown as Context
    const fake = makeController({ available: true, busy: false })
    registerContextDiagnosticsUI(ctx, fake.controller)
    expect(injected).toEqual(['conversation.session.header.utilities', 'shell.overlay'])
  })
})

describe('the header control', () => {
  it('renders nothing while the capability is unavailable, and appears when it does', async () => {
    const fake = makeController({ available: false, busy: false })
    const slots = makeSlots()
    registerContextDiagnosticsUI({ ...makeCtx('s1'), slots: slots.slots } as unknown as Context, fake.controller)
    const { container, unmount } = renderRoot(elementOf(slots.registrations))
    expect(entryButton(container, 'session')).toBeNull()

    // dsh-context installed while the page is open: the control must appear
    // without a reload, and open the session the slot was mounted for.
    await act(async () => { fake.publish({ available: true, busy: false }) })
    const button = entryButton(container, 'session')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')).toBe('上下文诊断')
    expect(button?.getAttribute('aria-busy')).toBeNull()

    await act(async () => { button?.click() })
    expect(fake.opens).toEqual([{ sessionId: 's1', label: '当前会话' }])
    unmount()
  })

  it('is DISABLED and announced busy while an open is in flight', async () => {
    const fake = makeController({ available: true, busy: true })
    const slots = makeSlots()
    registerContextDiagnosticsUI({ ...makeCtx('s1'), slots: slots.slots } as unknown as Context, fake.controller)
    const { container, unmount } = renderRoot(elementOf(slots.registrations))
    const button = entryButton(container, 'session')
    expect(button?.disabled).toBe(true)
    expect(button?.getAttribute('aria-busy')).toBe('true')
    await act(async () => { button?.click() })
    expect(fake.opens).toEqual([])
    unmount()
  })

  it('refuses to act when the session it was drawn for is no longer on screen', async () => {
    // The stale-header window: the host has switched to `s2` while an entry
    // contributed for `s1` is still mounted (re-registration is not synchronous
    // with the switch). Acting would open s1's Context view over s2.
    const fake = makeController({ available: true, busy: false })
    const current = makeSlots()
    registerContextDiagnosticsUI({ ...makeCtx('s1'), slots: current.slots } as unknown as Context, fake.controller)
    const live = renderRoot(elementOf(current.registrations, 's1'))
    await act(async () => { entryButton(live.container, 'session')?.click() })
    expect(fake.opens, 'the header drew s1 while s1 was on screen').toHaveLength(1)

    const stale = makeSlots()
    registerContextDiagnosticsUI({ ...makeCtx('s2'), slots: stale.slots } as unknown as Context, fake.controller)
    const old = renderRoot(elementOf(stale.registrations, 's1'))
    const button = entryButton(old.container, 'session')
    expect(button).not.toBeNull()
    await act(async () => { button?.click() })
    expect(fake.opens, 'a click on a stale header must not navigate').toHaveLength(1)

    live.unmount()
    old.unmount()
  })
})

describe('the frame-wide alert', () => {
  it('shows ONE role=alert with the reason, and dismisses through the controller', async () => {
    const fake = makeController({
      available: true,
      busy: false,
      error: { reason: 'timeout', targetLabel: '子代理 0' },
    })
    const { container, unmount } = renderRoot(createElement(ContextDiagnosticsAlert, { controller: fake.controller }))
    const alerts = container.querySelectorAll('[role="alert"]')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.textContent).toContain('无法打开「子代理 0」的上下文诊断')
    expect(alerts[0]!.textContent).toContain('打开超时，请重试')
    expect(container.querySelector('[data-dsh-ctx-alert]')).not.toBeNull()
    // The alert is not a modal: it names no dialog role and traps nothing.
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(0)

    const dismiss = container.querySelector('button[aria-label="关闭提示"]') as HTMLButtonElement
    expect(dismiss).not.toBeNull()
    await act(async () => { dismiss.click() })
    expect(fake.dismissals).toHaveLength(1)
    // The controller cleared its own error: the alert goes with it.
    await act(async () => { fake.publish({ available: true, busy: false }) })
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0)
    unmount()
  })

  it('still reports an open that failed because the capability went away', () => {
    // The controller publishes `available: false` WITH the error (an open in
    // flight when dsh-context disappeared): the entry points are gone, but the
    // failure the reader triggered must still be reported.
    const fake = makeController({
      available: false,
      busy: false,
      error: { reason: 'unavailable', targetLabel: '主会话' },
    })
    const { container, unmount } = renderRoot(createElement(ContextDiagnosticsAlert, { controller: fake.controller }))
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(container.textContent).toContain('dsh-context 的「上下文」页面不可用')
    unmount()
  })

  it('renders nothing without an error', () => {
    const fake = makeController({ available: true, busy: false })
    const { container, unmount } = renderRoot(createElement(ContextDiagnosticsAlert, { controller: fake.controller }))
    expect(container.textContent).toBe('')
    unmount()
  })

  it('reports each failure reason in its own words', () => {
    for (const [reason, wording] of [
      ['navigation', '无法定位到该会话'],
      ['open', '页面打开失败'],
    ] as const) {
      const fake = makeController({ available: true, busy: false, error: { reason, targetLabel: '主会话' } })
      const { container, unmount } = renderRoot(createElement(ContextDiagnosticsAlert, { controller: fake.controller }))
      expect(container.textContent).toContain(wording)
      unmount()
    }
  })
})

describe('per-activation isolation', () => {
  it('two providers keep their own controllers: unmounting one leaves the other working', async () => {
    const first = makeController({ available: true, busy: false })
    const second = makeController({ available: true, busy: false })
    const target: ContextDiagnosticTarget = { sessionId: 's1', label: '当前会话' }

    const firstRoot = renderRoot(createElement(
      ContextDiagnosticsHost,
      { controller: first.controller },
      createElement(ContextDiagnosticsButton, { kind: 'session', target, iconSize: 14 }),
    ))
    const secondRoot = renderRoot(createElement(
      ContextDiagnosticsHost,
      { controller: second.controller },
      createElement(ContextDiagnosticsButton, { kind: 'session', target, iconSize: 14 }),
    ))

    await act(async () => { entryButton(secondRoot.container, 'session')?.click() })
    expect(second.opens).toHaveLength(1)
    expect(first.opens, 'the click went to the other activation\'s controller').toHaveLength(0)

    // The second activation goes away; the first must be untouched — no
    // module-level "current controller" may be cleared by a sibling unmount.
    secondRoot.unmount()
    const surviving = entryButton(firstRoot.container, 'session')
    expect(surviving).not.toBeNull()
    await act(async () => { surviving?.click() })
    expect(first.opens).toEqual([target])

    // …and the first's own availability still drives its own control.
    await act(async () => { first.publish({ available: false, busy: false }) })
    expect(entryButton(firstRoot.container, 'session')).toBeNull()
    firstRoot.unmount()
  })

  it('renders no entry point where no provider supplied a controller', () => {
    const fake = makeController({ available: true, busy: false })
    const { container, unmount } = renderRoot(createElement(
      ContextDiagnosticsHost,
      undefined,
      createElement(ContextDiagnosticsButton, {
        kind: 'agent',
        target: { sessionId: 's1' },
        iconSize: 14,
      }),
    ))
    expect(entryButton(container, 'agent')).toBeNull()
    // A controller that exists elsewhere in the process is not adopted: the
    // store is the provider's, never a module-level registration.
    void fake
    unmount()
  })

  it('hides the entry point while the controller reports the capability unavailable', () => {
    const fake = makeController({ available: false, busy: false })
    const { container, unmount } = renderRoot(createElement(
      ContextDiagnosticsHost,
      { controller: fake.controller },
      createElement(ContextDiagnosticsButton, { kind: 'job', target: { sessionId: 's1' }, iconSize: 12 }),
    ))
    expect(entryButton(container, 'job')).toBeNull()
    unmount()
  })

  it('hides the entry point when the caller has no target (an unmapped job owner)', () => {
    const fake = makeController({ available: true, busy: false })
    const { container, unmount } = renderRoot(createElement(
      ContextDiagnosticsHost,
      { controller: fake.controller },
      createElement(ContextDiagnosticsButton, { kind: 'job', target: undefined, iconSize: 12 }),
    ))
    expect(entryButton(container, 'job')).toBeNull()
    unmount()
  })
})
