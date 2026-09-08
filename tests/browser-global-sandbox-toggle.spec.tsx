/**
 * The browser status row owns a persistent/global sandbox switch in addition
 * to its local temporary unlock. One write must update every mounted browser
 * tab through the shared prefs store and the round-tripped value must restore
 * the sandbox just as directly.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { api } from '../src/client/api.ts'
import { BrowserView } from '../src/client/BrowserView.tsx'
import { createSidebarStore } from '../src/client/state.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true })
})

const CTX = {} as Context

function tabProps(store: ReturnType<typeof createSidebarStore>, id: string) {
  return {
    ctx: CTX,
    store,
    scope: { sessionId: 's1', cwd: '/p' },
    tab: { id, type: 'browser', title: '浏览器', path: 'https://example.com/' },
    visible: true,
  }
}

describe('browser global sandbox toggle', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    if (root !== undefined) act(() => { root!.unmount() })
    container?.remove()
    root = undefined
    container = undefined
    vi.restoreAllMocks()
  })

  it('persists the setting and updates every open browser iframe', async () => {
    const store = createSidebarStore()
    vi.spyOn(api, 'browserProbe').mockResolvedValue({ reachable: false })
    const update = vi.spyOn(api, 'settingsUpdate').mockImplementation(async (patch) => ({
      value: { ...store.getPrefs(), ...patch },
      revision: 2,
    }))

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => {
      root!.render(createElement(Fragment, null,
        createElement(BrowserView, tabProps(store, 'browser:1')),
        createElement(BrowserView, tabProps(store, 'browser:2')),
      ))
    })

    const temporaryUnlocks = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .filter(button => button.textContent?.trim() === '临时解锁（不安全）')
    const globalOff = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('关闭浏览器沙箱'))
    expect(temporaryUnlocks).toHaveLength(2)
    expect(globalOff).toBeDefined()
    expect(container.querySelectorAll('iframe[sandbox]')).toHaveLength(2)

    // Leave tab B locally unlocked before exercising the global switch. A
    // later global restore must still secure both tabs.
    act(() => { temporaryUnlocks[1]!.click() })
    expect(container.querySelectorAll('iframe[sandbox]')).toHaveLength(1)

    await act(async () => { globalOff!.click() })

    expect(update).toHaveBeenLastCalledWith({ browserNoSandbox: true })
    expect(store.getPrefs().browserNoSandbox).toBe(true)
    expect(container.querySelectorAll('iframe[sandbox]')).toHaveLength(0)
    expect(container.textContent).toContain('沙箱已关闭')

    const globalOn = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === '恢复沙箱')
    expect(globalOn).toBeDefined()

    await act(async () => { globalOn!.click() })

    expect(update).toHaveBeenLastCalledWith({ browserNoSandbox: false })
    expect(store.getPrefs().browserNoSandbox).toBe(false)
    expect(container.querySelectorAll('iframe[sandbox]')).toHaveLength(2)
    expect(container.textContent).toContain('沙箱模式：已启用')
  })
})
