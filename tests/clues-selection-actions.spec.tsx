/**
 * UI19 selection actions contract.
 *
 * The wrapper is the ONE selection→action surface for clue bodies and the
 * shared text editor: a non-empty native selection opens a menu whose entries
 * insert the selection into the composer or start a server-side action
 * (`clues.actions.start`). The menu never reads or rewrites the composer draft
 * by itself; `insert` goes through the parent-installed bridge and every other
 * entry sends the RAW selected text.
 *
 * Pins:
 * - seven actions in the normal surface, only insert/explain in comment mode;
 * - main/side destination controls do not retarget local insert;
 * - the exact action request includes destination and a unique requestId;
 * - the raw selection beyond the legacy 500-char insert projection survives
 *   for both `insert` and the action request;
 * - `useSelectionPopup.show` keeps `insert` and the original `selection`
 *   separate (the editor must not lose the text it will act on).
 */
// @vitest-environment jsdom
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { useSelectionPopup, type SelectionPopupControls } from '../src/client/selection-popup.ts'
import { SidebarApiError } from '../src/client/api.ts'
import {
  CLUE_SELECTION_ACTIONS,
  ResourceSelectionActions,
  getClueSelectionActionContext,
  setClueSelectionActionContext,
  setClueSelectionActionStarter,
  useClueSelectionActionTarget,
  type ClueSelectionActionRequest,
  type ClueSelectionActionScope,
} from '../src/client/clues/selection-actions.tsx'

setupReactAct()

const resource = {
  sourceId: 'builtin.files',
  typeId: 'builtin.files.text',
  locator: { root: { kind: 'workspace', workspaceId: 'w' }, path: 'notes.md', dialect: 'posix' },
} as const

let mounted: RenderedRoot | undefined

beforeEach(() => {
  setClueSelectionActionContext(null)
  setClueSelectionActionStarter(undefined)
})

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  setClueSelectionActionContext(null)
  setClueSelectionActionStarter(undefined)
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

/** Render the wrapper around one selectable body. */
function renderBody(comment = false): HTMLElement {
  mounted = renderRoot(createElement(
    ResourceSelectionActions,
    { workspaceId: 'w', sessionId: 's', resource, comment },
    createElement('div', { 'data-testid': 'body' }, 'Keep the WHOLE selected text'),
  ))
  return mounted.container.querySelector<HTMLElement>('[data-testid="body"]')!
}

/** Select a body's text and let the wrapper capture the mouse-up. */
function select(element: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(element)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  // jsdom does not lay out ranges; the wrapper treats a missing rect as 0,0.
  act(() => {
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
}

/** The rendered menu's action ids in DOM order. */
function actionIds(): string[] {
  const menu = document.querySelector('[role="menu"]')
  if (menu === null) return []
  return [...menu.querySelectorAll<HTMLElement>('[data-clue-selection-action]')]
    .map(item => item.getAttribute('data-clue-selection-action') ?? '')
}

/** Click one menu entry and flush its async handler. */
async function clickAction(action: string): Promise<void> {
  const item = document.querySelector<HTMLButtonElement>(`[data-clue-selection-action="${action}"]`)
  expect(item, action).not.toBeNull()
  await act(async () => {
    item!.click()
    await Promise.resolve()
  })
}

/** Choose a server-action destination without activating an action. */
function chooseTarget(target: 'main' | 'side'): void {
  const button = document.querySelector<HTMLButtonElement>(`[data-clue-selection-target="${target}"]`)
  expect(button).not.toBeNull()
  act(() => { button!.click() })
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu

describe('ResourceSelectionActions', () => {
  it('offers continue separately from expansion for a normal selection', () => {
    const body = renderBody()
    select(body)
    expect(actionIds()).toEqual(['insert', 'explain', 'rewrite', 'expand', 'continue', 'shorten', 'translate'])
    expect(actionIds()).toEqual([...CLUE_SELECTION_ACTIONS])
    expect(document.querySelector('[role="group"]')?.getAttribute('aria-label')).toBeTruthy()
    expect(document.querySelector('[data-clue-selection-target="main"]')?.getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-clue-selection-target="side"]')?.getAttribute('aria-checked')).toBe('false')
  })

  it('restricts comment mode to insert and explain', () => {
    const body = renderBody(true)
    select(body)
    expect(actionIds()).toEqual(['insert', 'explain'])
  })

  it('sends the comment flag so the server enforces read-only', async () => {
    const start = vi.fn(async (_request: ClueSelectionActionRequest) => ({ ok: true }))
    setClueSelectionActionStarter(start)
    const body = renderBody(true)
    select(body)
    await clickAction('explain')
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ action: 'explain', comment: true }))
  })

  it('routes insert through the parent bridge with the raw selection', async () => {
    const onInsert = vi.fn()
    setClueSelectionActionContext({ onInsert })
    const body = renderBody()
    select(body)
    chooseTarget('side')
    await clickAction('insert')
    expect(onInsert).toHaveBeenCalledTimes(1)
    expect(onInsert).toHaveBeenCalledWith({
      workspaceId: 'w',
      sessionId: 's',
      resource,
      selection: 'Keep the WHOLE selected text',
      insert: 'Keep the WHOLE selected text',
      reference: { label: 'Keep the WHOLE selected text', text: 'Keep the WHOLE selected text' },
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('keeps the menu when the parent refuses the insert', async () => {
    const onInsert = vi.fn(() => false)
    setClueSelectionActionContext({ onInsert })
    const body = renderBody()
    select(body)
    await clickAction('insert')
    expect(onInsert).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
  })

  it('sends the exact typed action request and closes', async () => {
    const start = vi.fn(async (_request: ClueSelectionActionRequest) => ({ ok: true }))
    setClueSelectionActionStarter(start)
    const body = renderBody()
    select(body)
    await clickAction('rewrite')
    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith({
      workspaceId: 'w',
      sessionId: 's',
      resource,
      action: 'rewrite',
      target: 'main',
      requestId: expect.stringMatching(UUID),
      selection: 'Keep the WHOLE selected text',
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('sends continue to the explicitly selected side session with a new request identity', async () => {
    const start = vi.fn(async (_request: ClueSelectionActionRequest) => ({ ok: true }))
    setClueSelectionActionStarter(start)
    const body = renderBody()
    select(body)
    chooseTarget('side')
    expect(document.querySelector('[data-clue-selection-target="side"]')?.getAttribute('aria-checked')).toBe('true')
    await clickAction('continue')
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ action: 'continue', target: 'side', sessionId: 's', requestId: expect.stringMatching(UUID) }))
    select(body)
    await clickAction('rewrite')
    expect(start.mock.calls[1]![0].target).toBe('main')
    expect(start.mock.calls[1]![0].requestId).not.toBe(start.mock.calls[0]![0].requestId)
  })

  it('reuses requestId on an explicit failed retry and mints a fresh ID when destination changes', async () => {
    const start = vi.fn(async (_request: ClueSelectionActionRequest) => { throw new Error('delivery unavailable') })
    setClueSelectionActionStarter(start)
    const body = renderBody()
    select(body)
    await clickAction('continue')
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('delivery unavailable')
    await clickAction('continue')
    expect(start.mock.calls[1]![0].requestId).toBe(start.mock.calls[0]![0].requestId)
    chooseTarget('side')
    await clickAction('continue')
    expect(start.mock.calls[2]![0].requestId).not.toBe(start.mock.calls[1]![0].requestId)
    expect(start.mock.calls[2]![0].target).toBe('side')
    await clickAction('explain')
    expect(start.mock.calls[3]![0].requestId).not.toBe(start.mock.calls[2]![0].requestId)
    body.textContent = 'A newly selected passage'
    select(body)
    await clickAction('explain')
    expect(start.mock.calls[4]![0].requestId).not.toBe(start.mock.calls[3]![0].requestId)
    expect(start.mock.calls[4]![0].selection).toBe('A newly selected passage')
  })

  it.each([
    ['auth-required', 'Not authorized'],
    ['dependency-missing', 'Missing dependency'],
    ['permission-denied', 'Insufficient permissions'],
    ['failed', 'Delivery is unavailable; the prepared draft was preserved.'],
  ])('shows the recoverable %s reason and retries the captured intent', async (code, reason) => {
    const start = vi.fn(async (_request: ClueSelectionActionRequest) => ({ ok: true }))
      .mockRejectedValueOnce(new SidebarApiError(code!, reason!))
    setClueSelectionActionStarter(start)
    const body = renderBody()
    select(body)
    await clickAction('continue')
    expect(document.querySelector('[data-clue-selection-error]')?.textContent).toContain(reason)
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-clue-selection-action="continue"]')?.disabled).toBe(false)
    expect(start.mock.calls[0]![0]).toMatchObject({ sessionId: 's', selection: 'Keep the WHOLE selected text' })
    // Moving the page-wide bridge cannot retarget the already captured action.
    setClueSelectionActionContext({ workspaceId: 'other', sessionId: 'other-session', resource: { clueId: 'other' } })
    await clickAction('continue')
    expect(start.mock.calls[1]![0]).toEqual(start.mock.calls[0]![0])
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('blocks duplicate activation and destination changes while an action is in flight', async () => {
    let finish!: () => void
    const start = vi.fn((_request: ClueSelectionActionRequest) => new Promise<void>(resolve => { finish = resolve }))
    setClueSelectionActionStarter(start)
    select(renderBody())
    const button = document.querySelector<HTMLButtonElement>('[data-clue-selection-action="continue"]')!
    await act(async () => {
      button.click()
      button.click()
      await Promise.resolve()
    })
    expect(start).toHaveBeenCalledTimes(1)
    expect(document.querySelector<HTMLButtonElement>('[data-clue-selection-target="side"]')!.disabled).toBe(true)
    await act(async () => { finish(); await Promise.resolve() })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('supports keyboard destination selection without consuming menu action navigation', () => {
    const body = renderBody()
    select(body)
    const main = document.querySelector<HTMLButtonElement>('[data-clue-selection-target="main"]')!
    act(() => {
      main.focus()
      main.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    const side = document.querySelector<HTMLButtonElement>('[data-clue-selection-target="side"]')!
    expect(side.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(side)
    act(() => { side.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(document.activeElement?.getAttribute('data-clue-selection-action')).toBe('insert')
  })

  it('does not forward a stale resource.sessionId to the server', async () => {
    const start = vi.fn(async (_request: ClueSelectionActionRequest) => ({ ok: true }))
    setClueSelectionActionStarter(start)
    mounted = renderRoot(createElement(
      ResourceSelectionActions,
      { workspaceId: 'w', sessionId: 's', resource: { ...resource, sessionId: 'other', offset: 12 } },
      createElement('div', { 'data-testid': 'body' }, 'Scoped text'),
    ))
    select(mounted.container.querySelector<HTMLElement>('[data-testid="body"]')!)
    await clickAction('explain')
    const request = start.mock.calls[0]![0]
    expect('sessionId' in request.resource).toBe(false)
    expect('offset' in request.resource).toBe(false)
  })

  it('keeps a 500+ character selection whole for an action', async () => {
    const start = vi.fn(async (_request: ClueSelectionActionRequest) => ({ ok: true }))
    setClueSelectionActionStarter(start)
    const long = 'x'.repeat(600)
    mounted = renderRoot(createElement(
      ResourceSelectionActions,
      { workspaceId: 'w', sessionId: 's', resource },
      createElement('div', { 'data-testid': 'body' }, long),
    ))
    select(mounted.container.querySelector<HTMLElement>('[data-testid="body"]')!)
    await clickAction('explain')
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ action: 'explain', selection: long }))
  })
})

describe('bridge target for the shared TextEditor', () => {
  function TargetProbe(props: { readonly scope?: ClueSelectionActionScope }): ReturnType<typeof createElement> {
    const target = useClueSelectionActionTarget(props.scope)
    return createElement('span', {
      'data-target': target === undefined ? 'none' : `${target.workspaceId}:${target.sessionId}`,
    })
  }

  it('resolves a parent-installed target and clears it again', () => {
    setClueSelectionActionContext({ workspaceId: 'w', sessionId: 's', resource })
    mounted = renderRoot(createElement(TargetProbe))
    expect(mounted.container.querySelector('[data-target]')?.getAttribute('data-target')).toBe('w:s')
    act(() => { setClueSelectionActionContext(null) })
    expect(mounted.container.querySelector('[data-target]')?.getAttribute('data-target')).toBe('none')
  })

  it('never applies a global target to a different session or file', () => {
    setClueSelectionActionContext({ workspaceId: 'w', sessionId: 's', path: '/p/a.ts', resource })
    mounted = renderRoot(createElement(TargetProbe, { scope: { sessionId: 's', path: '/p/a.ts' } }))
    expect(mounted.container.querySelector('[data-target]')?.getAttribute('data-target')).toBe('w:s')
    mounted.rerender(createElement(TargetProbe, { scope: { sessionId: 's', path: '/p/b.ts' } }))
    expect(mounted.container.querySelector('[data-target]')?.getAttribute('data-target')).toBe('none')
    mounted.rerender(createElement(TargetProbe, { scope: { sessionId: 'other', path: '/p/a.ts' } }))
    expect(mounted.container.querySelector('[data-target]')?.getAttribute('data-target')).toBe('none')
  })

  it('does not implicitly apply a partial identity to an editor', () => {
    const scope = { sessionId: 's', path: '/p/a.ts' }
    for (const context of [
      { workspaceId: 'w', resource },
      { workspaceId: 'w', sessionId: 's', resource },
      { workspaceId: 'w', path: '/p/a.ts', resource },
    ]) {
      act(() => { setClueSelectionActionContext(context) })
      mounted?.unmount()
      mounted = renderRoot(createElement(TargetProbe, { scope }))
      expect(mounted.container.querySelector('[data-target]')?.getAttribute('data-target')).toBe('none')
    }
  })
})

describe('page-wide bridge across independently evaluated bundles', () => {
  it('shares core-installed insertion context and starter with an isolated editor module', async () => {
    const onInsert = vi.fn(() => true)
    const starter = vi.fn(async (_request: ClueSelectionActionRequest) => ({ delivered: 'side' }))
    const context = { workspaceId: 'w', sessionId: 's', path: '/p/a.ts', resource, onInsert }
    setClueSelectionActionContext(context)
    setClueSelectionActionStarter(starter)
    vi.resetModules()
    const editor = await import('../src/client/clues/selection-actions.tsx')
    expect(editor.setClueSelectionActionContext).not.toBe(setClueSelectionActionContext)
    expect(editor.getClueSelectionActionContext()).toBe(context)
    expect(editor.getClueSelectionActionContext()?.onInsert?.({ selection: 'text', insert: 'text' })).toBe(true)
    expect(onInsert).toHaveBeenCalledExactlyOnceWith({ selection: 'text', insert: 'text' })
    const request: ClueSelectionActionRequest = { workspaceId: 'w', sessionId: 's', resource, action: 'continue', target: 'side', selection: 'text', requestId: '30d3ba45-2231-4113-bf73-491990bf971d' }
    await expect(editor.startClueSelectionAction(request)).resolves.toEqual({ delivered: 'side' })
    expect(starter).toHaveBeenCalledExactlyOnceWith(request)
    editor.setClueSelectionActionContext(null)
    expect(getClueSelectionActionContext()).toBeUndefined()
  })

  it('keeps cross-module subscriptions through re-evaluation and releases them explicitly', async () => {
    vi.resetModules()
    const first = await import('../src/client/clues/selection-actions.tsx')
    const observed = vi.fn()
    const unsubscribe = first.subscribeClueSelectionActionContext(observed)
    try {
      vi.resetModules()
      const second = await import('../src/client/clues/selection-actions.tsx')
      second.setClueSelectionActionContext({ workspaceId: 'w', sessionId: 'side', resource })
      expect(observed).toHaveBeenCalledTimes(1)
      expect(first.getClueSelectionActionContext()?.sessionId).toBe('side')
      unsubscribe()
      unsubscribe()
      second.setClueSelectionActionContext(null)
      expect(first.getClueSelectionActionContext()).toBeUndefined()
      expect(observed).toHaveBeenCalledTimes(1)
      second.setClueSelectionActionStarter(undefined)
    } finally { unsubscribe() }
  })
})

describe('useSelectionPopup selection retention', () => {
  let controls: SelectionPopupControls | undefined
  let commits: string[] = []

  function Harness(): ReturnType<typeof createElement> {
    const popup = useSelectionPopup({
      onCommit: value => { commits.push(value) },
      getSurface: () => null,
    })
    controls = popup
    return createElement('span', { 'data-popup': true }, popup.popup?.insert ?? '')
  }

  it('stores the original selection separately from the insert projection', () => {
    commits = []
    mounted = renderRoot(createElement(Harness))
    act(() => { controls!.show('short projection', 10, 10, 'the whole original selection') })
    expect(controls!.popup).toMatchObject({
      insert: 'short projection',
      selection: 'the whole original selection',
    })
    act(() => { controls!.commit() })
    expect(commits).toEqual(['short projection'])
  })
})

it('focuses the comment menu and does not consume an IME Escape', () => {
  const body = renderBody(true)
  select(body)
  const first = document.querySelector<HTMLButtonElement>('[data-clue-selection-target="main"]')!
  expect(document.activeElement).toBe(first)
  act(() => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })) })
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  act(() => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(document.querySelector('[role="menu"]')).toBeNull()
})
