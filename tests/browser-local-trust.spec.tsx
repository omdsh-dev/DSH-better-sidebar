// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { api } from '../src/client/api.ts'
import { BrowserView } from '../src/client/BrowserView.tsx'
import { createSidebarStore } from '../src/client/state.ts'

const roots: Root[] = []

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('browser local app trust', () => {
  it('saves the exact authority and then loads the app without probing localhost', async () => {
    const store = createSidebarStore()
    const settingsGet = vi.spyOn(api, 'settingsGet').mockResolvedValue({
      value: { browserAllowedLoopback: '' },
      revision: 4,
      externalDisable: false,
    })
    const settingsUpdate = vi.spyOn(api, 'settingsUpdate').mockResolvedValue({
      value: { browserAllowedLoopback: 'localhost:5173' },
      revision: 5,
    })
    const browserProbe = vi.spyOn(api, 'browserProbe')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<BrowserView
        ctx={{} as Context}
        store={store}
        scope={{ sessionId: 's1', cwd: '/p' }}
        tab={{ id: 'browser:1', type: 'browser', title: 'Browser', path: 'localhost:5173' }}
        visible
      />)
    })

    expect(container.querySelector('iframe')).toBeNull()
    const trust = [...container.querySelectorAll('button')]
      .find(button => button.textContent === 'Trust and open')
    expect(trust).toBeDefined()

    await act(async () => {
      trust!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(settingsGet).toHaveBeenCalledOnce()
    expect(settingsUpdate).toHaveBeenCalledWith({ browserAllowedLoopback: 'localhost:5173' }, 4)
    expect(store.getPrefs().browserAllowedLoopback).toBe('localhost:5173')
    const iframe = container.querySelector('iframe')
    expect(iframe?.getAttribute('src')).toBe('http://localhost:5173/')
    expect(iframe?.getAttribute('sandbox')).toContain('allow-same-origin')
    expect(browserProbe).not.toHaveBeenCalled()

    await act(async () => {
      store.setPrefs({ ...store.getPrefs(), browserAllowedLoopback: '' })
    })
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('Trust and open localhost:5173?')

    container.remove()
  })
})
