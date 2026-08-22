/**
 * SideCardSection must not let a stale settings document (one that does not
 * yet contain the failed new-install migration) overwrite the store's
 * in-memory new defaults when the user commits another change.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'
import { SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../src/client/api.ts', () => ({
  api: {
    settingsGet: async () => ({
      value: {
        openByDefault: false,
        defaultWidthPercent: 35,
        sidebarWidthPersistent: false,
        autoRefreshFiles: false,
      },
      revision: 1,
    }),
    settingsUpdate: async (patch: Record<string, unknown>) => ({
      value: {
        openByDefault: false,
        defaultWidthPercent: patch.defaultWidthPercent ?? 35,
        sidebarWidthPersistent: false,
        autoRefreshFiles: false,
      },
      revision: 2,
    }),
  },
  downloadUrl: () => '/sidebar/file',
}))

let store: SidebarStore
let service: BetterSidebarService
let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  store = createSidebarStore()
  service = createBetterSidebarService(store)
  store.setPrefs({ ...SIDEBAR_PREFS_DEFAULTS, sidebarWidthPersistent: true, autoRefreshFiles: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(SideCardSection, { store, service } as unknown as SideCardSectionProps))
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('SideCardSection pending new-install defaults', () => {
  it('keeps in-memory new defaults after a settings commit that does not include them', async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="number"], input[inputmode="numeric"]')
    expect(input).not.toBeNull()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input!, '50')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
      input!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })

    expect(store.getPrefs().sidebarWidthPersistent).toBe(true)
    expect(store.getPrefs().autoRefreshFiles).toBe(true)
    expect(store.getPrefs().defaultWidthPercent).toBe(50)
  })

  it('allows the user to explicitly disable a pending new-install default', async () => {
    const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="Consistent width across conversations"]')
    expect(checkbox).not.toBeNull()
    act(() => { checkbox!.click() })
    await act(async () => { await Promise.resolve() })

    // The explicit disable comes through even though the store previously
    // held the in-memory new default.
    expect(store.getPrefs().sidebarWidthPersistent).toBe(false)
    // A key not included in this patch is still preserved.
    expect(store.getPrefs().autoRefreshFiles).toBe(true)
  })
})
