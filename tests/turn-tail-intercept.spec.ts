/**
 * Turn-tail interception registration spec (issue #15): `registerTurnTailInterception`
 * must go through `ctx.slots.inject` — the slot is a CHILD slot the host's
 * ui-conversation declares in its `conversation.chat.node` children table, so a
 * direct `slots.register` races the declaration and the ui-slots core throws
 * "not declared (a parent entry's children table must declare it)".
 *
 * The fake `slots` mirrors SlotRegistry.inject's semantics: run the callback
 * synchronously when the slot is already declared; otherwise wait and run it
 * when the declaration commits; the returned disposer cancels a pending wait
 * and disposes any active registration; the register disposer is idempotent.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSidebarStore } from '../src/client/state.ts'
import { registerTurnTailInterception } from '../src/client/intercept.tsx'
import type { Context } from '../src/context-types.ts'

interface RegisteredSlot {
  options: Record<string, unknown>
  component: unknown
}

/**
 * A structural fake of the client slots service. `declared` selects the
 * timing: already-on-ledger (callback runs synchronously) vs. pending
 * (callback runs on `declare()`, unless the controller was disposed first).
 */
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
        if (key !== 'conversation.chat.turnTail') {
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

/** A produced-files owner currency: one closing assistant seq + its nodes. */
const producedOwner = (paths: string[]): unknown => ({
  nodes: [
    { kind: 'assistant', seq: 1, turn: 1 },
    ...paths.map(path => ({
      kind: 'tool-result', isError: false, callView: { card: 'diff', locations: [{ path }] },
    })),
    { kind: 'assistant', seq: 2, turn: 1 },
  ],
  seq: 2,
})

const emptyOwner = (): unknown => ({ nodes: [{ kind: 'assistant', seq: 1, turn: 1 }], seq: 1 })

/** The minimal client-context fake the registration (and its seats) touch. */
const clientCtx = (slots: unknown): Context => ({
  slots,
  sessions: {
    list: { getSnapshot: () => ({ current: 's1', byId: { s1: { id: 's1', cwd: '/w', displayTitle: 's1' } } }) },
  },
  betterSidebar: { openTab: vi.fn() },
} as unknown as Context)

describe('turn-tail interception registration (issue #15)', () => {
  it('registers through slots.inject and lands once the slot is already declared', () => {
    const fake = fakeSlots(true)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)

    // Exactly one registration, with the takeover descriptor.
    expect(fake.registered).toHaveLength(1)
    const { options, component } = fake.registered[0]!
    expect(options.name).toBe('conversation.chat.turnTail')
    expect(options.priority).toBe(-1)
    expect(options.registrant).toBe('dsh-better-sidebar')
    expect(options.select).toBeTypeOf('function')
    expect(options.inject).toBeTypeOf('function')
    expect(component).toBeTypeOf('function')

    // Disposal removes the registration; the disposer is idempotent.
    restore()
    expect(fake.disposals).toHaveLength(1)
    restore()
    expect(fake.disposals).toHaveLength(1)
  })

  it('waits for the host declaration instead of throwing (the pre-fix race)', () => {
    const fake = fakeSlots(false)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)

    // The slot is undeclared: nothing registered yet, no error.
    expect(fake.registered).toHaveLength(0)

    // The host's ui-conversation commits the declaration → the entry lands.
    expect(fake.pendings).toHaveLength(1)
    fake.pendings[0]!()
    expect(fake.registered).toHaveLength(1)

    // A later re-declaration does not double-register while the entry is live.
    fake.pendings[0]!()
    expect(fake.registered).toHaveLength(1)

    restore()
    expect(fake.disposals).toHaveLength(1)
  })

  it('a disposal before the declaration cancels the wait permanently', () => {
    const fake = fakeSlots(false)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)
    restore()

    // The declaration arrives after the controller was disposed: ignored.
    fake.pendings[0]!()
    expect(fake.registered).toHaveLength(0)
  })

  it('declines the takeover while the editor tab is disabled in the settings', () => {
    const fake = fakeSlots(true)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)
    const select = fake.registered[0]!.options.select as (owner: unknown) => unknown

    // Enabled (default): a produced turn claims the chain; an empty one declines.
    expect(select(producedOwner(['a.ts', 'b.ts']))).toEqual(['a.ts', 'b.ts'])
    expect(select(emptyOwner())).toBeNull()

    // Editor tab disabled: even a produced turn falls back to the default
    // deliverables row (chips that cannot open must not be offered).
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { editor: false } })
    expect(select(producedOwner(['a.ts']))).toBeNull()

    restore()
  })

  it('wires the openInSidebar seat to the sidebar editor tab', () => {
    const fake = fakeSlots(true)
    const ctx = clientCtx(fake.slots)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(ctx, store)
    const inject = fake.registered[0]!.options.inject as (sessionId: string) => {
      openInSidebar: (path: string) => void
    }

    // The seat hands the session-scoped opener to the chips row.
    const seat = inject('s1')
    expect(seat.openInSidebar).toBeTypeOf('function')
    seat.openInSidebar('/w/src/a.ts')
    expect(ctx.betterSidebar.openTab).toHaveBeenCalledWith({
      type: 'editor',
      title: 'a.ts',
      path: '/w/src/a.ts',
      id: 'editor:/w/src/a.ts',
    })

    restore()
  })
})
