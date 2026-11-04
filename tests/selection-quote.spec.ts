/**
 * The quote chip: registry lifecycle (the input-trigger source registers when
 * the host service shows up, and self-heals after a dispose), the insert path
 * (record + localStorage persistence, structured reference minted through the
 * #1052 composer facade), the codec (send-time serialization back to the
 * fenced block, header-line clipboard text), and the click-through (open back
 * at the selection's line span, session-scoped).
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

type QuoteModule = typeof import('../src/client/selection-quote.ts')

const SELECTION: QuoteSelection = {
  path: '/w/src/a.ts',
  cwd: '/w',
  lines: { start: 2, end: 3 },
  text: 'const x = 1',
}

async function freshModule(): Promise<QuoteModule> {
  vi.resetModules()
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

describe('quoteFallbackInsert', () => {
  it('is byte-identical to the #1052 direct insert (fenced block)', async () => {
    const { quoteFallbackInsert } = await freshModule()
    expect(quoteFallbackInsert(SELECTION)).toBe('```src/a.ts:2-3\nconst x = 1\n```')
  })

  it('falls back to the header-only line past the limit, like the legacy insert', async () => {
    const { quoteFallbackInsert } = await freshModule()
    const big = { ...SELECTION, text: 'x'.repeat(501) }
    expect(quoteFallbackInsert(big)).toBe('src/a.ts:2-3')
  })

  it('omits the line suffix when the selection has no line numbers', async () => {
    const { quoteFallbackInsert } = await freshModule()
    expect(quoteFallbackInsert({ path: '/w/a.md', cwd: '/w', text: 'hi' })).toBe('```a.md\nhi\n```')
  })
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
    expect(mod.insertQuoteChip(fakeCtx({ composer }), 's1', SELECTION)).toBe(false)
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
    expect(mod.insertQuoteChip(fakeCtx({ composer: fakeComposer() }), 's1', huge)).toBe(true)
    const record = storedRecord(mod)
    expect(record?.text).toBe('src/a.ts:2-3')
    const raw = localStorage.getItem(mod.QUOTE_STORE_KEY) ?? ''
    expect(raw.length).toBeLessThan(1_000)
    expect(raw).not.toContain('xxxx')
  })

  it('stores the fenced block a normal selection sends, byte for byte', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    expect(mod.insertQuoteChip(fakeCtx({ composer: fakeComposer() }), 's1', SELECTION)).toBe(true)
    expect(storedRecord(mod)?.text).toBe('```src/a.ts:2-3\nconst x = 1\n```')
  })
})

describe('insertQuoteChip without a registered source', () => {
  it('refuses and leaves the store untouched (the caller falls back)', async () => {
    const mod = await freshModule()
    expect(mod.insertQuoteChip(fakeCtx({ composer: fakeComposer() }), 's1', SELECTION)).toBe(false)
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
    expect(mod.insertQuoteChip(fakeCtx({ composer: fakeComposer() }), 's1', SELECTION)).toBe(false)
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
    expect(mod.insertQuoteChip(ctx, 's1', SELECTION)).toBe(true)
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
    expect(mod.insertQuoteChip(ctx, 's1', SELECTION)).toBe(true)
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
    expect(editor.insertQuoteChip(fakeCtx({ triggers, composer: fakeComposer() }), 's1', SELECTION)).toBe(true)
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
    expect(editor.insertQuoteChip(ctx, 's1', SELECTION)).toBe(true)
    expect(triggers.captured).toHaveLength(1)
    // The owner goes away (session switch / socket reconnect / HMR). Nothing
    // tells the borrowing instance, so its next commit must notice the empty
    // slot and register — otherwise clicks are silently ignored and the codec
    // blocks the send.
    disposeCore()
    expect(triggers.captured).toHaveLength(0)
    expect(editor.insertQuoteChip(ctx, 's1', SELECTION)).toBe(true)
    expect(triggers.captured).toHaveLength(1)
    expect(triggers.captured[0]?.name).toBe(editor.QUOTE_SOURCE)
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
    const landed = mod.insertQuoteChip(fakeCtx({ composer, sidebar }), 's1', SELECTION)
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
    expect(mod.insertQuoteChip(fakeCtx({ composer: fakeComposer(false) }), 's1', SELECTION)).toBe(false)
    expect(storedJson(mod)).toBeNull()
  })

  it('refuses when the conversation service is unavailable', async () => {
    const mod = await freshModule()
    mod.registerQuoteSource(fakeCtx({ triggers: fakeTriggers() }))
    expect(mod.insertQuoteChip(fakeCtx({ sessions: false }), 's1', SELECTION)).toBe(false)
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
    mod.insertQuoteChip(fakeCtx({ composer: fakeComposer(), sidebar }), 's1', { path: '/w/a.md', cwd: '/w', text: 'hi' })
    const record = storedRecord(mod)
    expect(triggers.captured[0]?.openReference?.({ sessionId: 's1' }, { ref: record?.id as string })).toBe(true)
    expect(sidebar.openFile).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/w' }, '/w/a.md', undefined, undefined)
  })

  it('refuses a click on an unknown chip and reports it unhandled', async () => {
    const { source, sidebar } = await withChip()
    expect(source.openReference?.({ sessionId: 's1' }, { ref: 'q404-gone' })).toBe(false)
    expect(sidebar.openFile).not.toHaveBeenCalled()
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
      mod.insertQuoteChip(fakeCtx({ composer: fakeComposer() }), 's1', { ...SELECTION, lines })
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
    mod.insertQuoteChip(
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
      mod.insertQuoteChip(fakeCtx({ composer: fakeComposer() }), 's1', { ...SELECTION, text: `t${i}` })
    }
    const stored = storedJson(mod) as unknown[]
    expect(stored).toHaveLength(mod.QUOTE_STORE_CAP)
  })
})
