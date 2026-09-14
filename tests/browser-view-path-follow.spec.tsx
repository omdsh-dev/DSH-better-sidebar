// @vitest-environment jsdom
/**
 * The browser tab must FOLLOW an externally rewritten `tab.path`.
 *
 * The native right Sidebar keeps ONE record per tab and updates its
 * `tab.path` on a navigation (a second link click / `sidebar_open` into the
 * same record — see native/tab-adapter `ensure`). The component is NOT
 * remounted by that update, so its `useState(tab.path)` seed alone left the
 * iframe on the previous page (or on the start page when the record was
 * minted without a path). This pins the follow effect.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import './browser-globals.ts'
import type { Context } from '../src/context-types.ts'
import { BrowserView } from '../src/client/BrowserView.tsx'
import { createSidebarStore } from '../src/client/state.ts'

// The probe effect fetches the target's headers through the host route; the
// specs have no server, so keep it a quiet rejection.
vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))

const CTX = {} as Context

function tabProps(store: ReturnType<typeof createSidebarStore>, path: string | undefined) {
  return {
    ctx: CTX,
    store,
    scope: { sessionId: 's1', cwd: '/p' },
    tab: { id: 'browser:1', type: 'browser' as const, title: 'Browser', ...(path === undefined ? {} : { path }) },
    visible: true,
  }
}

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  act(() => { root?.unmount() })
  root = undefined
  host?.remove()
  host = undefined
})

describe('browser tab follows an external tab.path rewrite', () => {
  it('navigates the iframe when the persisted path changes under a mounted view', () => {
    const store = createSidebarStore()
    host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host!)
      root.render(createElement(BrowserView, tabProps(store, 'https://a.test/')))
    })
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://a.test/')

    // An external open rewrites the record's path; the same view re-renders.
    act(() => {
      root!.render(createElement(BrowserView, tabProps(store, 'https://b.test/x')))
    })
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://b.test/x')
  })

  it('moves off the start page when a path arrives late (the empty-tab symptom)', () => {
    const store = createSidebarStore()
    host = document.createElement('div')
    document.body.appendChild(host)
    act(() => {
      root = createRoot(host!)
      root.render(createElement(BrowserView, tabProps(store, undefined)))
    })
    expect(host.querySelector('iframe')).toBeNull()

    act(() => {
      root!.render(createElement(BrowserView, tabProps(store, 'https://a.test/')))
    })
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://a.test/')
  })
})
