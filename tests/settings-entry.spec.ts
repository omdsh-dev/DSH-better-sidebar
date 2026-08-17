/**
 * Settings entry selection tests: the pure target picker and the actual
 * registration behavior through a fake slots/effect context. The family mode
 * (web-ui-settings present) must register the `web-ui.plugin.item` card and
 * NOT the shell section; standalone mode keeps the `settings.section` row
 * and the nav-icon effect.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '../src/context-types.ts'
import {
  FAMILY_CARD_ORDER,
  registerSettingsEntry,
  settingsEntryTarget,
  type SettingsEntryDeps,
} from '../src/client/settings-entry.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'

function deps(): SettingsEntryDeps {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  return { store, service }
}

/** Recorded registration options (the business face factory is called on read). */
interface RecordedRegistration {
  name: string
  id?: string
  order?: number
  locale?: string
  inject?: () => Record<string, unknown>
}

interface FakeSlots {
  injections: string[]
  registrations: RecordedRegistration[]
  effects: number
}

function fakeCtx(): { ctx: Context; slots: FakeSlots } {
  const slots: FakeSlots = { injections: [], registrations: [], effects: 0 }
  const ctx = {
    slots: {
      inject(key: string, callback: () => () => void): () => void {
        slots.injections.push(key)
        // Simulate an already-declared slot: the factory runs immediately.
        return callback()
      },
      register(options: RecordedRegistration, _component: unknown): () => void {
        slots.registrations.push(options)
        return () => {}
      },
    },
    effect(_fn: () => void | (() => void)): void {
      // Record the lifecycle hook without running it: the nav-icon body
      // touches the DOM, which this node-env spec does not provide. The
      // registration decision is what is under test.
      slots.effects += 1
    },
    get(): undefined {
      return undefined
    },
  } as unknown as Context
  return { ctx, slots }
}

describe('settingsEntryTarget', () => {
  it('picks the family card when the family settings group is present', () => {
    expect(settingsEntryTarget(true)).toBe('family-card')
  })

  it('picks the standalone section otherwise', () => {
    expect(settingsEntryTarget(false)).toBe('section')
  })
})

describe('registerSettingsEntry', () => {
  it('family mode: registers the web-ui.plugin.item card, no shell section, no nav icon', () => {
    const { ctx, slots } = fakeCtx()
    const { store, service } = deps()
    registerSettingsEntry(ctx, { store, service, hasFamilySettings: true })

    expect(slots.injections).toEqual(['web-ui.plugin.item'])
    expect(slots.effects).toBe(0)
    expect(slots.registrations).toHaveLength(1)
    const card = slots.registrations[0]!
    expect(card.name).toBe('web-ui.plugin.item')
    expect(card.id).toBe('better-sidebar')
    expect(card.order).toBe(FAMILY_CARD_ORDER)
    expect(card.locale).toBe('betterSidebar')
    // The injected business face hands the shared store/service through.
    const face = card.inject?.() as { store?: unknown; service?: unknown }
    expect(face.store).toBe(store)
    expect(face.service).toBe(service)
  })

  it('standalone mode: registers the settings.section row plus the nav-icon effect', () => {
    const { ctx, slots } = fakeCtx()
    const { store, service } = deps()
    registerSettingsEntry(ctx, { store, service, hasFamilySettings: false })

    expect(slots.injections).toEqual(['settings.section'])
    expect(slots.effects).toBe(1)
    expect(slots.registrations).toHaveLength(1)
    const section = slots.registrations[0]!
    expect(section.name).toBe('settings.section')
    expect(section.id).toBe('better-sidebar')
    expect(section.order).toBe(100)
    const face = section.inject?.() as { store?: unknown; service?: unknown }
    expect(face.store).toBe(store)
    expect(face.service).toBe(service)
  })
})
