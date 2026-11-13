/** Per-editor selection ownership crosses the lazy viewer boundary by props. */
// @vitest-environment jsdom
import './browser-globals.ts'
import { createElement } from 'react'
import { EditorView } from '@codemirror/view'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import * as editorHostModule from '../src/client/EditorHost.tsx'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createBetterSidebarService, type FileViewerProps } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { setClueSelectionActionContext, setClueSelectionActionStarter, type ClueSelectionActionTarget, type ClueSelectionActionRequest } from '../src/client/clues/selection-actions.tsx'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
setupReactAct()
beforeAll(() => { Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true }) })
let root: RenderedRoot | undefined
afterEach(() => {
  root?.unmount(); root = undefined
  setClueSelectionActionContext(null); setClueSelectionActionStarter(undefined)
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})
async function flush(): Promise<void> { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }) }
function context(snapshot: Record<string, unknown> = {}): Context {
  return { get: (name: string) => name === 'workspaces' ? { list: { getSnapshot: () => ({ phase: 'ready', state: 'idle', archivedSessionIds: [], items: [{ workspaceId: 'w', path: '/repo', sessionIds: ['s'] }], ...snapshot }) } } : undefined } as unknown as Context
}
function target(ctx: Context, sessionId: string, path: string): ClueSelectionActionTarget | undefined {
  return (editorHostModule as unknown as { editorSelectionTargetOf(ctx: Context, sessionId: string, path: string): ClueSelectionActionTarget | undefined }).editorSelectionTargetOf(ctx, sessionId, path)
}
function selectPreview(container: ParentNode): void {
  const text = container.querySelector<HTMLElement>('[class*="editorMd"] p')!
  expect(text).not.toBeNull()
  const range = document.createRange(); range.selectNodeContents(text)
  Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ left: 40, right: 240, top: 100, bottom: 120, width: 200, height: 20 }) })
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  act(() => { text.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
}
const fileProps = (ctx: Context, path: string): FileViewerProps => ({
  ctx, path, title: 'note.md', viewerId: 'markdown', content: 'Selected file text',
  store: createSidebarStore(), scope: { sessionId: 's', cwd: '/repo/.worktrees/feature' }, toolbar: 'host',
})

describe('exact editor resource projection', () => {
  it('uses the registered workspace root rather than the session worktree root', () => {
    expect(target(context(), 's', '/repo/.worktrees/feature/note.md')).toEqual({ workspaceId: 'w', sessionId: 's', resource: {
      sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { root: { kind: 'workspace', workspaceId: 'w' }, path: '.worktrees/feature/note.md', dialect: 'posix' },
    } })
  })
  it.each(['/outside/note.md', '/repo', '/repo/../outside/note.md', 'relative.md'])('refuses an unproven file path %s', path => {
    expect(target(context(), 's', path)).toBeUndefined()
  })
  it.each([
    { phase: 'pending' }, { state: 'error' }, { archivedSessionIds: ['s'] }, { archivedSessionIds: undefined },
    { items: [{ path: '/repo', sessionIds: ['s'] }] },
    { items: [{ workspaceId: 'w', path: '/repo', sessionIds: ['other'] }] },
    { items: [{ workspaceId: 'w', path: '/repo', sessionIds: ['s'] }, { workspaceId: 'w', path: '/other', sessionIds: ['s'] }] },
  ])('keeps fallback when workspace evidence is incomplete: %j', snapshot => {
    expect(target(context(snapshot), 's', '/repo/note.md')).toBeUndefined()
  })
  it('uses native Windows locator semantics and the exact text type', () => {
    const ctx = context({ items: [{ workspaceId: 'win', path: 'C:\\repo', sessionIds: ['s'] }] })
    expect(target(ctx, 's', 'C:\\repo\\src\\a.ts')).toEqual({ workspaceId: 'win', sessionId: 's', resource: {
      sourceId: 'builtin.files', typeId: 'builtin.files.text', locator: { root: { kind: 'workspace', workspaceId: 'win' }, path: 'src/a.ts', dialect: 'win32' },
    } })
  })
})

describe('TextEditor selection channel', () => {
  it('keeps two retained editor targets independent without a global target overwrite', async () => {
    const start = vi.fn(async (_request: ClueSelectionActionRequest) => ({}))
    setClueSelectionActionStarter(start)
    const ctx = context()
    root = renderRoot(createElement('div', null,
      createElement('div', { 'data-editor': 'first' }, createElement(TextEditor, { ...fileProps(ctx, '/repo/first.md'), content: 'First editor text', resolveSelectionTarget: () => target(ctx, 's', '/repo/first.md') })),
      createElement('div', { 'data-editor': 'second' }, createElement(TextEditor, { ...fileProps(ctx, '/repo/second.md'), content: 'Second editor text', resolveSelectionTarget: () => target(ctx, 's', '/repo/second.md') })),
    ))
    await flush()
    selectPreview(root.container.querySelector('[data-editor="first"]')!)
    act(() => { document.querySelector<HTMLButtonElement>('[data-clue-selection-action="rewrite"]')!.click() })
    await flush()
    selectPreview(root.container.querySelector('[data-editor="second"]')!)
    act(() => { document.querySelector<HTMLButtonElement>('[data-clue-selection-action="rewrite"]')!.click() })
    await flush()
    expect(start.mock.calls[0]![0]).toMatchObject({ selection: 'First editor text', resource: { locator: { path: 'first.md' } } })
    expect(start.mock.calls[1]![0]).toMatchObject({ selection: 'Second editor text', resource: { locator: { path: 'second.md' } } })
    expect(root.container.querySelector('[data-clue-selection-surface]')).toBeNull()
  })

  it('uses the explicit resolver without a second wrapper or singleton target', async () => {
    const start = vi.fn(async (_request: ClueSelectionActionRequest) => ({}))
    setClueSelectionActionStarter(start)
    const ctx = context()
    const path = '/repo/.worktrees/feature/note.md'
    const props = { ...fileProps(ctx, path), resolveSelectionTarget: () => target(ctx, 's', path) }
    root = renderRoot(createElement(TextEditor, props))
    await flush()
    selectPreview(root.container)
    expect(document.querySelectorAll('[data-clue-selection-action="rewrite"]')).toHaveLength(1)
    expect(root.container.querySelector('[data-clue-selection-surface]')).toBeNull()
    act(() => { document.querySelector<HTMLButtonElement>('[data-clue-selection-action="rewrite"]')!.click() })
    await flush()
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w', sessionId: 's', resource: target(ctx, 's', path)!.resource, action: 'rewrite', selection: 'Selected file text' }))
  })
  it('keeps legacy insertion addressed to the editor session when no target is provable', async () => {
    const insert = vi.fn(() => true)
    setClueSelectionActionContext({ onInsert: insert })
    root = renderRoot(createElement(TextEditor, { ...fileProps(context({ phase: 'pending' }), '/repo/note.md'), resolveSelectionTarget: () => undefined }))
    await flush()
    selectPreview(root.container)
    expect(document.querySelector('[data-clue-selection-action]')).toBeNull()
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Add to conversation')!
    expect(button).toBeDefined()
    act(() => { button.click() })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's', insert: expect.any(String) }))
  })
  it('passes an event-time resolver from the actual host to any lazy viewer', async () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    let received: (FileViewerProps & { resolveSelectionTarget?: () => ClueSelectionActionTarget | undefined }) | undefined
    service.registerFileViewer({ id: 'capture', exts: ['md'], fetchStrategy: 'none', component: props => { received = props; return createElement('p', null, 'viewer') } })
    const registry = context()
    const ctx = { get: (name: string) => name === 'betterSidebar' ? service : registry.get(name as never) } as unknown as Context
    root = renderRoot(createElement(editorHostModule.EditorHost, {
      ctx, store, scope: { sessionId: 's', cwd: '/repo/.worktrees/feature' },
      tab: { id: 'editor', type: 'editor', title: 'note.md', path: '/repo/.worktrees/feature/note.md', meta: { treeOpen: false } },
      expanded: [], revealed: [], onToggleDir: () => {}, onReferenceFile: () => {},
    }))
    await flush()
    expect(received?.resolveSelectionTarget).toBeTypeOf('function')
    expect(received!.resolveSelectionTarget!()).toMatchObject({ workspaceId: 'w', sessionId: 's', resource: { locator: { path: '.worktrees/feature/note.md' } } })
  })
})

it('inserts a long editor selection as a compact chip payload without file appearance', async () => {
  const selected = 'Long selected content '.repeat(40)
  const insert = vi.fn((_input: unknown) => true)
  setClueSelectionActionContext({ onInsert: insert })
  const ctx = context()
  root = renderRoot(createElement(TextEditor, {
    ...fileProps(ctx, '/repo/note.md'), content: selected, scope: { sessionId: 's', cwd: '/repo' },
    resolveSelectionTarget: () => target(ctx, 's', '/repo/note.md'),
  }))
  await flush()
  selectPreview(root.container)
  act(() => { document.querySelector<HTMLButtonElement>('[data-clue-selection-action="insert"]')!.click() })
  await flush()
  expect(insert).toHaveBeenCalledTimes(1)
  const payload = insert.mock.calls[0]![0] as { selection: string; insert: string; reference: { label: string; text: string; appearance?: string } }
  expect(payload.selection).toBe(selected.trimEnd())
  expect(payload.reference.label).toBe('note.md:1')
  expect(payload.reference.text).toContain(selected.trimEnd())
  expect(payload.reference.text).toMatch(/^```note\.md:1\n/)
  expect(payload.insert).toBe(payload.reference.text)
  expect(payload.reference).not.toHaveProperty('appearance')
})

it('keeps the CodeMirror action menu open when focus moves into its controls', async () => {
  vi.spyOn(EditorView.prototype, 'coordsAtPos').mockReturnValue({ left: 40, right: 240, top: 100, bottom: 120 })
  const ctx = context()
  root = renderRoot(createElement(TextEditor, {
    ...fileProps(ctx, '/repo/note.ts'), viewerId: 'code', scope: { sessionId: 's', cwd: '/repo' },
    resolveSelectionTarget: () => target(ctx, 's', '/repo/note.ts'),
  }))
  await flush()
  const host = root.container.querySelector<HTMLElement>('.cm-editor')!
  const editor = EditorView.findFromDOM(host)!
  expect(editor).toBeDefined()
  act(() => { editor.focus(); editor.dispatch({ selection: { anchor: 0, head: 8 } }) })
  await flush()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
  expect(document.querySelector('[data-clue-selection-menu]')).not.toBeNull()
  expect(document.activeElement?.getAttribute('data-clue-selection-target')).toBe('main')
})
