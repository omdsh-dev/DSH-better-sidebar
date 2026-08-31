/**
 * MdFind spec: the markdown preview's find bar. Covers the Cmd/Ctrl+F gate
 * (it must claim the key only for a VISIBLE preview and must leave the native
 * dialog alone for other surfaces), match counting and navigation, Escape to
 * close, and the highlight cleanup that keeps a stale tint from outliving the
 * document.
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MdFind } from '../src/client/md-find.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** jsdom has no CSS Custom Highlight API; record what the bar would paint. */
const highlightSets = new Map<string, number>()
const highlightDeletes: string[] = []
class FakeHighlight {
  readonly size: number
  constructor(...ranges: Range[]) { this.size = ranges.length }
}
;(globalThis as Record<string, unknown>).Highlight = FakeHighlight
;(globalThis as Record<string, unknown>).CSS = {
  highlights: {
    set: (name: string, highlight: FakeHighlight) => { highlightSets.set(name, highlight.size) },
    delete: (name: string) => { highlightDeletes.push(name); highlightSets.delete(name) },
  },
}

// jsdom implements no layout: Range has no getBoundingClientRect at all, and
// every element reports zero client rects (which the visibility gate would
// read as "hidden"). Stub both so the bar's scroll step and its Cmd+F gate
// run the same code path they do in a browser.
Range.prototype.getBoundingClientRect = function () {
  return { top: 0, bottom: 10, left: 0, right: 10, width: 10, height: 10, x: 0, y: 0 } as DOMRect
}
Element.prototype.getClientRects = function (this: Element) {
  return (this.isConnected ? [{ width: 10, height: 10 }] : []) as unknown as DOMRectList
}

function Harness({ body }: { body: string }): React.ReactElement {
  return createElement(
    'div',
    null,
    createElement(MdFind),
    createElement('p', null, body),
  )
}

async function mountFind(body: string): Promise<{ container: HTMLDivElement; root: Root; host: HTMLDivElement }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(Harness, { body }))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
  return { container: host.firstElementChild as HTMLDivElement, root, host }
}

/** Dispatch Cmd+F; returns whether the bar claimed it (preventDefault). */
async function pressFind(key = 'f', init: KeyboardEventInit = { metaKey: true }): Promise<boolean> {
  const event = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...init })
  await act(async () => {
    document.dispatchEvent(event)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
  return event.defaultPrevented
}

async function type(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector('input') as HTMLInputElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

function countText(container: HTMLElement): string {
  return container.querySelector('[aria-live="polite"]')?.textContent ?? ''
}

async function unmount(root: Root): Promise<void> {
  await act(async () => { root.unmount() })
}

beforeEach(() => {
  document.body.innerHTML = ''
  highlightSets.clear()
  highlightDeletes.length = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(0) }, 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(id) })
})

describe('MdFind', () => {
  it('renders nothing but the zero-height bar until opened', async () => {
    const { container, root } = await mountFind('alpha beta')
    expect(container.querySelector('input')).toBeNull()
    await unmount(root)
  })

  it('opens on Cmd+F and claims the key from the browser dialog', async () => {
    const { container, root } = await mountFind('alpha beta')
    expect(await pressFind()).toBe(true)
    expect(container.querySelector('input')).not.toBeNull()
    await unmount(root)
  })

  it('opens on Ctrl+F too', async () => {
    const { container, root } = await mountFind('alpha beta')
    expect(await pressFind('f', { ctrlKey: true })).toBe(true)
    expect(container.querySelector('input')).not.toBeNull()
    await unmount(root)
  })

  it('leaves the native dialog alone when focus is on another surface', async () => {
    const { container, root } = await mountFind('alpha beta')
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    expect(await pressFind()).toBe(false)
    expect(container.querySelector('input')).toBeNull()
    await unmount(root)
  })

  it('ignores a plain f and Alt+Cmd+F', async () => {
    const { root } = await mountFind('alpha beta')
    expect(await pressFind('f', {})).toBe(false)
    expect(await pressFind('f', { metaKey: true, altKey: true })).toBe(false)
    await unmount(root)
  })

  it('counts matches and steps through them', async () => {
    const { container, root } = await mountFind('one two two two')
    await pressFind()
    await type(container, 'two')
    expect(countText(container)).toBe('1/3')

    const next = container.querySelector('[aria-label="Next match"]') as HTMLButtonElement
    await act(async () => { next.click() })
    expect(countText(container)).toBe('2/3')

    const prev = container.querySelector('[aria-label="Previous match"]') as HTMLButtonElement
    await act(async () => { prev.click() })
    expect(countText(container)).toBe('1/3')

    // Stepping back past the first match wraps to the last.
    await act(async () => { prev.click() })
    expect(countText(container)).toBe('3/3')
    await unmount(root)
  })

  it('reports a query with no matches', async () => {
    const { container, root } = await mountFind('one two')
    await pressFind()
    await type(container, 'zzz')
    expect(countText(container)).toBe('No results')
    await unmount(root)
  })

  it('paints every match plus the current one', async () => {
    const { container, root } = await mountFind('one two two two')
    await pressFind()
    await type(container, 'two')
    expect(highlightSets.get('dsh-md-find')).toBe(3)
    expect(highlightSets.get('dsh-md-find-current')).toBe(1)
    await unmount(root)
  })

  it('closes on Escape and drops the highlight', async () => {
    const { container, root } = await mountFind('one two')
    await pressFind()
    await type(container, 'two')
    const input = container.querySelector('input') as HTMLInputElement
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })
    expect(container.querySelector('input')).toBeNull()
    expect(highlightDeletes).toContain('dsh-md-find')
    expect(highlightDeletes).toContain('dsh-md-find-current')
    await unmount(root)
  })

  it('clears the highlight when the preview unmounts', async () => {
    const { container, root } = await mountFind('one two')
    await pressFind()
    await type(container, 'two')
    highlightDeletes.length = 0
    await unmount(root)
    expect(highlightDeletes).toContain('dsh-md-find')
    expect(highlightDeletes).toContain('dsh-md-find-current')
  })

  it('never matches the query text inside its own find bar', async () => {
    // The bar renders inside the container it searches; without the skip
    // predicate the input's own value would count as a match.
    const { container, root } = await mountFind('nothing here')
    await pressFind()
    await type(container, 'e')
    // "nothing here" holds two 'e's and the bar's own chrome holds none.
    expect(countText(container)).toBe('1/2')
    await unmount(root)
  })
})
