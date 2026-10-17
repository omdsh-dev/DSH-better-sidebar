/**
 * The public service face of the unified window host (S6): `windows` is one
 * host per activation, advertises the additive `windowHost` feature, and
 * open/focus/close work through `ctx.betterSidebar.windows`. It is explicitly
 * NOT the removed `floatWindows` feature.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  SIDEBAR_FEATURES,
  createBetterSidebarService,
} from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

let service: ReturnType<typeof createBetterSidebarService> | undefined

afterEach(() => {
  service?.windows.dispose()
  service = undefined
})

function makeService(): ReturnType<typeof createBetterSidebarService> {
  service = createBetterSidebarService(createSidebarStore())
  return service
}

describe('service.windows (S6)', () => {
  it('advertises windowHost, never floatWindows, and exposes the window face', () => {
    const created = makeService()
    expect(created.features).toContain('windowHost')
    expect(SIDEBAR_FEATURES).toContain('windowHost')
    expect(created.features).not.toContain('floatWindows')
    expect(typeof created.windows.open).toBe('function')
    expect(typeof created.windows.getSnapshot).toBe('function')
  })

  it('opens one store-backed window through the service face and focuses by identity', () => {
    const created = makeService()
    const first = created.windows.open({ id: 'clue:1', title: 'Clue', content: 'draft' })
    const second = created.windows.open({ id: 'clue:1', title: 'Other', content: 'other' })
    expect(second).toBe(first)
    expect(created.windows.getSnapshot().windows).toHaveLength(1)
    expect(created.windows.getSnapshot().windows[0]).toMatchObject({
      id: 'clue:1', title: 'Clue', content: 'draft', size: 'collection',
    })
    first.update({ content: 'updated' })
    expect(created.windows.getSnapshot().windows[0]!.content).toBe('updated')
  })

  it('exposes S1 format renderers to the window content seat', () => {
    const created = makeService()
    const renderer = () => null
    const dispose = created.clues.registerFormatRenderer('application/x-service-format', renderer)
    expect(created.clues.getFormatRenderer('application/x-service-format')).toBe(renderer)
    dispose()
    expect(created.clues.getFormatRenderer('application/x-service-format')).toBeUndefined()
  })
})
