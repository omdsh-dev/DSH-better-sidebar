/** The settings surface follows preference writes made outside its own form. */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { api } from '../src/client/api.ts'
import { SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

describe('SideCardSection external preference sync', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    if (root !== undefined) act(() => { root!.unmount() })
    container?.remove()
    root = undefined
    container = undefined
    vi.restoreAllMocks()
  })

  it('updates mounted controls when another surface writes the shared store', async () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    vi.spyOn(api, 'settingsGet').mockResolvedValue({ value: store.getPrefs(), revision: 1 })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(createElement(SideCardSection, {
        store,
        service,
        close: () => {},
      } as unknown as SideCardSectionProps))
    })

    const control = container.querySelector<HTMLInputElement>('input[aria-label="Open by default for new conversations"]')
    expect(control).not.toBeNull()
    expect(control!.checked).toBe(false)

    act(() => {
      store.setPrefs({ ...store.getPrefs(), openByDefault: true })
    })

    expect(control!.checked).toBe(true)
  })
})
