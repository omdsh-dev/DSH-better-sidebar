/** Configured menus share one side-only execution path; translation never enters an agent. */
// @vitest-environment jsdom
import './browser-globals.ts'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { SelectionActionMenu, setClueSelectionActionStarter, setSelectionMenuSettings } from '../src/client/clues/selection-actions.tsx'
import { selectionSettingsOf, type SelectionSettings } from '../src/selection-settings.ts'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
setupReactAct()
beforeAll(() => { Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true }) })
let root: RenderedRoot | undefined
const base = { workspaceId: 'w', sessionId: 's', resource: { clueId: 'c' }, selection: 'Original selection', insert: 'Original selection', left: 100, top: 100 }
afterEach(() => {
  root?.unmount(); root = undefined
  setClueSelectionActionStarter(undefined)
  setSelectionMenuSettings(selectionSettingsOf({}), () => 'en')
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function mount(settings = selectionSettingsOf({}), props = {}) {
  setSelectionMenuSettings(settings, () => 'ja')
  root = renderRoot(createElement(SelectionActionMenu, { ...base, ...props }))
}
function action(id: string): HTMLButtonElement { return document.querySelector<HTMLButtonElement>('[data-clue-selection-action="' + id + '"]')! }
async function click(id: string): Promise<void> { await act(async () => { action(id).click(); await Promise.resolve() }) }
function actions(surface: ParentNode = document): (string | null)[] { return [...surface.querySelectorAll('[data-clue-selection-action]')].map(node => node.getAttribute('data-clue-selection-action')) }
function configured(patch: Partial<SelectionSettings>): SelectionSettings { return { ...selectionSettingsOf({}), ...patch } }

it('shows only the new main menu, opens rewrite, and returns on Escape before closing', async () => {
  const close = vi.fn()
  mount(undefined, { onClose: close })
  expect(actions()).toEqual(['rewrite', 'translate', 'insertMain', 'insertSide'])
  expect(document.querySelector('[role="menuitemradio"]')).toBeNull()
  await click('rewrite')
  expect(actions(document.querySelector('[data-selection-submenu-panel]')!)).toEqual(['expand', 'humanize', 'shorten', 'continue'])
  expect(actions(document.querySelector('[data-clue-selection-menu]')!)).toEqual(['rewrite', 'translate', 'insertMain', 'insertSide'])
  act(() => { action('expand').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(actions()).toEqual(['rewrite', 'translate', 'insertMain', 'insertSide'])
  expect(close).not.toHaveBeenCalled()
})
it('executes a configured custom rewrite on side only and retries the exact same intent', async () => {
  const start = vi.fn().mockRejectedValueOnce(new Error('Another DSH instance is using this conversation.')).mockResolvedValue({})
  setClueSelectionActionStarter(start)
  mount(configured({ customActions: [{ id: 'custom-test', name: 'Formalize', prompt: 'Use a formal voice.' }], rewriteOrder: ['custom-test'], autoRun: false }))
  await click('rewrite'); await click('custom-test')
  const retry = [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry')!
  await act(async () => { retry.click(); await Promise.resolve() })
  expect(start).toHaveBeenCalledTimes(2)
  expect(start.mock.calls[0]![0]).toEqual(start.mock.calls[1]![0])
  expect(start.mock.calls[0]![0]).toMatchObject({ target: 'side', action: 'custom', instruction: 'Use a formal voice.', actionLabel: 'Formalize', prepareOnly: true, selection: base.selection })
})
it('inserts to the chosen composer without invoking the action starter', async () => {
  const start = vi.fn(); const insert = vi.fn(async () => true)
  setClueSelectionActionStarter(start)
  mount(undefined, { onInsert: insert })
  await click('insertSide')
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ target: 'side', sessionId: 's', selection: base.selection }))
  expect(start).not.toHaveBeenCalled()
})
it('keeps the popup for a refused insert and offers an explicit retry', async () => {
  const close = vi.fn(); const insert = vi.fn(async () => false)
  mount(undefined, { onInsert: insert, onClose: close })
  await click('insertMain')
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  expect(close).not.toHaveBeenCalled()
})
it('translates directly with the UI language from the page bridge and a configured model', async () => {
  const start = vi.fn(); setClueSelectionActionStarter(start)
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, value: { text: '翻訳された文章' } }), { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  mount(configured({ translationModel: 'provider/model/with-slash' }))
  await click('translate')
  expect(fetch).toHaveBeenCalledTimes(1)
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(String(url)).toContain('/sidebar/api/selection.translate')
  expect(JSON.parse(init.body as string)).toEqual({ sessionId: 's', text: base.selection, language: 'ja', model: { provider: 'provider', model: 'model/with-slash' } })
  expect(document.querySelector('[data-selection-translation]')?.textContent).toBe('翻訳された文章')
  expect(start).not.toHaveBeenCalled()
})
it('honors global/action switches, ordering and explicit language override', async () => {
  mount(configured({ enabled: false }))
  expect(document.querySelector('[data-clue-selection-menu]')).toBeNull()
  root!.unmount(); root = undefined
  mount(configured({ menuOrder: ['translate', 'rewrite'], disabled: { insertMain: true, shorten: true }, rewriteOrder: ['continue', 'shorten', 'expand', 'humanize'] }))
  expect(actions()).toEqual(['translate', 'rewrite', 'insertSide'])
  await click('rewrite')
  expect(actions(document.querySelector('[data-selection-submenu-panel]')!)).toEqual(['continue', 'expand', 'humanize'])
})
it.each([{ comment: true }, { writable: false }])('never offers rewrite for a protected surface %j', props => {
  mount(undefined, props)
  expect(actions()).toEqual(['translate', 'insertMain', 'insertSide'])
})
it('hover opens a side card without taking focus, and Escape dismisses just that card', () => {
  const close = vi.fn()
  mount(undefined, { onClose: close })
  const input = document.createElement('input'); document.body.append(input); input.focus()
  act(() => { action('rewrite').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })) })
  expect(document.querySelector('[data-selection-submenu-panel]')).not.toBeNull()
  expect(document.activeElement).toBe(input)
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('[data-selection-submenu-panel]')).toBeNull()
  expect(document.activeElement).toBe(input)
  expect(close).not.toHaveBeenCalled()
  input.remove()
})
it('keyboard navigation stays in the child list and returns to Rewrite before closing', () => {
  const close = vi.fn()
  mount(undefined, { onClose: close })
  const key = (value: string): void => { act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })) }) }
  key('ArrowRight'); expect(document.activeElement).toBe(action('expand'))
  key('End'); expect(document.activeElement).toBe(action('continue'))
  key('ArrowDown'); expect(document.activeElement).toBe(action('expand'))
  key('ArrowLeft'); expect(document.activeElement).toBe(action('rewrite'))
  expect(document.querySelector('[data-selection-submenu-panel]')).toBeNull()
  key('ArrowRight'); key('Escape')
  expect(document.activeElement).toBe(action('rewrite'))
  expect(close).not.toHaveBeenCalled()
  key('Escape'); expect(close).toHaveBeenCalledOnce()
})
it.each([[100, 'right'], [1000, 'left'], [195, 'right']])('places the flyout at %i facing %s, retaining it at narrow widths', async (left, side) => {
  if (left === 195) Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
  mount(undefined, { left })
  await click('rewrite')
  const panel = document.querySelector<HTMLElement>('[data-selection-submenu-panel]')!
  expect(panel.getAttribute('data-selection-submenu-side')).toBe(side)
  expect(parseFloat(panel.style.left)).toBeGreaterThanOrEqual(8)
  expect(parseFloat(panel.style.left) + parseFloat(panel.style.width)).toBeLessThanOrEqual(window.innerWidth - 8)
  expect(action('translate')).not.toBeNull()
  if (left === 195) Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
})
it('keeps full custom labels and cancels delayed close while crossing into the side card', () => {
  vi.useFakeTimers()
  const name = 'Long custom action '.repeat(5)
  mount(configured({ customActions: [{ id: 'custom-long', name, prompt: 'Rewrite' }], rewriteOrder: ['custom-long'] }))
  act(() => { action('rewrite').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })) })
  expect(action('custom-long').textContent).toBe(name)
  const panel = document.querySelector('[data-selection-submenu-panel]')!
  act(() => {
    action('rewrite').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: panel }))
    panel.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: action('rewrite') }))
    vi.advanceTimersByTime(250)
  })
  expect(document.querySelector('[data-selection-submenu-panel]')).not.toBeNull()
  act(() => { panel.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })); vi.advanceTimersByTime(250) })
  expect(document.querySelector('[data-selection-submenu-panel]')).toBeNull()
})
it('puts Back and Copy below the translation body and restores the compact menu', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, value: { text: 'Translated text' } }))))
  const copy = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: copy }, configurable: true })
  mount()
  const menu = document.querySelector<HTMLElement>('[data-clue-selection-menu]')!
  expect(menu.style.width).toBe('220px')
  await click('rewrite'); await click('translate')
  expect(document.querySelector('[data-selection-submenu-panel]')).toBeNull()
  expect(menu.style.width).toBe('320px')
  const footer = document.querySelector('[data-selection-translation-footer]')!
  expect([...footer.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Back', 'Copy'])
  expect(footer.previousElementSibling?.hasAttribute('data-selection-translation')).toBe(true)
  await act(async () => { (footer.lastElementChild as HTMLButtonElement).click(); await Promise.resolve() })
  expect(copy).toHaveBeenCalledWith('Translated text')
  act(() => { (footer.firstElementChild as HTMLButtonElement).click() })
  expect(menu.style.width).toBe('220px')
  expect(actions()).toEqual(['rewrite', 'translate', 'insertMain', 'insertSide'])
})
it('keeps a touch-opened flyout past the mouse hover-grace timeout', async () => {
  vi.useFakeTimers()
  mount(undefined, { left: 500 })
  act(() => { action('rewrite').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch' })) })
  expect(document.querySelector('[data-selection-submenu-panel]')).toBeNull()
  await click('rewrite')
  act(() => {
    action('rewrite').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'touch' }))
    vi.advanceTimersByTime(500)
  })
  expect(document.querySelector('[data-selection-submenu-panel]')).not.toBeNull()
})
