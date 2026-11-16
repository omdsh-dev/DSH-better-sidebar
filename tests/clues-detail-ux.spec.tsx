/**
 * Unified clue detail window (S9 UX refresh).
 *
 * Contract pinned here:
 * - opening renders a preview from the read/cache path and NEVER calls
 *   `loadEdit`; a hot cache/target snapshot paints without a spinner frame;
 * - the header is source metadata (read snapshot authoritative over the
 *   target snapshot), independent of the body;
 * - Edit is a lazy `loadEdit`; the switch is controlled by the detail window
 *   and the preview/edit panes stay mounted;
 * - Save uses only the edit document's baseline, refreshes the metadata from
 *   the save result, and a preview toggle after save can never show the stale
 *   read body;
 * - Refresh is always a toolbar action, keeps the current body while reading,
 *   and is disabled while the draft is dirty;
 * - a read-only type offers no Edit at all, and a failed read keeps the
 *   toolbar and an explicit retry.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement, Fragment, type ReactNode } from 'react'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { WindowHost } from '../src/client/windows/WindowHost.tsx'
import { createWindowHost } from '../src/client/windows/host.ts'
import type { WindowDocumentContent, WindowHostController, WindowOpenOptions, WindowHandle } from '../src/client/windows/types.ts'
import {
  clueDetailWindowId, deriveTaskInfo, openClueDetailWindow,
  type ClueDetailDataChange, type ClueDetailDataChangeListener, type ClueDetailReadCache, type ClueDetailTarget,
} from '../src/client/clues/windows/detail.tsx'
import type { BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import type { ClueCommentCreateResult, ClueDiscussionPage, ClueFormatRenderer, ClueReadResult, JsonValue, Locator } from '../src/clues/types.ts'
import type { ClueResourceInfo } from '../src/client/clues/resource-summary.tsx'
import { FeishuDocsPreview } from '../src/client/clues/sources/feishu/docs-preview.tsx'
import { FeishuTaskEditor } from '../src/client/clues/sources/feishu/task-editor.tsx'
import { DEFAULT_FEISHU_LABELS } from '../src/client/clues/sources/feishu/labels.ts'
import { SidebarApiError } from '../src/client/api.ts'
import { setClueSelectionActionContext } from '../src/client/clues/selection-actions.tsx'
setupReactAct()
beforeAll(() => { Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true }) })
const VIEWPORT = { width: 1_000, height: 800 }
const READ_OLD: ClueReadResult = { format: 'text/markdown', data: { text: '# Read only' }, fetchedAt: '2026-10-20T08:00:00.000Z' }
interface Calls { read: number; loadEdit: number; saveEdit: number; sources: number; bindingsList: number; ensure: { title: string; subtitle?: string; info?: ClueResourceInfo }[] }
interface FaceOptions {
  read?: (call: number, signal?: AbortSignal) => Promise<ClueReadResult>; loadEdit?: (signal?: AbortSignal) => Promise<unknown>; saveEdit?: (input: unknown) => Promise<unknown>
  edit?: boolean; format?: string; renderer?: ClueFormatRenderer
  commentsList?: (input: Record<string, unknown>) => Promise<ClueDiscussionPage>; commentsCreate?: (input: Record<string, unknown>) => Promise<ClueCommentCreateResult>
  readInput?: (input: Record<string, unknown>) => void
}
function faceOf(options: FaceOptions = {}): { face: BetterSidebarCluesClientFace; calls: Calls } {
  const calls: Calls = { read: 0, loadEdit: 0, saveEdit: 0, sources: 0, bindingsList: 0, ensure: [] }
  const comments = options.commentsList === undefined ? {} : { comments: { read: true, create: true, reply: 'native' } }
  const api = {
    ...(options.commentsList === undefined ? {} : { commentsList: async (_w: string, input: Record<string, unknown>) => options.commentsList!(input) }),
    ...(options.commentsCreate === undefined ? {} : { commentsCreate: async (_w: string, input: Record<string, unknown>) => options.commentsCreate!(input) }),
    sources: async () => {
      calls.sources += 1
      const editable = options.edit !== false
      return {
        sources: [{ sourceId: 'builtin.files', name: 'Local files', order: 0, pluginId: 'dsh-better-sidebar', types: ['builtin.files.markdown'], transport: 'files' as const,
          capabilities: { resolve: true, list: true, search: true, read: true, edit: editable, portable: true, ...comments } }],
        types: [{ typeId: 'builtin.files.markdown', sourceId: 'builtin.files', formats: ['text/markdown'], capabilities: { read: true, edit: editable, concurrency: 'check-before-save' as const } }],
      }
    },
    read: async (_w: string, input: unknown, signal?: AbortSignal) => {
      calls.read += 1
      options.readInput?.(input as Record<string, unknown>)
      return options.read?.(calls.read, signal) ?? READ_OLD
    },
    loadEdit: async (_w: string, _input: unknown, signal?: AbortSignal) => {
      calls.loadEdit += 1
      return options.loadEdit?.(signal) ?? { format: 'text/markdown', data: { text: '# Draft' }, baseRevision: 'r1' }
    },
    saveEdit: async (_w: string, input: unknown) => { calls.saveEdit += 1; return options.saveEdit?.(input) ?? { revision: 'r2', savedAt: '2026-10-21T09:00:00.000Z' } },
    ensure: async (_w: string, input: { title: string; subtitle?: string; info?: ClueResourceInfo }) => { calls.ensure.push(input); return { clue: { id: 'c9' }, created: true } },
    bindingsList: async () => { calls.bindingsList += 1; return { bindings: [], revision: 1 } },
  }
  const face = {
    api,
    registerSourceDisplay: () => () => {},
    getSourceDisplays: () => [],
    registerFormatRenderer: () => () => {},
    getFormatRenderer: (format: string) => (options.renderer !== undefined && format === options.format ? options.renderer : undefined),
    getFormatRenderers: () => new Map(),
    subscribe: () => () => {},
    isSourceEnabled: () => true,
    isSourceMentionEnabled: () => true,
    isPacksMentionEnabled: () => true,
  } as unknown as BetterSidebarCluesClientFace
  return { face, calls }
}
/** A window host that records opens/updates (no DOM). */
function recordingWindows(): { windows: { open(options: WindowOpenOptions): WindowHandle }; last(): WindowOpenOptions | undefined } {
  let last: WindowOpenOptions | undefined
  const navigation = { push: () => undefined, pop: () => false, back: () => false, canGoBack: () => false, depth: () => 1 }
  return {
    windows: {
      open(options: WindowOpenOptions): WindowHandle {
        last = options
        return { id: options.id, update(patch) { last = { ...(last ?? options), ...patch } as WindowOpenOptions }, focus: () => undefined, close: async () => undefined, navigation }
      },
    },
    last: () => last,
  }
}
async function flush(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)) })
}
const renderNode = (node: ReactNode): RenderedRoot => renderRoot(createElement(Fragment, null, node))
function frame(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-floating-window]')
  if (node === null) throw new Error('no floating window')
  return node
}
function click(container: ParentNode, label: string): void {
  const button = [...container.querySelectorAll('button')].find(candidate => (candidate.textContent ?? '').trim() === label || candidate.getAttribute('aria-label') === label)
  if (button === undefined) throw new Error(`button "${label}" not found`)
  act(() => { button.click() })
}
/** Click the first node matching `selector` inside `root`. */
function clickSel(root: ParentNode, selector: string): void {
  const node = root.querySelector<HTMLElement>(selector)
  if (node === null) throw new Error(`no ${selector}`)
  act(() => { node.click() })
}
function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
/** An injected shared-cache seam with a controllable data-change listener. */
function subscribingReadCache(peek: () => ClueReadResult | undefined = () => undefined) {
  const listeners = new Set<ClueDetailDataChangeListener>()
  const stats = { invalidations: 0, unsubscribes: 0 }
  const cache: ClueDetailReadCache = {
    peek: () => peek(),
    invalidate: () => { stats.invalidations += 1 },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); stats.unsubscribes += 1 } },
  }
  return { cache, stats, listenerCount: () => listeners.size, emit(change: ClueDetailDataChange) { for (const listener of [...listeners]) listener(change) } }
}
const TARGET = { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-detail', locator: { path: 'a.md' } as Locator, title: 'A note' }
const SAVED_AT = '2026-10-21T09:00:00.000Z'
const OLD_START = '2026-10-01T08:00:00.000Z'
const OLD_DUE = '2026-10-02T08:00:00.000Z'
const OLD_COMPLETED_AT = '2026-10-03T08:00:00.000Z'
const TASK_DOCUMENT = {
  kind: 'task', guid: 'g-1', title: 'Task title', description: 'Task body',
  start: { timestamp: '1700000000000', isAllDay: false }, due: { timestamp: '1700003600000', isAllDay: false }, completed: false,
} as unknown as JsonValue
const taskWith = (overrides: Record<string, unknown>): JsonValue => ({ ...(TASK_DOCUMENT as Record<string, unknown>), ...overrides }) as unknown as JsonValue
const candidateTarget = (title: string): ClueDetailTarget => ({ sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'a.md' }, title })
const isoOf = (timestamp: string): string => new Date(Number(timestamp)).toISOString()
const DOCS_EDIT_DOCUMENT = {
  kind: 'docx', docToken: 'doccnA', title: 'Doc title', baselineTitle: 'Doc title', titleEditable: true, titleAttrs: '',
  blocks: [{ id: 'blk-p1', tag: 'p', attrs: '', text: 'Hello', baseline: 'Hello', kind: 'plain', order: 1 }], readOnlyBlocks: [],
} as unknown as JsonValue
const feishuRenderer: ClueFormatRenderer = (props) => (props.format === 'feishu.task.document'
  ? createElement(FeishuTaskEditor, { ...props, labels: DEFAULT_FEISHU_LABELS })
  : createElement(FeishuDocsPreview, { ...props, labels: DEFAULT_FEISHU_LABELS }))
const titleRenderer: ClueFormatRenderer = (props) => {
  const data = props.document.data as Record<string, JsonValue>
  return createElement('input', {
    'data-test-title-input': '', value: String(data.title ?? ''),
    onChange: (event: { target: { value: string } }) => { props.onChange({ ...data, title: event.target.value }) },
  })
}
/** A markdown document whose title the reader edits through {@link titleRenderer}. */
function titleDocument(initial: JsonValue, info?: ClueResourceInfo): { options: FaceOptions } {
  let current = initial
  const extra = info === undefined ? {} : { info }
  return {
    options: {
      format: 'text/markdown', renderer: titleRenderer,
      read: async () => ({ format: 'text/markdown', data: current, fetchedAt: '2026-10-20T08:00:00.000Z', ...extra }),
      loadEdit: async () => ({ format: 'text/markdown', data: current, baseRevision: 'r1' }),
      saveEdit: async (input) => {
        const document = (input as { document?: { data?: JsonValue } }).document
        if (document?.data !== undefined) current = document.data
        return { revision: 'r2', savedAt: SAVED_AT, ...extra }
      },
    },
  }
}
/** One discussion page with the protocol fields the surface requires. */
const discussionPage = (overrides: Record<string, unknown>): ClueDiscussionPage =>
  ({ status: 'ok', coverage: 'document', fetchedAt: '', complete: true, ...overrides }) as unknown as ClueDiscussionPage
let host: WindowHostController | undefined
let view: RenderedRoot | undefined
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height })
})
afterEach(() => {
  setClueSelectionActionContext(null)
  view?.unmount(); view = undefined; host?.dispose(); host = undefined; document.body.innerHTML = ''
})
/** Mount the real window host and open one detail. */
async function mountDetail(options: FaceOptions = {}, extra: {
  readCache?: ClueDetailReadCache; target?: ClueDetailTarget; subtitle?: string; info?: ClueResourceInfo; sessionId?: string
  insert?: boolean; onInsertClue?: (clueId: string, title: string) => boolean; onAddToPack?: (target: ClueDetailTarget) => void
} = {}): Promise<Calls> {
  const { face, calls } = faceOf(options)
  host = createWindowHost({ viewport: () => VIEWPORT })
  view = renderRoot(createElement(WindowHost, { host, formats: face }))
  act(() => {
    openClueDetailWindow({
      windows: host!, face, workspaceId: 'ws-1', sessionId: extra.sessionId,
      target: { ...(extra.target ?? TARGET), ...(extra.subtitle === undefined ? {} : { subtitle: extra.subtitle }), ...(extra.info === undefined ? {} : { info: extra.info }) },
      ...(extra.readCache === undefined ? {} : { readCache: extra.readCache }),
      ...(extra.insert === true || extra.onInsertClue !== undefined ? { onInsertClue: extra.onInsertClue ?? (() => true) } : {}),
      ...(extra.onAddToPack === undefined ? {} : { onAddToPack: extra.onAddToPack }),
    })
  })
  await flush()
  return calls
}
type DocContent = WindowDocumentContent & { afterBody?: ReactNode }
type Windows = ReturnType<typeof recordingWindows>
const bodyOf = (windows: Windows): DocContent => windows.last()?.content as DocContent
const shown = (): DocContent => host!.getSnapshot().windows[0]!.content as DocContent
const afterBodyOf = (windows: Windows): ReactNode => bodyOf(windows).afterBody
const rerenderNode = (node: RenderedRoot, windows: Windows): void => node.rerender(createElement(Fragment, null, afterBodyOf(windows)))
/** Open one detail and render its `afterBody` supplement outside the host. */
async function openAfterBody(face: BetterSidebarCluesClientFace, clueId: string, readCache?: ClueDetailReadCache): Promise<{ windows: Windows; node: RenderedRoot }> {
  const windows = recordingWindows()
  act(() => { openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', target: { ...TARGET, clueId }, ...(readCache === undefined ? {} : { readCache }) }) })
  await flush()
  return { windows, node: renderNode(afterBodyOf(windows)) }
}
const q = <T extends Element>(selector: string): T => frame().querySelector<T>(selector)!
const modeTab = (mode: 'preview' | 'edit'): HTMLButtonElement => q(`[data-window-mode-tab="${mode}"]`)
const bodyEditor = (): HTMLTextAreaElement => q('[data-window-text-editor]')
const previewHeading = (): string | undefined => frame().querySelector<HTMLElement>('[data-window-document-preview] h1')?.textContent ?? undefined
const windowError = (): string => frame().querySelector('[data-window-error]')?.textContent ?? ''
const saveControl = (): HTMLButtonElement | null => frame().querySelector('[data-clue-detail-save]')
const paneHidden = (selector: string): boolean => q<HTMLElement>(selector).hidden
const summaryState = (): string | undefined => frame().querySelector<HTMLElement>('[data-clue-resource-summary]')?.dataset.clueResourceState
const bindingRevision = (): string | null | undefined => frame().querySelector('[data-clue-binding-revision]')?.getAttribute('data-clue-binding-revision')
const clickDetailSave = (): void => { act(() => { q<HTMLButtonElement>('[data-clue-detail-save]').click() }) }
async function enterEdit(text?: string): Promise<HTMLTextAreaElement> {
  act(() => { modeTab('edit').click() })
  await flush()
  const editor = bodyEditor()
  if (text !== undefined) typeInto(editor, text)
  return editor
}
async function closeWindow(): Promise<void> {
  const close = q<HTMLButtonElement>('button[aria-label="Close"]')
  await act(async () => { close.click(); await Promise.resolve() })
}
  it.each([undefined, 'stored-clue'])('preserves selection ownership and ensures only an unstored source (%s)', async clueId => {
    const insert = vi.fn(() => true)
    setClueSelectionActionContext({ onInsert: insert })
    const target = { ...TARGET, clueId }
    const calls = await mountDetail({}, { target, sessionId: 'selection-session' })
    const heading = q<HTMLElement>('[data-window-document-body] h1')
    const range = document.createRange()
    range.selectNodeContents(heading)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    act(() => { heading.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    const action = document.querySelector<HTMLButtonElement>('[data-clue-selection-action="insertMain"]')!
    expect(action).not.toBeNull()
    await act(async () => { action.click(); await Promise.resolve() })
    await flush()
    expect(calls.ensure).toHaveLength(clueId === undefined ? 1 : 0)
    expect(insert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      clueId: clueId ?? 'c9', workspaceId: 'ws-1', sessionId: 'selection-session', selection: 'Read only',
    }))
    expect(document.querySelector('[data-clue-selection-menu]')).toBeNull()
    selection.removeAllRanges()
  })

  it('paints a hot cached preview synchronously and never loads the edit document', async () => {
    const cache: ClueDetailReadCache = {
      peek: () => ({ ...READ_OLD, data: { title: 'Cached issue title', text: '# body' }, info: { repository: 'acme/widgets', number: 7, state: 'open' } }),
      invalidate: () => undefined,
    }
    const { face, calls } = faceOf({ read: async () => ({ format: 'text/markdown', data: { title: 'Read issue title', text: '# body' }, fetchedAt: '2026-10-20T08:00:00.000Z', info: { state: 'closed', number: 9, repository: 'acme/widgets', author: { id: 'read-author' } } }) })
    const windows = recordingWindows()
    act(() => {
      openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', readCache: cache, target: { ...TARGET, title: 'owner/repo#42', info: { state: 'open', number: 7, author: { name: 'List author' } } } })
    })
    // The first content is a document, not a spinner, already merging target + cached read.
    const initial = windows.last()?.content as WindowDocumentContent
    expect(initial.kind).toBe('document')
    expect(initial.document.data).toEqual({ title: 'Cached issue title', text: '# body' })
    expect(initial.readOnly).toBe(true)
    expect(initial.mode).toBe('preview')
    expect(initial.loading).toBeUndefined()
    expect(windows.last()?.title).toBe('Cached issue title')
    const cachedHeader = renderNode(initial.header)
    expect(cachedHeader.container.querySelector<HTMLElement>('[data-clue-resource-summary]')?.dataset.clueResourceRepository).toBe('acme/widgets')
    cachedHeader.unmount()
    await flush()
    // The authoritative read snapshot wins over the target snapshot, header and title.
    const readHeader = renderNode(bodyOf(windows).header)
    const summary = readHeader.container.querySelector<HTMLElement>('[data-clue-resource-summary]')!
    expect(summary.dataset.clueResourceState).toBe('closed')
    expect(summary.dataset.clueResourceNumber).toBe('9')
    expect(summary.dataset.clueResourceRepository).toBe('acme/widgets')
    expect(summary.querySelector<HTMLElement>('[data-clue-resource-item="author"]')?.textContent).toContain('read-author')
    readHeader.unmount()
    expect(windows.last()?.title).toBe('Read issue title')
    expect(calls.loadEdit).toBe(0)
  })
  it('offers a read-only type with no Edit and explains why', async () => {
    await mountDetail({ edit: false })
    expect(shown().readOnly).toBe(true)
    expect(shown().onModeChange).toBeUndefined()
    expect(frame().querySelector('[data-window-mode-tab="edit"]')).toBeNull()
    expect(frame().querySelector('[data-window-read-only]')).not.toBeNull()
    expect(frame().querySelector('[data-clue-detail-refresh]')).not.toBeNull()
  })
  it('loads the edit document only after Edit and keeps the draft across preview and a refused close', async () => {
    const calls = await mountDetail()
    expect(calls.loadEdit).toBe(0)
    expect(paneHidden('[data-window-document-preview]')).toBe(false)
    act(() => { modeTab('edit').click() })
    // The lazy load shows its own fixed spinner until the edit document lands.
    expect(frame().querySelector('[data-window-edit-loading]')).not.toBeNull()
    await flush()
    expect(calls.loadEdit).toBe(1)
    expect(frame().querySelector('[data-window-edit-loading]')).toBeNull()
    expect(paneHidden('[data-window-document-editor]')).toBe(false)
    const editor = bodyEditor()
    typeInto(editor, '# Unsaved draft')
    expect(q<HTMLElement>('[data-clue-detail-refresh]').hasAttribute('disabled')).toBe(true)
    act(() => { modeTab('preview').click() })
    expect(previewHeading()).toBe('Unsaved draft')
    expect(frame().querySelector('[data-window-text-editor]')).toBe(editor)
    await closeWindow()
    expect(windowError()).toContain('Unsaved edits')
    expect(document.querySelector('[data-floating-window]')).not.toBeNull()
    click(frame(), 'Discard edits')
    await flush()
    expect(document.querySelector('[data-floating-window]')).toBeNull()
  })
  it('saves with the edit baseline and never shows the stale read body on preview toggle', async () => {
    let resolveRead!: (value: ClueReadResult) => void
    const calls = await mountDetail({
      read: async (call) => call === 1 ? READ_OLD : new Promise<ClueReadResult>((resolve) => { resolveRead = resolve }),
      saveEdit: async () => ({ revision: 'r2', savedAt: SAVED_AT, info: { state: 'completed', repository: 'acme/widgets', number: 7 } }),
    })
    expect(calls.loadEdit).toBe(0)
    await enterEdit('# Saved draft')
    expect(calls.loadEdit).toBe(1)
    click(frame(), 'Save')
    await flush()
    expect(calls.saveEdit).toBe(1)
    // The save result's authoritative info reached the header immediately.
    expect(summaryState()).toBe('completed')
    // Background read is still in flight; preview must show the saved draft.
    act(() => { modeTab('preview').click() })
    expect(previewHeading()).toBe('Saved draft')
    expect(frame().querySelector('[data-window-document-preview] [data-window-text-read-only]')).not.toBeNull()
    await act(async () => {
      resolveRead({ format: 'text/markdown', data: { text: '# Fresh from read' }, fetchedAt: '2026-10-21T09:00:01.000Z' })
      await Promise.resolve()
    })
    await flush()
    expect(previewHeading()).toBe('Fresh from read')
  })
  it('keeps the draft and offers an explicit re-read on a save conflict', async () => {
    const calls = await mountDetail({ saveEdit: async () => { throw new SidebarApiError('conflict', 'stale revision') } })
    const editor = await enterEdit('# Kept draft')
    click(frame(), 'Save')
    await flush()
    expect(calls.saveEdit).toBe(1)
    expect(windowError()).toContain('changed elsewhere')
    expect(editor.value).toBe('# Kept draft')
    click(frame(), 'Re-read')
    await flush()
    expect(calls.loadEdit).toBe(2)
    // A fresh edit baseline is still edit mode with the explicit reader action.
    expect(paneHidden('[data-window-document-editor]')).toBe(false)
  })
  // The task body is the authoritative date projection: it both wins over and
  // clears the list-row snapshot, so no stale date can reach insert.
  const cases: { name: string; body: Record<string, unknown>; info: ClueResourceInfo; phase?: 'saved'; expected: Record<string, unknown> }[] = [
    { name: 'keeps an incomplete task active rather than open', body: { start: null, due: null, completed: false }, info: { state: 'active' }, expected: { state: 'active' } },
    { name: 'clears target start/due/completedAt when the authoritative body has none', body: { start: null, due: null, completed: false }, info: { state: 'completed', start: { at: OLD_START }, due: { at: OLD_DUE }, completedAt: OLD_COMPLETED_AT, author: { id: 'u1' }, labels: ['keep'] }, expected: { state: 'active', author: { id: 'u1' }, labels: ['keep'] } },
    { name: 'takes changed body dates and the save instant on save', body: { start: { timestamp: '1800000000000', isAllDay: false }, due: { timestamp: '1800003600000', isAllDay: true }, completed: true }, info: { state: 'active', start: { at: OLD_START }, due: { at: OLD_DUE } }, phase: 'saved', expected: { state: 'completed', start: { at: isoOf('1800000000000') }, due: { at: isoOf('1800003600000'), allDay: true }, completedAt: SAVED_AT, updatedAt: SAVED_AT } },
    { name: 'clears start/due/completedAt when the saved body clears them', body: { start: null, due: null, completed: false }, info: { state: 'completed', start: { at: OLD_START }, due: { at: OLD_DUE }, completedAt: OLD_COMPLETED_AT }, phase: 'saved', expected: { state: 'active', updatedAt: SAVED_AT } },
    { name: 'keeps the actual completion instant, while an explicit body completedAt wins', body: { completed: true, completedAt: '2026-10-04T08:00:00.000Z' }, info: { state: 'completed', completedAt: OLD_COMPLETED_AT }, phase: 'saved', expected: { state: 'completed', start: { at: isoOf('1700000000000') }, due: { at: isoOf('1700003600000') }, completedAt: '2026-10-04T08:00:00.000Z', updatedAt: SAVED_AT } },
    { name: 'keeps the provider completion instant when the body has none', body: { completed: true }, info: { state: 'completed', completedAt: OLD_COMPLETED_AT }, phase: 'saved', expected: { state: 'completed', start: { at: isoOf('1700000000000') }, due: { at: isoOf('1700003600000') }, completedAt: OLD_COMPLETED_AT, updatedAt: SAVED_AT } },
    { name: 'clears completedAt and returns to active on reopen', body: { completed: false }, info: { state: 'completed', completedAt: OLD_COMPLETED_AT }, phase: 'saved', expected: { state: 'active', start: { at: isoOf('1700000000000') }, due: { at: isoOf('1700003600000') }, updatedAt: SAVED_AT } },
  ]
  it.each(cases)('$name', ({ body, info, phase, expected }) => {
    expect(deriveTaskInfo('feishu.task.document', taskWith(body), info, phase, phase === undefined ? undefined : SAVED_AT)).toEqual(expected)
  })
  it('replaces start/due from the saved task body, clears them when the draft clears, and never persists stale dates on insert', async () => {
    let current = taskWith({ start: null, due: null, completed: false })
    const patchRenderer: ClueFormatRenderer = (props) => {
      const data = props.document.data as Record<string, unknown>
      const swap = (label: string, patch: Record<string, unknown>) => createElement('button', {
        type: 'button', 'data-test-dates': label, onClick: () => props.onChange({ ...data, ...patch } as unknown as JsonValue),
      }, label)
      return createElement('div', null, swap('change', { start: { timestamp: '1800000000000', isAllDay: false }, due: { timestamp: '1800003600000', isAllDay: true }, completed: true }), swap('clear', { start: null, due: null, completed: false }))
    }
    const calls = await mountDetail({
      format: 'feishu.task.document', renderer: patchRenderer,
      read: async () => ({ format: 'feishu.task.document', data: current, fetchedAt: '2026-10-20T08:00:00.000Z' }),
      loadEdit: async () => ({ format: 'feishu.task.document', data: current, baseRevision: 'r1' }),
      saveEdit: async (input) => {
        const document = (input as { document?: { data?: JsonValue } }).document
        if (document?.data !== undefined) current = document.data
        return { revision: 'r2', savedAt: SAVED_AT }
      },
    }, { target: candidateTarget('Task title'), insert: true, info: { state: 'completed', start: { at: OLD_START }, due: { at: OLD_DUE }, completedAt: OLD_COMPLETED_AT, author: { id: 'u1' } } })
    // The read body cleared the stale target dates before any edit.
    expect(frame().querySelector('[data-clue-resource-item="due"]')).toBeNull()
    await enterEdit()
    clickSel(q('[data-window-document-editor]'), '[data-test-dates="change"]')
    await flush()
    clickDetailSave()
    await flush()
    expect(calls.saveEdit).toBe(1)
    expect(frame().querySelector('[data-clue-resource-item="due"]')).not.toBeNull()
    expect(summaryState()).toBe('completed')
    clickSel(q('[data-window-document-editor]'), '[data-test-dates="clear"]')
    await flush()
    clickDetailSave()
    await flush()
    expect(calls.saveEdit).toBe(2)
    expect(frame().querySelector('[data-clue-resource-item="due"]')).toBeNull()
    expect(summaryState()).toBe('active')
    click(frame(), 'Insert resources')
    await flush()
    expect(calls.ensure).toHaveLength(1)
    const info = calls.ensure[0]!.info
    expect(info).not.toHaveProperty('start')
    expect(info).not.toHaveProperty('due')
    expect(info).not.toHaveProperty('completedAt')
    expect(info?.author).toEqual({ id: 'u1' })
  })
  it.each([
    { name: 'Feishu task', format: 'feishu.task.document', data: TASK_DOCUMENT, input: '[data-feishu-task-input="title"]', bodySave: '[data-feishu-task-save]' },
    { name: 'Feishu docs', format: 'feishu.docs.xml', data: DOCS_EDIT_DOCUMENT, input: '[data-feishu-docs-title]', bodySave: '[data-feishu-docs-save]' },
  ])('keeps the ONE Save in the footer for $name and commits from the host', async ({ name, format, data, input, bodySave }) => {
    const calls = await mountDetail({
      format, renderer: feishuRenderer,
      read: async () => ({ format, data, fetchedAt: '2026-10-20T08:00:00.000Z' }),
      loadEdit: async () => ({ format, data, baseRevision: 'r1' }),
    })
    await enterEdit()
    const editor = q<HTMLElement>('[data-window-document-editor]')
    // The embedded renderer got no onSave: no body save control at all.
    expect(editor.querySelector(bodySave)).toBeNull()
    expect(editor.querySelectorAll('button')).toHaveLength(0)
    expect(saveControl()).toBeNull()
    const title = q<HTMLInputElement>(input)
    typeInto(title, `${name} edited`)
    await flush()
    expect(saveControl()).not.toBeNull()
    expect(saveControl()!.hasAttribute('disabled')).toBe(false)
    // Ctrl/Cmd+Enter is handled by the HOST when embedded.
    act(() => { title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })) })
    await flush()
    expect(calls.saveEdit).toBe(1)
    expect(saveControl()).toBeNull()
    // The footer button itself is the same single write path.
    typeInto(title, `${name} edited again`)
    await flush()
    clickDetailSave()
    await flush()
    expect(calls.saveEdit).toBe(2)
    expect(editor.querySelector(bodySave)).toBeNull()
  })
  it('keeps the toolbar on a failed read, retries, and keeps the body while refreshing', async () => {
    let attempts = 0
    let resolveRefresh!: (value: ClueReadResult) => void
    const calls = await mountDetail({
      read: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('network down')
        if (attempts === 2) return READ_OLD
        return await new Promise<ClueReadResult>((resolve) => { resolveRefresh = resolve })
      },
    }, { target: { ...TARGET, locator: { path: 'a.md', url: 'https://example.com/a' } } })
    // A failed read keeps the toolbar and an explicit retry.
    expect(frame().querySelector('[data-clue-detail-view="failure"]')).not.toBeNull()
    expect(frame().querySelector('[data-clue-detail-refresh]')).not.toBeNull()
    click(frame(), 'Retry')
    await flush()
    expect(calls.read).toBe(2)
    expect(previewHeading()).toBe('Read only')
    const toolbar = q<HTMLElement>('[data-clue-detail-toolbar]')
    expect(toolbar.querySelector('[data-clue-detail-cached]')?.getAttribute('data-clue-detail-cached')).toBe('2026-10-20T08:00:00.000Z')
    expect(toolbar.querySelector('[data-clue-detail-source]')?.getAttribute('href')).toBe('https://example.com/a')
    expect(frame().querySelector('[data-window-document-preview] [data-clue-detail-refresh]')).toBeNull()
    // Refresh keeps the current body and shows its fixed disabled spinner.
    act(() => { q<HTMLButtonElement>('[data-clue-detail-refresh]').click() })
    await flush()
    expect(calls.read).toBe(3)
    expect(previewHeading()).toBe('Read only')
    const refresh = q<HTMLButtonElement>('[data-clue-detail-refresh]')
    expect(refresh.hasAttribute('disabled')).toBe(true)
    expect(refresh.querySelector('[data-loading-indicator]')).not.toBeNull()
    await act(async () => { resolveRefresh({ format: 'text/markdown', data: { text: '# Refreshed' }, fetchedAt: '2026-10-21T10:00:00.000Z' }); await Promise.resolve() })
    await flush()
    expect(previewHeading()).toBe('Refreshed')
    expect(q<HTMLButtonElement>('[data-clue-detail-refresh]').hasAttribute('disabled')).toBe(false)
  })
  it('remounts the binding panel after a save, refreshes it on library events, and unsubscribes on close', async () => {
    const shared = subscribingReadCache()
    const calls = await mountDetail({}, { target: TARGET, readCache: shared.cache })
    expect(shared.listenerCount()).toBe(1)
    expect(bindingRevision()).toBe('0')
    expect(calls.bindingsList).toBe(1)
    await enterEdit('# Saved binding draft')
    await flush()
    clickDetailSave()
    await flush()
    expect(calls.saveEdit).toBe(1)
    // The pre-save panel is gone and the remounted one re-read the bindings.
    expect(bindingRevision()).toBe('1')
    expect(calls.bindingsList).toBe(2)
    act(() => { shared.emit({ kind: 'library', workspaceId: 'other-ws' }) })
    await flush()
    expect(calls.bindingsList).toBe(2)
    act(() => { shared.emit({ kind: 'library', workspaceId: 'ws-1' }) })
    await flush()
    expect(calls.bindingsList).toBe(3)
    expect(bindingRevision()).toBe('2')
    click(frame(), 'Close')
    await flush()
    expect(document.querySelector('[data-floating-window]')).toBeNull()
    expect(shared.stats.unsubscribes).toBe(1)
    expect(shared.listenerCount()).toBe(0)
    act(() => { shared.emit({ kind: 'library', workspaceId: 'ws-1' }) })
    await flush()
    expect(calls.bindingsList).toBe(3)
  })
  it('never adopts an unsaved edit title, adopts the saved title, and flows metadata into insert/add-to-pack', async () => {
    const inserted: string[] = []
    const added: ClueDetailTarget[] = []
    const { options } = titleDocument({ title: 'Source issue title', body: 'Body', sourceUrl: 'https://example.com/doc' }, { state: 'active', repository: 'acme/widgets', number: 42 })
    const calls = await mountDetail(options, {
      target: { ...candidateTarget('owner/repo#42'), subtitle: 'acme/widgets' },
      onInsertClue: (_clueId, title) => { inserted.push(title); return true },
      onAddToPack: target => { added.push(target) },
    })
    expect(host!.getSnapshot().windows[0]!.id).toBe(clueDetailWindowId(candidateTarget('owner/repo#42')))
    expect(frame().getAttribute('aria-label')).toBe('Source issue title')
    // A credential-free read URL fills the source link when the locator has none.
    expect(frame().querySelector('[data-clue-detail-source]')?.getAttribute('href')).toBe('https://example.com/doc')
    await enterEdit()
    const input = q<HTMLInputElement>('[data-window-document-editor] [data-test-title-input]')
    expect(input.value).toBe('Source issue title')
    typeInto(input, 'Fresh saved title')
    await flush()
    // Unsaved drafts never change the shared window title.
    expect(frame().getAttribute('aria-label')).toBe('Source issue title')
    clickDetailSave()
    await flush()
    expect(calls.saveEdit).toBe(1)
    expect(frame().getAttribute('aria-label')).toBe('Fresh saved title')
    click(frame(), 'Insert resources')
    await flush()
    expect(calls.ensure[0]).toMatchObject({ title: 'Fresh saved title', subtitle: 'acme/widgets', info: { state: 'active', repository: 'acme/widgets', number: 42 } })
    expect(inserted).toEqual(['Fresh saved title'])
    click(frame(), 'Add to pack')
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ title: 'Fresh saved title', subtitle: 'acme/widgets', info: { state: 'active', repository: 'acme/widgets', number: 42 } })
  })
  it('aborts a pending read on an auth boundary and ignores the late old-account response', async () => {
    let resolveOld!: (value: ClueReadResult) => void
    let oldSignal: AbortSignal | undefined
    const shared = subscribingReadCache()
    const calls = await mountDetail({
      read: (call, signal) => {
        if (call === 1) { oldSignal = signal; return new Promise<ClueReadResult>((resolve) => { resolveOld = resolve }) }
        return Promise.resolve({ format: 'text/markdown', data: { title: 'New account title', text: '# new' }, fetchedAt: '2026-10-20T09:00:00.000Z' })
      },
    }, { target: candidateTarget('owner/repo#42'), readCache: shared.cache })
    expect(calls.read).toBe(1)
    expect(oldSignal?.aborted).toBe(false)
    act(() => { shared.emit({ kind: 'auth' }) })
    await flush()
    expect(oldSignal?.aborted).toBe(true)
    expect(shared.stats.invalidations).toBe(1)
    expect(calls.read).toBe(2)
    expect(frame().getAttribute('aria-label')).toBe('New account title')
    // The old identity's response arrives late; it must never be accepted.
    await act(async () => { resolveOld({ format: 'text/markdown', data: { title: 'Old account title', text: '# old' }, fetchedAt: '2026-10-20T08:00:00.000Z' }); await Promise.resolve() })
    await flush()
    expect(frame().getAttribute('aria-label')).toBe('New account title')
    expect(previewHeading()).toBe('new')
    expect(calls.read).toBe(2)
  })
  it('aborts a pending edit load on an auth boundary and never accepts its old-account draft', async () => {
    let resolveEdit!: (value: unknown) => void
    let editSignal: AbortSignal | undefined
    const shared = subscribingReadCache(() => READ_OLD)
    const calls = await mountDetail({
      loadEdit: (signal) => { editSignal = signal; return new Promise((resolve) => { resolveEdit = resolve }) },
    }, { target: candidateTarget('owner/repo#42'), readCache: shared.cache })
    act(() => { modeTab('edit').click() })
    expect(frame().querySelector('[data-window-edit-loading]')).not.toBeNull()
    expect(editSignal?.aborted).toBe(false)
    act(() => { shared.emit({ kind: 'auth' }) })
    await flush()
    expect(editSignal?.aborted).toBe(true)
    await act(async () => { resolveEdit({ format: 'text/markdown', data: { text: '# old account draft' }, baseRevision: 'r1' }); await Promise.resolve() })
    await flush()
    expect(paneHidden('[data-window-document-editor]')).toBe(true)
    expect(frame().querySelector('[data-window-edit-loading]')).toBeNull()
    expect(frame().querySelector<HTMLTextAreaElement>('[data-window-text-editor]')?.value).not.toBe('# old account draft')
    expect(calls.loadEdit).toBe(1)
  })
  it('preserves a dirty draft on auth change, blocks Save, and requires an explicit fresh base', async () => {
    const shared = subscribingReadCache(() => READ_OLD)
    const calls = await mountDetail({}, { target: candidateTarget('owner/repo#42'), readCache: shared.cache })
    const editor = await enterEdit('# Kept draft')
    await flush()
    act(() => { shared.emit({ kind: 'auth' }) })
    await flush()
    expect(editor.value).toBe('# Kept draft')
    expect(windowError()).toContain('Not authorized')
    expect(saveControl()).toBeNull()
    expect(frame().querySelector('[data-clue-detail-reread]')).not.toBeNull()
    // Dirty drafts are not silently replaced by a new-account read.
    expect(calls.read).toBe(1)
    click(frame(), 'Re-read')
    await flush()
    expect(calls.loadEdit).toBe(2)
    expect(frame().querySelector('[data-window-error]')).toBeNull()
    expect(bodyEditor().value).toBe('# Draft')
  })
  it('disables candidate Insert/Add-to-pack until the first read, while a stable clue keeps them', async () => {
    let resolveRead!: (value: ClueReadResult) => void
    const shared = subscribingReadCache()
    const added: ClueDetailTarget[] = []
    const calls = await mountDetail({
      read: () => new Promise<ClueReadResult>((resolve) => { resolveRead = resolve }),
    }, { target: candidateTarget('owner/repo#42'), readCache: shared.cache, insert: true, onAddToPack: target => { added.push(target) } })
    expect(calls.read).toBe(1)
    const insert = (): HTMLButtonElement => q('[data-clue-detail-insert]')
    const add = (): HTMLButtonElement => q('[data-clue-detail-add-to-pack]')
    expect(insert().disabled).toBe(true)
    expect(add().disabled).toBe(true)
    act(() => { insert().click() })
    await flush()
    expect(calls.ensure).toHaveLength(0)
    expect(added).toHaveLength(0)
    await act(async () => { resolveRead(READ_OLD); await Promise.resolve() })
    await flush()
    expect(insert().disabled).toBe(false)
    expect(add().disabled).toBe(false)
    // A stable clue already has an identity: its actions stay available.
    const windows = recordingWindows()
    const { face } = faceOf({ read: () => new Promise<ClueReadResult>(() => {}) })
    act(() => {
      openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', target: { ...TARGET, clueId: 'c-stable' }, onInsertClue: () => true, onAddToPack: () => undefined })
    })
    const footer = renderNode(windows.last()?.footer)
    expect(footer.container.querySelector<HTMLButtonElement>('[data-clue-detail-insert]')!.disabled).toBe(false)
    expect(footer.container.querySelector<HTMLButtonElement>('[data-clue-detail-add-to-pack]')!.disabled).toBe(false)
    footer.unmount()
  })
  it('loads comments independently, keeps the draft on a resource event, and retains loaded comments on page failure', async () => {
    const cache = subscribingReadCache()
    let releaseBody!: (value: ClueReadResult) => void
    let pages = 0
    const inputs: Record<string, unknown>[] = []
    const { face, calls } = faceOf({
      read: () => new Promise(resolve => { releaseBody = resolve }),
      readInput: input => { inputs.push(input) },
      commentsList: async input => {
        pages += 1
        if (input.cursor === 'next') throw new Error('next-page-unavailable')
        return discussionPage({ complete: false, nextCursor: 'next', items: [{ id: 'review-1', kind: 'review', format: 'text/plain', body: 'Review summary', reviewState: 'APPROVED', author: { name: 'Reviewer' } }] })
      },
      commentsCreate: async () => { throw new Error('not used') },
    })
    const windows = recordingWindows()
    act(() => { openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', target: { ...TARGET, clueId: 'ui19-comments' }, readCache: cache.cache }) })
    await flush()
    expect(pages).toBe(1)
    expect(inputs[0]).toMatchObject({ includeDiscussion: false })
    releaseBody(READ_OLD)
    await flush()
    const comments = renderNode(afterBodyOf(windows))
    const textarea = comments.container.querySelector<HTMLTextAreaElement>('[data-clue-comment-input]')!
    typeInto(textarea, 'Unsent comment')
    const catalogueCalls = calls.sources
    expect(comments.container.textContent).toContain('Review summary')
    expect(comments.container.querySelector('[data-clue-review-state="APPROVED"]')).not.toBeNull()
    // A resource comment event refreshes the thread but keeps the unsent draft.
    act(() => { cache.emit({ kind: 'resource', workspaceId: 'ws-1', resource: { clueId: 'ui19-comments' } }) })
    await flush()
    rerenderNode(comments, windows)
    expect(comments.container.querySelector('[data-clue-comment-input]')).toBe(textarea)
    expect(textarea.value).toBe('Unsent comment')
    expect(calls.sources).toBe(catalogueCalls)
    expect(pages).toBe(2)
    clickSel(comments.container, '[data-clue-comments-more]')
    await flush()
    rerenderNode(comments, windows)
    expect(comments.container.textContent).toContain('Review summary')
    expect(comments.container.querySelector('[role="alert"]')).not.toBeNull()
    expect(comments.container.querySelector('[data-clue-comments-more]')).not.toBeNull()
    comments.unmount()
  })
  it('appends same-revision pages, but retains the readable body on revision changes', async () => {
    let revision = 'r1'
    const inputs: Record<string, unknown>[] = []
    const { face } = faceOf({
      readInput: input => { inputs.push(input) },
      read: async call => call === 1
        ? { format: 'text/plain', data: { text: 'first-' }, revision: 'r1', fetchedAt: '', limited: true, nextOffset: 6 }
        : { format: 'text/plain', data: { text: 'next-' }, revision, fetchedAt: '', limited: true, nextOffset: 11 },
    })
    const windows = recordingWindows()
    act(() => { openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', target: { ...TARGET, clueId: 'ui19-continuation' } }) })
    await flush()
    const controls = renderNode(afterBodyOf(windows))
    clickSel(controls.container, '[data-clue-body-more]')
    await flush()
    expect(inputs[1]).toMatchObject({ offset: 6, includeDiscussion: false })
    expect(bodyOf(windows).document.data).toEqual({ text: 'first-next-' })
    revision = 'r2'
    rerenderNode(controls, windows)
    clickSel(controls.container, '[data-clue-body-more]')
    await flush()
    rerenderNode(controls, windows)
    expect(bodyOf(windows).document.data).toEqual({ text: 'first-next-' })
    expect(controls.container.querySelector('[role="alert"]')).not.toBeNull()
    controls.unmount()
  })
  it('retains resource pagination while loading replies, retries a broken reply cursor, and adopts the posted reply once', async () => {
    const requests: Record<string, unknown>[] = []
    const writes: Record<string, unknown>[] = []
    let fail = true
    const { face } = faceOf({
      commentsList: async input => {
        requests.push(input)
        if (input.parentId === 'c1') {
          if (fail) throw new SidebarApiError('failed', 'reply page temporarily unavailable')
          return discussionPage({ items: [{ id: 'r1', kind: 'reply', format: 'text/plain', body: 'Fetched reply', replyToId: 'c1' }] })
        }
        return discussionPage({ complete: false, nextCursor: 'resource-next', items: [{ id: 'c1', kind: 'comment', format: 'text/plain', body: 'Top comment', nextRepliesCursor: 'replies-next' }] })
      },
      commentsCreate: async input => {
        writes.push(input)
        return { savedAt: '', comment: { id: 'r2', kind: 'reply', format: 'text/plain', body: String(input.body), replyToId: 'c1' } }
      },
    })
    const { windows, node } = await openAfterBody(face, 'ui19-reply-pagination')
    clickSel(node.container, '[data-clue-comment-replies="c1"]')
    await flush()
    rerenderNode(node, windows)
    expect(node.container.textContent).toContain('Top comment')
    expect(node.container.textContent).toContain('reply page temporarily unavailable')
    fail = false
    click(node.container, 'Retry')
    await flush()
    rerenderNode(node, windows)
    expect(requests.at(-1)).toMatchObject({ parentId: 'c1', cursor: 'replies-next' })
    expect(node.container.textContent).toContain('Fetched reply')
    expect(node.container.querySelector('[data-clue-comment-replies="c1"]')).toBeNull()
    expect(node.container.querySelector('[data-clue-comments-more]')).not.toBeNull()
    clickSel(node.container, '[data-clue-comment-reply="c1"]')
    typeInto(node.container.querySelector<HTMLTextAreaElement>('[data-clue-comment-input]')!, 'New reply')
    clickSel(node.container, '[data-clue-comment-submit]')
    await flush()
    rerenderNode(node, windows)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ body: 'New reply', replyToId: 'c1', requestId: expect.any(String) })
    expect(node.container.querySelectorAll('[data-clue-comment="r2"]')).toHaveLength(1)
    node.unmount()
  })
  it('loads the new account discussion while an old-account comment submission is still pending', async () => {
    const cache = subscribingReadCache()
    let pages = 0
    let finishWrite!: (value: ClueCommentCreateResult) => void
    const { face } = faceOf({
      commentsList: async () => {
        pages += 1
        return discussionPage({ items: [{ id: `account-${pages}`, kind: 'comment', format: 'text/plain', body: `Account ${pages}` }] })
      },
      commentsCreate: () => new Promise(resolve => { finishWrite = resolve }),
    })
    const { windows, node } = await openAfterBody(face, 'ui19-auth-comment', cache.cache)
    typeInto(node.container.querySelector<HTMLTextAreaElement>('[data-clue-comment-input]')!, 'Old account draft')
    clickSel(node.container, '[data-clue-comment-submit]')
    await flush()
    act(() => { cache.emit({ kind: 'auth' }) })
    await flush()
    expect(pages).toBe(2)
    finishWrite({ savedAt: '', comment: { id: 'old-write', kind: 'comment', format: 'text/plain', body: 'Old account draft' } })
    await flush()
    rerenderNode(node, windows)
    expect(node.container.textContent).toContain('Account 2')
    expect(node.container.querySelector('[data-clue-comment="old-write"]')).toBeNull()
    node.unmount()
  })
  it('clears a pre-write comment read cancellation error after the comment posts successfully', async () => {
    let rejectPage!: (failure: unknown) => void
    const { face } = faceOf({
      commentsList: input => input.cursor === 'pending-page'
        ? new Promise((_resolve, reject) => { rejectPage = reject })
        : Promise.resolve(discussionPage({ complete: false, nextCursor: 'pending-page', items: [{ id: 'root-post', kind: 'comment', format: 'text/plain', body: 'Existing comment' }] })),
      commentsCreate: async input => {
        rejectPage(new SidebarApiError('failed', 'pre-write page cancelled'))
        // Model the cache invalidation rejecting its old subscriber before the
        // successful mutation result is delivered to this controller.
        for (let i = 0; i < 4; i++) await Promise.resolve()
        return { savedAt: '', comment: { id: 'posted', kind: 'comment', format: 'text/plain', body: String(input.body) } }
      },
    })
    const { windows, node } = await openAfterBody(face, 'ui19-post-read-cancel')
    clickSel(node.container, '[data-clue-comments-more]')
    await flush()
    rerenderNode(node, windows)
    typeInto(node.container.querySelector<HTMLTextAreaElement>('[data-clue-comment-input]')!, 'Successful comment')
    clickSel(node.container, '[data-clue-comment-submit]')
    await flush()
    rerenderNode(node, windows)
    expect(node.container.querySelector('[data-clue-comment="posted"]')?.textContent).toContain('Successful comment')
    expect(node.container.querySelector('[role="alert"]')).toBeNull()
    node.unmount()
  })