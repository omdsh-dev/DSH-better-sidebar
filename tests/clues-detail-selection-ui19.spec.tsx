/** Real detail body/comment selection integration; no third-party writes. */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { WindowHost } from '../src/client/windows/WindowHost.tsx'
import { createWindowHost } from '../src/client/windows/host.ts'
import { openClueDetailWindow } from '../src/client/clues/windows/detail.tsx'
import type { BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import type { WindowHostController } from '../src/client/windows/types.ts'
import type { ClueCommentCapabilities } from '../src/clues/types.ts'
import { setClueSelectionActionContext, setClueSelectionActionStarter, type ClueSelectionActionRequest } from '../src/client/clues/selection-actions.tsx'

setupReactAct()
beforeAll(() => { Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true }) })
let root: RenderedRoot | undefined
let host: WindowHostController | undefined
afterEach(() => {
  root?.unmount(); root = undefined
  host?.dispose(); host = undefined
  setClueSelectionActionContext(null)
  setClueSelectionActionStarter(undefined)
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})
async function flush(): Promise<void> {
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
}
function select(element: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(element)
  const selection = window.getSelection()!
  selection.removeAllRanges(); selection.addRange(range)
  act(() => { element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
}
function actions(): string[] {
  return [...document.querySelectorAll('[data-clue-selection-action]')].map(item => item.getAttribute('data-clue-selection-action')!)
}
function type(input: HTMLTextAreaElement, text: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function mount(options: { sourceId?: string; reply?: ClueCommentCapabilities['reply']; sessionId?: string } = {}) {
  const sourceId = options.sourceId ?? 'builtin.github.issues'
  const writes = vi.fn(async (_workspace: string, input: Record<string, unknown>) => ({ savedAt: '', comment: { id: 'saved', kind: 'reply', format: 'text/plain', body: String(input.body), replyToId: String(input.replyToId) } }))
  const capabilities = { resolve: true, list: true, search: true, read: true, edit: false, portable: true,
    comments: { read: true, create: true, reply: options.reply ?? 'native' } }
  const face = { api: {
    sources: async () => ({ sources: [{ sourceId, name: 'Source', order: 0, types: ['text'], capabilities }], types: [{ typeId: 'text', capabilities: { read: true, edit: false } }] }),
    read: async () => ({ format: 'text/plain', data: 'Selectable detail body', fetchedAt: '' }),
    commentsList: async () => ({ status: 'ok', coverage: 'document', fetchedAt: '', complete: true, items: [
      { id: 'root', kind: 'comment', format: 'text/plain', body: 'Selectable comment body', author: { name: 'Comment author' } },
      { id: 'child', kind: 'reply', format: 'text/plain', body: 'Selectable reply body', replyToId: 'root' },
    ] }),
    commentsCreate: writes,
    bindingsList: async () => ({ bindings: [], revision: 0 }),
  }, getFormatRenderer: () => undefined, subscribe: () => () => {} } as unknown as BetterSidebarCluesClientFace
  host = createWindowHost({ viewport: () => ({ width: 1000, height: 800 }) })
  root = renderRoot(createElement(WindowHost, { host, formats: face }))
  act(() => {
    openClueDetailWindow({ windows: host!, face, workspaceId: 'workspace-captured',
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      target: { sourceId, typeId: 'text', clueId: `selection-${sourceId}`, title: 'Detail title' } })
  })
  await flush()
  return { writes, sourceId }
}

describe('detail selection targets', () => {
  it('opens one body popup with the captured workspace/session/resource', async () => {
    const start = vi.fn(async (_request: ClueSelectionActionRequest) => ({}))
    setClueSelectionActionStarter(start)
    const { sourceId } = await mount({ sessionId: 'session-captured' })
    const body = document.querySelector<HTMLElement>('[data-window-text-read-only]')!
    select(body)
    expect(actions()).toContain('rewrite')
    expect(document.querySelectorAll('[data-clue-selection-action="rewrite"]')).toHaveLength(1)
    act(() => { document.querySelector<HTMLButtonElement>('[data-clue-selection-action="rewrite"]')!.click() })
    await flush()
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-captured', sessionId: 'session-captured', resource: { clueId: `selection-${sourceId}` }, action: 'rewrite', selection: 'Selectable detail body' }))
  })

  it('wraps only comment text in read-only selection actions, excluding meta and composer', async () => {
    const start = vi.fn(async (_request: ClueSelectionActionRequest) => ({}))
    setClueSelectionActionStarter(start)
    await mount({ sessionId: 'session-comment' })
    const comment = document.querySelector<HTMLElement>('[data-clue-comment="root"]')!
    const body = [...comment.querySelectorAll<HTMLElement>('div')].find(node => node.textContent === 'Selectable comment body')!
    select(body)
    expect(actions()).toEqual(['insert', 'explain'])
    act(() => { document.querySelector<HTMLButtonElement>('[data-clue-selection-action="explain"]')!.click() })
    await flush()
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-comment', comment: true, selection: 'Selectable comment body' }))
    const meta = comment.querySelector<HTMLElement>('strong')!
    expect(meta.closest('[data-clue-selection-surface]')).toBeNull()
    select(meta)
    expect(actions()).toEqual([])
    expect(document.querySelector('[data-clue-comment-input]')!.closest('[data-clue-selection-surface]')).toBeNull()
  })

  it('does not invent an active-session target when no session was captured', async () => {
    await mount()
    select(document.querySelector<HTMLElement>('[data-window-text-read-only]')!)
    expect(actions()).toEqual([])
    expect(document.querySelectorAll('[data-clue-selection-surface]')).toHaveLength(0)
  })
})

describe('provider reply identities', () => {
  it.each([
    ['builtin.feishu.docs', 'quote', 'root'],
    ['builtin.feishu.tasks', 'native', 'child'],
    ['builtin.github.issues', 'quote', 'child'],
  ] as const)('uses the right reply ID for %s %s', async (sourceId, reply, expected) => {
    const { writes } = await mount({ sourceId, reply, sessionId: 'session-reply' })
    act(() => { document.querySelector<HTMLButtonElement>('[data-clue-comment-reply="child"]')!.click() })
    type(document.querySelector<HTMLTextAreaElement>('[data-clue-comment-input]')!, 'Reply body')
    act(() => { document.querySelector<HTMLButtonElement>('[data-clue-comment-submit]')!.click() })
    await flush()
    expect(writes).toHaveBeenCalledWith('workspace-captured', expect.objectContaining({ replyToId: expected, body: 'Reply body', sessionId: 'session-reply' }))
  })
})
