// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://dsh.internal/"}
/**
 * Client clue face (S1): the display registry on `ctx.betterSidebar.clues`,
 * the source enable / @ preference semantics, and the node-free wire methods.
 *
 * The face is the ONLY client-side entry other plugins use: duplicate source
 * displays are rejected (registration order never silently wins), disposers
 * are identity-checked, and prefs answer "absent = ON" through the one shared
 * helper. The wire methods reuse the plugin's single `call` transport, so the
 * error code on a rejected envelope is the clue category.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { cachedClueRequest, invalidateClueRequests, notifyClueDataChange } from '../src/client/clues/request-cache.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { SidebarApiError } from '../src/client/api.ts'
import type {
  ClueFormatRenderer,
  ClueFormatRendererProps,
  ClueSourceDisplayDescriptor,
} from '../src/clues/types.ts'
import { SIDEBAR_PREFS_DEFAULTS, type SidebarPrefs } from '../src/prefs-shared.ts'
import { ClueBrowser } from '../src/client/clues/tab/browser.tsx'
import type { CluesClientApi } from '../src/client/clues/api.ts'
import type { BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import type { BetterSidebarWindowsClientFace } from '../src/client/windows/types.ts'
import type { ClueCandidate, ClueSourceDescriptor } from '../src/clues/types.ts'

setupReactAct()

const rendered: RenderedRoot[] = []
beforeEach(() => { invalidateClueRequests() })
afterEach(() => {
  for (const view of rendered.splice(0)) view.unmount()
  invalidateClueRequests()
  vi.unstubAllGlobals()
})

/** Flush effects, promise continuations and one macrotask. */
async function flushBrowser(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** A service backed by a fresh store (no DOM needed for the registry). */
function serviceWithPrefs(overrides: Partial<SidebarPrefs> = {}) {
  const store = createSidebarStore()
  const prefs: SidebarPrefs = { ...SIDEBAR_PREFS_DEFAULTS, ...overrides }
  store.setPrefs(prefs)
  const service = createBetterSidebarService(store)
  return { service, store }
}

describe('client clue display registry', () => {
  it('invalidates only source catalogue reads for display changes and no reads for formats', async () => {
    const { service } = serviceWithPrefs()
    const sources = vi.fn(async () => 'catalogue')
    const list = vi.fn(async () => 'resources')
    const readSources = () => cachedClueRequest('clues.sources', undefined, {}, sources)
    const readList = () => cachedClueRequest('clues.list', 'workspace', {}, list)
    await readSources(); await readList()
    const disposeDisplay = service.clues.registerSourceDisplay({ sourceId: 'x.source' })
    await readSources(); await readList()
    expect(sources).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenCalledTimes(1)
    disposeDisplay()
    await readSources()
    expect(sources).toHaveBeenCalledTimes(3)
    const disposeFormat = service.clues.registerFormatRenderer('text/plain', () => null)
    await readSources(); await readList()
    disposeFormat()
    await readSources(); await readList()
    expect(sources).toHaveBeenCalledTimes(3)
    expect(list).toHaveBeenCalledTimes(1)
  })
  it('is published on the service and advertised as a feature', () => {
    const { service } = serviceWithPrefs()
    expect(service.clues).toBeDefined()
    expect(service.features).toContain('clues')
    expect(service.clues.getSourceDisplays()).toEqual([])
  })

  it('starts each client registry with an empty activation read cache', async () => {
    const load = vi.fn(async () => 'catalogue')
    const read = () => cachedClueRequest('clues.list', 'workspace', {}, load)
    await read()
    expect(load).toHaveBeenCalledTimes(1)
    // A new registry is a new activation scope, not just another display
    // registration: it drops reads retained by the previous activation.
    serviceWithPrefs()
    await read()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('registers displays, rejects duplicates and releases them on dispose', () => {
    const { service } = serviceWithPrefs()
    const display: ClueSourceDisplayDescriptor = { sourceId: 'builtin.files', name: 'Files' }
    const dispose = service.clues.registerSourceDisplay(display)
    expect(service.clues.getSourceDisplays()).toEqual([display])
    expect(() => service.clues.registerSourceDisplay({ sourceId: 'builtin.files' }))
      .toThrow(/already registered/)
    dispose()
    expect(service.clues.getSourceDisplays()).toEqual([])
    // A second dispose is a strict no-op, and re-registration is accepted.
    dispose()
    expect(service.clues.registerSourceDisplay(display)).toBeTypeOf('function')
  })

  it('publishes independent display copies', () => {
    const { service } = serviceWithPrefs()
    const display: ClueSourceDisplayDescriptor = { sourceId: 'x.source', name: 'Original' }
    service.clues.registerSourceDisplay(display)
    // Neither the registrant's object nor a returned row aliases the stored
    // descriptor: the registry is the authority for published metadata.
    ;(display as { name?: string }).name = 'Changed by registrant'
    const returned = service.clues.getSourceDisplays() as unknown as Array<{ name?: string }>
    returned[0]!.name = 'Changed by reader'
    expect(service.clues.getSourceDisplays()[0]?.name).toBe('Original')
  })

  it('rejects a display without a source id', () => {
    const { service } = serviceWithPrefs()
    expect(() => service.clues.registerSourceDisplay({ sourceId: '  ' })).toThrow(/sourceId/)
  })

  it('registers format renderers by format, rejects duplicates and disposes', () => {
    const { service } = serviceWithPrefs()
    const renderer: ClueFormatRenderer = props => props.document.format
    const dispose = service.clues.registerFormatRenderer('text/markdown', renderer)
    // Lookup by format, and the list form preserves registration order.
    expect(service.clues.getFormatRenderer('text/markdown')).toBe(renderer)
    expect([...service.clues.getFormatRenderers()]).toEqual([['text/markdown', renderer]])
    expect(service.clues.getFormatRenderer('text/plain')).toBeUndefined()

    // A second renderer for the same format is rejected: registration order
    // never silently wins.
    expect(() => service.clues.registerFormatRenderer('text/markdown', () => null))
      .toThrow(/already registered/)
    // Empty formats / non-functions cannot be registered.
    expect(() => service.clues.registerFormatRenderer('  ', renderer)).toThrow(/format/)
    expect(() => service.clues.registerFormatRenderer('text/plain', null as unknown as ClueFormatRenderer))
      .toThrow(/function/)

    // The disposer is identity-checked and releases exactly this format.
    dispose()
    expect(service.clues.getFormatRenderer('text/markdown')).toBeUndefined()
    expect(service.clues.getFormatRenderers().size).toBe(0)
    dispose()
    // Re-registration after disposal is accepted again.
    expect(service.clues.registerFormatRenderer('text/markdown', renderer)).toBeTypeOf('function')
  })

  it('hands the renderer its props and accepts a ReactNode result', () => {
    const { service } = serviceWithPrefs()
    const renderer: ClueFormatRenderer = props => {
      expect(props.sourceId).toBe('my.source')
      expect(props.typeId).toBe('my.source.page')
      expect(props.format).toBe('text/markdown')
      expect(props.readOnly).toBe(false)
      expect(props.saving).toBe(true)
      expect(props.document).toEqual({
        format: 'text/markdown',
        data: { text: '# hi' },
        baseRevision: 'r1',
      })
      props.onChange({ text: '# edited' })
      props.onSave?.()
      return props.document.format
    }
    service.clues.registerFormatRenderer('text/markdown', renderer)
    const onChange = vi.fn()
    const onSave = vi.fn()
    const props: ClueFormatRendererProps = {
      sourceId: 'my.source',
      typeId: 'my.source.page',
      format: 'text/markdown',
      document: { format: 'text/markdown', data: { text: '# hi' }, baseRevision: 'r1' },
      readOnly: false,
      saving: true,
      onChange,
      onSave,
    }
    // The signature itself is the seam: whatever ReactNode the source format
    // returns is handed to S6 unchanged.
    const node = service.clues.getFormatRenderer('text/markdown')!(props)
    expect(node).toBe('text/markdown')
    expect(onChange).toHaveBeenCalledWith({ text: '# edited' })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers on format-renderer register/dispose', () => {
    const { service } = serviceWithPrefs()
    let calls = 0
    const unsubscribe = service.clues.subscribe(() => { calls += 1 })
    const dispose = service.clues.registerFormatRenderer('text/plain', () => null)
    expect(calls).toBe(1)
    dispose()
    expect(calls).toBe(2)
    unsubscribe()
  })

  it('notifies subscribers on register/dispose and stops after unsubscribe', () => {
    const { service } = serviceWithPrefs()
    let calls = 0
    const unsubscribe = service.clues.subscribe(() => { calls += 1 })
    const dispose = service.clues.registerSourceDisplay({ sourceId: 'x.source' })
    expect(calls).toBe(1)
    dispose()
    expect(calls).toBe(2)
    unsubscribe()
    service.clues.registerSourceDisplay({ sourceId: 'y.source' })
    expect(calls).toBe(2)
  })
})

describe('client clue preference semantics', () => {
  it('treats an absent source entry as enabled (the default)', () => {
    const { service } = serviceWithPrefs()
    expect(service.clues.isSourceEnabled('never.toggled')).toBe(true)
    expect(service.clues.isSourceMentionEnabled('never.toggled')).toBe(true)
    expect(service.clues.isPacksMentionEnabled()).toBe(true)
  })

  it('honors explicit switches, and a disabled source never mentions', () => {
    const { service } = serviceWithPrefs({
      clueSourcesEnabled: { off: false, on: true },
      clueSourcesMentionEnabled: { off: true, on: false },
      cluePacksMentionEnabled: false,
    })
    expect(service.clues.isSourceEnabled('off')).toBe(false)
    expect(service.clues.isSourceEnabled('on')).toBe(true)
    // The source switch is authoritative: its stored @ value is preserved but
    // cannot resurrect candidates while the source is off.
    expect(service.clues.isSourceMentionEnabled('off')).toBe(false)
    expect(service.clues.isSourceMentionEnabled('on')).toBe(false)
    expect(service.clues.isPacksMentionEnabled()).toBe(false)
  })
})

interface Posted {
  url: string
  body: Record<string, unknown>
  signal?: AbortSignal
}

/** Stub fetch: record POSTs, answer one envelope (`value` or an error). */
function stubFetch(answer: { value?: unknown; status?: number; code?: string; message?: string }): Posted[] {
  const posted: Posted[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    posted.push({
      url,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    })
    const status = answer.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (status >= 200 && status < 300
        ? { ok: true, value: answer.value }
        : { ok: false, error: { code: answer.code ?? 'failed', message: answer.message ?? 'failed' } }),
    } as unknown as Response
  }))
  return posted
}

describe('client clue wire methods', () => {
  it('posts the source catalogue with an empty payload', async () => {
    const { service } = serviceWithPrefs()
    const posted = stubFetch({ value: { sources: [{ sourceId: 'builtin.files' }], types: [] } })
    const result = await service.clues.api.sources()
    expect(result.sources).toHaveLength(1)
    expect(posted).toEqual([{ url: 'http://dsh.internal/sidebar/api/clues.sources', body: {}, signal: expect.any(AbortSignal) }])
  })

  it('passes workspaceId, resource selectors, pagination and the abort signal through', async () => {
    const { service } = serviceWithPrefs()
    const posted = stubFetch({ value: { items: [] } })
    const controller = new AbortController()
    await service.clues.api.list('ws-1', {
      sourceId: 'builtin.files',
      scope: 'docs',
      cursor: 'c2',
      limit: 2,
    }, controller.signal)
    expect(posted[0]).toEqual({
      url: 'http://dsh.internal/sidebar/api/clues.list',
      body: { workspaceId: 'ws-1', sourceId: 'builtin.files', scope: 'docs', cursor: 'c2', limit: 2 },
      signal: expect.any(AbortSignal),
    })
    expect(posted[0]!.signal).not.toBe(controller.signal)
    expect(posted[0]!.signal?.aborted).toBe(false)
    posted.length = 0
    await service.clues.api.read('ws-1', {
      clueId: 'clue-1',
      offset: 1024,
      sessionId: 's1',
    })
    expect(posted[0]).toEqual({
      url: 'http://dsh.internal/sidebar/api/clues.read',
      body: { workspaceId: 'ws-1', clueId: 'clue-1', offset: 1024, sessionId: 's1' },
      signal: expect.any(AbortSignal),
    })
    // The shared read cache owns the wire signal; the caller's own default
    // signal is not required.
    expect(posted[0]!.signal?.aborted).toBe(false)
  })

  it('readFresh bypasses the shared cache and refreshes the retained answer', async () => {
    const { service } = serviceWithPrefs()
    const posted = stubFetch({ value: { format: 'text/plain', data: { text: 'A' }, fetchedAt: 't1' } })
    expect(service.clues.api.readFresh).toBeTypeOf('function')
    await service.clues.api.read('ws-1', { clueId: 'clue-1' })
    await service.clues.api.readFresh!('ws-1', { clueId: 'clue-1' })
    // The fresh answer replaced the cached one: an ordinary read now observes
    // it without a third wire request.
    await service.clues.api.read('ws-1', { clueId: 'clue-1' })
    expect(posted).toHaveLength(2)
    expect(posted.every(item => item.url === 'http://dsh.internal/sidebar/api/clues.read')).toBe(true)
  })

  it('posts pack mutations with an explicit revision and no undefined keys', async () => {
    const { service } = serviceWithPrefs()
    const posted = stubFetch({ value: { pack: {}, revision: 1 } })
    await service.clues.api.packsRename('ws-1', { packId: 'pack-1', name: 'New', expectedRevision: 3 })
    const body = posted[0]!.body
    expect(body).toEqual({ workspaceId: 'ws-1', packId: 'pack-1', name: 'New', expectedRevision: 3 })
    expect(Object.values(body).every(value => value !== undefined)).toBe(true)
  })

  it('surfaces a rejected envelope as the clue category on the wire', async () => {
    const { service } = serviceWithPrefs()
    stubFetch({ status: 409, code: 'conflict', message: 'changed on disk' })
    const failure: unknown = await service.clues.api.saveEdit('ws-1', {
      clueId: 'clue-1',
      document: { format: 'text/markdown', data: { text: '# x' }, baseRevision: 'r1' },
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(SidebarApiError)
    expect((failure as SidebarApiError).code).toBe('conflict')
    expect((failure as SidebarApiError).message).toBe('changed on disk')
  })
})

describe('browser background-refresh visibility', () => {
  it('clears a pending refresh indicator when hidden and issues no read on return', async () => {
    const page: ClueCandidate = {
      sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-visible',
      title: 'Cached note', locator: { path: 'cached.md' },
    }
    const source: ClueSourceDescriptor = {
      sourceId: 'builtin.files', name: 'Local files', order: 0, pluginId: 'test', types: [],
      transport: 'files',
      capabilities: { resolve: true, list: true, search: true, read: true, edit: false, portable: true },
    }
    let listCalls = 0
    let finishRefresh: ((value: { items: readonly ClueCandidate[] }) => void) | undefined
    const api = {
      sources: async () => ({ sources: [source], types: [] }),
      pinsList: async () => ({ pins: [], revision: 0 }),
      clues: async () => ({ clues: [], revision: 0 }),
      list: async () => {
        listCalls += 1
        if (listCalls === 1) return { items: [page] }
        return new Promise<{ items: readonly ClueCandidate[] }>(resolve => { finishRefresh = resolve })
      },
      search: async () => ({ items: [] }),
      resolve: async () => ({ candidates: [] }),
      defaultScope: async () => ({ reason: 'no-github-remote' as const }),
      read: async () => ({ format: 'text/plain', data: { text: '' }, fetchedAt: '' }),
      loadEdit: async () => ({ format: 'text/plain', data: { text: '' }, baseRevision: '' }),
      saveEdit: async () => ({ savedAt: '' }),
      ensure: async () => ({
        clue: {
          ...page, id: 'c-visible', sourceId: page.sourceId, typeId: page.typeId,
          workspaceId: 'ws-1', createdAt: '', updatedAt: '',
        },
        created: false,
      }),
      portable: async () => ({ portable: true }),
      pinsAdd: async () => ({ pins: [], revision: 0 }),
      pinsRemove: async () => ({ pins: [], revision: 0 }),
    } as unknown as CluesClientApi
    const face: BetterSidebarCluesClientFace = {
      api,
      registerSourceDisplay: () => () => {},
      getSourceDisplays: () => [],
      registerFormatRenderer: () => () => {},
      getFormatRenderer: () => undefined,
      getFormatRenderers: () => new Map(),
      subscribe: () => () => {},
      isSourceEnabled: () => true,
      isSourceMentionEnabled: () => true,
      isPacksMentionEnabled: () => true,
    }
    const windows: BetterSidebarWindowsClientFace = {
      open: () => { throw new Error('no window expected') },
    }
    const props = {
      workspaceId: 'ws-1', face, windows, scopes: {},
      onScopeChange: () => undefined,
      onOpenDetail: () => undefined,
      onInsertClue: () => true,
      onOpenSettings: () => undefined,
      onNotice: () => undefined,
    }
    const view = renderRoot(createElement(ClueBrowser, { ...props, visible: true }))
    rendered.push(view)
    await flushBrowser()
    expect(view.container.textContent).toContain('Cached note')
    expect(listCalls).toBe(1)

    const refresh = [...view.container.querySelectorAll('button')]
      .find(button => button.getAttribute('aria-label') === 'Refresh')!
    act(() => { refresh.click() })
    await flushBrowser()
    expect(view.container.querySelector('[data-clue-refresh-status="refreshing"]')).not.toBeNull()
    expect(view.container.textContent).toContain('Cached note')

    view.rerender(createElement(ClueBrowser, { ...props, visible: false }))
    await flushBrowser()
    // The pending refresh is aborted; its indicator cannot survive the hide.
    expect(view.container.querySelector('[data-clue-refresh-status]')).toBeNull()
    expect(listCalls).toBe(2)

    // The shared request completes while the tab is hidden, then the tab shows
    // again. The aborted completion is inert and must not leave a spinner or
    // trigger a third backend read.
    act(() => { finishRefresh?.({ items: [{ ...page, title: 'Server note' }] }) })
    await flushBrowser()
    view.rerender(createElement(ClueBrowser, { ...props, visible: true }))
    await flushBrowser()
    expect(view.container.querySelector('[data-clue-refresh-status="refreshing"]')).toBeNull()
    expect(view.container.textContent).toContain('Cached note')
    expect(listCalls).toBe(2)
  })
})

/** The minimal source/browser face used by the business-event DOM cases. */
function browserSource(): ClueSourceDescriptor {
  return {
    sourceId: 'builtin.files', name: 'Local files', order: 0, pluginId: 'test', types: [],
    transport: 'files',
    capabilities: { resolve: true, list: true, search: true, read: true, edit: false, portable: true },
  }
}

function browserFace(api: CluesClientApi): BetterSidebarCluesClientFace {
  return {
    api,
    registerSourceDisplay: () => () => {},
    getSourceDisplays: () => [],
    registerFormatRenderer: () => () => {},
    getFormatRenderer: () => undefined,
    getFormatRenderers: () => new Map(),
    subscribe: () => () => {},
    isSourceEnabled: () => true,
    isSourceMentionEnabled: () => true,
    isPacksMentionEnabled: () => true,
  }
}

const browserWindows: BetterSidebarWindowsClientFace = {
  open: () => { throw new Error('no window expected') },
}

function browserProps(face: BetterSidebarCluesClientFace) {
  return {
    workspaceId: 'ws-1', face, windows: browserWindows, scopes: {},
    onScopeChange: () => undefined,
    onOpenDetail: () => undefined,
    onInsertClue: () => true,
    onOpenSettings: () => undefined,
    onNotice: () => undefined,
  }
}

/** The shared floor of a browser API used by the event tests. */
function browserApi(overrides: Partial<CluesClientApi> = {}): CluesClientApi {
  return {
    sources: async () => ({ sources: [browserSource()], types: [] }),
    pinsList: async () => ({ pins: [], revision: 0 }),
    clues: async () => ({ clues: [], revision: 0 }),
    list: async () => ({ items: [] }),
    search: async () => ({ items: [] }),
    resolve: async () => ({ candidates: [] }),
    defaultScope: async () => ({ reason: 'no-github-remote' as const }),
    read: async () => ({ format: 'text/plain', data: { text: '' }, fetchedAt: '' }),
    loadEdit: async () => ({ format: 'text/plain', data: { text: '' }, baseRevision: '' }),
    saveEdit: async () => ({ savedAt: '' }),
    ensure: async () => ({ clue: { id: 'c1' } as never, created: false }),
    portable: async () => ({ portable: true }),
    pinsAdd: async () => ({ pins: [], revision: 0 }),
    pinsRemove: async () => ({ pins: [], revision: 0 }),
    ...overrides,
  } as CluesClientApi
}

describe('browser business-data events', () => {
  it('a library event refreshes local pins in place without an external page read', async () => {
    const page: ClueCandidate = {
      sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-pin',
      title: 'Pinned note', locator: { path: 'pin.md' },
    }
    let pins: { workspaceId: string; clueId: string; createdAt: string }[] = []
    let clues: { id: string; sourceId: string; typeId: string; locator: unknown; title: string; workspaceId: string; createdAt: string; updatedAt: string }[] = []
    let listCalls = 0
    const api = browserApi({
      list: async () => { listCalls += 1; return { items: [page] } },
      pinsList: async () => ({ pins, revision: 0 }),
      clues: async () => ({ clues: clues as never, revision: 0 }),
    })
    const view = renderRoot(createElement(ClueBrowser, { ...browserProps(browserFace(api)), visible: true }))
    rendered.push(view)
    await flushBrowser()
    expect(view.container.textContent).toContain('Pinned note')
    expect(view.container.querySelector('[data-clue-pins-region]')).toBeNull()
    expect(listCalls).toBe(1)

    pins = [{ workspaceId: 'ws-1', clueId: 'c-pin', createdAt: '' }]
    clues = [{
      id: 'c-pin', sourceId: 'builtin.files', typeId: 'builtin.files.markdown',
      locator: { path: 'pin.md' }, title: 'Pinned note', workspaceId: 'ws-1', createdAt: '', updatedAt: '',
    }]
    act(() => { notifyClueDataChange({ kind: 'library', workspaceId: 'ws-1' }) })
    await flushBrowser()
    expect(view.container.querySelector('[data-clue-pins-region]')?.textContent).toContain('Pinned note')
    // The library event must not re-read the external list/page.
    expect(listCalls).toBe(1)
  })

  it('an auth event drops the old page and source memo, then reads under the new identity', async () => {
    const oldPage: ClueCandidate = {
      sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-old',
      title: 'Old identity note', locator: { path: 'old.md' },
    }
    const newPage: ClueCandidate = {
      sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-new',
      title: 'New identity note', locator: { path: 'new.md' },
    }
    let listCalls = 0
    const api = browserApi({
      list: async () => {
        listCalls += 1
        return { items: [listCalls === 1 ? oldPage : newPage] }
      },
    })
    const view = renderRoot(createElement(ClueBrowser, { ...browserProps(browserFace(api)), visible: true }))
    rendered.push(view)
    await flushBrowser()
    expect(view.container.textContent).toContain('Old identity note')

    act(() => { notifyClueDataChange({ kind: 'auth' }) })
    await flushBrowser()
    expect(view.container.textContent).not.toContain('Old identity note')
    expect(view.container.textContent).toContain('New identity note')
    expect(listCalls).toBe(2)
  })
})
