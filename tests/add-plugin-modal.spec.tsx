/**
 * "Add plugin" modal tests: the body component (PluginListBody) renders the
 * GitHub topic BUTTON + the recommended plugin catalog of the matching kind
 * with per-entry jump/copy buttons. The copy button COPIES the install
 * script to the clipboard (writeClipboard) with a transient "Copied"
 * feedback — nothing is opened, nothing is closed, nothing can fail
 * outward.
 *
 * The body is tested directly — the Modal primitive runs hooks
 * unconditionally, so an open Modal must never be renderToString'd (same
 * rule as the settingsFor popup). The click paths are exercised with
 * createRoot + act().
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { PLUGIN_TOPIC_URL, type PluginEntry } from '../src/client/plugins-shared.ts'
import { builtinTabPlugins } from '../src/client/plugins-tabs.ts'
import { builtinViewerPlugins } from '../src/client/plugins-viewers.ts'
import { AddPluginModal, PluginListBody } from '../src/client/add-plugin-modal.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const officeEntry = builtinViewerPlugins[0] as PluginEntry

describe('PluginListBody (render)', () => {
  it('viewer kind renders the topic button and the office catalog entry', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const html = renderToString(createElement(PluginListBody, { service, kind: 'viewer' }))
    // The topic is a BUTTON (window.open in a new tab), not an anchor.
    expect(html).toContain('Browse more plugins on GitHub')
    // The name is a BUTTON on the same window.open path (an anchor would be
    // caught by the sidebar link takeover) — no href anywhere in the body.
    expect(html).not.toContain('href=')
    // The seeded catalog entry: name, description, install script,
    // a jump button (opens the repo in a NEW browser tab) and a copy button.
    expect(html).toContain(officeEntry.name)
    expect(html).toContain(officeEntry.install.replaceAll('&', '&amp;'))
    expect(html).toContain('Open')
    expect(html).toContain('Copy')
  })

  it('tab kind renders the sentinel entry (its own catalog, no office entry)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const html = renderToString(createElement(PluginListBody, { service, kind: 'tab' }))
    expect(html).toContain('dsh-sentinel 唤醒系统')
    expect(html).toContain('github:fuhefei/dsh-sentinel')
    expect(html).not.toContain(officeEntry.name)
  })
})

describe('AddPluginModal wiring', () => {
  it('mounts the body through the Modal for each kind (client render)', () => {
    // The Modal primitive renders a portal into document.body — the server
    // renderer refuses portals, so mount it client-side (createRoot + act
    // in jsdom) and assert on the portaled body HTML.
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    for (const kind of ['tab', 'viewer'] as const) {
      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)
      act(() => {
        root.render(createElement(AddPluginModal, { service, onClose: () => {}, kind }))
      })
      const html = document.body.innerHTML
      if (kind === 'viewer') {
        expect(html).toContain(officeEntry.name)
      } else {
        expect(html).toContain('dsh-sentinel 唤醒系统')
      }
      act(() => { root.unmount() })
      container.remove()
      document.body.innerHTML = ''
    }
  })
})

/** Mount PluginListBody and click its copy button (the first one). */
function mountBody(service: ReturnType<typeof createBetterSidebarService>, kind: 'tab' | 'viewer' = 'viewer'):
  { clickCopy: () => void; buttonLabel: () => string | null; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(PluginListBody, { service, kind }))
  })
  return {
    clickCopy: async () => {
      const button = container.querySelector('button[aria-label^="Copy install command:"]')!
      await act(async () => { (button as HTMLButtonElement).click() })
    },
    buttonLabel: () => {
      const button = container.querySelector('button[aria-label^="Copy install command:"]')
      return button?.textContent ?? null
    },
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

describe('PluginListBody copy click (interactive)', () => {
  it('clicking Copy writes the install script to the clipboard and flashes "Copied"', async () => {
    vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(true)
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)

    const body = mountBody(service)
    expect(body.buttonLabel()).toBe('Copy')
    await body.clickCopy()

    expect(primitives.writeClipboard).toHaveBeenCalledWith(officeEntry.install)
    expect(body.buttonLabel()).toBe('Copied')
    body.unmount()
    vi.restoreAllMocks()
  })

  it('copying does NOT close anything and the modal body stays mounted', async () => {
    vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(true)
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)

    const body = mountBody(service)
    await body.clickCopy()

    // The entry is still rendered (nothing closed, no navigation, no open).
    expect(body.buttonLabel()).toBe('Copied')
    expect(service.getSnapshot().state).toBeUndefined()
    body.unmount()
    vi.restoreAllMocks()
  })

  it('a DENIED clipboard write shows no "Copied" feedback (never claims a copy that did not happen)', async () => {
    vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(false)
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)

    const body = mountBody(service)
    await body.clickCopy()

    expect(primitives.writeClipboard).toHaveBeenCalledWith(officeEntry.install)
    expect(body.buttonLabel()).toBe('Copy')
    body.unmount()
    vi.restoreAllMocks()
  })

  it('the name and jump buttons open each catalog entry in a NEW browser tab (window.open, not a link)', () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    const opened: Array<[string, string, string]> = []
    const original = window.open
    window.open = ((url: string, target: string, features: string) => {
      opened.push([url, target, features])
      return null
    }) as typeof window.open
    try {
      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)
      act(() => {
        root.render(createElement(PluginListBody, { service, kind: 'viewer' }))
      })
      // Two window.open buttons per catalog entry — the name button and the
      // jump button. The expected count is catalog-driven so adding or
      // removing recommended plugins keeps the test honest instead of
      // pinning a hardcoded total.
      const jumpButtons = [...container.querySelectorAll('button[aria-label^="Open:"]')]
      expect(jumpButtons).toHaveLength(builtinViewerPlugins.length * 2)
      for (const button of jumpButtons) {
        act(() => { (button as HTMLButtonElement).click() })
      }
      expect(opened).toEqual(
        builtinViewerPlugins.flatMap((entry) => [
          [entry.url, '_blank', 'noopener'],
          [entry.url, '_blank', 'noopener'],
        ]),
      )
      act(() => { root.unmount() })
      container.remove()
    } finally {
      window.open = original
    }
  })
})
