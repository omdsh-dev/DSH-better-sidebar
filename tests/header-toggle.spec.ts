/**
 * Header-utilities toggle: the cluster must land through `slots.inject` on
 * `conversation.session.header.utilities` (a child of the session header,
 * same race as turn-tail) and the header-hosted buttons must write the
 * shared store. The floating fallback is a CSS concern (`data-dsh-sidebar-in-header`)
 * and is asserted via the body attribute the occupant sets on mount.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  HEADER_TOGGLE_ATTR,
  HeaderToggleCluster,
  registerHeaderToggle,
} from '../src/client/ToggleCluster.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { t } from '../src/client/locales.ts'
import type { Context } from '../src/context-types.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

interface RegisteredSlot {
  options: Record<string, unknown>
  component: unknown
}

/** Structural fake of SlotRegistry.inject (same timing as turn-tail). */
const fakeSlots = (declared: boolean) => {
  const registered: RegisteredSlot[] = []
  const disposals: number[] = []
  const pendings: Array<() => void> = []
  return {
    registered,
    disposals,
    pendings,
    slots: {
      register: (options: Record<string, unknown>, component: unknown) => {
        registered.push({ options, component })
        return () => { disposals.push(1) }
      },
      inject: (key: string, callback: () => () => void) => {
        if (key !== 'conversation.session.header.utilities') {
          throw new Error(`unexpected injected key "${key}"`)
        }
        let active: (() => void) | undefined
        let stopped = false
        const run = (): void => {
          if (stopped || active !== undefined) return
          active = callback()
        }
        if (declared) run()
        else pendings.push(run)
        return () => {
          stopped = true
          active?.()
          active = undefined
        }
      },
    },
  }
}

const clientCtx = (slots: unknown): Context => ({ slots } as unknown as Context)

describe('header toggle registration', () => {
  it('registers through slots.inject once the utilities slot is declared', () => {
    const fake = fakeSlots(true)
    const store = createSidebarStore()
    const restore = registerHeaderToggle(clientCtx(fake.slots), store)

    expect(fake.registered).toHaveLength(1)
    const { options, component } = fake.registered[0]!
    expect(options.name).toBe('conversation.session.header.utilities')
    expect(options.id).toBe('better-sidebar-toggle')
    expect(options.order).toBe(100)
    expect(options.inject).toBeTypeOf('function')
    expect((options.inject as () => { store: unknown })()).toEqual({ store })
    expect(component).toBe(HeaderToggleCluster)

    restore()
    expect(fake.disposals).toHaveLength(1)
    restore()
    expect(fake.disposals).toHaveLength(1)
  })

  it('waits for the host declaration instead of throwing', () => {
    const fake = fakeSlots(false)
    const store = createSidebarStore()
    const restore = registerHeaderToggle(clientCtx(fake.slots), store)

    expect(fake.registered).toHaveLength(0)
    expect(fake.pendings).toHaveLength(1)
    fake.pendings[0]!()
    expect(fake.registered).toHaveLength(1)
    expect(fake.registered[0]!.options.id).toBe('better-sidebar-toggle')

    restore()
    expect(fake.disposals).toHaveLength(1)
  })
})

describe('HeaderToggleCluster', () => {
  const mounts: Array<{ root: Root; host: HTMLDivElement }> = []

  afterEach(() => {
    for (const { root, host } of mounts) {
      act(() => { root.unmount() })
      host.remove()
    }
    mounts.length = 0
    document.body.removeAttribute(HEADER_TOGGLE_ATTR)
  })

  function mount(store = createSidebarStore()): { host: HTMLDivElement; store: ReturnType<typeof createSidebarStore> } {
    store.setSession('s1')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => { root.render(createElement(HeaderToggleCluster, { store })) })
    mounts.push({ root, host })
    return { host, store }
  }

  it('sets the body attribute while mounted and clears it on unmount', () => {
    const { host } = mount()
    expect(document.body.hasAttribute(HEADER_TOGGLE_ATTR)).toBe(true)
    expect(host.querySelector('[data-dsh-sidebar-header-toggle]')).not.toBeNull()

    const { root } = mounts[0]!
    act(() => { root.unmount() })
    host.remove()
    mounts.length = 0
    expect(document.body.hasAttribute(HEADER_TOGGLE_ATTR)).toBe(false)
  })

  it('renders both panel buttons and writes the store', () => {
    const { host, store } = mount()
    const buttons = [...host.querySelectorAll('button')]
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.getAttribute('aria-label')).toBe(t('expandBottomPanel'))
    expect(buttons[1]!.getAttribute('aria-label')).toBe(t('collapse'))

    act(() => { buttons[1]!.click() })
    expect(store.getSnapshot().state?.panelOpen).toBe(false)
    expect(buttons[1]!.getAttribute('aria-label')).toBe(t('expand'))

    act(() => { buttons[0]!.click() })
    expect(store.getSnapshot().state?.bottomOpen).toBe(true)
    expect(buttons[0]!.getAttribute('aria-label')).toBe(t('collapseBottomPanel'))
  })

  it('disables both buttons when the store has no session', () => {
    const store = createSidebarStore()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => { root.render(createElement(HeaderToggleCluster, { store })) })
    mounts.push({ root, host })

    const buttons = [...host.querySelectorAll('button')]
    expect(buttons).toHaveLength(2)
    expect(buttons.every(button => button.disabled)).toBe(true)
    expect(buttons[0]!.getAttribute('aria-label')).toBe(t('noSession'))
  })
})
