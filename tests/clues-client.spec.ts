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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { SidebarApiError } from '../src/client/api.ts'
import type {
  ClueFormatRenderer,
  ClueFormatRendererProps,
  ClueSourceDisplayDescriptor,
} from '../src/clues/types.ts'
import { SIDEBAR_PREFS_DEFAULTS, type SidebarPrefs } from '../src/prefs-shared.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A service backed by a fresh store (no DOM needed for the registry). */
function serviceWithPrefs(overrides: Partial<SidebarPrefs> = {}) {
  const store = createSidebarStore()
  const prefs: SidebarPrefs = { ...SIDEBAR_PREFS_DEFAULTS, ...overrides }
  store.setPrefs(prefs)
  const service = createBetterSidebarService(store)
  return { service, store }
}

describe('client clue display registry', () => {
  it('is published on the service and advertised as a feature', () => {
    const { service } = serviceWithPrefs()
    expect(service.clues).toBeDefined()
    expect(service.features).toContain('clues')
    expect(service.clues.getSourceDisplays()).toEqual([])
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
    expect(posted).toEqual([{ url: 'http://dsh.internal/sidebar/api/clues.sources', body: {}, signal: undefined }])
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
      signal: controller.signal,
    })
    posted.length = 0
    await service.clues.api.read('ws-1', {
      clueId: 'clue-1',
      offset: 1024,
      sessionId: 's1',
    })
    expect(posted[0]).toEqual({
      url: 'http://dsh.internal/sidebar/api/clues.read',
      body: { workspaceId: 'ws-1', clueId: 'clue-1', offset: 1024, sessionId: 's1' },
      signal: undefined,
    })
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
