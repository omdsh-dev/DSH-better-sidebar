/**
 * The Git card's pinned-model panel: the follow switch gates the route box,
 * and every candidate is displayed as the SAME string the host dispatches on
 * (`provider/model`) — a catalog entry must not read as a decorated
 * "<provider> · <model>" while the default reads as a route.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { CommitModelSettings } from '../src/client/changes/CommitModelSettings.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { api, type GitModelCatalog } from '../src/client/api.ts'
import type { BetterSidebarService } from '../src/client/service.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const CATALOG: GitModelCatalog = {
  llm: true,
  providers: [{
    provider: 'deepseek',
    name: 'DeepSeek',
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
  }],
  recent: [{ provider: 'openai', model: 'gpt-4o' }],
  default: { provider: 'deepseek', model: 'deepseek-chat' },
}

/** Mount the panel with one session attached and the catalog already loaded. */
async function mount(pluginSettings: Record<string, unknown>): Promise<{
  container: HTMLElement
  writes: unknown[]
  unmount: () => void
}> {
  vi.spyOn(api, 'gitModels').mockResolvedValue(CATALOG)
  const writes: unknown[] = []
  const store = createSidebarStore()
  store.setSession('session')
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(CommitModelSettings, {
      store,
      service: {} as unknown as BetterSidebarService,
      prefs: store.getPrefs(),
      pluginSettings,
      updatePluginSetting: (_key: string, value: unknown) => { writes.push(value) },
      close: () => {},
    }))
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return {
    container,
    writes,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

function routeInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]')
  if (input === null) throw new Error('the route input is missing')
  return input
}

function followSwitch(container: HTMLElement): HTMLInputElement {
  const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (box === null) throw new Error('the follow switch is missing')
  return box
}

afterEach(() => { vi.restoreAllMocks() })

describe('CommitModelSettings', () => {
  it('follows the conversation by default and disables the route box while it does', async () => {
    const { container, unmount } = await mount({})
    try {
      expect(followSwitch(container).checked).toBe(true)
      expect(routeInput(container).disabled).toBe(true)
    } finally {
      unmount()
    }
  })

  it('enables the box when following is switched off', async () => {
    const { container, unmount } = await mount({})
    try {
      const box = followSwitch(container)
      await act(async () => { box.click() })
      expect(box.checked).toBe(false)
      expect(routeInput(container).disabled).toBe(false)
    } finally {
      unmount()
    }
  })

  it('lists every candidate as the route it would dispatch on', async () => {
    const { container, unmount } = await mount({})
    try {
      await act(async () => { followSwitch(container).click() })
      const input = routeInput(container)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, 'deepseek')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => { await Promise.resolve() })

      // The portalled menu renders outside this container.
      const menuText = document.body.textContent ?? ''
      expect(menuText).toContain('deepseek/deepseek-chat')
      // The decorated catalog rendering would show the provider label instead.
      expect(menuText).not.toContain('DeepSeek · DeepSeek Chat')
    } finally {
      unmount()
    }
  })

  it('shows the stored route on its own line and keeps the search box empty', async () => {
    const { container, unmount } = await mount({ commitModel: 'openai/gpt-4o' })
    try {
      // A stored route means the switch starts OFF; the route is displayed,
      // but it is NOT projected into the search box (which would then filter
      // the menu down to the already-selected model).
      expect(followSwitch(container).checked).toBe(false)
      expect(container.textContent).toContain('Current: openai/gpt-4o')
      expect(routeInput(container).value).toBe('')
    } finally {
      unmount()
    }
  })

  it('reopens the menu over every candidate while a model is already pinned', async () => {
    const { container, unmount } = await mount({ commitModel: 'deepseek/deepseek-chat' })
    try {
      const input = routeInput(container)
      await act(async () => { input.focus() })
      await act(async () => { await Promise.resolve() })

      const menuText = document.body.textContent ?? ''
      expect(menuText).toContain('deepseek/deepseek-chat')
      // The other candidate proves the list is not filtered by the selection.
      expect(menuText).toContain('openai/gpt-4o')
    } finally {
      unmount()
    }
  })

  it('commits a hand-typed route and clears the filter', async () => {
    const { container, writes, unmount } = await mount({})
    try {
      await act(async () => { followSwitch(container).click() })
      const input = routeInput(container)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, 'vendor/model-x')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })

      expect(writes.at(-1)).toBe('vendor/model-x')
      expect(input.value).toBe('')
    } finally {
      unmount()
    }
  })

  it('clears the pinned route when following is restored', async () => {
    const { container, writes, unmount } = await mount({ commitModel: 'openai/gpt-4o' })
    try {
      await act(async () => { followSwitch(container).click() })
      expect(writes.at(-1)).toBe('')
    } finally {
      unmount()
    }
  })
})
