// @vitest-environment jsdom
/**
 * Start-page component and catalog: the chain component's cards, the More
 * card, hidden entries, the terminal shell menu, and the registry catalog.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { act } from 'react-dom/test-utils'
import { GuideGrid, NativeGuide } from '../src/client/native/guide.tsx'
import { createNativeGuideCatalog } from '../src/client/native/guide-catalog.ts'
import { registerNativeSurface } from '../src/client/native/index.ts'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import type { NativeGuideEntry } from '../src/client/native/guide-catalog.ts'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

/** One synthetic card. */
function entry(key: string, kind = key): NativeGuideEntry {
  return {
    key,
    providerId: 'p',
    entryId: key,
    kind,
    title: () => key.toUpperCase(),
    description: () => key + ' description',
    icon: ({ size }: { size?: number }) => createElement('svg', { 'data-icon': 'entry-' + key, width: size, height: size }),
  }
}

/** The five cards most layout tests use. */
const entries = ['a', 'b', 'c', 'd', 'e'].map(key => entry(key))

/** Render one grid into HTML. */
function htmlOf(props: {
  entries?: readonly NativeGuideEntry[]
  prefs?: Partial<typeof SIDEBAR_PREFS_DEFAULTS>
  width?: number
  onOpen?: (entry: NativeGuideEntry, params?: Record<string, unknown>) => void
  shellMenu?: { launchShells: (signal: AbortSignal) => Promise<{ shells: { name: string; path: string }[]; selectedShell?: string }>; selectShell: (path: string) => void }
}): string {
  return renderToString(createElement(GuideGrid, {
    entries: props.entries ?? entries,
    prefs: { ...SIDEBAR_PREFS_DEFAULTS, ...props.prefs },
    width: props.width ?? 600,
    onOpen: props.onOpen ?? (() => {}),
    ...(props.shellMenu === undefined ? {} : { shellMenu: props.shellMenu }),
  }))
}

describe('GuideGrid', () => {
  it('draws two columns and one data entry per card when the list fits', () => {
    const html = htmlOf({})
    expect(html).toContain('data-guide-columns="2"')
    expect(html).toContain('data-guide-rows="6"')
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      expect(html, key).toContain('data-sidebar-right-guide-entry="' + key + '"')
    }
    expect(html).not.toContain('data-guide-more')
    expect(html).toContain('a description')
  })

  it('switches to one column and turns the overflow into the More card', () => {
    const wide = htmlOf({ prefs: { guideRows: 1 }, width: 600 })
    expect(wide).toContain('data-guide-columns="2"')
    expect(wide).toContain('data-guide-rows="1"')
    expect(wide).toContain('data-sidebar-right-guide-entry="a"')
    expect(wide).not.toContain('data-sidebar-right-guide-entry="b"')
    expect(wide).toContain('data-guide-more="true"')

    const narrow = htmlOf({ prefs: { guideRows: 1 }, width: 400 })
    expect(narrow).toContain('data-guide-columns="1"')
    expect(narrow).toContain('data-guide-rows="1"')
    // At capacity one the More card is the only cell.
    expect(narrow).not.toContain('data-sidebar-right-guide-entry="a"')
    expect(narrow).toContain('data-guide-more="true"')
  })

  it('publishes the stored vertical alignment (center by default)', () => {
    expect(htmlOf({})).toContain('data-guide-align="center"')
    expect(htmlOf({ prefs: { guideAlign: 'top' } })).toContain('data-guide-align="top"')
  })

  it('omits hidden cards and keeps the explicit order', () => {
    const html = htmlOf({
      prefs: { guideOrder: ['c', 'a'], guideHidden: { a: true } },
      width: 400,
    })
    expect(html).not.toContain('data-sidebar-right-guide-entry="a"')
    expect(html.indexOf('data-sidebar-right-guide-entry="c"'))
      .toBeLessThan(html.indexOf('data-sidebar-right-guide-entry="b"'))
  })

  it('opens a card through the supplied action and closes the guide tab', () => {
    const onOpen = vi.fn()
    const mounted = renderRoot(createElement(GuideGrid, {
      entries,
      prefs: { ...SIDEBAR_PREFS_DEFAULTS },
      width: 600,
      onOpen,
    }))
    const card = mounted.container.querySelector('[data-sidebar-right-guide-entry="a"] button')
    expect(card).not.toBeNull()
    act(() => { (card as HTMLButtonElement).click() })
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: 'a' }))
    mounted.unmount()
  })

  it('draws the More menu rows with an icon and a title', async () => {
    const mounted = renderRoot(createElement(GuideGrid, {
      entries,
      prefs: { ...SIDEBAR_PREFS_DEFAULTS, guideRows: 1 },
      width: 600,
      onOpen: () => {},
    }))
    const trigger = mounted.container.querySelector('[data-guide-more]')
    expect(trigger).not.toBeNull()
    await act(async () => {
      ;(trigger as HTMLButtonElement).click()
      await Promise.resolve()
    })
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    const overflow = items.find(node => node.textContent?.includes('B'))
    expect(overflow).toBeDefined()
    expect(overflow?.querySelector('svg[data-icon]')).not.toBeNull()
    mounted.unmount()
  })

  it('also exposes the shared row-count control inside the reorder dialog', async () => {
    const mounted = renderRoot(createElement(GuideGrid, {
      entries,
      prefs: { ...SIDEBAR_PREFS_DEFAULTS, guideRows: 1 },
      width: 600,
      onOpen: () => {},
    }))
    const trigger = mounted.container.querySelector('[data-guide-more]')
    await act(async () => {
      ;(trigger as HTMLButtonElement).click()
      await Promise.resolve()
    })
    const reorder = [...document.querySelectorAll('[role="menuitem"]')]
      .find(node => node.textContent?.includes('Reorder'))
    expect(reorder).toBeDefined()
    await act(async () => {
      ;(reorder as HTMLElement).click()
      await Promise.resolve()
    })
    const input = document.querySelector('input[aria-label="Maximum rows"]')
    expect(input).not.toBeNull()
    expect((input as HTMLInputElement).value).toBe('1')
    mounted.unmount()
  })

  it('draws the terminal shell trigger only when the host offers both shell faces', () => {
    const terminal = entry('terminal')
    const without = htmlOf({ entries: [terminal] })
    expect(without).not.toContain('aria-haspopup="menu"')
    const shells = {
      launchShells: async () => ({ shells: [{ name: 'zsh', path: '/bin/zsh' }], selectedShell: '/bin/zsh' }),
      selectShell: () => {},
    }
    const withMenu = htmlOf({ entries: [terminal], shellMenu: shells })
    expect(withMenu).toContain('aria-haspopup="menu"')
  })

  it('lists host shells and opens the chosen shell', async () => {
    const terminal = entry('terminal')
    const selectShell = vi.fn()
    const launchShells = vi.fn(async () => ({
      shells: [{ name: 'zsh', path: '/bin/zsh' }, { name: 'bash', path: '/bin/bash' }],
      selectedShell: '/bin/zsh',
    }))
    const onOpen = vi.fn()
    const mounted = renderRoot(createElement(GuideGrid, {
      entries: [terminal],
      prefs: { ...SIDEBAR_PREFS_DEFAULTS },
      width: 600,
      onOpen,
      shellMenu: { launchShells, selectShell },
    }))
    const trigger = mounted.container.querySelector('[data-sidebar-right-guide-entry="terminal"] button[aria-haspopup="menu"]')
    expect(trigger).not.toBeNull()
    await act(async () => {
      ;(trigger as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(launchShells).toHaveBeenCalled()
    const bash = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent?.includes('bash'))
    expect(bash).toBeDefined()
    act(() => { (bash as HTMLElement).click() })
    expect(selectShell).toHaveBeenCalledWith('/bin/bash')
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: 'terminal' }), { shellPath: '/bin/bash' })
    mounted.unmount()
  })
})

describe('NativeGuide', () => {
  it('renders from a real store and catalog without losing their method receivers', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    const catalog = { getSnapshot: () => entries, subscribe: () => () => {} }
    const openTab = vi.fn()
    const close = vi.fn()
    const mounted = renderRoot(createElement(NativeGuide, {
      catalog,
      store,
      useTabInfo: () => ({ tab: { actions: { openTab, close } } }),
    }))
    const card = mounted.container.querySelector('[data-sidebar-right-guide-entry="a"] button')
    expect(card).not.toBeNull()
    act(() => { (card as HTMLButtonElement).click() })
    expect(openTab).toHaveBeenCalledWith('a', { replaceTab: true })
    expect(close).toHaveBeenCalled()
    mounted.unmount()
  })
})

describe('registerNativeSurface start-page takeover', () => {
  it('registers one chain guide and releases it with the seat', () => {
    const store = createSidebarStore()
    store.setSession('s1')
    const service = createBetterSidebarService(store)
    service.registerTab({ id: 'git', title: 'Changes', component: () => null })
    const records = createNativeTabRecords()
    const catalog = { getSnapshot: () => [], subscribe: () => () => {} }
    const slotRegistrations: Array<{ name: string; options: Record<string, unknown> }> = []
    const released: string[] = []
    const registry = {
      register: (definition: { id: string; kind: string }) => () => { released.push(definition.id) },
    }
    const ctx = {
      inject: (_deps: readonly string[], callback: (injected: { get: (name: string) => unknown }) => unknown) => {
        const cleanup = callback({ get: () => registry })
        return { dispose: () => { if (typeof cleanup === 'function') cleanup() } }
      },
      get: () => undefined,
      slots: {
        inject: (_key: string, callback: () => () => void) => callback(),
        register: (options: Record<string, unknown>) => {
          slotRegistrations.push({ name: String(options.name), options })
          return () => { released.push('slot:' + String(options.name)) }
        },
      },
    }
    const dispose = registerNativeSurface({
      ctx: ctx as never,
      store,
      service,
      records,
      guideCatalog: catalog,
    })
    const guide = slotRegistrations.filter(item => item.name === 'sidebar.right.tab.guide')
    expect(guide).toHaveLength(1)
    const select = guide[0]?.options.select as (() => unknown) | undefined
    expect(select?.()).toEqual({})
    const inject = guide[0]?.options.inject as ((sessionId: string) => Record<string, unknown>) | undefined
    const face = inject?.('s1')
    expect(face?.catalog).toBe(catalog)
    expect(face?.store).toBe(store)
    expect(face?.shellMenu).toBeUndefined()
    // The preference disarms the takeover and restores it without touching the
    // tab types.
    store.setPrefs({ ...store.getPrefs(), guideTakeover: false })
    expect(released).toContain('slot:sidebar.right.tab.guide')
    expect(slotRegistrations.filter(item => item.name === 'sidebar.right.tab.guide')).toHaveLength(1)
    store.setPrefs({ ...store.getPrefs(), guideTakeover: true })
    expect(slotRegistrations.filter(item => item.name === 'sidebar.right.tab.guide')).toHaveLength(2)
    dispose()
    expect(released).toContain('slot:sidebar.right.tab.guide')
  })
})

describe('createNativeGuideCatalog', () => {
  it('maps guide cards to stable keys and the owning descriptor', () => {
    const registry = {
      guide: () => [
        { id: 'files', kind: 'files', providerId: 'dsh-better-sidebar:files', title: () => 'Files' },
        { id: 'git', kind: 'git', providerId: 'dsh-better-sidebar:git', title: () => 'Git', description: () => 'Changes' },
        { id: 'new', kind: 'terminal', providerId: 'dsh-client-ui-sidebar-terminal', title: () => 'Terminal' },
      ],
      subscribe: () => () => {},
    }
    const ctx = {
      inject: (_deps: readonly string[], callback: (injected: { get: (name: string) => unknown }) => unknown) => {
        const cleanup = callback({ get: () => registry })
        return { dispose: () => { if (typeof cleanup === 'function') cleanup() } }
      },
    }
    const created = createNativeGuideCatalog(ctx as never)
    const snapshot = created.catalog.getSnapshot()
    expect(snapshot.map(item => item.key)).toEqual([
      'dsh-better-sidebar:files::files',
      'dsh-better-sidebar:git::git',
      'dsh-client-ui-sidebar-terminal::new',
    ])
    expect(snapshot[0]?.descriptorId).toBe('editor')
    expect(snapshot[1]?.descriptorId).toBe('git')
    expect(snapshot[2]?.descriptorId).toBeUndefined()
    expect(snapshot[1]?.description?.()).toBe('Changes')
    created.dispose()
  })

  it('notifies subscribers when the registry changes', () => {
    let cards: Array<{ id: string; kind: string; providerId: string; title: () => string }> = []
    const listeners = new Set<() => void>()
    const registry = {
      guide: () => cards,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const ctx = {
      inject: (_deps: readonly string[], callback: (injected: { get: (name: string) => unknown }) => unknown) => {
        const cleanup = callback({ get: () => registry })
        return { dispose: () => { if (typeof cleanup === 'function') cleanup() } }
      },
    }
    const created = createNativeGuideCatalog(ctx as never)
    const listener = vi.fn()
    created.catalog.subscribe(listener)
    cards = [{ id: 'x', kind: 'x', providerId: 'p', title: () => 'X' }]
    for (const notify of listeners) notify()
    expect(listener).toHaveBeenCalled()
    expect(created.catalog.getSnapshot()).toHaveLength(1)
    created.dispose()
  })
})
