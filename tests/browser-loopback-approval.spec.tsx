/**
 * The loopback gate offers an exact, explicit recovery action: approving one
 * host:port persists only that authority, keeps the iframe sandboxed, and
 * completes the navigation without leaving the stale "Blocked" banner up.
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { BrowserView, BROWSER_IFRAME_SANDBOX } from '../src/client/BrowserView.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

const settingsUpdate = vi.fn()
vi.mock('../src/client/api.ts', () => ({
  api: {
    browserProbe: async () => ({ reachable: false }),
    settingsUpdate: (...args: unknown[]) => settingsUpdate(...args),
  },
}))

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

describe('Browser loopback approval', () => {
  it('allows one exact authority and keeps the sandbox on', async () => {
    const store = createSidebarStore()
    store.setSession('s1')
    settingsUpdate.mockImplementation(async (patch: Record<string, unknown>) => ({
      revision: 1,
      value: { ...store.getPrefs(), ...patch },
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(BrowserView, {
        ctx: {} as Context,
        store,
        scope: { sessionId: 's1', cwd: '/p' },
        tab: { id: 'browser:1', type: 'browser', title: 'Browser' },
        visible: true,
      }))
    })

    const input = container.querySelector<HTMLInputElement>('input')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'http://localhost:3003/app')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    const allow = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === 'Allow localhost:3003')
    expect(allow).toBeDefined()
    expect(container.textContent).toContain('Blocked: local and internal addresses')

    await act(async () => { allow!.click() })

    expect(settingsUpdate).toHaveBeenCalledWith({ browserAllowedLoopback: 'localhost:3003' })
    expect(store.getPrefs().browserAllowedLoopback).toBe('localhost:3003')
    expect(container.textContent).not.toContain('Blocked: local and internal addresses')
    const iframe = container.querySelector<HTMLIFrameElement>('iframe')!
    expect(iframe.getAttribute('src')).toBe('http://localhost:3003/app')
    expect(iframe.getAttribute('sandbox')).toBe(`${BROWSER_IFRAME_SANDBOX} allow-same-origin`)

    act(() => { root.unmount() })
    container.remove()
  })
})
