/**
 * Plan quote-chip spec: the plan page's selection flow (select → floating
 * button → note box → one quote chip) and its degradation when the composer
 * refuses the chip. The plan body itself must stay untouched — there is no
 * mark, card list or second annotation store; the chip is the only carrier.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

const chipInserts: Array<Record<string, unknown>> = []
let chipResult: { id: string } | undefined = { id: 'q-test' }
vi.mock('../src/client/selection-quote.ts', () => ({
  insertQuoteRecord: (_ctx: unknown, _sessionId: string, selection: Record<string, unknown>) => {
    chipInserts.push(selection)
    return chipResult
  },
}))

import { PlanViewer } from '../src/client/PlanViewer.tsx'
import { t } from '../src/client/locales.ts'
import type { Context } from '../src/context-types.ts'

/** Find the first text node whose data contains `needle`, and the matched offset. */
function textPoint(root: Node, needle: string): { node: Text; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const data = (node as Text).data
    const at = data.indexOf(needle)
    if (at !== -1) return { node: node as Text, offset: at }
  }
  throw new Error(`text "${needle}" not found`)
}

/** A DOM range over one exact string occurrence. */
function rangeOf(root: Node, needle: string): Range {
  const from = textPoint(root, needle)
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(from.node, from.offset + needle.length)
  return range
}

const PLAN_MARKDOWN = '# Ship it\n\nCache the session on the client and retry once.\n'

interface MountOptions {
  visible?: boolean
  address?: string
  params?: unknown
  onTitle?: (title: string) => void
  /** Override the host resource reader; `null` simulates a host that injects none. */
  useResource?: ((address: string) => unknown) | null
  ctx?: Context
}

interface PageCtl {
  root: Root
  rerender(visible: boolean): void
  update(next: Pick<MountOptions, 'address' | 'params'>): void
  doc(): HTMLElement
  unmount(): void
}

const LIVE_RESOURCE = (): unknown => ({ status: 'live', value: { markdown: PLAN_MARKDOWN, title: 'Ship it' } })

function mountPlanPage(options: MountOptions = {}): PageCtl {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const state = {
    visible: options.visible ?? true,
    address: options.address ?? 'dsh-resource://plan/s1/call-1',
    params: options.params,
  }
  const useResource = options.useResource === undefined ? LIVE_RESOURCE : options.useResource
  const ctx = options.ctx ?? ({ get: () => undefined, locale: undefined } as unknown as Context)
  const render = (visible: boolean): void => {
    const native = {
      address: state.address,
      params: state.params,
      ...(useResource === null ? {} : { useResource }),
      ...(options.onTitle === undefined ? {} : { onTitle: options.onTitle }),
    }
    root.render(createElement(PlanViewer, {
      ctx,
      store: undefined,
      scope: { sessionId: 's1', cwd: '/w' },
      tab: { id: 'tab1', type: 'plan', title: 'Plan' },
      visible,
      native,
    } as never))
  }
  act(() => { render(state.visible) })
  return {
    root,
    rerender: (visible: boolean) => {
      state.visible = visible
      act(() => { render(visible) })
    },
    update: (next) => {
      if (next.address !== undefined) state.address = next.address
      if ('params' in next) state.params = next.params
      act(() => { render(state.visible) })
    },
    doc: () => container.querySelector<HTMLElement>('[data-plan-document]')!,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** Select `needle` inside the document and fire the mouseup the page listens to. */
function selectInPage(page: PageCtl, needle: string): void {
  const doc = page.doc()
  const range = rangeOf(doc, needle)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  act(() => { doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
}

/** Set a controlled textarea value the way React reads it. */
function setTextAreaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Type into the open note box. */
function typeNote(box: HTMLElement, value: string): void {
  act(() => { setTextAreaValue(box.querySelector('textarea')!, value) })
}

/** Dispatch one click inside the current act batch. */
function click(element: Element): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** Click the note box's submit button. */
function submitNote(box: HTMLElement): void {
  click(box.querySelector('[data-plan-annotation-submit]')!)
}

/** Open the note box through the floating button. */
function openNote(page: PageCtl, needle: string): HTMLElement {
  selectInPage(page, needle)
  const add = document.querySelector<HTMLButtonElement>('[data-plan-annotation-add]')
  expect(add).not.toBeNull()
  act(() => { add!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const box = document.querySelector<HTMLElement>('[data-plan-annotation-note]')
  expect(box).not.toBeNull()
  return box!
}

beforeEach(() => {
  chipInserts.length = 0
  chipResult = { id: 'q-test' }
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('PlanViewer quote chip', () => {
  it('select → add → note → submit mints one plan quote chip and leaves the plan untouched', () => {
    const page = mountPlanPage()
    const box = openNote(page, 'retry once')
    typeNote(box, 'Retry with backoff instead.')
    submitNote(box)

    expect(box.isConnected).toBe(false)
    expect(chipInserts).toEqual([{
      kind: 'plan',
      planId: 'dsh-resource://plan/s1/call-1',
      note: 'Retry with backoff instead.',
      text: 'retry once',
      planTitle: 'Ship it',
    }])
    // The chip is the only carrier: no mark, no card list, no second store.
    expect(page.doc().querySelector('mark')).toBeNull()
    expect(document.querySelector('[data-plan-annotation-card]')).toBeNull()
    expect(document.querySelector('[data-plan-annotation-panel]')).toBeNull()
    expect(document.querySelector('[data-plan-annotation-toast]')).not.toBeNull()
    page.unmount()
  })

  it('keeps the typed note on screen when the composer refuses the chip, then retries', () => {
    chipResult = undefined
    const page = mountPlanPage()
    const box = openNote(page, 'retry once')
    typeNote(box, 'Try a queue.')
    submitNote(box)

    expect(box.isConnected).toBe(true)
    expect(box.querySelector('[data-plan-annotation-error]')).not.toBeNull()
    expect(chipInserts).toHaveLength(1)

    chipResult = { id: 'q-retry' }
    submitNote(box)
    expect(chipInserts).toHaveLength(2)
    expect(document.querySelector('[data-plan-annotation-note]')).toBeNull()
    page.unmount()
  })

  it('keeps the note box open while its textarea is focused, and outside pointerdown dismisses it', () => {
    const page = mountPlanPage()
    const box = openNote(page, 'Cache the session')
    const textarea = box.querySelector('textarea')!
    act(() => { textarea.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(box.isConnected).toBe(true)
    act(() => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(box.isConnected).toBe(false)
    page.unmount()
  })

  it('closes the portalled note box when the native tab becomes hidden', () => {
    const page = mountPlanPage()
    openNote(page, 'Cache the session')
    page.rerender(false)
    expect(document.querySelector('[data-plan-annotation-note]')).toBeNull()
    page.rerender(true)
    expect(document.querySelector('[data-plan-annotation-note]')).toBeNull()
    page.unmount()
  })

  it('does not submit on an IME composition Enter', () => {
    const page = mountPlanPage()
    const box = openNote(page, 'Cache the session')
    const textarea = box.querySelector('textarea')!
    typeNote(box, '输入中的批注')
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
      Object.defineProperty(event, 'isComposing', { value: true })
      textarea.dispatchEvent(event)
    })
    expect(chipInserts).toEqual([])
    expect(box.isConnected).toBe(true)
    page.unmount()
  })

  it('retitles the native tab once the plan document is available', () => {
    const titles: string[] = []
    const page = mountPlanPage({ onTitle: title => titles.push(title) })
    expect(titles).toEqual(['Ship it'])
    page.unmount()
  })

  it('renders a temporary review document from navigation params, and its expired state', () => {
    const address = 'dsh-resource://plan-review/s1/req-1'
    const params = { planReview: { markdown: '# Review\n\nTemporary plan body.\n', title: 'Review' } }
    const page = mountPlanPage({ address, params })
    expect(page.doc().textContent).toContain('Temporary plan body.')
    page.unmount()
    const expired = mountPlanPage({ address, params: undefined })
    expect(expired.doc().textContent?.toLowerCase()).toContain('expired')
    expired.unmount()
  })

  it('renders loading, unavailable and failed states, and treats an unusable live value as a failure', () => {
    const cases: Array<[string, string]> = [
      ['loading', t('planAnnotationLoading')],
      ['none', t('planAnnotationUnavailable')],
      ['failed', t('planAnnotationFailed')],
    ]
    for (const [status, text] of cases) {
      const page = mountPlanPage({ useResource: () => ({ status }) })
      expect(page.doc().textContent).toContain(text)
      page.unmount()
    }
    const bad = mountPlanPage({ useResource: () => ({ status: 'live', value: { markdown: 1 } }) })
    expect(bad.doc().textContent).toContain(t('planAnnotationFailed'))
    bad.unmount()
  })

  it('degrades to the unavailable state when the host injects no resource reader', () => {
    const page = mountPlanPage({ useResource: null })
    expect(page.doc().textContent).toContain(t('planAnnotationUnavailable'))
    page.unmount()
  })

  it('disables submit for a blank note and submits with Ctrl+Enter', () => {
    const page = mountPlanPage()
    const box = openNote(page, 'Cache the session')
    const textarea = box.querySelector('textarea')!
    const submit = box.querySelector<HTMLButtonElement>('[data-plan-annotation-submit]')!
    expect(submit.disabled).toBe(true)
    typeNote(box, '   ')
    expect(submit.disabled).toBe(true)
    typeNote(box, 'Serialize it.')
    expect(submit.disabled).toBe(false)
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    expect(chipInserts).toEqual([expect.objectContaining({ note: 'Serialize it.' })])
    expect(box.isConnected).toBe(false)
    page.unmount()
  })

  it('Escape closes an open note, but is inert after a failed insert', () => {
    chipResult = undefined
    const page = mountPlanPage()
    const first = openNote(page, 'Cache the session')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(first.isConnected).toBe(false)

    // A failed insert owns the note: neither Escape nor an outside click may
    // discard what the reader typed; only an explicit cancel closes it.
    const second = openNote(page, 'retry once')
    typeNote(second, 'Keep me.')
    submitNote(second)
    expect(second.querySelector('[data-plan-annotation-error]')).not.toBeNull()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(second.isConnected).toBe(true)
    act(() => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(second.isConnected).toBe(true)
    click(second.querySelector('[data-plan-annotation-cancel]')!)
    expect(second.isConnected).toBe(false)
    page.unmount()
  })

  it('hides the floating button when the plan document scrolls', () => {
    const page = mountPlanPage()
    selectInPage(page, 'retry once')
    expect(document.querySelector('[data-plan-annotation-add]')).not.toBeNull()
    act(() => { page.doc().dispatchEvent(new Event('scroll')) })
    expect(document.querySelector('[data-plan-annotation-add]')).toBeNull()
    page.unmount()
  })

  it('keeps the note box inside the plan document instead of covering the window chrome', () => {
    const rect = (left: number, top: number, right: number, bottom: number): DOMRect => ({
      left, top, right, bottom,
      x: left, y: top, width: right - left, height: bottom - top,
      toJSON: () => ({}),
    }) as DOMRect
    const page = mountPlanPage()
    vi.spyOn(page.doc(), 'getBoundingClientRect').mockReturnValue(rect(600, 100, 1180, 700))
    // jsdom has no Range rect at all; install one for this test only.
    const proto = Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect }
    const hadRect = 'getBoundingClientRect' in proto
    const originalRect = proto.getBoundingClientRect
    proto.getBoundingClientRect = () => rect(700, 500, 900, 740)
    try {
      const box = openNote(page, 'retry once')
      // A tall selection leaves no room above or below: the old placement
      // put the box at 92px, above the document's 100px top (over the pane
      // header); it now stays at the selection inside the document.
      expect(box.style.top).toBe('300px')
      expect(box.style.left).toBe('640px')
    } finally {
      if (hadRect) proto.getBoundingClientRect = originalRect
      else delete proto.getBoundingClientRect
      page.unmount()
    }
  })

  it('keeps an unsubmitted note when a new selection is attempted', () => {
    chipResult = undefined
    const page = mountPlanPage()
    const box = openNote(page, 'Cache the session')
    typeNote(box, 'Keep me.')
    submitNote(box)
    selectInPage(page, 'retry once')
    expect(document.querySelector('[data-plan-annotation-add]')).toBeNull()
    expect(box.isConnected).toBe(true)
    expect((box.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Keep me.')
    expect(box.textContent).toContain('Cache the session')
    page.unmount()
  })

  it('drops an open note when the tab navigates to another plan', () => {
    const page = mountPlanPage()
    openNote(page, 'Cache the session')
    page.update({ address: 'dsh-resource://plan/s1/call-2' })
    expect(document.querySelector('[data-plan-annotation-note]')).toBeNull()
    page.unmount()
  })

  it('subscribes to the host locale and the better-locale override, and unsubscribes on unmount', () => {
    const subscribed = new Set<() => void>()
    let betterSubscribed = false
    let unsubscribed = 0
    const subscribe = (): (() => void) => {
      const listener = (): void => {}
      subscribed.add(listener)
      return () => { subscribed.delete(listener); unsubscribed++ }
    }
    const ctx = {
      get: (key: string) => (key === 'betterLocale' ? { subscribe: () => { betterSubscribed = true; return () => {} } } : undefined),
      locale: { subscribe },
    } as unknown as Context
    const page = mountPlanPage({ ctx })
    expect(subscribed.size).toBe(1)
    expect(betterSubscribed).toBe(true)
    page.unmount()
    expect(unsubscribed).toBe(1)
  })
})
