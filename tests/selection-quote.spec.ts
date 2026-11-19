/**
 * The quote chip: registry lifecycle (the input-trigger source registers when
 * the host service shows up, and self-heals after a dispose), the insert path
 * (record + localStorage persistence, structured reference minted through the
 * #1052 composer facade), the codec (send-time serialization back to the
 * fenced block, header-line clipboard text), and the click-through (open back
 * at the selection's line span, session-scoped), and the store shared by
 * several pages of one origin.
 *
 * Everything under test lives in a module with cross-test state (the
 * registry, the record store), so every test pulls a FRESH module instance
 * through `freshModule()` — and takes every runtime symbol from that
 * instance (`vi.resetModules()` invalidates the top-level static imports).
 */
import './browser-globals.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import type { QuoteSelection, SidebarQuoteSource } from '../src/client/selection-quote.ts'
import { SELECTION_LIMIT } from '../src/client/selection-payload.ts'

type QuoteModule = typeof import('../src/client/selection-quote.ts')

const SELECTION: QuoteSelection = {
  path: '/w/src/a.ts',
  cwd: '/w',
  lines: { start: 2, end: 3 },
  text: 'const x = 1',
}

async function freshModule(): Promise<QuoteModule> {
  vi.resetModules()
  // resetModules gives every import a fresh locales instance; pin English on
  // THAT instance so the label assertions are independent of the runner locale.
  const { attachLocale: attach } = await import('../src/client/locales.ts')
  attach({ getSnapshot: () => ({ active: 'en' }) })
  return await import('../src/client/selection-quote.ts')
}

/** The host's input-trigger service face, as the plugin consumes it. */
interface FakeTriggers {
  captured: SidebarQuoteSource[]
  registerSource(src: SidebarQuoteSource): () => void
}

function fakeTriggers(): FakeTriggers {
  const captured: SidebarQuoteSource[] = []
  return {
    captured,
    registerSource: (src: SidebarQuoteSource): (() => void) => {
      // The REAL contract (`ctx.inputTriggers`): one source per (trigger,
      // name); a second registration THROWS. A permissive fake would hide the
      // borrowed-source lifecycle bug this file pins.
      if (captured.length > 0) {
        throw new Error('slash source "@betterSidebarQuote" is already registered')
      }
      captured.push(src)
      return () => {
        const at = captured.indexOf(src)
        if (at !== -1) captured.splice(at, 1)
      }
    },
  }
}

/**
 * A fake composer: the conversation service face `insertDraftReference` walks
 * (session scope, input facade, snapshot). The editor starts empty so the
 * insert lands at offset 0 with no leading space.
 */
function fakeComposer(landed = true) {
  const insertReference = vi.fn((_ref: unknown, _span: unknown) => landed)
  const input = {
    state: { getSnapshot: (): { draft: string; draftRev: number } => ({ draft: '', draftRev: 1 }) },
    insertReference,
  }
  return {
    insertReference,
    conversation: { input: { for: (): unknown => input } },
  }
}

/** A fake plugin ctx: `get` answers the services, the rest is undefined. */
function fakeCtx(opts: {
  triggers?: FakeTriggers | { registerSource(src: SidebarQuoteSource): () => void }
  composer?: ReturnType<typeof fakeComposer>
  sidebar?: { openFile: ReturnType<typeof vi.fn> }
  sessions?: boolean
} = {}): Context {
  const composer = opts.composer
  return {
    get: (name: string) => {
      if (name === 'inputTriggers') return opts.triggers
      if (name === 'conversation') return composer?.conversation
      return undefined
    },
    sessions: opts.sessions === false ? undefined : { scope: (): unknown => ({}) },
    betterSidebar: opts.sidebar,
  } as unknown as Context
}

/** A real-shaped in-memory Storage (the node-environment stub in
 *  browser-globals only answers getItem/setItem; the store tests need the
 *  full contract incl. removeItem and durable reads). */
function installMemoryStorage(): void {
  const backing = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => (backing.has(key) ? backing.get(key) as string : null),
      setItem: (key: string, value: string) => { backing.set(key, String(value)) },
      removeItem: (key: string) => { backing.delete(key) },
      clear: () => { backing.clear() },
      key: (index: number) => [...backing.keys()][index] ?? null,
      get length() { return backing.size },
    },
  })
}

/** The store JSON under the module's own key. */
function storedJson(mod: QuoteModule): unknown {
  return JSON.parse(localStorage.getItem(mod.QUOTE_STORE_KEY) ?? 'null')
}

/** The newest record the store holds (the persistence keeps n-ascending order). */
function storedRecord(mod: QuoteModule): ReturnType<QuoteModule['resolveQuote']> {
  const all = storedJson(mod) as { id: string }[] | null
  const id = all?.at(-1)?.id
  return id === undefined ? undefined : mod.resolveQuote(id)
}

beforeEach(() => {
  installMemoryStorage()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the record store (persistence is a prerequisite for a chip)', () => {
  it('skips the chip when the record cannot be written (the caller falls back)', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    // Private mode / quota: writes throw. There is no readable store at all.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: () => null,
        setItem: () => { throw new Error('QuotaExceededError') },
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      },
    })
    const composer = fakeComposer()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A chip whose record never landed would click into nothing and make the
    // codec throw on send, so the insert must report false and leave the
    // composer to the built-in fallback (identical payload, not clickable).
    expect(mod.insertQuoteRecord(fakeCtx({ composer }), 's1', SELECTION)).toBeUndefined()
    expect(composer.insertReference).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('persists the size-reduced payload, not the raw selection', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    // A large selection is exactly what used to blow the quota: the record
    // must carry the send payload (header only past the limit), never the raw
    // text (200 records of whole selections).
    const huge = { ...SELECTION, text: 'x'.repeat(200_000) }
    expect(mod.insertQuoteRecord(fakeCtx({ composer: fakeComposer() }), 's1', huge)).toBeDefined()
    const record = storedRecord(mod)
    expect(record?.text).toBe('src/a.ts:2-3')
    const raw = localStorage.getItem(mod.QUOTE_STORE_KEY) ?? ''
    expect(raw.length).toBeLessThan(1_000)
    expect(raw).not.toContain('xxxx')
  })

  it('stores the fenced block a normal selection sends, byte for byte', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    expect(mod.insertQuoteRecord(fakeCtx({ composer: fakeComposer() }), 's1', SELECTION)).toBeDefined()
    expect(storedRecord(mod)?.text).toBe('```src/a.ts:2-3\nconst x = 1\n```')
  })

  it('reuses the store synced by saveStore across a batch of inserts (one parse)', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    // Seed an existing record so the first read has a store to parse/merge.
    localStorage.setItem(mod.QUOTE_STORE_KEY, JSON.stringify([{
      id: 'seed-1', sessionId: 's1', n: 1, path: '/w/seed.ts',
      label: 'Quote seed.ts', clipboardText: 'seed.ts', text: 'seed',
    }]))
    const ctx = fakeCtx({ composer: fakeComposer() })
    const parse = vi.spyOn(JSON, 'parse')
    for (let i = 0; i < 6; i++) {
      expect(mod.insertQuoteRecord(ctx, 's1', { ...SELECTION, text: `t${i}` })).toBeDefined()
    }
    // Only the first insert parses the persisted store; every saveStore
    // records the exact value it wrote so the rest of the batch reuses memory.
    expect(parse).toHaveBeenCalledTimes(1)
    expect((storedJson(mod) as unknown[])).toHaveLength(7)
  })
})

describe('insertQuoteRecord without a registered source', () => {
  it('refuses and leaves the store untouched (the caller falls back)', async () => {
    const mod = await freshModule()
    expect(mod.insertQuoteRecord(fakeCtx({ composer: fakeComposer() }), 's1', SELECTION)).toBeUndefined()
    expect(storedJson(mod)).toBeNull()
  })
})

describe('registerQuoteSource', () => {
  it('registers once the host service is present and the disposer unregisters', async () => {
    const mod = await freshModule()
    const triggers = fakeTriggers()
    const dispose = mod.registerQuoteSource(fakeCtx({ triggers }))
    expect(triggers.captured).toHaveLength(1)
    expect(triggers.captured[0]?.name).toBe(mod.QUOTE_SOURCE)
    // The source never joins the @-menu: candidates stay empty.
    expect(await triggers.captured[0]?.candidates({ sessionId: 's1' }, {})).toEqual([])
    dispose()
    expect(triggers.captured).toHaveLength(0)
  })

  it('gives up after the retries when the service never shows up', async () => {
    vi.useFakeTimers()
    const mod = await freshModule()
    const dispose = mod.registerQuoteSource(fakeCtx()) // no inputTriggers
    // 20 retries × 500 ms; the source is still absent afterwards, so the
    // insert path keeps refusing (the fallback takes over).
    for (let i = 0; i < 25; i++) await vi.advanceTimersByTimeAsync(500)
    dispose()
    expect(mod.insertQuoteRecord(fakeCtx({ composer: fakeComposer() }), 's1', SELECTION)).toBeUndefined()
    expect(storedJson(mod)).toBeNull()
  })
})

describe('lifecycle self-heal (a disposed fiber must not kill the feature silently)', () => {
  it('re-registers at commit time after a dispose and still inserts the chip', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const mod = await freshModule()
    const triggers = fakeTriggers()
    const composer = fakeComposer()
    const ctx = fakeCtx({ triggers, composer, sidebar: { openFile: vi.fn() } })
    const dispose = mod.registerQuoteSource(ctx)
    dispose() // the fiber went away (session switch, socket reconnect, HMR, …)
    expect(triggers.captured).toHaveLength(0)
    // The very next commit self-heals: re-registers (loudly) and inserts.
    expect(mod.insertQuoteRecord(ctx, 's1', SELECTION)).toBeDefined()
    expect(triggers.captured).toHaveLength(1)
    const lines = infoSpy.mock.calls.map((calls) => calls.map(String).join(' '))
    expect(lines.some((line) => line.includes('unregistered'))).toBe(true)
    expect(lines.some((line) => line.includes('re-registering'))).toBe(true)
    expect(storedJson(mod)).toBeTruthy()
  })

  it('treats the other instance\'s source as ready instead of staying off forever', async () => {
    const mod = await freshModule()
    // The exact host wording (ui-input-trigger service.ts:58) — it contains
    // "already registered", not "duplicate"; the tolerance must match it.
    const dup = {
      registerSource: (_src: SidebarQuoteSource): (() => void) => {
        throw new Error('slash source "@betterSidebarQuote" is already registered')
      },
    }
    const ctx = fakeCtx({ triggers: dup, composer: fakeComposer() })
    mod.registerQuoteSource(ctx)
    // The gate passed → the insert path runs (and lands in the fake composer).
    expect(mod.insertQuoteRecord(ctx, 's1', SELECTION)).toBeDefined()
    expect(storedJson(mod)).toBeTruthy()
  })

  it('a second module instance (the editor chunk copy) reuses the registered source and shares the store', async () => {
    // The build ships this module in the core bundle AND the lazy editor
    // chunk: two independent module instances at runtime. The core copy
    // registers at apply; the editor copy — the one the commit actually
    // calls — starts cold. The host refuses its duplicate registration, so it
    // must commit through the BORROWED source and reach the same store.
    const core = await freshModule()
    const triggers = fakeTriggers()
    core.registerQuoteSource(fakeCtx({ triggers, sidebar: { openFile: vi.fn() } }))
    expect(triggers.captured).toHaveLength(1)

    const editor = await freshModule() // a cold second instance of the module
    expect(editor.insertQuoteRecord(fakeCtx({ triggers, composer: fakeComposer() }), 's1', SELECTION)).toBeDefined()
    expect(triggers.captured).toHaveLength(1) // no second source: the host refused it
    const record = storedRecord(editor)
    expect(record?.path).toBe('/w/src/a.ts')

    // The core copy resolves the editor-written record through the shared
    // localStorage (click routing / send serialization live there).
    expect(core.resolveQuote(record?.id as string)?.path).toBe('/w/src/a.ts')
  })

  it('takes the source over after the owning instance disposes (a chip must never go dead)', async () => {
    const core = await freshModule()
    const triggers = fakeTriggers()
    const ctx = fakeCtx({ triggers, composer: fakeComposer() })
    const disposeCore = core.registerQuoteSource(ctx)
    const editor = await freshModule()
    // The editor copy borrows the live source from the core bundle.
    expect(editor.insertQuoteRecord(ctx, 's1', SELECTION)).toBeDefined()
    expect(triggers.captured).toHaveLength(1)
    // The owner goes away (session switch / socket reconnect / HMR). Nothing
    // tells the borrowing instance, so its next commit must notice the empty
    // slot and register — otherwise clicks are silently ignored and the codec
    // blocks the send.
    disposeCore()
    expect(triggers.captured).toHaveLength(0)
    expect(editor.insertQuoteRecord(ctx, 's1', SELECTION)).toBeDefined()
    expect(triggers.captured).toHaveLength(1)
    expect(triggers.captured[0]?.name).toBe(editor.QUOTE_SOURCE)
  })
})

describe('several pages of one origin (one shared store, one memory per page)', () => {
  /** One browser tab: its own module instance and host, the same localStorage. */
  async function openPage() {
    const mod = await freshModule()
    const triggers = fakeTriggers()
    const composer = fakeComposer()
    const ctx = fakeCtx({ triggers, composer })
    /** Commit one selection and return the ref of the chip it minted. */
    const quote = (): string => {
      expect(mod.insertQuoteRecord(ctx, 's1', SELECTION)).toBeDefined()
      return (composer.insertReference.mock.calls.at(-1)?.[0] as { ref: string }).ref
    }
    return { mod, triggers, ctx, quote }
  }

  it('keeps the other page\'s records when a page rewrites the store (a chip must never go dead)', async () => {
    const pageA = await openPage()
    const pageB = await openPage()
    const refs = [pageA.quote(), pageB.quote(), pageA.quote(), pageB.quote()]

    const stored = storedJson(pageA.mod) as { id: string; n: number }[]
    expect(stored.map(record => record.id)).toEqual(refs)
    // The numbering keeps growing across pages instead of colliding.
    expect(stored.map(record => record.n)).toEqual([1, 2, 3, 4])

    // A reloaded page has nothing but the store: every chip must still send.
    const reloaded = await openPage()
    reloaded.mod.registerQuoteSource(reloaded.ctx)
    const codec = reloaded.triggers.captured[0]?.codec
    for (const ref of refs) {
      await expect(codec?.serialize(ref, new AbortController().signal)).resolves.toBe(
        '```src/a.ts:2-3\nconst x = 1\n```',
      )
    }
  })

  it('still caps the merged store FIFO', async () => {
    const pageA = await openPage()
    const pageB = await openPage()
    const oldest = pageA.quote()
    for (let i = 0; i < pageB.mod.QUOTE_STORE_CAP; i++) pageB.quote()
    const newest = pageA.quote()

    const ids = (storedJson(pageA.mod) as { id: string }[]).map(record => record.id)
    expect(ids).toHaveLength(pageA.mod.QUOTE_STORE_CAP)
    expect(ids).not.toContain(oldest)
    expect(ids.at(-1)).toBe(newest)
  })
})

describe('the registered source', () => {
  /** Register, commit one selection, and return the captured source + record. */
  async function withChip() {
    const mod = await freshModule()
    const triggers = fakeTriggers()
    const composer = fakeComposer()
    const sidebar = { openFile: vi.fn() }
    mod.registerQuoteSource(fakeCtx({ triggers, composer, sidebar }))
    const landed = mod.insertQuoteRecord(fakeCtx({ composer, sidebar }), 's1', SELECTION) !== undefined
    const record = storedRecord(mod)
    return { mod, source: triggers.captured[0] as NonNullable<typeof triggers.captured[0]>, sidebar, composed: composer, landed, record }
  }

  it('mints a source-owned, clickable chip at the draft end', async () => {
    const { composed, landed, record } = await withChip()
    expect(landed).toBe(true)
    expect(composed.insertReference).toHaveBeenCalledTimes(1)
    const [chip, span] = composed.insertReference.mock.calls[0] as [{ source: string; ref: string; label: string; appearance: string; clipboardText: string }, { start: number; end: number; draftRev: number }]
    // The chip belongs to THIS plugin's source (which answers its clicks) and
    // carries the short id, not the whole fenced payload.
    expect(chip.source).toBe('betterSidebarQuote')
    expect(chip.ref).toBe(record?.id)
    expect(chip.appearance).toBe('file')
    expect(chip.label).toBe('Quote a.ts L2-3')
    expect(chip.clipboardText).toBe('src/a.ts:2-3')
    // An empty draft: zero-width span at offset 0, no leading space.
    expect(span).toEqual({ start: 0, end: 0, draftRev: 1 })
  })

  it('drops the record when the chip cannot land (no orphan ids in the store)', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    expect(mod.insertQuoteRecord(fakeCtx({ composer: fakeComposer(false) }), 's1', SELECTION)).toBeUndefined()
    expect(storedJson(mod)).toBeNull()
  })

  it('refuses when the conversation service is unavailable', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    expect(mod.insertQuoteRecord(fakeCtx({ sessions: false }), 's1', SELECTION)).toBeUndefined()
    expect(storedJson(mod)).toBeNull()
  })

  it('serializes back to the same fenced block the #1052 insert produced', async () => {
    const { source, record } = await withChip()
    await expect(source.codec?.serialize(record?.id as string, new AbortController().signal)).resolves.toBe(
      '```src/a.ts:2-3\nconst x = 1\n```',
    )
  })

  it('rejects serialization for an unknown ref (blocking the submission, never downgrading silently)', async () => {
    const { source } = await withChip()
    await expect(source.codec?.serialize('q999-gone', new AbortController().signal)).rejects.toThrow(/no longer available/u)
  })

  it('copies the path:lines header', async () => {
    const { source, record } = await withChip()
    expect(source.codec?.clipboardText(record?.id as string)).toBe('src/a.ts:2-3')
  })

  it('leaves an already-plain clipboard text alone', async () => {
    const { source } = await withChip()
    // Unknown ids degrade to themselves (the host may re-render an old chip).
    expect(source.codec?.clipboardText('plain text')).toBe('plain text')
  })

  it('opens the file at the selection span on click, same session only', async () => {
    const { source, sidebar, record } = await withChip()
    expect(source.openReference?.({ sessionId: 's1' }, { ref: record?.id as string })).toBe(true)
    expect(sidebar.openFile).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/w' }, '/w/src/a.ts', undefined, { line: 2, lineEnd: 3 })
    sidebar.openFile.mockClear()
    // Another session's chip click is refused (its cwd may differ → the
    // wrong file would open).
    expect(source.openReference?.({ sessionId: 's2' }, { ref: record?.id as string })).toBe(false)
    expect(sidebar.openFile).not.toHaveBeenCalled()
  })

  it('opens a lineless quote without a range', async () => {
    const mod = await freshModule()
    const triggers = fakeTriggers()
    const sidebar = { openFile: vi.fn() }
    mod.registerQuoteSource(fakeCtx({ triggers, composer: fakeComposer(), sidebar }))
    mod.insertQuoteRecord(fakeCtx({ composer: fakeComposer(), sidebar }), 's1', { path: '/w/a.md', cwd: '/w', text: 'hi' })
    const record = storedRecord(mod)
    expect(triggers.captured[0]?.openReference?.({ sessionId: 's1' }, { ref: record?.id as string })).toBe(true)
    expect(sidebar.openFile).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/w' }, '/w/a.md', undefined, undefined)
  })

  it('refuses a click on an unknown chip and reports it unhandled', async () => {
    const { source, sidebar } = await withChip()
    expect(source.openReference?.({ sessionId: 's1' }, { ref: 'q404-gone' })).toBe(false)
    expect(sidebar.openFile).not.toHaveBeenCalled()
  })

  it('still resolves a legacy file record written before the plan kind existed', async () => {
    const mod = await freshModule()
    const triggers = fakeTriggers()
    const sidebar = { openFile: vi.fn() }
    mod.registerQuoteSource(fakeCtx({ triggers, composer: fakeComposer(), sidebar }))
    // Old records carry no `kind`: they are file quotes and must keep clicking
    // and serializing across the upgrade (a live draft may still hold them).
    localStorage.setItem(mod.QUOTE_STORE_KEY, JSON.stringify([{
      id: 'legacy-1', sessionId: 's1', n: 1, path: '/w/src/old.ts', cwd: '/w',
      lines: { start: 4, end: 4 }, label: 'Quote old.ts L4', clipboardText: 'src/old.ts:4',
      text: '```src/old.ts:4\nold\n```',
    }]))
    const source = triggers.captured[0]!
    expect(source.openReference?.({ sessionId: 's1' }, { ref: 'legacy-1' })).toBe(true)
    expect(sidebar.openFile).toHaveBeenCalledWith(
      { sessionId: 's1', cwd: '/w' }, '/w/src/old.ts', undefined, { line: 4, lineEnd: 4 },
    )
    expect(source.codec?.clipboardText('legacy-1')).toBe('src/old.ts:4')
    await expect(source.codec?.serialize('legacy-1', new AbortController().signal))
      .resolves.toBe('```src/old.ts:4\nold\n```')
  })

  it('names chips by file and lines — a deleted chip leaves no gap', async () => {
    const first = await withChip()
    expect(first.record?.label).toBe('Quote a.ts L2-3')
    // A fresh module instance (a reload): a NEW quote of the same file/lines
    // carries the SAME identity — there is no sequence number to fall out of
    // order when a chip is deleted from the draft. Ids stay unique.
    const second = await withChip()
    expect(second.record?.label).toBe('Quote a.ts L2-3')
    expect(second.record?.id).not.toBe(first.record?.id)
  })

  it('varies the label shape with the line span', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    const commit = (lines?: { start: number; end: number }): string => {
      mod.insertQuoteRecord(fakeCtx({ composer: fakeComposer() }), 's1', { ...SELECTION, lines })
      const all = JSON.parse(localStorage.getItem(mod.QUOTE_STORE_KEY) ?? '[]') as { label: string }[]
      return all.at(-1)?.label as string
    }
    expect(commit(undefined)).toBe('Quote a.ts') // no line info → no L part
    expect(commit({ start: 7, end: 7 })).toBe('Quote a.ts L7') // single line
    expect(commit({ start: 7, end: 9 })).toBe('Quote a.ts L7-9') // span
  })

  it('labels Windows-style paths by basename too', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    mod.insertQuoteRecord(
      fakeCtx({ composer: fakeComposer() }),
      's1',
      { ...SELECTION, path: 'C:\\Users\\x\\proj\\a.ts' },
    )
    const all = JSON.parse(localStorage.getItem(mod.QUOTE_STORE_KEY) ?? '[]') as { label: string }[]
    expect(all.at(-1)?.label).toBe('Quote a.ts L2-3')
  })

  it('caps the persisted store FIFO', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    for (let i = 0; i < mod.QUOTE_STORE_CAP + 10; i++) {
      mod.insertQuoteRecord(fakeCtx({ composer: fakeComposer() }), 's1', { ...SELECTION, text: `t${i}` })
    }
    const stored = storedJson(mod) as unknown[]
    expect(stored).toHaveLength(mod.QUOTE_STORE_CAP)
  })
})

describe("plan annotations (the plan page's chip)", () => {
  const PLAN: QuoteSelection = {
    kind: 'plan',
    planId: 'dsh-resource://plan/s1/call-1',
    planTitle: 'Ship it',
    note: 'Use a queue.',
    text: 'retry once',
  }

  it('persists a plan record without a path and mints a non-file chip', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    const composer = fakeComposer()
    const record = mod.insertQuoteRecord(fakeCtx({ composer }), 's1', PLAN)
    expect(record?.kind).toBe('plan')
    expect(record?.path).toBeUndefined()
    expect(record?.planId).toBe(PLAN.planId)
    expect(record?.text).toContain('Use a queue.')
    expect(record?.text).toContain('> retry once')
    // The chip carries the source-owned ref and NO file appearance (a file
    // chip would be handed to the file opener by the host).
    const inserted = composer.insertReference.mock.calls[0]?.[0] as { source: string; appearance?: string; label: string }
    expect(inserted.source).toBe(mod.QUOTE_SOURCE)
    expect(inserted.appearance).toBeUndefined()
    expect(inserted.label).toContain('Plan annotation')
    // The persisted record is the one the codec resolves in the other bundle.
    expect(storedRecord(mod)?.kind).toBe('plan')
  })

  it('serializes back to the annotation plus quoted plan text', async () => {
    const mod = await freshModule()
    const triggers = fakeTriggers()
    mod.registerQuoteSource(fakeCtx({ triggers }))
    const record = mod.insertQuoteRecord(fakeCtx({ composer: fakeComposer() }), 's1', PLAN)!
    const payload = await triggers.captured[0]!.codec!.serialize(record.id, new AbortController().signal)
    expect(payload).toContain('Use a queue.')
    expect(payload).toContain('> retry once')
    expect(payload).toBe(record.text)
  })

  it('projects only the short label into the draft and still copies the full payload', async () => {
    const mod = await freshModule()
    const triggers = fakeTriggers()
    const composer = fakeComposer()
    mod.registerQuoteSource(fakeCtx({ triggers, composer }))
    const record = mod.insertQuoteRecord(fakeCtx({ composer }), 's1', PLAN)!
    const inserted = composer.insertReference.mock.calls[0]?.[0] as { label: string; clipboardText: string }
    // The host concatenates chip clipboardText on every composer projection
    // and saves it with the draft; a plan chip carries its short label there.
    expect(inserted.clipboardText).toBe(inserted.label)
    // The chip's copy affordance still yields the full annotation payload,
    // and the record stores the payload only once.
    expect(triggers.captured[0]!.codec!.clipboardText(record.id)).toBe(record.text)
    expect(storedRecord(mod)?.clipboardText).toBeUndefined()
  })

  it('refuses the click-through instead of asking the file opener to open a plan address', async () => {
    const mod = await freshModule()
    const triggers = fakeTriggers()
    mod.registerQuoteSource(fakeCtx({ triggers }))
    const sidebar = { openFile: vi.fn() }
    const record = mod.insertQuoteRecord(fakeCtx({ composer: fakeComposer(), sidebar }), 's1', PLAN)!
    const opened = triggers.captured[0]!.openReference!({ sessionId: 's1' }, { ref: record.id })
    expect(opened).toBe(false)
    expect(sidebar.openFile).not.toHaveBeenCalled()
  })

  it('keeps file selections on the original fenced path payload', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    const composer = fakeComposer()
    expect(mod.insertQuoteRecord(fakeCtx({ composer }), 's1', SELECTION)?.text)
      .toBe('```src/a.ts:2-3\nconst x = 1\n```')
    const inserted = composer.insertReference.mock.calls[0]?.[0] as { appearance?: string }
    expect(inserted.appearance).toBe('file')
  })

  it('keeps an over-limit note whole in the bare envelope (never silently truncates)', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    const note = 'n'.repeat(SELECTION_LIMIT + 20)
    const record = mod.insertQuoteRecord(fakeCtx({ composer: fakeComposer() }), 's1', {
      ...PLAN, planTitle: undefined, note, text: 'some plan text',
    })!
    expect(record.text).toBe(`Plan annotation\n${note}`)
    expect(record.text).toContain(note)
    expect(record.text.length).toBeGreaterThan(SELECTION_LIMIT)
    // The quote — not the reader's note — is what the bare envelope drops.
    expect(record.text).not.toContain('some plan text')
  })

  it('shows a plan title with $ patterns verbatim in the chip label', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    for (const title of ['cost$&fee', 'a$`b', "a$'b", 'a$$b']) {
      const record = mod.insertQuoteRecord(fakeCtx({ composer: fakeComposer() }), 's1', { ...PLAN, planTitle: title })!
      expect(record.label).toBe(`Plan annotation · ${title}`)
    }
  })

  it('truncates an emoji plan title on code points (no lone surrogate in the label)', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    const title = '🙂'.repeat(30)
    const record = mod.insertQuoteRecord(fakeCtx({ composer: fakeComposer() }), 's1', { ...PLAN, planTitle: title })!
    expect(record.label).toBe(`Plan annotation · ${'🙂'.repeat(23)}…`)
    // Strip valid pairs; no surrogate code unit may remain on its own.
    const withoutPairs = record.label.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
    expect(withoutPairs).not.toMatch(/[\uD800-\uDFFF]/)
  })
})
