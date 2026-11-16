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
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function mount(settings = selectionSettingsOf({}), props = {}) {
  setSelectionMenuSettings(settings, () => 'ja')
  root = renderRoot(createElement(SelectionActionMenu, { ...base, ...props }))
}
function action(id: string): HTMLButtonElement { return document.querySelector<HTMLButtonElement>('[data-clue-selection-action="' + id + '"]')! }
async function click(id: string): Promise<void> { await act(async () => { action(id).click(); await Promise.resolve() }) }
function actions(): (string | null)[] { return [...document.querySelectorAll('[data-clue-selection-action]')].map(node => node.getAttribute('data-clue-selection-action')) }
function configured(patch: Partial<SelectionSettings>): SelectionSettings { return { ...selectionSettingsOf({}), ...patch } }

it('shows only the new main menu, opens rewrite, and returns on Escape before closing', async () => {
  const close = vi.fn()
  mount(undefined, { onClose: close })
  expect(actions()).toEqual(['rewrite', 'translate', 'insertMain', 'insertSide'])
  expect(document.querySelector('[role="menuitemradio"]')).toBeNull()
  await click('rewrite')
  expect(actions()).toEqual(['expand', 'humanize', 'shorten', 'continue'])
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
  expect(actions()).toEqual(['continue', 'expand', 'humanize'])
})
it.each([{ comment: true }, { writable: false }])('never offers rewrite for a protected surface %j', props => {
  mount(undefined, props)
  expect(actions()).toEqual(['translate', 'insertMain', 'insertSide'])
})
