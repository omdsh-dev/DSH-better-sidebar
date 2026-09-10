// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CENTER_COLUMN_REVALIDATE_MS,
  resolveCenterColumn,
} from '../src/client/center-column.ts'

interface Fixture {
  doc: Document
  col: HTMLDivElement
  slot: HTMLDivElement
}

function connectedColumn(doc = document.implementation.createHTMLDocument()): Fixture {
  const col = doc.createElement('div')
  const slot = doc.createElement('div')
  slot.dataset.slot = 'conversation'
  col.append(slot)
  doc.body.append(col)
  return { doc, col, slot }
}

// alpha.2 fixture: a real #root in the jsdom global document, because the
// contents-skip walk needs a live defaultView.getComputedStyle (inline
// `display: contents` on the wrapper). Build:
// #root > col > wrapper[display: contents] > host[data-slot="main.conversation"].
function alphaColumn(hostSlot: string): { col: HTMLDivElement; host: HTMLDivElement } {
  const root = document.createElement('div')
  root.id = 'root'
  const col = document.createElement('div')
  const wrapper = document.createElement('div')
  wrapper.style.display = 'contents'
  const host = document.createElement('div')
  host.dataset.slot = hostSlot
  wrapper.append(host)
  col.append(wrapper)
  root.append(col)
  document.body.append(root)
  return { col, host }
}

// The alpha fixtures append into the shared jsdom document; drop them so
// later tests' querySelector scans stay deterministic.
afterEach(() => {
  for (const root of document.body.querySelectorAll('div#root')) root.remove()
})

describe('center-column anchor keys (DSH 0.1.5-alpha.2)', () => {
  it('skips display:contents slot hosts above a main.conversation host', () => {
    const { col } = alphaColumn('main.conversation')
    expect(resolveCenterColumn(null, { now: () => 0 })).toBe(col)
  })

  it('still resolves the alpha.1 conversation key through the default selector', () => {
    const { col } = alphaColumn('conversation')
    expect(resolveCenterColumn(null, { now: () => 0 })).toBe(col)
  })
})

describe('center-column locator (issue #403)', () => {
  it('reuses a connected cached column without querying during the hot-path window', () => {
    const { doc, col, slot } = connectedColumn()
    let now = 0
    const query = vi.fn<() => Element | null>(() => slot)
    const options = { document: doc, query, now: () => now }

    expect(resolveCenterColumn(col, options)).toBe(col)
    now = CENTER_COLUMN_REVALIDATE_MS - 1
    expect(resolveCenterColumn(col, options)).toBe(col)
    expect(query).not.toHaveBeenCalled()
  })

  it('fully revalidates a connected cache at the 1.5s safety-net boundary', () => {
    const { doc, col, slot } = connectedColumn()
    let now = 0
    const query = vi.fn<() => Element | null>(() => slot)
    const options = { document: doc, query, now: () => now }

    expect(resolveCenterColumn(col, options)).toBe(col)
    expect(query).not.toHaveBeenCalled()

    now = CENTER_COLUMN_REVALIDATE_MS
    expect(resolveCenterColumn(col, options)).toBe(col)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('revalidates immediately when the html style signal changes', () => {
    const { doc, col, slot } = connectedColumn()
    let now = 0
    const query = vi.fn<() => Element | null>(() => slot)
    const options = { document: doc, query, now: () => now }

    expect(resolveCenterColumn(col, options)).toBe(col)
    expect(query).not.toHaveBeenCalled()

    doc.documentElement.style.setProperty('--dsh-sidebar-width', '320px')
    now = 1
    expect(resolveCenterColumn(col, options)).toBe(col)
    expect(query).toHaveBeenCalledTimes(1)

    // The same fingerprint is cheap again; one style change causes one full
    // validation instead of turning later streaming mutations into queries.
    now = 2
    expect(resolveCenterColumn(col, options)).toBe(col)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('queries and adopts the replacement as soon as the cached column detaches', () => {
    const first = connectedColumn()
    const stale = first.col
    stale.remove()
    const { col: replacement, slot } = connectedColumn(first.doc)
    const query = vi.fn<() => Element | null>(() => slot)

    expect(resolveCenterColumn(stale, { document: first.doc, query, now: () => 1 })).toBe(replacement)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('queries when no column has been cached yet', () => {
    const { doc, col, slot } = connectedColumn()
    const query = vi.fn<() => Element | null>(() => slot)

    expect(resolveCenterColumn(null, { document: doc, query, now: () => 0 })).toBe(col)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing or detached query result', () => {
    const doc = document.implementation.createHTMLDocument()
    expect(resolveCenterColumn(null, { document: doc, query: () => null, now: () => 0 })).toBeUndefined()

    const detachedCol = doc.createElement('div')
    const detachedSlot = doc.createElement('div')
    detachedCol.append(detachedSlot)
    expect(resolveCenterColumn(null, {
      document: doc,
      query: () => detachedSlot,
      now: () => 1,
    })).toBeUndefined()
  })
})
