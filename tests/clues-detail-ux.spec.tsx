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
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement, Fragment, type ReactNode } from 'react'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { WindowHost } from '../src/client/windows/WindowHost.tsx'
import { createWindowHost } from '../src/client/windows/host.ts'
import type { WindowDocumentContent, WindowHostController, WindowOpenOptions, WindowHandle } from '../src/client/windows/types.ts'
import {
  clueDetailWindowId,
  deriveTaskInfo,
  openClueDetailWindow,
  type ClueDetailDataChange,
  type ClueDetailDataChangeListener,
  type ClueDetailReadCache,
  type ClueDetailTarget,
} from '../src/client/clues/windows/detail.tsx'
import type { BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import type { ClueFormatRenderer, ClueReadResult, JsonValue, Locator } from '../src/clues/types.ts'
import type { ClueResourceInfo } from '../src/client/clues/resource-summary.tsx'
import { FeishuDocsPreview } from '../src/client/clues/sources/feishu/docs-preview.tsx'
import { FeishuTaskEditor } from '../src/client/clues/sources/feishu/task-editor.tsx'
import { DEFAULT_FEISHU_LABELS } from '../src/client/clues/sources/feishu/labels.ts'
import { SidebarApiError } from '../src/client/api.ts'

setupReactAct()
beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

const VIEWPORT = { width: 1_000, height: 800 }

interface Calls {
  read: number
  loadEdit: number
  saveEdit: number
  sources: number
  bindingsList: number
  ensure: { title: string; subtitle?: string; info?: ClueResourceInfo }[]
}

interface FaceOptions {
  read?: (call: number, signal?: AbortSignal) => Promise<ClueReadResult>
  loadEdit?: (signal?: AbortSignal) => Promise<unknown>
  saveEdit?: (input: unknown) => Promise<unknown>
  edit?: boolean
  format?: string
  renderer?: ClueFormatRenderer
  commentsList?: (input: Record<string, unknown>) => Promise<import('../src/clues/types.ts').ClueDiscussionPage>
  commentsCreate?: (input: Record<string, unknown>) => Promise<import('../src/clues/types.ts').ClueCommentCreateResult>
  readInput?: (input: Record<string, unknown>) => void
}

const READ_OLD: ClueReadResult = {
  format: 'text/markdown',
  data: { text: '# Read only' },
  fetchedAt: '2026-10-20T08:00:00.000Z',
}

function faceOf(options: FaceOptions = {}): {
  face: BetterSidebarCluesClientFace
  calls: Calls
} {
  const calls: Calls = { read: 0, loadEdit: 0, saveEdit: 0, sources: 0, bindingsList: 0, ensure: [] }
  const api = {
    ...(options.commentsList === undefined ? {} : { commentsList: async (_workspaceId: string, input: Record<string, unknown>) => options.commentsList!(input) }),
    ...(options.commentsCreate === undefined ? {} : { commentsCreate: async (_workspaceId: string, input: Record<string, unknown>) => options.commentsCreate!(input) }),
    sources: async () => {
      calls.sources += 1
      const editable = options.edit !== false
      return {
        sources: [{
          sourceId: 'builtin.files',
          name: 'Local files',
          order: 0,
          pluginId: 'dsh-better-sidebar',
          types: ['builtin.files.markdown'],
          transport: 'files' as const,
          capabilities: { resolve: true, list: true, search: true, read: true, edit: editable, portable: true,
            ...(options.commentsList === undefined ? {} : { comments: { read: true, create: true, reply: 'native' } }) },
        }],
        types: [{
          typeId: 'builtin.files.markdown',
          sourceId: 'builtin.files',
          formats: ['text/markdown'],
          capabilities: { read: true, edit: editable, concurrency: 'check-before-save' as const },
        }],
      }
    },
    read: async (_workspaceId: string, _input: unknown, signal?: AbortSignal) => {
      calls.read += 1
      options.readInput?.(_input as Record<string, unknown>)
      return options.read?.(calls.read, signal) ?? READ_OLD
    },
    loadEdit: async (_workspaceId: string, _input: unknown, signal?: AbortSignal) => {
      calls.loadEdit += 1
      return options.loadEdit?.(signal) ?? { format: 'text/markdown', data: { text: '# Draft' }, baseRevision: 'r1' }
    },
    saveEdit: async (_workspaceId: string, input: unknown) => {
      calls.saveEdit += 1
      return options.saveEdit?.(input) ?? { revision: 'r2', savedAt: '2026-10-21T09:00:00.000Z' }
    },
    ensure: async (_workspaceId: string, input: { title: string; subtitle?: string; info?: ClueResourceInfo }) => {
      calls.ensure.push(input)
      return { clue: { id: 'c9' }, created: true }
    },
    bindingsList: async () => {
      calls.bindingsList += 1
      return { bindings: [], revision: 1 }
    },
  }
  const face = {
    api,
    registerSourceDisplay: () => () => {},
    getSourceDisplays: () => [],
    registerFormatRenderer: () => () => {},
    getFormatRenderer: (format: string) =>
      options.renderer !== undefined && format === options.format ? options.renderer : undefined,
    getFormatRenderers: () => new Map(),
    subscribe: () => () => {},
    isSourceEnabled: () => true,
    isSourceMentionEnabled: () => true,
    isPacksMentionEnabled: () => true,
  } as unknown as BetterSidebarCluesClientFace
  return { face, calls }
}

/** A window host that records opens/updates (no DOM). */
function recordingWindows(): {
  windows: { open(options: WindowOpenOptions): WindowHandle }
  last(): WindowOpenOptions | undefined
} {
  let last: WindowOpenOptions | undefined
  return {
    windows: {
      open(options: WindowOpenOptions): WindowHandle {
        last = options
        return {
          id: options.id,
          update(patch) {
            last = { ...(last ?? options), ...patch } as WindowOpenOptions
          },
          focus: () => undefined,
          close: async () => undefined,
          navigation: { push: () => undefined, pop: () => false, back: () => false, canGoBack: () => false, depth: () => 1 },
        }
      },
    },
    last: () => last,
  }
}

async function flush(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

/** Render one content descriptor (or the header slot) outside a window host. */
function renderNode(node: ReactNode): RenderedRoot {
  return renderRoot(createElement(Fragment, null, node))
}

function frame(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-floating-window]')
  if (node === null) throw new Error('no floating window')
  return node
}

function click(container: ParentNode, label: string): void {
  const button = [...container.querySelectorAll('button')]
    .find(candidate => (candidate.textContent ?? '').trim() === label || candidate.getAttribute('aria-label') === label)
  if (button === undefined) throw new Error(`button "${label}" not found`)
  act(() => { button.click() })
}

function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** An injected shared-cache seam with a controllable data-change listener. */
function subscribingReadCache(peek: () => ClueReadResult | undefined = () => undefined) {
  const listeners = new Set<ClueDetailDataChangeListener>()
  const stats = { invalidations: 0, unsubscribes: 0 }
  const cache: ClueDetailReadCache = {
    peek: () => peek(),
    invalidate: () => { stats.invalidations += 1 },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        stats.unsubscribes += 1
      }
    },
  }
  return {
    cache,
    stats,
    listenerCount: () => listeners.size,
    emit(change: ClueDetailDataChange) {
      for (const listener of [...listeners]) listener(change)
    },
  }
}

const TARGET = {
  sourceId: 'builtin.files',
  typeId: 'builtin.files.markdown',
  clueId: 'c-detail',
  locator: { path: 'a.md' } as Locator,
  title: 'A note',
}

let host: WindowHostController | undefined
let view: RenderedRoot | undefined

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height })
})

afterEach(() => {
  view?.unmount()
  view = undefined
  host?.dispose()
  host = undefined
  document.body.innerHTML = ''
})

/** Mount the real window host and open one detail. */
async function mountDetail(
  options: FaceOptions = {},
  extra: {
    readCache?: ClueDetailReadCache
    target?: ClueDetailTarget
    subtitle?: string
    info?: ClueResourceInfo
    insert?: boolean
    onInsertClue?: (clueId: string, title: string) => boolean
    onAddToPack?: (target: ClueDetailTarget) => void
  } = {},
): Promise<{ face: BetterSidebarCluesClientFace; calls: Calls; target: ClueDetailTarget }> {
  const { face, calls } = faceOf(options)
  host = createWindowHost({ viewport: () => VIEWPORT })
  view = renderRoot(createElement(WindowHost, { host, formats: face }))
  const target = extra.target ?? TARGET
  act(() => {
    openClueDetailWindow({
      windows: host!,
      face,
      workspaceId: 'ws-1',
      target: {
        ...target,
        ...(extra.subtitle === undefined ? {} : { subtitle: extra.subtitle }),
        ...(extra.info === undefined ? {} : { info: extra.info }),
      },
      ...(extra.readCache === undefined ? {} : { readCache: extra.readCache }),
      ...(extra.insert === true || extra.onInsertClue !== undefined
        ? { onInsertClue: extra.onInsertClue ?? (() => true) }
        : {}),
      ...(extra.onAddToPack === undefined ? {} : { onAddToPack: extra.onAddToPack }),
    })
  })
  await flush()
  return { face, calls, target }
}

describe('clue detail read path', () => {
  it('renders a hot cached preview synchronously and never loads the edit document', async () => {
    const windows = recordingWindows()
    const { face, calls } = faceOf()
    const cache: ClueDetailReadCache = {
      peek: () => ({ ...READ_OLD, info: { repository: 'acme/widgets', number: 7, state: 'open' } }),
      invalidate: () => undefined,
    }
    act(() => {
      openClueDetailWindow({
        windows: windows.windows,
        face,
        workspaceId: 'ws-1',
        target: { ...TARGET, info: { author: { id: 'u1' } } },
        readCache: cache,
      })
    })
    const initial = windows.last()?.content as WindowDocumentContent
    // The first WindowOpenOptions content is a document, not a spinner-only node.
    expect(initial.kind).toBe('document')
    expect(initial.document.data).toEqual({ text: '# Read only' })
    expect(initial.readOnly).toBe(true)
    expect(initial.mode).toBe('preview')
    expect(initial.header).toBeDefined()
    expect(initial.loading).toBeUndefined()
    // Even the first content already merges target info with the cached read.
    const header = renderNode(initial.header!)
    expect(header.container.querySelector<HTMLElement>('[data-clue-resource-summary]')?.dataset.clueResourceRepository)
      .toBe('acme/widgets')
    header.unmount()
    await flush()
    expect(calls.loadEdit).toBe(0)
  })

  it('overlays the authoritative read info over the target snapshot', async () => {
    const windows = recordingWindows()
    const { face } = faceOf({
      read: async () => ({
        ...READ_OLD,
        info: { state: 'closed', number: 9, repository: 'acme/widgets', author: { id: 'read-author' } },
      }),
    })
    act(() => {
      openClueDetailWindow({
        windows: windows.windows,
        face,
        workspaceId: 'ws-1',
        target: { ...TARGET, info: { state: 'open', number: 7, author: { name: 'List author' } } },
      })
    })
    await flush()
    const content = windows.last()?.content as WindowDocumentContent
    const header = renderNode(content.header!)
    const summary = header.container.querySelector<HTMLElement>('[data-clue-resource-summary]')!
    expect(summary.dataset.clueResourceState).toBe('closed')
    expect(summary.dataset.clueResourceNumber).toBe('9')
    expect(summary.dataset.clueResourceRepository).toBe('acme/widgets')
    expect(summary.querySelector<HTMLElement>('[data-clue-resource-item="author"]')?.textContent).toContain('read-author')
    header.unmount()
  })

  it('offers a read-only type with no Edit and explains why', async () => {
    await mountDetail({ edit: false })
    const content = host!.getSnapshot().windows[0]!.content as WindowDocumentContent
    expect(content.readOnly).toBe(true)
    expect(content.onModeChange).toBeUndefined()
    expect(frame().querySelector('[data-window-mode-tab="edit"]')).toBeNull()
    expect(frame().querySelector('[data-window-read-only]')).not.toBeNull()
    expect(frame().querySelector('[data-clue-detail-refresh]')).not.toBeNull()
  })
})

describe('clue detail lazy edit and save', () => {
  it('loads the edit document only after Edit and keeps preview/edit bodies mounted', async () => {
    const { calls } = await mountDetail()
    expect(calls.loadEdit).toBe(0)
    expect(frame().querySelector<HTMLElement>('[data-window-document-preview]')!.hidden).toBe(false)
    act(() => { frame().querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    // The lazy load shows its own fixed spinner until the edit document lands.
    expect(frame().querySelector('[data-window-edit-loading]')).not.toBeNull()
    await flush()
    expect(calls.loadEdit).toBe(1)
    expect(frame().querySelector('[data-window-edit-loading]')).toBeNull()
    expect(frame().querySelector<HTMLElement>('[data-window-document-editor]')!.hidden).toBe(false)
    expect(frame().querySelector<HTMLElement>('[data-window-document-preview]')!.hidden).toBe(true)
    const editor = frame().querySelector<HTMLTextAreaElement>('[data-window-text-editor]')!
    typeInto(editor, '# Unsaved draft')
    expect(frame().querySelector<HTMLElement>('[data-clue-detail-refresh]')!.hasAttribute('disabled')).toBe(true)
    act(() => { frame().querySelector<HTMLButtonElement>('[data-window-mode-tab="preview"]')!.click() })
    expect(frame().querySelector<HTMLElement>('[data-window-document-preview] h1')?.textContent).toBe('Unsaved draft')
    expect(frame().querySelector('[data-window-text-editor]')).toBe(editor)
  })

  it('keeps an unsaved draft on close and discards only after the explicit action', async () => {
    await mountDetail()
    act(() => { frame().querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    await flush()
    const editor = frame().querySelector<HTMLTextAreaElement>('[data-window-text-editor]')!
    typeInto(editor, '# Keep me')
    const close = frame().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
    await act(async () => { close.click(); await Promise.resolve() })
    expect(document.querySelector('[data-floating-window]')).not.toBeNull()
    expect(frame().querySelector<HTMLElement>('[data-window-document-editor]')!.hidden).toBe(false)
    expect(frame().querySelector<HTMLTextAreaElement>('[data-window-text-editor]')!.value).toBe('# Keep me')
    expect(frame().querySelector('[data-window-error]')?.textContent).toContain('Unsaved edits')
    click(frame(), 'Discard edits')
    await flush()
    expect(document.querySelector('[data-floating-window]')).toBeNull()
  })

  it('saves with the edit baseline and never shows the stale read body on preview toggle', async () => {
    let resolveRead!: (value: ClueReadResult) => void
    const { calls } = await mountDetail({
      read: async (call) => {
        if (call === 1) return READ_OLD
        return await new Promise<ClueReadResult>((resolve) => { resolveRead = resolve })
      },
      saveEdit: async () => ({
        revision: 'r2',
        savedAt: '2026-10-21T09:00:00.000Z',
        info: { state: 'completed', repository: 'acme/widgets', number: 7 },
      }),
    })
    expect(calls.loadEdit).toBe(0)
    act(() => { frame().querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    await flush()
    expect(calls.loadEdit).toBe(1)
    const editor = frame().querySelector<HTMLTextAreaElement>('[data-window-text-editor]')!
    typeInto(editor, '# Saved draft')
    click(frame(), 'Save')
    await flush()
    expect(calls.saveEdit).toBe(1)
    // The save result's authoritative info reached the header immediately.
    expect(frame().querySelector<HTMLElement>('[data-clue-resource-summary]')?.dataset.clueResourceState)
      .toBe('completed')
    // Background read is still in flight; preview must show the saved draft.
    act(() => { frame().querySelector<HTMLButtonElement>('[data-window-mode-tab="preview"]')!.click() })
    expect(frame().querySelector<HTMLElement>('[data-window-document-preview] h1')?.textContent).toBe('Saved draft')
    expect(frame().querySelector('[data-window-document-preview] [data-window-text-read-only]')).not.toBeNull()
    // Once the fresh read lands, it becomes the preview body.
    await act(async () => {
      resolveRead({ format: 'text/markdown', data: { text: '# Fresh from read' }, fetchedAt: '2026-10-21T09:00:01.000Z' })
      await Promise.resolve()
    })
    await flush()
    expect(frame().querySelector<HTMLElement>('[data-window-document-preview] h1')?.textContent).toBe('Fresh from read')
  })

  it('keeps the draft and offers an explicit re-read on a save conflict', async () => {
    const { calls } = await mountDetail({
      saveEdit: async () => { throw new SidebarApiError('conflict', 'stale revision') },
    })
    act(() => { frame().querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    await flush()
    const editor = frame().querySelector<HTMLTextAreaElement>('[data-window-text-editor]')!
    typeInto(editor, '# Kept draft')
    click(frame(), 'Save')
    await flush()
    expect(calls.saveEdit).toBe(1)
    expect(frame().querySelector('[data-window-error]')?.textContent).toContain('changed elsewhere')
    expect(editor.value).toBe('# Kept draft')
    click(frame(), 'Re-read')
    await flush()
    expect(calls.loadEdit).toBe(2)
    // A fresh edit baseline is still edit mode with the explicit reader action.
    expect(frame().querySelector<HTMLElement>('[data-window-document-editor]')!.hidden).toBe(false)
  })
})

// A source renderer can be standalone-save-capable; the detail EMBEDS it and
// keeps the one Save in its own footer. Real Feishu renderers prove the body
// draws no second control.
const TASK_DOCUMENT = {
  kind: 'task',
  guid: 'g-1',
  title: 'Task title',
  description: 'Task body',
  start: { timestamp: '1700000000000', isAllDay: false },
  due: { timestamp: '1700003600000', isAllDay: false },
  completed: false,
} as unknown as JsonValue

it('keeps an incomplete task active rather than changing it to a GitHub-style open state', () => {
  expect(deriveTaskInfo('feishu.task.document', TASK_DOCUMENT, { state: 'active' })?.state).toBe('active')
})

const SAVED_AT = '2026-10-21T09:00:00.000Z'
const OLD_START = '2026-10-01T08:00:00.000Z'
const OLD_DUE = '2026-10-02T08:00:00.000Z'
const OLD_COMPLETED_AT = '2026-10-03T08:00:00.000Z'

const taskWith = (overrides: Record<string, unknown>): JsonValue =>
  ({ ...(TASK_DOCUMENT as Record<string, unknown>), ...overrides }) as unknown as JsonValue

const candidateTarget = (title: string): ClueDetailTarget => ({
  sourceId: 'builtin.files',
  typeId: 'builtin.files.markdown',
  locator: { path: 'a.md' },
  title,
})

const isoOf = (timestamp: string): string => new Date(Number(timestamp)).toISOString()

const DOCS_EDIT_DOCUMENT = {
  kind: 'docx',
  docToken: 'doccnA',
  title: 'Doc title',
  baselineTitle: 'Doc title',
  titleEditable: true,
  titleAttrs: '',
  blocks: [{
    id: 'blk-p1',
    tag: 'p',
    attrs: '',
    text: 'Hello',
    baseline: 'Hello',
    kind: 'plain',
    order: 1,
  }],
  readOnlyBlocks: [],
} as unknown as JsonValue

const feishuRenderer: ClueFormatRenderer = (props) => (props.format === 'feishu.task.document'
  ? createElement(FeishuTaskEditor, { ...props, labels: DEFAULT_FEISHU_LABELS })
  : createElement(FeishuDocsPreview, { ...props, labels: DEFAULT_FEISHU_LABELS }))

describe('task body dates win over a stale metadata snapshot', () => {
  it('clears target start/due/completedAt when the authoritative task body has none', () => {
    const info = deriveTaskInfo(
      'feishu.task.document',
      taskWith({ start: null, due: null, completed: false }),
      {
        state: 'completed',
        start: { at: OLD_START },
        due: { at: OLD_DUE },
        completedAt: OLD_COMPLETED_AT,
        author: { id: 'u1' },
        labels: ['keep'],
      },
    )
    expect(info).toEqual({ state: 'active', author: { id: 'u1' }, labels: ['keep'] })
  })

  it('takes changed body dates on save and clears them when the saved body clears', () => {
    const changed = deriveTaskInfo(
      'feishu.task.document',
      taskWith({
        start: { timestamp: '1800000000000', isAllDay: false },
        due: { timestamp: '1800003600000', isAllDay: true },
        completed: true,
      }),
      { state: 'active', start: { at: OLD_START }, due: { at: OLD_DUE } },
      'saved',
      SAVED_AT,
    )
    expect(changed?.start).toEqual({ at: isoOf('1800000000000') })
    expect(changed?.due).toEqual({ at: isoOf('1800003600000'), allDay: true })
    expect(changed?.state).toBe('completed')
    // Newly completed: the save instant is the actual completion time.
    expect(changed?.completedAt).toBe(SAVED_AT)
    const cleared = deriveTaskInfo(
      'feishu.task.document',
      taskWith({ start: null, due: null, completed: false }),
      { state: 'completed', start: { at: OLD_START }, due: { at: OLD_DUE }, completedAt: OLD_COMPLETED_AT },
      'saved',
      SAVED_AT,
    )
    expect(cleared).not.toHaveProperty('start')
    expect(cleared).not.toHaveProperty('due')
    expect(cleared).not.toHaveProperty('completedAt')
    expect(cleared?.state).toBe('active')
  })

  it('keeps the actual completion instant, lets the body value win, and clears it on reopen', () => {
    const preserved = deriveTaskInfo(
      'feishu.task.document',
      taskWith({ completed: true }),
      { state: 'completed', completedAt: OLD_COMPLETED_AT },
      'saved',
      SAVED_AT,
    )
    expect(preserved?.completedAt).toBe(OLD_COMPLETED_AT)
    const bodyWins = deriveTaskInfo(
      'feishu.task.document',
      taskWith({ completed: true, completedAt: '2026-10-04T08:00:00.000Z' }),
      { state: 'completed', completedAt: OLD_COMPLETED_AT },
    )
    expect(bodyWins?.completedAt).toBe('2026-10-04T08:00:00.000Z')
    const reopened = deriveTaskInfo(
      'feishu.task.document',
      taskWith({ completed: false }),
      { state: 'completed', completedAt: OLD_COMPLETED_AT },
      'saved',
      SAVED_AT,
    )
    expect(reopened).not.toHaveProperty('completedAt')
    expect(reopened?.state).toBe('active')
  })

  it('clears stale target dates after the read and never persists them on insert', async () => {
    const { calls } = await mountDetail({
      format: 'feishu.task.document',
      read: async () => ({
        format: 'feishu.task.document',
        data: taskWith({ start: null, due: null, completed: false }),
        fetchedAt: '2026-10-20T08:00:00.000Z',
      }),
    }, {
      target: candidateTarget('Task title'),
      info: {
        state: 'completed',
        start: { at: OLD_START },
        due: { at: OLD_DUE },
        completedAt: OLD_COMPLETED_AT,
        author: { id: 'u1' },
      },
      insert: true,
    })
    expect(frame().querySelector('[data-clue-resource-item="due"]')).toBeNull()
    click(frame(), 'Insert resources')
    await flush()
    expect(calls.ensure).toHaveLength(1)
    const info = calls.ensure[0]!.info
    expect(info).not.toHaveProperty('start')
    expect(info).not.toHaveProperty('due')
    expect(info).not.toHaveProperty('completedAt')
    expect(info?.author).toEqual({ id: 'u1' })
  })

  it('replaces start/due from the saved task body and clears them when the draft clears them', async () => {
    let current = taskWith({})
    const patchRenderer: ClueFormatRenderer = (props) => {
      const data = props.document.data as Record<string, unknown>
      return createElement(
        'div',
        { 'data-test-task-patch': '' },
        createElement('button', {
          type: 'button',
          'data-test-change-dates': '',
          onClick: () => { props.onChange({ ...data, start: { timestamp: '1800000000000', isAllDay: false }, due: { timestamp: '1800003600000', isAllDay: true }, completed: true } as unknown as JsonValue) },
        }, 'change'),
        createElement('button', {
          type: 'button',
          'data-test-clear-dates': '',
          onClick: () => { props.onChange({ ...data, start: null, due: null, completed: false } as unknown as JsonValue) },
        }, 'clear'),
      )
    }
    const { calls } = await mountDetail({
      format: 'feishu.task.document',
      renderer: patchRenderer,
      read: async () => ({ format: 'feishu.task.document', data: current, fetchedAt: '2026-10-20T08:00:00.000Z' }),
      loadEdit: async () => ({ format: 'feishu.task.document', data: current, baseRevision: 'r1' }),
      saveEdit: async (input) => {
        const document = (input as { document?: { data?: JsonValue } }).document
        if (document?.data !== undefined) current = document.data
        return { revision: 'r2', savedAt: SAVED_AT }
      },
    }, {
      target: candidateTarget('Task title'),
      info: { state: 'active', start: { at: OLD_START }, due: { at: OLD_DUE } },
    })
    act(() => { frame().querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    await flush()
    act(() => {
      frame().querySelector<HTMLElement>('[data-window-document-editor]')!
        .querySelector<HTMLButtonElement>('[data-test-change-dates]')!.click()
    })
    await flush()
    act(() => { frame().querySelector<HTMLButtonElement>('[data-clue-detail-save]')!.click() })
    await flush()
    expect(calls.saveEdit).toBe(1)
    expect(frame().querySelector('[data-clue-resource-item="due"]')).not.toBeNull()
    expect(frame().querySelector<HTMLElement>('[data-clue-resource-summary]')?.dataset.clueResourceState).toBe('completed')

    act(() => {
      frame().querySelector<HTMLElement>('[data-window-document-editor]')!
        .querySelector<HTMLButtonElement>('[data-test-clear-dates]')!.click()
    })
    await flush()
    act(() => { frame().querySelector<HTMLButtonElement>('[data-clue-detail-save]')!.click() })
    await flush()
    expect(calls.saveEdit).toBe(2)
    expect(frame().querySelector('[data-clue-resource-item="due"]')).toBeNull()
    expect(frame().querySelector<HTMLElement>('[data-clue-resource-summary]')?.dataset.clueResourceState).toBe('active')
  })
})

describe('clue detail unified save', () => {
  const scenarios = [
    {
      name: 'Feishu task',
      format: 'feishu.task.document',
      data: TASK_DOCUMENT,
      input: '[data-feishu-task-input="title"]',
      bodySave: '[data-feishu-task-save]',
    },
    {
      name: 'Feishu docs',
      format: 'feishu.docs.xml',
      data: DOCS_EDIT_DOCUMENT,
      input: '[data-feishu-docs-title]',
      bodySave: '[data-feishu-docs-save]',
    },
  ]

  for (const scenario of scenarios) {
    it(`keeps the ONE Save in the footer for ${scenario.name} and commits from the host`, async () => {
      const { calls } = await mountDetail({
        format: scenario.format,
        renderer: feishuRenderer,
        read: async () => ({
          format: scenario.format,
          data: scenario.data,
          fetchedAt: '2026-10-20T08:00:00.000Z',
        }),
        loadEdit: async () => ({ format: scenario.format, data: scenario.data, baseRevision: 'r1' }),
      })
      act(() => { frame().querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
      await flush()
      const editor = frame().querySelector<HTMLElement>('[data-window-document-editor]')!
      expect(editor).not.toBeNull()
      // The embedded renderer got no onSave: no body save control at all.
      expect(editor.querySelector(scenario.bodySave)).toBeNull()
      expect(editor.querySelectorAll('button')).toHaveLength(0)
      expect(frame().querySelector('[data-clue-detail-save]')).toBeNull()
      const input = frame().querySelector<HTMLInputElement>(scenario.input)!
      typeInto(input, `${scenario.name} edited`)
      await flush()
      const footerSave = frame().querySelector<HTMLButtonElement>('[data-clue-detail-save]')!
      expect(footerSave).not.toBeNull()
      expect(footerSave.hasAttribute('disabled')).toBe(false)
      // Ctrl/Cmd+Enter is handled by the HOST when embedded.
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
        }))
      })
      await flush()
      expect(calls.saveEdit).toBe(1)
      expect(frame().querySelector('[data-clue-detail-save]')).toBeNull()
      // The footer button itself is the same single write path.
      typeInto(input, `${scenario.name} edited again`)
      await flush()
      act(() => { frame().querySelector<HTMLButtonElement>('[data-clue-detail-save]')!.click() })
      await flush()
      expect(calls.saveEdit).toBe(2)
      expect(editor.querySelector(scenario.bodySave)).toBeNull()
    })
  }
})

describe('clue detail refresh', () => {
  it('keeps the current body and shows a fixed spinner while refreshing', async () => {
    let resolveRefresh!: (value: ClueReadResult) => void
    const { calls } = await mountDetail({
      read: async (call) => {
        if (call === 1) return READ_OLD
        return await new Promise<ClueReadResult>((resolve) => { resolveRefresh = resolve })
      },
    })
    expect(frame().querySelector<HTMLElement>('[data-window-document-preview] h1')?.textContent).toBe('Read only')
    act(() => { frame().querySelector<HTMLButtonElement>('[data-clue-detail-refresh]')!.click() })
    await flush()
    expect(calls.read).toBe(2)
    expect(frame().querySelector<HTMLElement>('[data-window-document-preview] h1')?.textContent).toBe('Read only')
    const refresh = frame().querySelector<HTMLButtonElement>('[data-clue-detail-refresh]')!
    expect(refresh.hasAttribute('disabled')).toBe(true)
    expect(refresh.querySelector('[data-loading-indicator]')).not.toBeNull()
    await act(async () => {
      resolveRefresh({ format: 'text/markdown', data: { text: '# Refreshed' }, fetchedAt: '2026-10-21T10:00:00.000Z' })
      await Promise.resolve()
    })
    await flush()
    expect(frame().querySelector<HTMLElement>('[data-window-document-preview] h1')?.textContent).toBe('Refreshed')
    expect(frame().querySelector<HTMLButtonElement>('[data-clue-detail-refresh]')!.hasAttribute('disabled')).toBe(false)
  })

  it('keeps Refresh visible after a failed read and retries without losing the toolbar', async () => {
    let attempts = 0
    const { calls } = await mountDetail({
      read: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('network down')
        return { format: 'text/markdown', data: { text: '# Recovered' }, fetchedAt: '2026-10-21T10:00:00.000Z' }
      },
    })
    expect(frame().querySelector('[data-clue-detail-view="failure"]')).not.toBeNull()
    expect(frame().querySelector('[data-clue-detail-refresh]')).not.toBeNull()
    click(frame(), 'Retry')
    await flush()
    expect(calls.read).toBe(2)
    expect(frame().querySelector<HTMLElement>('[data-window-document-preview] h1')?.textContent).toBe('Recovered')
  })

  it('shows a fixed Refresh toolbar on a source link and cache stamp, not in the body', async () => {
    const { face } = faceOf()
    host = createWindowHost({ viewport: () => VIEWPORT })
    view = renderRoot(createElement(WindowHost, { host, formats: face }))
    act(() => {
      openClueDetailWindow({
        windows: host!,
        face,
        workspaceId: 'ws-1',
        target: { ...TARGET, locator: { path: 'a.md', url: 'https://example.com/a' } },
      })
    })
    await flush()
    const toolbar = frame().querySelector<HTMLElement>('[data-clue-detail-toolbar]')!
    expect(toolbar).not.toBeNull()
    expect(toolbar.querySelector('[data-clue-detail-cached]')?.getAttribute('data-clue-detail-cached'))
      .toBe('2026-10-20T08:00:00.000Z')
    expect(toolbar.querySelector('[data-clue-detail-source]')?.getAttribute('href')).toBe('https://example.com/a')
    expect(frame().querySelector('[data-window-document-preview] [data-clue-detail-refresh]')).toBeNull()
  })
})

describe('binding panel CAS freshness', () => {
  it('remounts the already-open binding panel after a successful save', async () => {
    const { calls } = await mountDetail()
    expect(frame().querySelector('[data-clue-binding-revision]')?.getAttribute('data-clue-binding-revision')).toBe('0')
    await flush()
    expect(calls.bindingsList).toBe(1)
    act(() => { frame().querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    await flush()
    const editor = frame().querySelector<HTMLTextAreaElement>('[data-window-text-editor]')!
    typeInto(editor, '# Saved binding draft')
    await flush()
    act(() => { frame().querySelector<HTMLButtonElement>('[data-clue-detail-save]')!.click() })
    await flush()
    expect(calls.saveEdit).toBe(1)
    expect(frame().querySelector('[data-clue-binding-revision]')?.getAttribute('data-clue-binding-revision')).toBe('1')
    // The pre-save panel is gone and the remounted one re-read the bindings.
    expect(calls.bindingsList).toBe(2)
  })
})

describe('window title and source url follow the source', () => {
  it('adopts a hot-cache title before opening and a read title when it lands', async () => {
    const windows = recordingWindows()
    const { face } = faceOf({
      read: async () => ({
        format: 'text/markdown',
        data: { title: 'Read issue title', text: '# body' },
        fetchedAt: '2026-10-20T08:00:00.000Z',
      }),
    })
    const cache: ClueDetailReadCache = {
      peek: () => ({
        format: 'text/markdown',
        data: { title: 'Cached issue title', text: '# body' },
        fetchedAt: '2026-10-20T07:00:00.000Z',
      }),
      invalidate: () => undefined,
    }
    act(() => {
      openClueDetailWindow({
        windows: windows.windows,
        face,
        workspaceId: 'ws-1',
        target: candidateTarget('owner/repo#42'),
        readCache: cache,
      })
    })
    expect(windows.last()?.title).toBe('Cached issue title')
    await flush()
    expect(windows.last()?.title).toBe('Read issue title')
  })

  it('never adopts an unsaved edit title and adopts the saved edited title', async () => {
    let current: JsonValue = { title: 'Source title', body: 'Body' }
    const titleRenderer: ClueFormatRenderer = (props) => {
      const data = props.document.data as Record<string, JsonValue>
      return createElement('input', {
        'data-test-title-input': '',
        value: String(data.title ?? ''),
        onChange: (event: { target: { value: string } }) => {
          props.onChange({ ...data, title: event.target.value })
        },
      })
    }
    const { calls } = await mountDetail({
      format: 'text/markdown',
      renderer: titleRenderer,
      read: async () => ({ format: 'text/markdown', data: current, fetchedAt: '2026-10-20T08:00:00.000Z' }),
      loadEdit: async () => ({ format: 'text/markdown', data: current, baseRevision: 'r1' }),
      saveEdit: async (input) => {
        const document = (input as { document?: { data?: JsonValue } }).document
        if (document?.data !== undefined) current = document.data
        return { revision: 'r2', savedAt: SAVED_AT }
      },
    }, { target: candidateTarget('owner/repo#42') })
    expect(frame().getAttribute('aria-label')).toBe('Source title')
    act(() => { frame().querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    await flush()
    const input = frame().querySelector<HTMLElement>('[data-window-document-editor]')!
      .querySelector<HTMLInputElement>('[data-test-title-input]')!
    expect(input.value).toBe('Source title')
    typeInto(input, 'Edited title')
    await flush()
    // Unsaved drafts never change the shared window title.
    expect(frame().getAttribute('aria-label')).toBe('Source title')
    act(() => { frame().querySelector<HTMLButtonElement>('[data-clue-detail-save]')!.click() })
    await flush()
    expect(calls.saveEdit).toBe(1)
    expect(frame().getAttribute('aria-label')).toBe('Edited title')
  })

  it('flows the observed title and fresh metadata through ensure, insert and add-to-pack', async () => {
    let current: JsonValue = { title: 'Source issue title', body: 'Body' }
    const titleRenderer: ClueFormatRenderer = (props) => {
      const data = props.document.data as Record<string, JsonValue>
      return createElement('input', {
        'data-test-title-input': '',
        value: String(data.title ?? ''),
        onChange: (event: { target: { value: string } }) => {
          props.onChange({ ...data, title: event.target.value })
        },
      })
    }
    const inserted: string[] = []
    const added: ClueDetailTarget[] = []
    const { calls } = await mountDetail({
      format: 'text/markdown',
      renderer: titleRenderer,
      read: async () => ({
        format: 'text/markdown',
        data: current,
        fetchedAt: '2026-10-20T08:00:00.000Z',
        info: { state: 'active', repository: 'acme/widgets', number: 42 },
      }),
      loadEdit: async () => ({ format: 'text/markdown', data: current, baseRevision: 'r1' }),
      saveEdit: async (input) => {
        const document = (input as { document?: { data?: JsonValue } }).document
        if (document?.data !== undefined) current = document.data
        return {
          revision: 'r2',
          savedAt: SAVED_AT,
          info: { state: 'active', repository: 'acme/widgets', number: 42 },
        }
      },
    }, {
      target: { ...candidateTarget('owner/repo#42'), subtitle: 'acme/widgets' },
      onInsertClue: (_clueId, title) => { inserted.push(title); return true },
      onAddToPack: target => { added.push(target) },
    })
    expect(frame().getAttribute('aria-label')).toBe('Source issue title')
    act(() => { frame().querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    await flush()
    const input = frame().querySelector<HTMLElement>('[data-window-document-editor]')!
      .querySelector<HTMLInputElement>('[data-test-title-input]')!
    typeInto(input, 'Fresh saved title')
    await flush()
    act(() => { frame().querySelector<HTMLButtonElement>('[data-clue-detail-save]')!.click() })
    await flush()
    expect(calls.saveEdit).toBe(1)
    expect(frame().getAttribute('aria-label')).toBe('Fresh saved title')

    click(frame(), 'Insert resources')
    await flush()
    expect(calls.ensure).toHaveLength(1)
    expect(calls.ensure[0]!.title).toBe('Fresh saved title')
    expect(calls.ensure[0]!.info).toMatchObject({ state: 'active', repository: 'acme/widgets', number: 42 })
    expect(inserted).toEqual(['Fresh saved title'])

    click(frame(), 'Add to pack')
    expect(added).toHaveLength(1)
    expect(added[0]!.title).toBe('Fresh saved title')
    expect(added[0]!.subtitle).toBe('acme/widgets')
    expect(added[0]!.info).toMatchObject({ state: 'active', repository: 'acme/widgets', number: 42 })
  })

  it('fills the source link from a credential-free read URL when the locator has none', async () => {
    await mountDetail({
      read: async () => ({
        format: 'text/markdown',
        data: { title: 'Doc title', text: '# body', sourceUrl: 'https://example.com/doc' },
        fetchedAt: '2026-10-20T08:00:00.000Z',
      }),
    }, { target: candidateTarget('doc-token') })
    expect(frame().querySelector('[data-clue-detail-source]')?.getAttribute('href'))
      .toBe('https://example.com/doc')
  })
})

describe('shared cache data changes', () => {
  it('aborts a pending read on an auth boundary and ignores the late old-account response', async () => {
    let resolveOld!: (value: ClueReadResult) => void
    let oldSignal: AbortSignal | undefined
    let reads = 0
    const shared = subscribingReadCache()
    const { calls } = await mountDetail({
      read: (call, signal) => {
        reads += 1
        if (call === 1) {
          oldSignal = signal
          return new Promise<ClueReadResult>((resolve) => { resolveOld = resolve })
        }
        return Promise.resolve({
          format: 'text/markdown',
          data: { title: 'New account title', text: '# new' },
          fetchedAt: '2026-10-20T09:00:00.000Z',
        })
      },
    }, { target: candidateTarget('owner/repo#42'), readCache: shared.cache })
    expect(reads).toBe(1)
    expect(oldSignal?.aborted).toBe(false)

    act(() => { shared.emit({ kind: 'auth' }) })
    await flush()
    expect(oldSignal?.aborted).toBe(true)
    expect(shared.stats.invalidations).toBe(1)
    expect(reads).toBe(2)
    expect(frame().getAttribute('aria-label')).toBe('New account title')

    // The old identity's response arrives late; it must never be accepted.
    await act(async () => {
      resolveOld({
        format: 'text/markdown',
        data: { title: 'Old account title', text: '# old' },
        fetchedAt: '2026-10-20T08:00:00.000Z',
      })
      await Promise.resolve()
    })
    await flush()
    expect(frame().getAttribute('aria-label')).toBe('New account title')
    expect(frame().textContent).not.toContain('# old')
    expect(calls.read).toBe(2)
  })

  it('aborts a pending edit load on an auth boundary and never accepts its old-account draft', async () => {
    let resolveEdit!: (value: unknown) => void
    let editSignal: AbortSignal | undefined
    const shared = subscribingReadCache(() => READ_OLD)
    const { calls } = await mountDetail({
      loadEdit: (signal) => {
        editSignal = signal
        return new Promise((resolve) => { resolveEdit = resolve })
      },
    }, { target: candidateTarget('owner/repo#42'), readCache: shared.cache })
    act(() => { frame().querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    expect(frame().querySelector('[data-window-edit-loading]')).not.toBeNull()
    expect(editSignal?.aborted).toBe(false)

    act(() => { shared.emit({ kind: 'auth' }) })
    await flush()
    expect(editSignal?.aborted).toBe(true)
    await act(async () => {
      resolveEdit({ format: 'text/markdown', data: { text: '# old account draft' }, baseRevision: 'r1' })
      await Promise.resolve()
    })
    await flush()
    expect(frame().querySelector<HTMLElement>('[data-window-document-editor]')!.hidden).toBe(true)
    expect(frame().querySelector('[data-window-edit-loading]')).toBeNull()
    expect(frame().querySelector<HTMLTextAreaElement>('[data-window-text-editor]')?.value)
      .not.toBe('# old account draft')
    expect(calls.loadEdit).toBe(1)
  })

  it('preserves a dirty draft on auth change, blocks Save, and requires an explicit fresh base', async () => {
    const shared = subscribingReadCache(() => READ_OLD)
    const { calls } = await mountDetail({}, { target: candidateTarget('owner/repo#42'), readCache: shared.cache })
    act(() => { frame().querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    await flush()
    const editor = frame().querySelector<HTMLTextAreaElement>('[data-window-text-editor]')!
    typeInto(editor, '# Kept draft')
    await flush()

    act(() => { shared.emit({ kind: 'auth' }) })
    await flush()
    expect(editor.value).toBe('# Kept draft')
    expect(frame().querySelector('[data-window-error]')?.textContent).toContain('Not authorized')
    expect(frame().querySelector('[data-clue-detail-save]')).toBeNull()
    expect(frame().querySelector('[data-clue-detail-reread]')).not.toBeNull()
    // Dirty drafts are not silently replaced by a new-account read.
    expect(calls.read).toBe(1)

    click(frame(), 'Re-read')
    await flush()
    expect(calls.loadEdit).toBe(2)
    expect(frame().querySelector('[data-window-error]')).toBeNull()
    expect(frame().querySelector<HTMLTextAreaElement>('[data-window-text-editor]')?.value).toBe('# Draft')
  })

  it('refreshes the binding CAS revision on library events and unsubscribes on close', async () => {
    const shared = subscribingReadCache()
    const { calls } = await mountDetail({}, { target: TARGET, readCache: shared.cache })
    expect(shared.listenerCount()).toBe(1)
    expect(frame().querySelector('[data-clue-binding-revision]')?.getAttribute('data-clue-binding-revision')).toBe('0')
    expect(calls.bindingsList).toBe(1)

    act(() => { shared.emit({ kind: 'library', workspaceId: 'other-ws' }) })
    await flush()
    expect(calls.bindingsList).toBe(1)
    act(() => { shared.emit({ kind: 'library', workspaceId: 'ws-1' }) })
    await flush()
    expect(calls.bindingsList).toBe(2)
    expect(frame().querySelector('[data-clue-binding-revision]')?.getAttribute('data-clue-binding-revision')).toBe('1')

    click(frame(), 'Close')
    await flush()
    expect(document.querySelector('[data-floating-window]')).toBeNull()
    expect(shared.stats.unsubscribes).toBe(1)
    expect(shared.listenerCount()).toBe(0)
    act(() => { shared.emit({ kind: 'library', workspaceId: 'ws-1' }) })
    await flush()
    expect(calls.bindingsList).toBe(2)
  })

  it('disables candidate Insert/Add-to-pack until the first read, while a stable clue keeps them', async () => {
    let resolveRead!: (value: ClueReadResult) => void
    let reads = 0
    const shared = subscribingReadCache()
    const added: ClueDetailTarget[] = []
    const { calls } = await mountDetail({
      read: () => {
        reads += 1
        return new Promise<ClueReadResult>((resolve) => { resolveRead = resolve })
      },
    }, {
      target: candidateTarget('owner/repo#42'),
      readCache: shared.cache,
      insert: true,
      onAddToPack: target => { added.push(target) },
    })
    expect(reads).toBe(1)
    const insert = (): HTMLButtonElement => frame().querySelector<HTMLButtonElement>('[data-clue-detail-insert]')!
    const add = (): HTMLButtonElement => frame().querySelector<HTMLButtonElement>('[data-clue-detail-add-to-pack]')!
    expect(insert().disabled).toBe(true)
    expect(add().disabled).toBe(true)
    act(() => { insert().click() })
    await flush()
    expect(calls.ensure).toHaveLength(0)
    expect(added).toHaveLength(0)

    await act(async () => {
      resolveRead(READ_OLD)
      await Promise.resolve()
    })
    await flush()
    expect(insert().disabled).toBe(false)
    expect(add().disabled).toBe(false)

    // A stable clue already has an identity: its actions stay available.
    const windows = recordingWindows()
    const { face } = faceOf({ read: () => new Promise<ClueReadResult>(() => {}) })
    act(() => {
      openClueDetailWindow({
        windows: windows.windows,
        face,
        workspaceId: 'ws-1',
        target: { ...TARGET, clueId: 'c-stable' },
        onInsertClue: () => true,
        onAddToPack: () => undefined,
      })
    })
    const footer = renderNode(windows.last()?.footer)
    expect(footer.container.querySelector<HTMLButtonElement>('[data-clue-detail-insert]')!.disabled).toBe(false)
    expect(footer.container.querySelector<HTMLButtonElement>('[data-clue-detail-add-to-pack]')!.disabled).toBe(false)
    footer.unmount()
  })
})

describe('clue detail metadata persistence', () => {
  it('carries subtitle/info into ensure on first insert and keeps stable window identity', async () => {
    const windows = recordingWindows()
    const { face, calls } = faceOf()
    const info: ClueResourceInfo = { repository: 'acme/widgets', number: 3, state: 'open' }
    let handle!: WindowHandle
    act(() => {
      handle = openClueDetailWindow({
        windows: windows.windows,
        face,
        workspaceId: 'ws-1',
        target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'a.md' }, title: 'A note', subtitle: 'src/a.md', info },
        onInsertClue: () => true,
      })
    })
    await flush()
    expect(clueDetailWindowId({ sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'a.md' }, title: 'A note' }))
      .toBe(handle.id)
    const footer = renderNode(windows.last()?.footer)
    click(footer.container, 'Insert resources')
    await flush()
    expect(calls.ensure).toHaveLength(1)
    expect(calls.ensure[0]).toMatchObject({ title: 'A note', subtitle: 'src/a.md', info })
    footer.unmount()
  })
})


describe('UI19 independent resource discussion', () => {
  it('loads comments independently while requesting only the body and retains loaded comments on page failure', async () => {
    const windows = recordingWindows()
    let releaseBody!: (value: ClueReadResult) => void
    let pages = 0
    const inputs: Record<string, unknown>[] = []
    const { face } = faceOf({
      read: () => new Promise(resolve => { releaseBody = resolve }),
      readInput: input => { inputs.push(input) },
      commentsList: async input => {
        pages += 1
        if (input.cursor === 'next') throw new Error('next-page-unavailable')
        return { status: 'ok', coverage: 'document', fetchedAt: '', complete: false, nextCursor: 'next', items: [
          { id: 'review-1', kind: 'review', format: 'text/plain', body: 'Review summary', reviewState: 'APPROVED', author: { name: 'Reviewer' } },
        ] }
      },
    })
    openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', target: { ...TARGET, clueId: 'ui19-comments' } })
    await flush()
    expect(pages).toBe(1)
    expect(inputs[0]).toMatchObject({ includeDiscussion: false })
    releaseBody(READ_OLD)
    await flush()
    const supplement = () => (windows.last()?.content as WindowDocumentContent & { afterBody?: ReactNode }).afterBody
    const comments = renderNode(supplement())
    expect(comments.container.textContent).toContain('Review summary')
    expect(comments.container.querySelector('[data-clue-review-state="APPROVED"]')).not.toBeNull()
    act(() => { comments.container.querySelector<HTMLButtonElement>('[data-clue-comments-more]')!.click() })
    await flush()
    comments.rerender(createElement(Fragment, null, supplement()))
    expect(comments.container.textContent).toContain('Review summary')
    expect(comments.container.querySelector('[role="alert"]')).not.toBeNull()
    expect(comments.container.querySelector('[data-clue-comments-more]')).not.toBeNull()
    comments.unmount()
  })
})


describe('UI19 long body continuation', () => {
  it('appends same-revision pages, but retains the readable body on revision changes', async () => {
    const windows = recordingWindows()
    let revision = 'r1'
    const inputs: Record<string, unknown>[] = []
    const { face } = faceOf({ readInput: input => { inputs.push(input) }, read: async call => call === 1
      ? { format: 'text/plain', data: { text: 'first-' }, revision: 'r1', fetchedAt: '', limited: true, nextOffset: 6 }
      : { format: 'text/plain', data: { text: 'next-' }, revision, fetchedAt: '', limited: true, nextOffset: 11 } })
    openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', target: { ...TARGET, clueId: 'ui19-continuation' } })
    await flush()
    const supplement = () => (windows.last()?.content as WindowDocumentContent & { afterBody?: ReactNode }).afterBody
    const controls = renderNode(supplement())
    act(() => { controls.container.querySelector<HTMLButtonElement>('[data-clue-body-more]')!.click() })
    await flush()
    expect(inputs[1]).toMatchObject({ offset: 6, includeDiscussion: false })
    expect((windows.last()?.content as WindowDocumentContent).document.data).toEqual({ text: 'first-next-' })
    revision = 'r2'
    controls.rerender(createElement(Fragment, null, supplement()))
    act(() => { controls.container.querySelector<HTMLButtonElement>('[data-clue-body-more]')!.click() })
    await flush()
    controls.rerender(createElement(Fragment, null, supplement()))
    expect((windows.last()?.content as WindowDocumentContent).document.data).toEqual({ text: 'first-next-' })
    expect(controls.container.querySelector('[role="alert"]')).not.toBeNull()
    controls.unmount()
  })
})


it('treats a resource comment event as a refresh and retains the same unsent comment draft', async () => {
  const windows = recordingWindows(), cache = subscribingReadCache()
  let pages = 0
  const { face, calls } = faceOf({ commentsList: async () => {
    pages += 1
    return { status: 'ok', coverage: 'document', fetchedAt: '', complete: true,
      items: [{ id: `c-${pages}`, kind: 'comment', format: 'text/plain', body: `Page ${pages}` }] }
  }, commentsCreate: async () => { throw new Error('not used') } })
  const clueId = 'ui19-resource-event'
  openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', target: { ...TARGET, clueId }, readCache: cache.cache })
  await flush()
  const supplement = () => (windows.last()?.content as WindowDocumentContent).afterBody
  const view = renderNode(supplement())
  const textarea = view.container.querySelector<HTMLTextAreaElement>('[data-clue-comment-input]')!
  typeInto(textarea, 'Unsent comment')
  const catalogueCalls = calls.sources
  act(() => { cache.emit({ kind: 'resource', workspaceId: 'ws-1', resource: { clueId } }) })
  await flush()
  view.rerender(createElement(Fragment, null, supplement()))
  expect(view.container.querySelector('[data-clue-comment-input]')).toBe(textarea)
  expect(textarea.value).toBe('Unsent comment')
  expect(calls.sources).toBe(catalogueCalls)
  expect(pages).toBe(2)
  expect(view.container.textContent).toContain('Page 2')
  view.unmount()
})

describe('UI19 discussion controller integration', () => {
  it('retains resource pagination while loading replies, retries a broken reply cursor, and adopts the posted reply once', async () => {
    const windows = recordingWindows()
    const requests: Record<string, unknown>[] = []
    const writes: Record<string, unknown>[] = []
    let fail = true
    const { face } = faceOf({
      commentsList: async input => {
        requests.push(input)
        if (input.parentId === 'c1') {
          if (fail) throw new SidebarApiError('failed', 'reply page temporarily unavailable')
          return { status: 'ok', coverage: 'document', fetchedAt: '', complete: true, items: [
            { id: 'r1', kind: 'reply', format: 'text/plain', body: 'Fetched reply', replyToId: 'c1' },
          ] }
        }
        return { status: 'ok', coverage: 'document', fetchedAt: '', complete: false, nextCursor: 'resource-next', items: [
          { id: 'c1', kind: 'comment', format: 'text/plain', body: 'Top comment', nextRepliesCursor: 'replies-next' },
        ] }
      },
      commentsCreate: async input => { writes.push(input); return { savedAt: '', comment: { id: 'r2', kind: 'reply', format: 'text/plain', body: String(input.body), replyToId: 'c1' } } },
    })
    openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', target: { ...TARGET, clueId: 'ui19-reply-pagination' } })
    await flush()
    const supplement = () => (windows.last()?.content as WindowDocumentContent & { afterBody?: ReactNode }).afterBody
    const controls = renderNode(supplement())
    act(() => { controls.container.querySelector<HTMLButtonElement>('[data-clue-comment-replies="c1"]')!.click() })
    await flush()
    controls.rerender(createElement(Fragment, null, supplement()))
    expect(controls.container.textContent).toContain('Top comment')
    expect(controls.container.textContent).toContain('reply page temporarily unavailable')
    fail = false
    click(controls.container, 'Retry')
    await flush()
    controls.rerender(createElement(Fragment, null, supplement()))
    expect(requests.at(-1)).toMatchObject({ parentId: 'c1', cursor: 'replies-next' })
    expect(controls.container.textContent).toContain('Fetched reply')
    expect(controls.container.querySelector('[data-clue-comment-replies="c1"]')).toBeNull()
    expect(controls.container.querySelector('[data-clue-comments-more]')).not.toBeNull()
    act(() => { controls.container.querySelector<HTMLButtonElement>('[data-clue-comment-reply="c1"]')!.click() })
    typeInto(controls.container.querySelector<HTMLTextAreaElement>('[data-clue-comment-input]')!, 'New reply')
    act(() => { controls.container.querySelector<HTMLButtonElement>('[data-clue-comment-submit]')!.click() })
    await flush()
    controls.rerender(createElement(Fragment, null, supplement()))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ body: 'New reply', replyToId: 'c1', requestId: expect.any(String) })
    expect(controls.container.querySelectorAll('[data-clue-comment="r2"]')).toHaveLength(1)
    controls.unmount()
  })
})


it('loads the new account discussion while an old-account comment submission is still pending', async () => {
  const windows = recordingWindows()
  const cache = subscribingReadCache()
  let pages = 0
  let finishWrite!: (value: import('../src/clues/types.ts').ClueCommentCreateResult) => void
  const { face } = faceOf({ commentsList: async () => {
    pages += 1
    return { status: 'ok', coverage: 'document', fetchedAt: '', complete: true, items: [
      { id: `account-${pages}`, kind: 'comment', format: 'text/plain', body: `Account ${pages}` },
    ] }
  }, commentsCreate: () => new Promise(resolve => { finishWrite = resolve }) })
  openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', readCache: cache.cache, target: { ...TARGET, clueId: 'ui19-auth-comment' } })
  await flush()
  const supplement = () => (windows.last()?.content as WindowDocumentContent & { afterBody?: ReactNode }).afterBody
  const controls = renderNode(supplement())
  typeInto(controls.container.querySelector<HTMLTextAreaElement>('[data-clue-comment-input]')!, 'Old account draft')
  act(() => { controls.container.querySelector<HTMLButtonElement>('[data-clue-comment-submit]')!.click() })
  await flush()
  act(() => { cache.emit({ kind: 'auth' }) })
  await flush()
  expect(pages).toBe(2)
  finishWrite({ savedAt: '', comment: { id: 'old-write', kind: 'comment', format: 'text/plain', body: 'Old account draft' } })
  await flush()
  controls.rerender(createElement(Fragment, null, supplement()))
  expect(controls.container.textContent).toContain('Account 2')
  expect(controls.container.querySelector('[data-clue-comment="old-write"]')).toBeNull()
  controls.unmount()
})


it('clears a pre-write comment read cancellation error after the comment posts successfully', async () => {
  const windows = recordingWindows()
  let rejectPage!: (failure: unknown) => void
  const { face } = faceOf({
    commentsList: input => input.cursor === 'pending-page'
      ? new Promise((_resolve, reject) => { rejectPage = reject })
      : Promise.resolve({ status: 'ok', coverage: 'document', fetchedAt: '', complete: false, nextCursor: 'pending-page', items: [
          { id: 'root-post', kind: 'comment', format: 'text/plain', body: 'Existing comment' },
        ] }),
    commentsCreate: async input => {
      rejectPage(new SidebarApiError('failed', 'pre-write page cancelled'))
      // Model the cache invalidation rejecting its old subscriber before the
      // successful mutation result is delivered to this controller.
      for (let i = 0; i < 4; i++) await Promise.resolve()
      return { savedAt: '', comment: { id: 'posted', kind: 'comment', format: 'text/plain', body: String(input.body) } }
    },
  })
  openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', target: { ...TARGET, clueId: 'ui19-post-read-cancel' } })
  await flush()
  const supplement = () => (windows.last()?.content as WindowDocumentContent).afterBody
  const controls = renderNode(supplement())
  act(() => { controls.container.querySelector<HTMLButtonElement>('[data-clue-comments-more]')!.click() })
  await flush()
  controls.rerender(createElement(Fragment, null, supplement()))
  typeInto(controls.container.querySelector<HTMLTextAreaElement>('[data-clue-comment-input]')!, 'Successful comment')
  act(() => { controls.container.querySelector<HTMLButtonElement>('[data-clue-comment-submit]')!.click() })
  await flush()
  controls.rerender(createElement(Fragment, null, supplement()))
  expect(controls.container.querySelector('[data-clue-comment="posted"]')?.textContent).toContain('Successful comment')
  expect(controls.container.querySelector('[role="alert"]')).toBeNull()
  controls.unmount()
})
