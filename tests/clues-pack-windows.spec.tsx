/**
 * S9 clue pack, detail and share surfaces.
 *
 * Contract pinned here (approved S9 spec §3–§4, §7):
 * - pack management saves the name as an explicit action, removes members
 *   without deleting anything, and shows a CAS conflict without pretending the
 *   save landed;
 * - the workspace binding panel is collapsed by default, and binding/unbinding
 *   acts on the SELECTED workspace without long explanatory copy;
 * - the add-member page keeps its cross-page selection, filters by source,
 *   appends real cursor pages on scroll (deduped) and keeps loaded rows with a
 *   bottom Retry when a later page fails; no Prev/Next controls exist, keyword
 *   search runs after a trailing pause (IME-safe), and its rows never read pins;
 * - pack, member and shelf rows expose the same cursor/keyboard context menu
 *   (preview / insert / remove, and a confirmed pack delete from the shelf);
 * - the detail window edits through loadEdit/saveEdit, keeps the draft on a
 *   conflict (with an explicit re-read action), and offers insert separately
 *   from save; a read-only type never offers a save;
 * - the share window previews the exact export payload, downloads the archive,
 *   previews an import (missing sources / unresolved counts) and reports a
 *   partial import with explicit acceptance.
 */
// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement, Fragment } from 'react'
import type { ReactNode } from 'react'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()
beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

import { PackManagementPage, openPackManagementWindow } from '../src/client/clues/windows/pack.tsx'
import { CluePacksSection } from '../src/client/clues/tab/packs.tsx'
import { openClueDetailWindow } from '../src/client/clues/windows/detail.tsx'
import { SharePage, openShareWindow } from '../src/client/clues/windows/share.tsx'
import type { PackDraftGuard } from '../src/client/clues/windows/pack.tsx'
import type { BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import type { WindowOpenOptions, WindowHandle } from '../src/client/windows/types.ts'
import type { ClueBinding, ClueBindingTarget, ClueCandidate, CluePack, ClueSourceDescriptor } from '../src/clues/types.ts'
import { SidebarApiError } from '../src/client/api.ts'

// ── fixtures ────────────────────────────────────────────────────────────────

const PACK: CluePack = {
  id: 'p1',
  name: 'Release clues',
  workspaceId: 'ws-1',
  members: ['c1', 'c2'],
  revision: 3,
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
}

interface FaceCalls {
  rename: number
  removeMember: number
  addMember: number
  bindingAdd: string[]
  bindingRemove: string[]
  bindingAddTargets: { workspaceId: string; target: ClueBindingTarget }[]
  bindingRemoveTargets: { workspaceId: string; target: ClueBindingTarget }[]
  loadEdit: number
  saveEdit: number
  list: number
  search: number
  resolve: number
  listParams: Record<string, unknown>[]
  searchParams: Record<string, unknown>[]
  resolveParams: Record<string, unknown>[]
  /** The workspace ids packsList was called for (share-window retargeting). */
  packsList: string[]
  /** Pack-delete mutations (shelf context menu). */
  packsDelete: { packId: string; expectedRevision?: number }[]
}

interface FaceOverrides {
  saveError?: () => unknown
  renameError?: () => unknown
  editable?: boolean
  sources?: ClueSourceDescriptor[]
  enabled?: (sourceId: string) => boolean
  listFor?: (sourceId: string) => readonly ClueCandidate[]
  searchFor?: (sourceId: string) => readonly ClueCandidate[]
  listResultFor?: (sourceId: string, input: Record<string, unknown>) => { items: readonly ClueCandidate[]; nextCursor?: string }
  /** A deliberately pending cursor page used by the stale-response test. */
  listDeferred?: Promise<{ items: readonly ClueCandidate[]; nextCursor?: string }>
  resolveCandidates?: readonly ClueCandidate[]
  packs?: readonly CluePack[]
  readError?: () => unknown
  loadEditDocument?: () => unknown
  packsListError?: () => unknown
  bindingsListError?: () => unknown
  bindingAddError?: () => unknown
}

const FILES_SOURCE: ClueSourceDescriptor = {
  sourceId: 'builtin.files',
  name: 'Local files',
  order: 0,
  pluginId: 'dsh-better-sidebar',
  types: ['builtin.files.markdown'],
  transport: 'files',
  capabilities: { resolve: true, list: true, search: true, read: true, edit: true, portable: true },
}

const GITHUB_SOURCE: ClueSourceDescriptor = {
  sourceId: 'builtin.github.issues',
  name: 'GitHub Issues',
  order: 10,
  pluginId: 'dsh-better-sidebar',
  types: ['builtin.github.issue'],
  transport: 'cli',
  capabilities: { resolve: true, list: true, search: true, read: true, edit: true, portable: true },
}

function faceOf(overrides: FaceOverrides = {}): { face: BetterSidebarCluesClientFace; calls: FaceCalls } {
  const bound: ClueBinding[] = []
  const calls: FaceCalls = {
    rename: 0,
    removeMember: 0,
    addMember: 0,
    bindingAdd: [],
    bindingRemove: [],
    bindingAddTargets: [],
    bindingRemoveTargets: [],
    loadEdit: 0,
    saveEdit: 0,
    list: 0,
    search: 0,
    resolve: 0,
    listParams: [],
    searchParams: [],
    resolveParams: [],
    packsList: [],
    packsDelete: [],
  }
  const api = {
    defaultScope: async () => ({ reason: 'no-github-remote' as const }),
    sources: async () => ({
      sources: (overrides.sources ?? [FILES_SOURCE]).map(source => ({
        ...source,
        capabilities: { ...source.capabilities, edit: overrides.editable !== false && source.capabilities.edit },
      })),
      types: (overrides.sources ?? [FILES_SOURCE]).flatMap(source => source.types.map(typeId => ({
        typeId,
        sourceId: source.sourceId,
        formats: ['text/markdown'],
        capabilities: { read: true, edit: overrides.editable !== false, concurrency: 'check-before-save' as const },
      }))),
    }),
    packsList: async (workspaceId: string) => {
      calls.packsList.push(workspaceId)
      const rejected = overrides.packsListError?.()
      if (rejected !== undefined) throw rejected
      return { packs: overrides.packs ?? [PACK], revision: 4 }
    },
    pinsList: async () => {
      return { pins: [], revision: 0 }
    },
    packsDelete: async (_workspaceId: string, input: { packId: string; expectedRevision?: number }) => {
      calls.packsDelete.push(input)
      return {
        deleted: true as const,
        packs: (overrides.packs ?? [PACK]).filter(pack => pack.id !== input.packId),
        revision: 5,
        packRevision: 3,
      }
    },
    packsRename: async (_workspaceId: string, input: { name: string }) => {
      calls.rename += 1
      if (overrides.renameError !== undefined) throw overrides.renameError()
      return { pack: { ...PACK, name: input.name, revision: 4 }, revision: 5, packRevision: 4 }
    },
    packsRemoveMember: async (_workspaceId: string, input: { clueId: string }) => {
      calls.removeMember += 1
      return {
        pack: { ...PACK, members: PACK.members.filter(id => id !== input.clueId), revision: 4 },
        revision: 5,
        packRevision: 4,
      }
    },
    packsAddMember: async (_workspaceId: string, input: { clueId: string }) => {
      calls.addMember += 1
      return { pack: { ...PACK, members: [...PACK.members, input.clueId], revision: 4 }, revision: 5, packRevision: 4 }
    },
    clues: async () => ({
      clues: [
        { id: 'c1', sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'a.md' }, title: 'A note', workspaceId: 'ws-1', createdAt: '', updatedAt: '' },
        { id: 'c2', sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'b.md' }, title: 'B note', workspaceId: 'ws-1', createdAt: '', updatedAt: '', unresolved: { reason: 'source missing' } },
      ],
      revision: 2,
    }),
    bindingsList: async (workspaceId: string) => {
      const rejected = overrides.bindingsListError?.()
      if (rejected !== undefined) throw rejected
      return {
        bindings: bound.filter(binding => binding.workspaceId === workspaceId),
        revision: bound.length + 1,
      }
    },
    bindingsAdd: async (workspaceId: string, input: { target: ClueBindingTarget }) => {
      const rejected = overrides.bindingAddError?.()
      if (rejected !== undefined) throw rejected
      calls.bindingAdd.push(workspaceId)
      calls.bindingAddTargets.push({ workspaceId, target: input.target })
      bound.push({ workspaceId, target: input.target, createdAt: '' })
      return {
        bindings: bound.filter(binding => binding.workspaceId === workspaceId),
        revision: bound.length + 1,
      }
    },
    bindingsRemove: async (workspaceId: string, input: { target: ClueBindingTarget }) => {
      calls.bindingRemove.push(workspaceId)
      calls.bindingRemoveTargets.push({ workspaceId, target: input.target })
      const index = bound.findIndex(binding =>
        binding.workspaceId === workspaceId
        && binding.target.kind === input.target.kind
        && JSON.stringify(binding.target) === JSON.stringify(input.target))
      if (index !== -1) bound.splice(index, 1)
      return {
        bindings: bound.filter(binding => binding.workspaceId === workspaceId),
        revision: bound.length + 1,
      }
    },
    list: async (_workspaceId: string, input: Record<string, unknown>) => {
      calls.list += 1
      calls.listParams.push(input)
      if (overrides.listDeferred !== undefined) return overrides.listDeferred
      return overrides.listResultFor?.(String(input.sourceId), input) ?? {
        items: overrides.listFor?.(String(input.sourceId))
          ?? [{ sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'c.md' }, title: 'C note' }],
      }
    },
    search: async (_workspaceId: string, input: Record<string, unknown>) => {
      calls.search += 1
      calls.searchParams.push(input)
      return {
        items: overrides.searchFor?.(String(input.sourceId))
          ?? [{ sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'd.md' }, title: 'D note' }],
      }
    },
    resolve: async (_workspaceId: string, input: Record<string, unknown>) => {
      calls.resolve += 1
      calls.resolveParams.push(input)
      return { candidates: overrides.resolveCandidates ?? [] }
    },
    ensure: async () => ({ clue: { id: 'c9' }, created: true }),
    read: async () => {
      const rejected = overrides.readError?.()
      if (rejected !== undefined) throw rejected
      return {
        format: 'text/markdown',
        data: { text: '# Read only' },
        fetchedAt: '2026-10-17T00:00:00.000Z',
      }
    },
    loadEdit: async () => {
      calls.loadEdit += 1
      if (overrides.loadEditDocument !== undefined) return overrides.loadEditDocument()
      return { format: 'text/markdown', data: { text: '# Draft' }, baseRevision: 'r1' }
    },
    saveEdit: async () => {
      calls.saveEdit += 1
      if (overrides.saveError !== undefined) throw overrides.saveError()
      return { revision: 'r2', savedAt: '2026-10-17T00:00:00.000Z' }
    },
  }
  const face = {
    api,
    registerSourceDisplay: () => () => {},
    getSourceDisplays: () => [],
    registerFormatRenderer: () => () => {},
    getFormatRenderer: () => undefined,
    getFormatRenderers: () => new Map(),
    subscribe: () => () => {},
    isSourceEnabled: (sourceId: string) => overrides.enabled?.(sourceId) ?? true,
    isSourceMentionEnabled: () => true,
    isPacksMentionEnabled: () => true,
  } as unknown as BetterSidebarCluesClientFace
  return { face, calls }
}

/** A window host that records opens/updates. */
function recordingWindows(): {
  windows: { open(options: WindowOpenOptions): WindowHandle }
  last(): WindowOpenOptions | undefined
  updates(): WindowOpenOptions[]
} {
  let last: WindowOpenOptions | undefined
  const updates: WindowOpenOptions[] = []
  return {
    windows: {
      open(options: WindowOpenOptions): WindowHandle {
        last = options
        return {
          id: options.id,
          update(patch) {
            last = { ...(last ?? options), ...patch } as WindowOpenOptions
            updates.push(last)
          },
          focus: () => undefined,
          close: async () => undefined,
          navigation: { push: () => undefined, pop: () => false, back: () => false, canGoBack: () => false, depth: () => 1 },
        }
      },
    },
    last: () => last,
    updates: () => updates,
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

function click(container: ParentNode, label: string): void {
  const button = [...container.querySelectorAll('button')]
    .find(candidate => (candidate.textContent ?? '').trim() === label || candidate.getAttribute('aria-label') === label)
  if (button === undefined) throw new Error(`button "${label}" not found`)
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** Choose a source through the shared horizontal tab row. */
function chooseSource(container: ParentNode, label: string): void {
  const tab = [...container.querySelectorAll<HTMLButtonElement>('[data-clue-source-navigation] [role="tab"]')]
    .find(button => button.textContent?.trim() === label)
  if (tab === undefined) throw new Error('source tab not found: ' + label)
  if (tab.getAttribute('aria-selected') !== 'true') act(() => { tab.click() })
}

/** Choose a detail binding workspace through its real disclosure and portaled menu. */
function chooseBindingWorkspace(container: ParentNode, title: string): void {
  const advanced = container.querySelector<HTMLDetailsElement>('[data-clue-detail-advanced]')!
  if (!advanced.open) {
    const summary = advanced.querySelector('summary')!
    act(() => { summary.click() })
  }
  expect(advanced.open).toBe(true)
  const trigger = advanced.querySelector<HTMLButtonElement>('button[aria-label="Choose a workspace"][aria-haspopup="menu"]')!
  act(() => { trigger.click() })
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  const option = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]')]
    .find(button => button.textContent?.trim() === title)!
  expect(option).toBeDefined()
  act(() => { option.click() })
  expect(trigger.textContent).toContain(title)
}

/** The structural subset of a detail descriptor/state these specs probe. */
interface DetailProbe {
  kind?: string
  mode?: 'preview' | 'edit'
  readOnly?: boolean
  presentation?: string
  document?: { data: unknown }
  error?: string
  onModeChange?(next: 'preview' | 'edit'): void
  onChange?(data: unknown): void
  onSave?(): void
}

/**
 * Enter edit mode through the detail's own controlled mode seam. Edit is
 * lazy: the document arrives only after this explicit choice.
 */
async function enterDetailEdit(windows: ReturnType<typeof recordingWindows>): Promise<DetailProbe> {
  const preview = windows.last()?.content as DetailProbe
  expect(preview.mode).toBe('preview')
  expect(preview.onModeChange).toBeTypeOf('function')
  act(() => { preview.onModeChange?.('edit') })
  await flush()
  return windows.last()?.content as DetailProbe
}

/** Set one controlled input's value through React's change pipeline. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/**
 * jsdom has no layout and ships no IntersectionObserver, so the add page's
 * real scroll-fallback path is exercised with a geometry stub: the reader has
 * scrolled to a 240px-tall box and the sentinel sits just inside the 100px
 * preload zone. Dispatching `scroll` then runs the same listener a browser
 * runs — no synthetic `onLoad` call and no Next button.
 */
function scrollAddToEnd(container: ParentNode, times = 1): void {
  const scroll = container.querySelector<HTMLElement>('[data-clue-pack-scroll]')
  if (scroll === null) throw new Error('no add scroll root')
  const sentinel = scroll.querySelector<HTMLElement>('[data-clue-add-sentinel]')
  if (sentinel === null) throw new Error('no add sentinel')
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 240 })
  scroll.getBoundingClientRect = () => ({ top: 0, bottom: 240 } as DOMRect)
  sentinel.getBoundingClientRect = () => ({ top: 250, bottom: 251 } as DOMRect)
  act(() => {
    for (let index = 0; index < times; index += 1) {
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
  })
}

// ── pack management ─────────────────────────────────────────────────────────

describe('clue pack management window', () => {
  it('saves the name explicitly and renames through the pack API', async () => {
    const { face, calls } = faceOf()
    const guard: PackDraftGuard = { dirty: false }
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard,
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    const nameInput = view.container.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    expect(nameInput.value).toBe('Release clues')
    expect(view.container.textContent).toContain('A note')
    const footerLabels = (): string[] => [...view.container.querySelectorAll('[data-clue-pack-footer] button')]
      .map(button => button.textContent ?? '')
    expect(footerLabels()).toEqual(['Insert pack reference'])

    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Renamed')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    expect(guard.dirty).toBe(true)
    expect(footerLabels()).toEqual(['Cancel', 'Save'])
    click(view.container, 'Save')
    await flush()
    expect(calls.rename).toBe(1)
    expect(guard.dirty).toBe(false)
    expect(footerLabels()).toEqual(['Insert pack reference'])
    view.unmount()
  })

  it('never saves on blur and saves exactly once from the explicit button', async () => {
    const { face, calls } = faceOf()
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Blurred name')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    act(() => { input.dispatchEvent(new FocusEvent('blur', { bubbles: true })) })
    await flush()
    expect(calls.rename).toBe(0)

    click(view.container, 'Save')
    await flush()
    expect(calls.rename).toBe(1)
    view.unmount()
  })

  it('discards the name draft on Cancel without saving', async () => {
    const { face, calls } = faceOf()
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Doomed draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    click(view.container, 'Cancel')
    await flush()
    expect(calls.rename).toBe(0)
    expect(input.value).toBe('Release clues')
    view.unmount()
  })

  it('shows a request failure rather than a conflict when the rename fails for another reason', async () => {
    const { face, calls } = faceOf({ renameError: () => new SidebarApiError('network', 'offline') })
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Network draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    click(view.container, 'Save')
    await flush()
    expect(calls.rename).toBe(1)
    expect(view.container.textContent).not.toContain('This pack changed elsewhere')
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Saving the pack failed.')
    expect(input.value).toBe('Network draft')
    view.unmount()
  })

  it('shows the conflict and clears it when the pack is re-read successfully', async () => {
    const { face } = faceOf({ renameError: () => new SidebarApiError('conflict', 'stale revision') })
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Stale draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    click(view.container, 'Save')
    await flush()
    expect(view.container.textContent).toContain('This pack changed elsewhere')
    click(view.container, 'Retry')
    await flush()
    expect(view.container.textContent).not.toContain('This pack changed elsewhere')
    expect(input.value).toBe('Stale draft')
    view.unmount()
  })

  it('removes a member without deleting the resource and explains unresolved rows', async () => {
    const { face, calls } = faceOf()
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    expect(view.container.textContent).toContain('Source unavailable')
    click(view.container, 'Remove from pack: A note')
    await flush()
    expect(calls.removeMember).toBe(1)
    expect(view.container.textContent).not.toContain('A note')
    view.unmount()
  })

  it('opens the member context menu for preview and removal', async () => {
    const { face, calls } = faceOf()
    const windows = recordingWindows()
    const view = renderRoot(createElement(PackManagementPage, {
      windows: windows.windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    const titleOf = (title: string): HTMLButtonElement => [...view.container.querySelectorAll('button')]
      .find(button => (button.textContent ?? '').trim() === title)!
    const rowOf = (title: string): HTMLElement => titleOf(title).closest('li')!

    // Cursor path: Preview opens the same detail surface as the title.
    act(() => {
      rowOf('A note').dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 40, clientY: 60,
      }))
    })
    await flush()
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    const preview = [...menu.querySelectorAll('button')]
      .find(button => (button.textContent ?? '').trim() === 'Preview')!
    act(() => { preview.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    // Preview is a plain read: the edit baseline stays lazy until the reader
    // chooses Edit inside the window.
    expect(calls.loadEdit).toBe(0)
    expect(windows.last()?.title).toBe('A note')

    // Keyboard path: Shift+F10 opens the same menu and Remove acts once.
    act(() => {
      rowOf('A note').dispatchEvent(new KeyboardEvent('keydown', {
        key: 'F10', shiftKey: true, bubbles: true, cancelable: true,
      }))
    })
    await flush()
    const keyboardMenu = document.querySelector<HTMLElement>('[role="menu"]')!
    const remove = [...keyboardMenu.querySelectorAll('button')]
      .find(button => (button.textContent ?? '').trim() === 'Remove from pack: A note')!
    act(() => { remove.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(calls.removeMember).toBe(1)
    expect(view.container.textContent).not.toContain('A note')
    view.unmount()
  })

  it('coalesces add-page keyword search and cancels it on IME or leaving the page', async () => {
    const { face, calls } = faceOf()
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    click(view.container, 'Add members')
    await flush()
    chooseSource(view.container, 'Local files')
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    const loaded = calls.search

    // Two keystrokes inside the trailing window collapse into ONE search.
    typeInto(input, 'rel')
    typeInto(input, 'rele')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    expect(calls.search).toBe(loaded + 1)
    expect(calls.searchParams.at(-1)?.query).toBe('rele')

    // IME composition never issues the trailing search mid-word.
    act(() => { input.dispatchEvent(new Event('compositionstart', { bubbles: true })) })
    typeInto(input, '设计')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    expect(calls.search).toBe(loaded + 1)
    act(() => { input.dispatchEvent(new Event('compositionend', { bubbles: true })) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    expect(calls.search).toBe(loaded + 2)
    expect(calls.searchParams.at(-1)?.query).toBe('设计')

    // Leaving the page before the pause expires cancels the queued search.
    const settled = calls.search
    typeInto(input, 'draft')
    click(view.container, 'Back')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    expect(calls.search).toBe(settled)
    view.unmount()
  })


  it('binds to the selected workspace and toggles the real bound state', async () => {
    const { face, calls } = faceOf()
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [
        { workspaceId: 'ws-1', title: '/repo' },
        { workspaceId: 'ws-2', title: '/other' },
      ],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    const panel = view.container.querySelector<HTMLDetailsElement>('[data-clue-binding-panel]')!
    // The explanation lives in the summary only; the panel starts collapsed.
    expect(panel.open).toBe(false)
    expect(panel.querySelector('summary')?.textContent).toBe('Workspace binding')
    expect(view.container.textContent).not.toContain('New sessions in this workspace receive these references automatically')
    panel.open = true
    const select = panel.querySelector<HTMLButtonElement>('button[aria-label="Choose a workspace"]')!
    act(() => { select.click() })
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find(button => button.textContent === '/other')!
    act(() => { option.click() })
    click(panel, 'Bind')
    await flush()
    expect(calls.bindingAdd).toEqual(['ws-2'])
    expect(panel.textContent).toContain('Bound')
    expect(panel.querySelector('button[aria-label="Choose a workspace"]')).toBeNull()
    click(panel, 'Unbind')
    await flush()
    expect(calls.bindingRemove).toEqual(['ws-2'])
    expect(panel.textContent).not.toContain('Bound')
    expect(panel.querySelector('button[aria-label="Choose a workspace"]')).not.toBeNull()
    view.unmount()
  })

  it('shows a request-failed state with Retry when the binding read fails', async () => {
    let fail = true
    const { face } = faceOf({
      bindingsListError: () => (fail ? new SidebarApiError('network', 'offline') : undefined),
    })
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    const panel = view.container.querySelector('[data-clue-binding-panel]')!
    // A failed read must not look "unbound": the panel says request-failed
    // and offers Retry instead of the Bind control.
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain('Request failed')
    expect(panel.querySelector('button[aria-label="Choose a workspace"]')).toBeNull()

    fail = false
    click(panel, 'Retry')
    await flush()
    expect(panel.querySelector('[role="alert"]')).toBeNull()
    expect(panel.querySelector('button[aria-label="Choose a workspace"]')).not.toBeNull()
    view.unmount()
  })

  it('never reads pinned clues from the add-member page', async () => {
    const { face } = faceOf()
    const pinsList = vi.fn(face.api.pinsList)
    face.api.pinsList = pinsList
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    click(view.container, 'Add members')
    await flush()
    chooseSource(view.container, 'Local files')
    await flush()
    expect(pinsList).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-clue-add-pins]')).toBeNull()
    expect(view.container.textContent).not.toContain('Pin frequently used clues to keep them here.')
    view.unmount()
  })

  it('keeps the cross-page selection while adding members from another source page', async () => {
    const { face, calls } = faceOf()
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    click(view.container, 'Add members')
    await flush()
    chooseSource(view.container, 'Local files')
    await flush()
    const checkbox = view.container.querySelector<HTMLInputElement>('ul input[type="checkbox"]')!
    act(() => { checkbox.click() })
    await flush()
    expect(view.container.textContent).toContain('1 selected')
    click(view.container, 'Add selected')
    await flush()
    expect(calls.addMember).toBe(1)
    view.unmount()
  })

  it('keeps the cross-source selection while switching sources and pages', async () => {
    const filesCandidate: ClueCandidate = {
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { path: 'a.md' },
      title: 'A note',
    }
    const githubCandidate: ClueCandidate = {
      sourceId: 'builtin.github.issues',
      typeId: 'builtin.github.issue',
      locator: { host: 'github.com', owner: 'acme', repo: 'widgets', kind: 'issue', number: 7 },
      title: 'Fix the widget',
    }
    const { face } = faceOf({
      sources: [FILES_SOURCE, GITHUB_SOURCE],
      listFor: sourceId => sourceId === GITHUB_SOURCE.sourceId ? [githubCandidate] : [filesCandidate],
    })
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      scopes: { [GITHUB_SOURCE.sourceId]: { repo: 'acme/widgets', state: 'open' } },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    click(view.container, 'Add members')
    await flush()
    chooseSource(view.container, 'Local files')
    await flush()
    const filesBox = view.container.querySelector<HTMLInputElement>('[data-clue-add-member] ul input[type="checkbox"]')!
    act(() => { filesBox.click() })
    await flush()
    expect(view.container.textContent).toContain('1 selected')

    const navigation = view.container.querySelector<HTMLElement>('[data-clue-add-member] [data-clue-source-navigation]')!
    expect(navigation.dataset.clueActiveSource).toBe(FILES_SOURCE.sourceId)
    expect(navigation.querySelector('[role="tablist"]')?.getAttribute('aria-orientation')).toBe('horizontal')
    expect(navigation.querySelectorAll('[role="tab"]')).toHaveLength(2)
    // Switching source rebuilds the page but must NOT drop the selection.
    chooseSource(view.container, 'GitHub Issues')
    await flush()
    expect(view.container.textContent).toContain('1 selected')
    expect(view.container.textContent).toContain('Fix the widget')
    expect(navigation.dataset.clueActiveSource).toBe(GITHUB_SOURCE.sourceId)

    chooseSource(view.container, 'Local files')
    await flush()
    const filesAgain = view.container.querySelector<HTMLInputElement>('[data-clue-add-member] ul input[type="checkbox"]')!
    expect(filesAgain.checked).toBe(true)
    view.unmount()
  })

  it('appends the next cursor on scroll, dedupes, and keeps the selection', async () => {
    const pageOne: ClueCandidate = {
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { path: 'page-1.md' },
      title: 'Page one',
    }
    const pageTwo: ClueCandidate = {
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { path: 'page-2.md' },
      title: 'Page two',
    }
    const { face, calls } = faceOf({
      // The second page deliberately repeats page one: the growing list must
      // keep one row per candidate identity.
      listResultFor: (_sourceId, input) => input.cursor === 'cursor-2'
        ? { items: [pageOne, pageTwo] }
        : { items: [pageOne], nextCursor: 'cursor-2' },
    })
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    click(view.container, 'Add members')
    await flush()
    chooseSource(view.container, 'Local files')
    await flush()
    const addPage = view.container.querySelector<HTMLElement>('[data-clue-add-member]')!
    expect(addPage.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(1)
    act(() => { view.container.querySelector<HTMLInputElement>('[data-clue-add-member] ul input[type="checkbox"]')!.click() })
    await flush()
    expect(view.container.textContent).toContain('1 selected')

    // A real scroll event at the sentinel appends the cursor page; it does not
    // replace the rows and it carries no Prev/Next controls. Two coalesced
    // scroll events still issue ONE cursor request (synchronous latch).
    scrollAddToEnd(view.container, 2)
    await flush()
    expect(calls.list).toBe(2)
    expect(calls.listParams.at(-1)).toMatchObject({ cursor: 'cursor-2' })
    expect(addPage.textContent).toContain('Page one')
    expect(addPage.textContent).toContain('Page two')
    expect(addPage.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(2)
    expect(addPage.querySelector<HTMLInputElement>('[data-clue-add-scroll] ul input[type="checkbox"]')!.checked).toBe(true)
    expect(addPage.querySelector('[data-clue-add-sentinel]')).not.toBeNull()
    const labels = [...addPage.querySelectorAll('button')].map(button => (button.textContent ?? '').trim())
    expect(labels).not.toContain('Prev')
    expect(labels).not.toContain('Previous')
    expect(labels).not.toContain('Next')

    // No next cursor: another scroll request is a no-op.
    const requests = calls.list
    scrollAddToEnd(view.container)
    await flush()
    expect(calls.list).toBe(requests)
    expect(addPage.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(2)
    view.unmount()
  })

  it('walks empty pages with distinct cursors and stops on a repeated cursor', async () => {
    const first: ClueCandidate = {
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { path: 'walk-1.md' },
      title: 'Walk first',
    }
    const loopFirst: ClueCandidate = {
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { path: 'loop-1.md' },
      title: 'Loop first',
    }
    const loopSecond: ClueCandidate = {
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { path: 'loop-2.md' },
      title: 'Loop second',
    }
    let mode: 'walk' | 'loop' = 'walk'
    const { face, calls } = faceOf({
      listResultFor: (_sourceId, input) => {
        if (mode === 'walk') {
          if (input.cursor === undefined) return { items: [first], nextCursor: 'walk-2' }
          // Empty pages with DISTINCT cursors are a normal walk, not a loop.
          if (input.cursor === 'walk-2') return { items: [], nextCursor: 'walk-3' }
          return { items: [] }
        }
        if (input.cursor === undefined) return { items: [loopFirst], nextCursor: 'loop-2' }
        // Every later page re-issues the cursor it was asked for.
        return { items: [loopSecond], nextCursor: 'loop-2' }
      },
    })
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    click(view.container, 'Add members')
    await flush()
    chooseSource(view.container, 'Local files')
    await flush()
    const addPage = view.container.querySelector<HTMLElement>('[data-clue-add-member]')!
    expect(calls.list).toBe(1)

    // The sentinel stub stays in the preload zone, so the hook re-arms after
    // each empty page: walk-2 and walk-3 are consumed automatically until the
    // source reports no next. No error, no duplicate rows.
    scrollAddToEnd(view.container)
    await flush()
    expect(calls.list).toBe(3)
    expect(calls.listParams.at(-1)).toMatchObject({ cursor: 'walk-3' })
    expect(addPage.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(1)
    expect(addPage.querySelector('[data-clue-add-more-error]')).toBeNull()

    // Stop the automatic walk before the loop phase so the repeated cursor is
    // requested by an explicit scroll, not by the previous geometry.
    const scroll = view.container.querySelector<HTMLElement>('[data-clue-pack-scroll]')!
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 0 })
    mode = 'loop'
    // Changing the range starts a fresh list; reselecting the current source
    // intentionally keeps its existing rows in the shared selector.
    click(view.container, 'Choose range')
    await flush()
    click(view.container, 'Save range')
    await flush()
    expect(calls.list).toBe(4)
    expect(addPage.textContent).toContain('Loop first')

    scrollAddToEnd(view.container)
    await flush()
    expect(calls.list).toBe(5)
    const loopError = addPage.querySelector<HTMLElement>('[data-clue-add-more-error]')
    expect(loopError).not.toBeNull()
    expect(loopError!.getAttribute('role')).toBe('alert')
    expect(loopError!.querySelector('button')?.textContent).toBe('Retry')
    // The looping page is not merged and its cursor is not silently cleared:
    // the row already loaded stays, and Retry remains at the bottom.
    expect(addPage.textContent).toContain('Loop first')
    expect(addPage.textContent).not.toContain('Loop second')
    expect(addPage.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(1)

    // No automatic retry after the loop error.
    scrollAddToEnd(view.container, 2)
    await flush()
    expect(calls.list).toBe(5)
    expect(addPage.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(1)
    view.unmount()
  })

  it('keeps the rows on a failed next page and retries from the bottom', async () => {
    const pageOne: ClueCandidate = {
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { path: 'retry-1.md' },
      title: 'Retry page one',
    }
    const pageTwo: ClueCandidate = {
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { path: 'retry-2.md' },
      title: 'Retry page two',
    }
    let failNext = true
    const { face, calls } = faceOf({
      listResultFor: (_sourceId, input) => {
        if (input.cursor === undefined) return { items: [pageOne], nextCursor: 'cursor-2' }
        if (failNext) {
          failNext = false
          throw new SidebarApiError('network', 'offline')
        }
        return { items: [pageTwo] }
      },
    })
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    click(view.container, 'Add members')
    await flush()
    chooseSource(view.container, 'Local files')
    await flush()
    const addPage = view.container.querySelector<HTMLElement>('[data-clue-add-member]')!
    act(() => { addPage.querySelector<HTMLInputElement>('ul input[type="checkbox"]')!.click() })
    await flush()

    scrollAddToEnd(view.container)
    await flush()
    // The rows read so far stay; the failure lives at the bottom with Retry.
    expect(addPage.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(1)
    expect(addPage.textContent).toContain('Retry page one')
    const retry = addPage.querySelector<HTMLElement>('[data-clue-add-more-error]')
    expect(retry).not.toBeNull()
    expect(retry!.getAttribute('role')).toBe('alert')
    expect(retry!.querySelector('button')?.textContent).toBe('Retry')
    expect(calls.list).toBe(2)

    // The failed cursor is not re-requested by scrolling; only Retry does.
    scrollAddToEnd(view.container)
    await flush()
    expect(calls.list).toBe(2)

    click(view.container, 'Retry')
    await flush()
    expect(calls.list).toBe(3)
    expect(calls.listParams.at(-1)).toMatchObject({ cursor: 'cursor-2' })
    expect(addPage.querySelector('[data-clue-add-more-error]')).toBeNull()
    expect(addPage.textContent).toContain('Retry page two')
    expect(addPage.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(2)
    expect(addPage.querySelector<HTMLInputElement>('ul input[type="checkbox"]')!.checked).toBe(true)
    view.unmount()
  })

  it('ignores a superseded list response when the query changes', async () => {
    const staleRow: ClueCandidate = {
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { path: 'stale.md' },
      title: 'Stale row',
    }
    let resolvePending!: (value: { items: readonly ClueCandidate[] }) => void
    const pending = new Promise<{ items: readonly ClueCandidate[] }>((resolve) => { resolvePending = resolve })
    const { face } = faceOf({ listDeferred: pending })
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    click(view.container, 'Add members')
    await flush()
    chooseSource(view.container, 'Local files')
    await flush()
    const addPage = view.container.querySelector<HTMLElement>('[data-clue-add-member]')!

    // The source list is still pending when the reader searches: the new
    // view wins, and the late first response must not repaint it.
    typeInto(addPage.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!, 'design')
    click(view.container, 'Search')
    await flush()
    expect(addPage.textContent).toContain('D note')

    await act(async () => {
      resolvePending({ items: [staleRow] })
      await Promise.resolve()
    })
    await flush()
    expect(addPage.textContent).toContain('D note')
    expect(addPage.textContent).not.toContain('Stale row')
    view.unmount()
  })

  it('asks for a range before listing GitHub members instead of surfacing invalid-request', async () => {
    const { face, calls } = faceOf({ sources: [GITHUB_SOURCE] })
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    click(view.container, 'Add members')
    await flush()
    chooseSource(view.container, 'GitHub Issues')
    await flush()
    expect(calls.list).toBe(0)
    expect(view.container.textContent).toContain('No range chosen yet')
    expect(view.container.textContent).not.toContain('Failed to load')

    click(view.container, 'Choose range')
    await flush()
    const repoInput = view.container.querySelector<HTMLInputElement>('input[placeholder="owner/repo or repository URL"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(repoInput, 'acme/widgets')
      repoInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const stateChoices = repoInput.closest('form')!.querySelector('fieldset')!
    expect([...stateChoices.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map(input => input.value)).toEqual(['open', 'closed', 'all'])
    expect(stateChoices.querySelector('select')).toBeNull()
    const closed = stateChoices.querySelector<HTMLInputElement>('input[value="closed"]')!
    expect(closed.closest('label')?.textContent).toContain('Closed')
    act(() => { closed.click() })
    expect(closed.checked).toBe(true)
    click(view.container, 'Save range')
    await flush()
    expect(calls.list).toBe(1)
    expect(calls.listParams[0]).toMatchObject({
      sourceId: GITHUB_SOURCE.sourceId,
      scope: { repo: 'acme/widgets', state: 'closed' },
    })
    view.unmount()
  })

  it('searches Feishu docs account-wide from the add page when no range is chosen', async () => {
    const feishu: ClueSourceDescriptor = {
      sourceId: 'builtin.feishu.docs',
      name: 'Feishu docs',
      order: 30,
      pluginId: 'dsh-better-sidebar',
      types: ['builtin.feishu.docs'],
      transport: 'cli',
      capabilities: { resolve: true, list: true, search: true, read: true, edit: true, portable: true },
    }
    const { face, calls } = faceOf({ sources: [feishu] })
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    click(view.container, 'Add members')
    await flush()
    chooseSource(view.container, 'Feishu docs')
    await flush()
    // Browse defaults to Drive; a keyword below still searches the account.
    expect(calls.list).toBe(1)

    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    typeInto(input, 'design')
    click(view.container, 'Search')
    await flush()
    // ...but a keyword runs the account-wide search, with the range stated.
    expect(calls.search).toBe(1)
    expect(calls.searchParams[0]).toMatchObject({ sourceId: 'builtin.feishu.docs', query: 'design' })
    expect(calls.searchParams[0]).not.toHaveProperty('scope')
    expect(view.container.querySelector('[data-add-global-search]')?.textContent)
      .toContain('searching all documents visible to this account')
    view.unmount()
  })

  it('adds a member from a pasted complete URL without a browse range', async () => {
    const githubCandidate: ClueCandidate = {
      sourceId: 'builtin.github.issues',
      typeId: 'builtin.github.issue',
      locator: { host: 'github.com', owner: 'acme', repo: 'widgets', kind: 'issue', number: 7 },
      title: 'Fix the widget',
    }
    const { face, calls } = faceOf({
      sources: [GITHUB_SOURCE],
      resolveCandidates: [githubCandidate],
    })
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    click(view.container, 'Add members')
    await flush()
    chooseSource(view.container, 'GitHub Issues')
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'https://github.com/acme/widgets/issues/7')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(view.container, 'Resolve')
    await flush()
    expect(calls.list).toBe(0)
    expect(calls.resolve).toBe(1)
    expect(calls.resolveParams[0]).toMatchObject({ text: 'https://github.com/acme/widgets/issues/7' })
    expect(view.container.textContent).toContain('Fix the widget')

    const box = view.container.querySelector<HTMLInputElement>('[data-clue-add-member] ul input[type="checkbox"]')!
    act(() => { box.click() })
    await flush()
    click(view.container, 'Add selected')
    await flush(6)
    expect(calls.addMember).toBe(1)
    view.unmount()
  })

  it('hides a source that is switched off from the add page', async () => {
    const { face } = faceOf({
      sources: [FILES_SOURCE, GITHUB_SOURCE],
      enabled: sourceId => sourceId !== GITHUB_SOURCE.sourceId,
    })
    const view = renderRoot(createElement(PackManagementPage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      guard: { dirty: false },
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    }))
    await flush()
    click(view.container, 'Add members')
    await flush()
    const sourceTabs = [...view.container.querySelectorAll('[data-clue-source-navigation] [role="tab"]')]
      .map(tab => tab.textContent?.trim())
    expect(sourceTabs).toContain('Local files')
    expect(sourceTabs).not.toContain('GitHub Issues')
    view.unmount()
  })

  it('guards a dirty name draft on close with a visible unsaved marker', async () => {
    const { face } = faceOf()
    const windows = recordingWindows()
    const handle = openPackManagementWindow({
      windows: windows.windows,
      workspaceId: 'ws-1',
      face,
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
      pack: PACK,
      onInsertClue: () => true,
      onInsertPack: () => true,
      onNotice: () => undefined,
    })
    await flush()
    const view = renderRoot(createElement(Fragment, null, windows.last()?.content as ReactNode))
    await flush()
    expect(handle.id).toBe('pack:p1')
    await expect(windows.last()?.onBeforeClose?.()).resolves.toBe(true)

    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Unsaved draft')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    await expect(windows.last()?.onBeforeClose?.()).resolves.toBe(false)
    expect(windows.last()?.dirty).toBe(true)
    expect(windows.last()?.title).toContain('Unsaved pack name')

    // Cancel discards the name draft and restores the clean title.
    click(view.container, 'Cancel')
    await flush()
    await expect(windows.last()?.onBeforeClose?.()).resolves.toBe(true)
    expect(windows.last()?.title).toBe('Release clues')
    view.unmount()
  })
})

// ── shelf context menu ──────────────────────────────────────────────────────

describe('clue pack shelf context menu', () => {
  it('deletes a pack only after the confirmation and never touches its clues', async () => {
    const other: CluePack = {
      ...PACK,
      id: 'p2',
      name: 'Design notes',
      members: [],
      updatedAt: '2026-10-16T00:00:00.000Z',
    }
    const { face, calls } = faceOf({ packs: [PACK, other] })
    const view = renderRoot(createElement(CluePacksSection, {
      workspaceId: 'ws-1',
      face,
      windows: recordingWindows().windows,
      visible: true,
      settings: {},
      onSettingsChange: () => undefined,
      onInsertPack: () => true,
      onOpenPack: () => undefined,
      onImport: () => undefined,
      onNotice: () => undefined,
    }))
    await flush()
    const name = [...view.container.querySelectorAll<HTMLElement>('[data-clue-pack-name]')]
      .find(element => element.textContent === 'Release clues')!
    act(() => {
      name.closest('li')!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 30, clientY: 40,
      }))
    })
    await flush()
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    const deleteItem = [...menu.querySelectorAll('button')]
      .find(button => (button.textContent ?? '').trim() === 'Delete')!
    act(() => { deleteItem.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    // Choosing Delete only opens the confirmation; nothing is written yet.
    expect(calls.packsDelete).toEqual([])
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Delete')
    expect(dialog.textContent).toContain('Delete “Release clues”? Its clues will remain available.')
    click(dialog, 'Delete')
    await flush()
    expect(calls.packsDelete).toEqual([{ packId: 'p1', expectedRevision: 3 }])
    expect(calls.rename).toBe(0)
    expect(calls.addMember).toBe(0)
    expect(calls.removeMember).toBe(0)
    expect(view.container.textContent).not.toContain('Release clues')
    expect(view.container.textContent).toContain('Design notes')
    view.unmount()
  })
})

// ── detail window ───────────────────────────────────────────────────────────

describe('clue detail window', () => {
  it('offers Save for a changed draft and never saves while inserting a reference', async () => {
    const { face, calls } = faceOf()
    const windows = recordingWindows()
    const inserted: string[] = []
    openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-clean-save', title: 'Note' },
      onInsertClue: id => { inserted.push(id); return true },
    })
    await flush()
    const footer = renderRoot(createElement(Fragment, null, windows.last()?.footer))
    const saveButton = (): HTMLButtonElement | undefined => [...footer.container.querySelectorAll('button')]
      .find(button => button.textContent === 'Save')
    expect(saveButton()).toBeUndefined()
    click(footer.container, 'Insert resources')
    await flush()
    expect(inserted).toEqual(['c-clean-save'])
    expect(calls.saveEdit).toBe(0)
    // Opening is a read-only preview; the edit document is fetched only after
    // the explicit Edit choice and only that document can be saved.
    expect(calls.loadEdit).toBe(0)
    const edited = await enterDetailEdit(windows)
    expect(calls.loadEdit).toBe(1)
    expect(edited.readOnly).toBe(false)
    act(() => { edited.onChange?.({ text: '# Changed' }) })
    footer.rerender(createElement(Fragment, null, windows.last()?.footer))
    expect(saveButton()?.disabled).toBe(false)
    const changed = windows.last()?.content as DetailProbe
    act(() => { changed.onChange?.({ text: '# Draft' }) })
    footer.rerender(createElement(Fragment, null, windows.last()?.footer))
    expect(saveButton()).toBeUndefined()
    expect(windows.last()?.dirty).toBe(false)
    footer.unmount()
  })

  it('orders Add to pack before Insert, and keeps Save the only primary while dirty', async () => {
    const { face, calls } = faceOf()
    const windows = recordingWindows()
    const added: unknown[] = []
    openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-pack-order', title: 'Note' },
      onInsertClue: () => true,
      onAddToPack: target => { added.push(target) },
    })
    await flush()
    const footer = renderRoot(createElement(Fragment, null, windows.last()?.footer))
    const labelled = (): HTMLButtonElement[] => [...footer.container.querySelectorAll('button')]
    const find = (label: string): HTMLButtonElement | undefined => labelled()
      .find(button => (button.textContent ?? '').trim() === label)
    const add = find('Add to pack')
    const insert = find('Insert resources')
    expect(add).toBeDefined()
    expect(insert).toBeDefined()
    // The two reference actions are the rightmost pair, in this order.
    expect(add!.compareDocumentPosition(insert!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(add!.className).not.toContain('primary')
    expect(insert!.className).toContain('primary')
    act(() => { add!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(added).toEqual([expect.objectContaining({ clueId: 'c-pack-order' })])
    expect(calls.saveEdit).toBe(0)

    // The dirty state only exists in edit mode: enter it through the detail's
    // controlled mode seam, then edit the loaded document.
    const content = await enterDetailEdit(windows)
    act(() => { content.onChange?.({ text: '# Changed' }) })
    footer.rerender(createElement(Fragment, null, windows.last()?.footer))
    const save = find('Save')
    expect(save).toBeDefined()
    expect(save!.className).toContain('primary')
    expect(find('Add to pack')!.className).not.toContain('primary')
    expect(find('Insert resources')!.className).not.toContain('primary')
    expect(calls.saveEdit).toBe(0)
    footer.unmount()
  })

  it('keeps an unknown edit format read-only with no Save control', async () => {
    const { face, calls } = faceOf({ loadEditDocument: () => ({ format: 'application/x-opaque', data: { n: 1 } }) })
    const windows = recordingWindows()
    openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-opaque', title: 'Opaque' },
    })
    await flush()
    const content = windows.last()?.content as { readOnly?: boolean; onSave?: () => void }
    expect(content.readOnly).toBe(true)
    expect(content.onSave).toBeUndefined()
    const footer = renderRoot(createElement(Fragment, null, windows.last()?.footer))
    expect([...footer.container.querySelectorAll('button')].some(button => button.textContent === 'Save')).toBe(false)
    expect(calls.saveEdit).toBe(0)
    footer.unmount()
  })

  it('removes Save when a source renderer disappears and blocks its stale save callback', async () => {
    const { face, calls } = faceOf({ loadEditDocument: () => ({ format: 'application/x-removable', data: { n: 1 } }) })
    let renderer: ReturnType<BetterSidebarCluesClientFace['getFormatRenderer']> = () => createElement('div', null, 'source')
    const listeners = new Set<() => void>()
    const liveFace = { ...face, getFormatRenderer: () => renderer,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    const windows = recordingWindows()
    openClueDetailWindow({ windows: windows.windows, face: liveFace, workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-removable', title: 'Removable' },
    })
    await flush()
    const initial = await enterDetailEdit(windows)
    expect(calls.loadEdit).toBe(1)
    act(() => { initial.onChange?.({ n: 2 }) })
    const edited = windows.last()?.content as DetailProbe
    expect(edited.onSave).toBeTypeOf('function')
    const footer = renderRoot(createElement(Fragment, null, windows.last()?.footer))
    expect([...footer.container.querySelectorAll('button')].some(button => button.textContent === 'Save')).toBe(true)
    act(() => { renderer = undefined; for (const listener of listeners) listener() })
    expect([...footer.container.querySelectorAll('button')].some(button => button.textContent === 'Save')).toBe(false)
    act(() => { edited.onSave?.() })
    await flush()
    expect(calls.saveEdit).toBe(0)
    expect(footer.container.textContent).toContain('Discard edits')
    footer.unmount()
    expect(listeners.size).toBe(0)
  })

  it('preserves the current edit mode, draft and controls when close is refused', async () => {
    const { WindowHost } = await import('../src/client/windows/WindowHost.tsx')
    const { createWindowHost } = await import('../src/client/windows/host.ts')
    const { face, calls } = faceOf()
    const host = createWindowHost({ viewport: () => ({ width: 1200, height: 900 }) })
    const view = renderRoot(createElement(WindowHost, { host, formats: face }))
    act(() => { openClueDetailWindow({ windows: host, face, workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-visible-draft', title: 'Visible draft' },
    }) })
    await flush()
    const frame = document.querySelector<HTMLElement>('[data-floating-window]')!
    expect(frame.querySelector<HTMLElement>('[data-window-document-preview]')!.hidden).toBe(false)
    expect(frame.querySelector<HTMLElement>('[data-window-document-editor]')!.hidden).toBe(true)
    act(() => { frame.querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    await flush()
    const editor = frame.querySelector<HTMLTextAreaElement>('[data-window-text-editor]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(editor, '# Retained draft')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    const close = frame.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
    await act(async () => { close.click(); await Promise.resolve() })
    expect(frame.querySelector('[data-window-text-editor]')).toBe(editor)
    expect(editor.value).toBe('# Retained draft')
    expect(frame.querySelector<HTMLElement>('[data-window-document-preview]')!.hidden).toBe(true)
    expect(frame.querySelector<HTMLElement>('[data-window-document-editor]')!.hidden).toBe(false)
    expect(frame.querySelector('[data-window-mode-tab="edit"]')?.getAttribute('aria-selected')).toBe('true')
    expect(frame.querySelector('[data-window-document-preview] h1')?.textContent).toBe('Retained draft')
    expect(frame.querySelector('[data-window-error]')?.textContent).toContain('Unsaved edits')
    const save = [...frame.querySelectorAll('button')].find(button => button.textContent === 'Save')!
    expect(save.disabled).toBe(false)
    act(() => { save.click() })
    await flush()
    expect(calls.saveEdit).toBe(1)
    expect(frame.querySelector('[data-window-mode-tab="edit"]')?.getAttribute('aria-selected')).toBe('true')
    expect(frame.querySelector<HTMLElement>('[data-window-document-editor]')!.hidden).toBe(false)
    expect(frame.querySelector('[data-window-dirty]')).toBeNull()
    expect([...frame.querySelectorAll('button')].find(button => button.textContent === 'Save')).toBeUndefined()
    await act(async () => { close.click(); await Promise.resolve() })
    expect(document.querySelector('[data-floating-window]')).toBeNull()
    view.unmount()
    host.dispose()
  })

  it('keeps preview selected when closing is refused after returning to the unsaved preview', async () => {
    const { WindowHost } = await import('../src/client/windows/WindowHost.tsx')
    const { createWindowHost } = await import('../src/client/windows/host.ts')
    const { face } = faceOf()
    const host = createWindowHost({ viewport: () => ({ width: 1200, height: 900 }) })
    const view = renderRoot(createElement(WindowHost, { host, formats: face }))
    act(() => { openClueDetailWindow({ windows: host, face, workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-preview-close', title: 'Preview close' },
    }) })
    await flush()
    const frame = document.querySelector<HTMLElement>('[data-floating-window]')!
    act(() => { frame.querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    await flush()
    const editor = frame.querySelector<HTMLTextAreaElement>('[data-window-text-editor]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(editor, '# Unsaved preview')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { frame.querySelector<HTMLButtonElement>('[data-window-mode-tab="preview"]')!.click() })
    const close = frame.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
    await act(async () => { close.click(); await Promise.resolve() })
    expect(frame.querySelector<HTMLElement>('[data-window-document-preview]')!.hidden).toBe(false)
    expect(frame.querySelector<HTMLElement>('[data-window-document-editor]')!.hidden).toBe(true)
    expect(frame.querySelector('[data-window-document-preview] h1')?.textContent).toBe('Unsaved preview')
    expect(frame.querySelector('[data-window-text-editor]')).toBe(editor)
    expect(editor.value).toBe('# Unsaved preview')
    expect(frame.querySelector('[data-window-error]')?.textContent).toContain('Unsaved edits')
    view.unmount()
    host.dispose()
  })

  it('edits through loadEdit/saveEdit and offers insert separately', async () => {
    const { face, calls } = faceOf()
    const windows = recordingWindows()
    const inserted: string[] = []
    openClueDetailWindow({
      windows: windows.windows,
      face,
      workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-edit', title: 'A note' },
      onInsertClue: (clueId) => { inserted.push(clueId); return true },
    })
    await flush()
    // Opening reads the preview only; Edit is the lazy request that fetches
    // the save baseline, and a read preview can never reach saveEdit.
    expect(calls.loadEdit).toBe(0)
    const preview = windows.last()?.content as DetailProbe
    expect(preview.kind).toBe('document')
    expect(preview.mode).toBe('preview')
    expect(preview.readOnly).toBe(true)
    const content = await enterDetailEdit(windows)
    expect(calls.loadEdit).toBe(1)
    expect(content.kind).toBe('document')
    expect(content.readOnly).toBe(false)
    expect(content.onSave).toBeUndefined()
    expect(content.presentation).toBe('modes')

    act(() => { content.onChange?.({ text: '# Edited' }) })
    await flush()
    const edited = windows.last()?.content as DetailProbe
    expect((edited.document?.data as { text: string }).text).toBe('# Edited')
    // Save lives in the ONE footer for every format and is an explicit click.
    const footer = renderRoot(createElement(Fragment, null, windows.last()?.footer))
    await flush()
    click(footer.container, 'Save')
    await flush()
    expect(calls.saveEdit).toBe(1)
    footer.unmount()
  })

  it('keeps the draft and offers a re-read after a save conflict', async () => {
    const conflict = new SidebarApiError('conflict', 'stale revision')
    const { face, calls } = faceOf({ saveError: () => conflict })
    const windows = recordingWindows()
    openClueDetailWindow({
      windows: windows.windows,
      face,
      workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-conflict', title: 'A note' },
    })
    await flush()
    const content = await enterDetailEdit(windows)
    act(() => { content.onChange?.({ text: '# Kept draft' }) })
    await flush()
    const footer = renderRoot(createElement(Fragment, null, windows.last()?.footer))
    await flush()
    click(footer.container, 'Save')
    await flush()
    const failed = windows.last()?.content as DetailProbe
    expect(failed.error).toContain('changed elsewhere')
    expect((failed.document?.data as { text: string }).text).toBe('# Kept draft')
    footer.rerender(createElement(Fragment, null, windows.last()?.footer))
    expect(footer.container.textContent).toContain('Re-read')
    click(footer.container, 'Re-read')
    await flush()
    expect(calls.loadEdit).toBe(2)
    footer.unmount()
  })

  it('refuses to close with an unsaved edit and keeps the draft', async () => {
    const { face } = faceOf()
    const windows = recordingWindows()
    openClueDetailWindow({
      windows: windows.windows,
      face,
      workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-unsaved', title: 'A note' },
    })
    await flush()
    const content = await enterDetailEdit(windows)
    act(() => { content.onChange?.({ text: '# Unsaved' }) })
    await flush()
    expect(windows.last()?.onBeforeClose?.()).toBe(false)
    const refreshed = windows.last()?.content as DetailProbe
    // The refusal does not drop the draft: the window stays open with the
    // explicit discard/save choice offered above.
    expect(refreshed.kind).toBe('document')
    expect((refreshed.document?.data as { text: string }).text).toBe('# Unsaved')
    expect(refreshed.error).toContain('Unsaved edits')
  })

  it('allows closing a freshly loaded window that was never edited', async () => {
    const { face } = faceOf()
    const windows = recordingWindows()
    openClueDetailWindow({
      windows: windows.windows,
      face,
      workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-clean', title: 'A note' },
    })
    await flush()
    // A load is the saved baseline: dirty means "actual unsaved edit", not
    // "the editor has not saved yet".
    expect(windows.last()?.dirty).toBe(false)
    expect(windows.last()?.onBeforeClose?.()).toBe(true)
  })

  it('focuses an already-open detail window without replacing its unsaved draft', async () => {
    const { face, calls } = faceOf()
    let latest: WindowOpenOptions | undefined
    const handles = new Map<string, WindowHandle>()
    const windows = {
      open(options: WindowOpenOptions): WindowHandle {
        const existing = handles.get(options.id)
        if (existing !== undefined) return existing
        latest = options
        const handle: WindowHandle = {
          id: options.id,
          update(patch) { latest = { ...(latest ?? options), ...patch } as WindowOpenOptions },
          focus: () => undefined,
          close: async () => undefined,
          navigation: { push: () => undefined, pop: () => false, back: () => false, canGoBack: () => false, depth: () => 1 },
        }
        handles.set(options.id, handle)
        return handle
      },
    }
    const target = { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-draft', title: 'A note' }
    openClueDetailWindow({ windows, face, workspaceId: 'ws-1', target })
    await flush()
    expect(calls.loadEdit).toBe(0)
    const preview = latest?.content as unknown as DetailProbe
    act(() => { preview.onModeChange?.('edit') })
    await flush()
    const content = latest?.content as unknown as DetailProbe
    act(() => { content.onChange?.({ text: '# Unsaved draft' }) })
    await flush()

    openClueDetailWindow({ windows, face, workspaceId: 'ws-1', target })
    await flush()
    // The second open focused the live instance: no second loadEdit and the
    // draft is still in the window.
    expect(calls.loadEdit).toBe(1)
    const reopened = latest?.content as unknown as DetailProbe
    expect((reopened.document?.data as { text: string }).text).toBe('# Unsaved draft')
  })

  it('binds a single clue to a workspace and unbinds without deleting it', async () => {
    const { face, calls } = faceOf()
    const windows = recordingWindows()
    openClueDetailWindow({
      windows: windows.windows,
      face,
      workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-bind', title: 'A note' },
      workspaces: [
        { workspaceId: 'ws-1', title: '/repo' },
        { workspaceId: 'ws-2', title: '/other' },
      ],
    })
    await flush()
    const view = renderRoot(createElement(Fragment, null, windows.last()?.footer))
    await flush()

    const advanced = view.container.querySelector<HTMLDetailsElement>('[data-clue-detail-advanced]')!
    expect(advanced.open).toBe(false)
    expect(advanced.querySelector('summary')?.textContent).toBe('Workspace binding')
    act(() => { advanced.open = true })
    expect(view.container.textContent).toContain('Workspace binding')
    expect(view.container.textContent).toContain('New sessions in this workspace receive these references automatically')
    expect(view.container.textContent).toContain('Unbinding deletes neither the clues')
    chooseBindingWorkspace(view.container, '/other')
    await flush()
    click(view.container, 'Bind')
    await flush()
    expect(calls.bindingAddTargets).toEqual([
      { workspaceId: 'ws-2', target: { kind: 'clue', clueId: 'c-bind' } },
    ])
    expect(view.container.textContent).toContain('Bound')

    click(view.container, 'Unbind')
    await flush()
    expect(calls.bindingRemoveTargets).toEqual([
      { workspaceId: 'ws-2', target: { kind: 'clue', clueId: 'c-bind' } },
    ])
    expect(view.container.querySelector('button[aria-label="Choose a workspace"][aria-haspopup="menu"]')).not.toBeNull()
    view.unmount()
  })

  it('uses the binding copy instead of the pack-save copy when binding fails', async () => {
    const { face } = faceOf({ bindingAddError: () => new SidebarApiError('network', 'offline') })
    const windows = recordingWindows()
    openClueDetailWindow({
      windows: windows.windows,
      face,
      workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-bind-fail', title: 'A note' },
      workspaces: [
        { workspaceId: 'ws-1', title: '/repo' },
        { workspaceId: 'ws-2', title: '/other' },
      ],
    })
    await flush()
    const view = renderRoot(createElement(Fragment, null, windows.last()?.footer))
    await flush()
    chooseBindingWorkspace(view.container, '/other')
    click(view.container, 'Bind')
    await flush()
    const alert = view.container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('The workspace binding operation failed.')
    expect(alert?.textContent).not.toContain('Saving the pack failed.')
    view.unmount()
  })

  it('explains that a cross-workspace clue must be added there before binding', async () => {
    const { face } = faceOf({
      bindingAddError: () => new SidebarApiError('not-found', 'clue "c-cross" does not exist in this workspace'),
    })
    const windows = recordingWindows()
    openClueDetailWindow({
      windows: windows.windows,
      face,
      workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-cross', title: 'A note' },
      workspaces: [
        { workspaceId: 'ws-1', title: '/repo' },
        { workspaceId: 'ws-2', title: '/other' },
      ],
    })
    await flush()
    const view = renderRoot(createElement(Fragment, null, windows.last()?.footer))
    await flush()
    chooseBindingWorkspace(view.container, '/other')
    click(view.container, 'Bind')
    await flush()
    const alert = view.container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('not in the selected workspace')
    expect(alert?.textContent).toContain('before binding')
    view.unmount()
  })

  it('uses the binding copy when the binding list read fails', async () => {
    const { face } = faceOf({ bindingsListError: () => new SidebarApiError('network', 'offline') })
    const windows = recordingWindows()
    openClueDetailWindow({
      windows: windows.windows,
      face,
      workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-bind-read', title: 'A note' },
      workspaces: [{ workspaceId: 'ws-1', title: '/repo' }],
    })
    await flush()
    const view = renderRoot(createElement(Fragment, null, windows.last()?.footer))
    await flush()
    const alert = view.container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('The workspace binding operation failed.')
    expect(alert?.textContent).not.toContain('Saving the pack failed.')
    view.unmount()
  })

  it('never offers a save for a read-only type and explains why', async () => {
    const { face } = faceOf({ editable: false })
    const windows = recordingWindows()
    openClueDetailWindow({
      windows: windows.windows,
      face,
      workspaceId: 'ws-1',
      target: {
        sourceId: GITHUB_SOURCE.sourceId,
        typeId: 'builtin.github.issue',
        locator: { host: 'github.com', owner: 'acme', repo: 'widgets', kind: 'issue', number: 7 },
        title: '#7',
      },
    })
    await flush()
    const content = windows.last()?.content as unknown as { readOnly?: boolean; error?: string }
    expect(content.readOnly).toBe(true)
    expect(content.error).toContain('read-only')
    // The original-source link is a header action now (it is not a save and
    // does not belong in the footer), and the window opens no toolbar band.
    expect(windows.last()?.actions).toBeUndefined()
    const header = renderRoot(createElement(Fragment, null, (windows.last()?.content as { header?: ReactNode }).header))
    expect(header.container.textContent).toContain('Open the original resource')
    expect(header.container.querySelector('a[href="https://github.com/acme/widgets/issues/7"]')).not.toBeNull()
    expect(header.container.querySelector('[data-clue-detail-toolbar]')).not.toBeNull()
    const footer = renderRoot(createElement(Fragment, null, windows.last()?.footer))
    await flush()
    expect(footer.container.querySelector('[data-clue-detail-save]')).toBeNull()
    header.unmount()
    footer.unmount()
  })

  it('treats a source-locked edit document (archived) as read-only with the reason', async () => {
    const { face, calls } = faceOf({
      sources: [GITHUB_SOURCE],
      loadEditDocument: () => ({
        format: 'text/markdown',
        data: { text: '# Locked', readOnly: true, readOnlyReason: 'archived' },
        baseRevision: 'r1',
      }),
    })
    const windows = recordingWindows()
    openClueDetailWindow({
      windows: windows.windows,
      face,
      workspaceId: 'ws-1',
      target: { sourceId: GITHUB_SOURCE.sourceId, typeId: 'builtin.github.issue', clueId: 'c-archived', title: '#7' },
    })
    await flush()
    // A source lock is discovered by the lazy edit load, not by the preview
    // read: choosing Edit is what fetches the document and its lock reason.
    expect(calls.loadEdit).toBe(0)
    const locked = await enterDetailEdit(windows)
    expect(calls.loadEdit).toBe(1)
    expect(locked.mode).toBe('preview')
    expect(locked.readOnly).toBe(true)
    expect(locked.onSave).toBeUndefined()
    expect(locked.error).toContain('archived')
  })

  it('offers Retry and the original source on a permission failure', async () => {
    let fail = true
    const { face } = faceOf({
      editable: false,
      readError: () => {
        if (fail) return new SidebarApiError('permission-denied', 'no access')
        return undefined
      },
    })
    const windows = recordingWindows()
    openClueDetailWindow({
      windows: windows.windows,
      face,
      workspaceId: 'ws-1',
      target: {
        sourceId: GITHUB_SOURCE.sourceId,
        typeId: 'builtin.github.issue',
        locator: { host: 'github.com', owner: 'acme', repo: 'widgets', kind: 'pull', number: 9 },
        title: '#9',
      },
    })
    await flush()
    const failure = renderRoot(createElement(Fragment, null, windows.last()?.content as ReactNode))
    await flush()
    expect(failure.container.textContent).toContain('Insufficient permissions')
    expect(failure.container.textContent).toContain('Retry')
    expect(failure.container.querySelector('a[href="https://github.com/acme/widgets/pull/9"]')).not.toBeNull()

    fail = false
    click(failure.container, 'Retry')
    await flush()
    const content = windows.last()?.content as unknown as { readOnly?: boolean }
    expect(content.readOnly).toBe(true)
    failure.unmount()
  })
})

// ── share window ────────────────────────────────────────────────────────────

describe('clue share window', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:cluepack'),
      revokeObjectURL: vi.fn(),
    }))
  })

  it('previews the export payload and downloads the archive', async () => {
    const { face } = faceOf()
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/sidebar/api/clues.share.exportPreview')) {
        return new Response(JSON.stringify({
          ok: true,
          value: {
            mode: 'snapshot',
            fileName: 'release.cluepack',
            items: [],
            packs: [{ packId: 'p1', name: 'Release clues', members: 2 }],
            warnings: [],
            totals: { clues: 2, packs: 1, sources: 1 },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (String(url).includes('/sidebar/api/clues.share.exportInspect')) {
        return new Response(JSON.stringify({ ok: true, value: { mode: 'snapshot', fileName: 'release.cluepack', items: [], warnings: [] } }), { status: 200 })
      }
      if (String(url).includes('/sidebar/clues/share/export')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="release.cluepack"', 'x-cluepack-complete': 'true', 'x-cluepack-issues': '0' },
        })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    const view = renderRoot(createElement(SharePage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      packIds: ['p1'],
    }))
    await flush(6)
    click(view.container, 'Preview selection')
    await flush(6)
    expect(view.container.querySelector('[aria-label="Preview selection"] button')?.textContent).toBe('Check source references')
    expect(view.container.textContent).toContain('2 clues')
    expect(view.container.textContent).toContain('Release clues')
    expect(view.container.textContent).toContain('2 members')
    click(view.container, 'Export .cluepack')
    await flush(8)
    expect(view.container.textContent).toContain('Done')
    expect(URL.createObjectURL).toHaveBeenCalled()
    view.unmount()
  })

  it('locks preview inputs while busy and keeps actions outside the scrolling panel', async () => {
    const { face } = faceOf()
    let finish!: (response: Response) => void
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve }))
    const view = renderRoot(createElement(SharePage, {
      windows: recordingWindows().windows, workspaceId: 'ws-1', face, packIds: ['p1'],
    }))
    await flush()
    click(view.container, 'Preview selection')
    await flush()
    expect(view.container.querySelector<HTMLFieldSetElement>('fieldset[aria-label="Share content"]')?.disabled).toBe(true)
    const checks = [...view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(checks.length).toBeGreaterThan(0)
    expect(checks.every(input => input.disabled)).toBe(true)
    const panel = view.container.querySelector('[role="tabpanel"]')!
    const exportAction = [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('Preview selection'))!
    expect(panel.contains(exportAction)).toBe(false)
    expect(exportAction.disabled).toBe(true)
    await act(async () => { finish(new Response(JSON.stringify({ ok: true, value: {
      mode: 'snapshot', fileName: 'release.cluepack', items: [], packs: [], warnings: [],
      totals: { clues: 2, packs: 1, sources: 1 },
    } }), { status: 200 })) })
    await flush()
    expect(view.container.querySelector<HTMLFieldSetElement>('fieldset[aria-label="Share content"]')?.disabled).toBe(false)
    expect(exportAction.disabled).toBe(false)
    view.unmount()
  })

  it('only cancels an in-flight preview when a later open actually changes its inputs', async () => {
    const { face } = faceOf()
    const recorded = recordingWindows()
    let handle: WindowHandle | undefined
    const windows = { open: (options: WindowOpenOptions): WindowHandle => {
      handle ??= recorded.windows.open(options)
      return handle
    } }
    let signal: AbortSignal | undefined
    let finish!: (response: Response) => void
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      return new Promise<Response>(resolve => { finish = resolve })
    })
    openShareWindow({ windows, workspaceId: 'ws-1', face, packIds: ['p1'], direction: 'export' })
    const view = renderRoot(createElement(Fragment, null, recorded.last()!.content as ReactNode))
    await flush()
    click(view.container, 'Preview selection')
    await flush()
    expect(signal?.aborted).toBe(false)
    act(() => { openShareWindow({ windows, workspaceId: 'ws-1', face, packIds: ['p1'], direction: 'export' }) })
    expect(signal?.aborted).toBe(false)
    expect(view.container.querySelector<HTMLFieldSetElement>('fieldset[aria-label="Share content"]')?.disabled).toBe(true)
    act(() => { openShareWindow({ windows, workspaceId: 'ws-1', face, packIds: ['p2'], direction: 'export' }) })
    expect(signal?.aborted).toBe(true)
    expect(view.container.querySelector<HTMLFieldSetElement>('fieldset[aria-label="Share content"]')?.disabled).toBe(false)
    await act(async () => { finish(new Response(JSON.stringify({ ok: true, value: {
      mode: 'snapshot', fileName: 'old.cluepack', items: [], packs: [], warnings: [],
      totals: { clues: 999, packs: 1, sources: 1 },
    } }), { status: 200 })) })
    await flush()
    expect(view.container.textContent).not.toContain('999 clues')
    view.unmount()
  })

  it('exports with the protocol mode "references" (not the singular client spelling)', async () => {
    const { face } = faceOf()
    const bodies: Record<string, unknown>[] = []
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      if (String(url).includes('/sidebar/api/clues.share.exportPreview')) {
        return new Response(JSON.stringify({
          ok: true,
          value: {
            mode: 'references',
            fileName: 'release.cluepack',
            items: [],
            packs: [{ packId: 'p1', name: 'Release clues', members: 2 }],
            warnings: [],
            totals: { clues: 2, packs: 1, sources: 1 },
          },
        }), { status: 200 })
      }
      if (String(url).includes('/sidebar/clues/share/export')) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="release.cluepack"',
            'x-cluepack-complete': 'true',
            'x-cluepack-issues': '0',
          },
        })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })

    const view = renderRoot(createElement(SharePage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      packIds: ['p1'],
    }))
    await flush(6)
    const choices = view.container.querySelector('fieldset[aria-label="Share content"]')!
    const radios = choices.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    expect(radios).toHaveLength(2)
    expect(choices.textContent).toContain('readable offline')
    expect(choices.textContent).toContain('authorization')
    const referenceOption = choices.querySelector<HTMLInputElement>('input[value="references"]')!
    act(() => { referenceOption.click() })
    expect(referenceOption.checked).toBe(true)
    await flush()
    click(view.container, 'Preview selection')
    await flush(6)
    click(view.container, 'Export .cluepack')
    await flush(8)

    // Progress polls are a different payload shape; only preview/export carry
    // the archive mode.
    const archiveBodies = bodies.filter(body => body.workspaceId === 'ws-1')
    expect(archiveBodies).toHaveLength(2)
    expect(archiveBodies.every(body => body.mode === 'references')).toBe(true)
    // The host protocol only knows the plural spelling.
    expect(bodies.some(body => body.mode === 'reference')).toBe(false)
    view.unmount()
  })

  it('exposes the two directions as an accessible tab set', async () => {
    const { face } = faceOf()
    const view = renderRoot(createElement(SharePage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
    }))
    await flush()
    const exportTab = view.container.querySelector<HTMLButtonElement>('#clue-share-tab-export')!
    const importTab = view.container.querySelector<HTMLButtonElement>('#clue-share-tab-import')!
    expect(exportTab.getAttribute('aria-selected')).toBe('true')
    expect(exportTab.getAttribute('aria-controls')).toBe('clue-share-panel')
    expect(importTab.getAttribute('tabindex')).toBe('-1')
    expect(view.container.querySelector('#clue-share-panel')?.getAttribute('role')).toBe('tabpanel')

    act(() => { exportTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    await flush()
    expect(importTab.getAttribute('aria-selected')).toBe('true')
    expect(exportTab.getAttribute('tabindex')).toBe('-1')
    act(() => { importTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    await flush()
    expect(exportTab.getAttribute('aria-selected')).toBe('true')
    view.unmount()
  })

  it('clears its operation state on Reset', async () => {
    const { face } = faceOf()
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/sidebar/api/clues.share.exportPreview')) {
        return new Response(JSON.stringify({
          ok: true,
          value: {
            mode: 'snapshot',
            fileName: 'release.cluepack',
            items: [],
            packs: [{ packId: 'p1', name: 'Release clues', members: 2 }],
            warnings: [],
            totals: { clues: 2, packs: 1, sources: 1 },
          },
        }), { status: 200 })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    const view = renderRoot(createElement(SharePage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
      packIds: ['p1'],
    }))
    await flush(6)
    click(view.container, 'Preview selection')
    await flush(6)
    expect(view.container.textContent).toContain('2 clues')
    click(view.container, 'Reset')
    await flush()
    expect(view.container.textContent).not.toContain('2 clues')
    expect(view.container.textContent).not.toContain('Done')
    view.unmount()
  })

  it('merges later pack selections and direction into the already-open window', async () => {
    const second: CluePack = {
      id: 'p2',
      name: 'Design notes',
      workspaceId: 'ws-1',
      members: [],
      revision: 1,
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
    }
    const { face } = faceOf({ packs: [PACK, second] })
    let content: ReactNode
    const handles = new Map<string, WindowHandle>()
    const windows = {
      open(options: WindowOpenOptions): WindowHandle {
        const existing = handles.get(options.id)
        if (existing !== undefined) return existing
        content = options.content as ReactNode
        const handle: WindowHandle = {
          id: options.id,
          update: () => undefined,
          focus: () => undefined,
          close: async () => undefined,
          navigation: { push: () => undefined, pop: () => false, back: () => false, canGoBack: () => false, depth: () => 1 },
        }
        handles.set(options.id, handle)
        return handle
      },
    }
    openShareWindow({ windows, workspaceId: 'ws-1', face, packIds: ['p1'] })
    const view = renderRoot(createElement(Fragment, null, content!))
    await flush(6)
    openShareWindow({ windows, workspaceId: 'ws-1', face, packIds: ['p2'], direction: 'import' })
    await flush()
    expect(view.container.querySelector('#clue-share-tab-import')?.getAttribute('aria-selected')).toBe('true')

    // The new pack is merged with the original selection, not replacing it.
    click(view.container, 'Export')
    await flush()
    const checked = [...view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .filter(input => input.checked)
    expect(checked.length).toBe(2)
    view.unmount()
  })

  it('retargets an open window to the workspace of a later Import request', async () => {
    const { face, calls } = faceOf()
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/sidebar/clues/share/import-preview')) {
        return new Response(JSON.stringify({
          ok: true,
          value: {
            workspaceId: 'ws-2',
            mode: 'snapshot',
            exportedAt: '2026-10-17T00:00:00.000Z',
            packNames: [],
            packs: [],
            items: [],
            missingSources: [],
            snapshotCount: 0,
            unresolvedCount: 0,
            warnings: [],
          },
        }), { status: 200 })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    let content: ReactNode
    const handles = new Map<string, WindowHandle>()
    const windows = {
      open(options: WindowOpenOptions): WindowHandle {
        const existing = handles.get(options.id)
        if (existing !== undefined) return existing
        content = options.content as ReactNode
        const handle: WindowHandle = {
          id: options.id,
          update: () => undefined,
          focus: () => undefined,
          close: async () => undefined,
          navigation: { push: () => undefined, pop: () => false, back: () => false, canGoBack: () => false, depth: () => 1 },
        }
        handles.set(options.id, handle)
        return handle
      },
    }
    openShareWindow({ windows, workspaceId: 'ws-1', face, direction: 'import' })
    const view = renderRoot(createElement(Fragment, null, content!))
    await flush(6)
    expect(calls.packsList).toEqual(['ws-1'])

    // The workspace switched while the singleton window stayed open; the
    // tab's Import now names ws-2.
    act(() => {
      openShareWindow({ windows, workspaceId: 'ws-2', face, direction: 'import' })
    })
    await flush(6)
    expect(calls.packsList).toEqual(['ws-1', 'ws-2'])

    // The file chosen AFTER the switch is previewed against ws-2, never the
    // workspace the window was first opened for.
    const file = new File([new Uint8Array([1, 2, 3])], 'share.cluepack')
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    act(() => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush(6)
    const previewUrls = fetchMock.mock.calls.map(call => String(call[0]))
    expect(previewUrls.some(url => url.includes('workspaceId=ws-2'))).toBe(true)
    expect(previewUrls.some(url => url.includes('workspaceId=ws-1'))).toBe(false)
    view.unmount()
  })

  it('opens the import page when the tab asks for it', async () => {
    const { face } = faceOf()
    let content: ReactNode
    const windows = {
      open(options: WindowOpenOptions): WindowHandle {
        content = options.content as ReactNode
        return {
          id: options.id,
          update: () => undefined,
          focus: () => undefined,
          close: async () => undefined,
          navigation: { push: () => undefined, pop: () => false, back: () => false, canGoBack: () => false, depth: () => 1 },
        }
      },
    }
    openShareWindow({ windows, workspaceId: 'ws-1', face, direction: 'import' })
    const view = renderRoot(createElement(Fragment, null, content!))
    await flush()
    expect(view.container.querySelector('#clue-share-tab-import')?.getAttribute('aria-selected')).toBe('true')
    expect(view.container.querySelector('input[type="file"]')).not.toBeNull()
    view.unmount()
  })

  it('does not turn a failed pack list into "no packs" and retries it', async () => {
    let fail = true
    const { face } = faceOf({ packsListError: () => (fail ? new SidebarApiError('network', 'offline') : undefined) })
    const view = renderRoot(createElement(SharePage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
    }))
    await flush()
    const alert = view.container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Failed to load')
    expect(view.container.textContent).not.toContain('No clue packs yet')

    fail = false
    click(view.container, 'Retry')
    await flush()
    expect(view.container.textContent).toContain('Release clues')
    view.unmount()
  })

  it('previews an import and reports unresolved rows and missing sources', async () => {
    const { face } = faceOf()
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/sidebar/clues/share/import-preview')) {
        return new Response(JSON.stringify({
          ok: true,
          value: {
            workspaceId: 'ws-1',
            mode: 'snapshot',
            exportedAt: '2026-10-17T00:00:00.000Z',
            packNames: ['Release clues'],
            packs: [{ key: 'p1', name: 'Release clues', members: 1 }],
            items: [{
              key: 'k1',
              title: 'A note',
              sourceId: 'third.party:docs',
              typeId: 'third.party:doc',
              portable: false,
              snapshot: true,
              snapshotFetchedAt: '2026-10-17T00:00:00.000Z',
              willBeUnresolved: true,
              unresolvedReason: 'source not installed',
            }],
            missingSources: ['third.party:docs'],
            snapshotCount: 1,
            unresolvedCount: 1,
            warnings: [],
          },
        }), { status: 200 })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    const view = renderRoot(createElement(SharePage, {
      windows: recordingWindows().windows,
      workspaceId: 'ws-1',
      face,
    }))
    await flush()
    click(view.container, 'Import')
    await flush()
    const file = new File([new Uint8Array([1, 2, 3])], 'share.cluepack')
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    act(() => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush(6)
    expect(view.container.textContent).toContain('share.cluepack')
    expect(view.container.textContent).toContain('Release clues')
    expect(view.container.textContent).toContain('1 member')
    expect(view.container.textContent).toContain('Missing sources: third.party:docs')
    expect(view.container.textContent).toContain('source not installed')
    view.unmount()
  })

  it('shows partial import reasons until and after explicit acceptance without replaying writes', async () => {
    const { face } = faceOf()
    let imports = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/sidebar/clues/share/import-preview')) {
        return new Response(JSON.stringify({ ok: true, value: {
          workspaceId: 'ws-1', mode: 'snapshot', exportedAt: '2026-10-17T00:00:00.000Z',
          packNames: [], packs: [], items: [], missingSources: [], snapshotCount: 0, unresolvedCount: 0, warnings: [],
        } }), { status: 200 })
      }
      if (String(url).includes('/sidebar/clues/share/import')) {
        imports += 1
        return new Response(JSON.stringify({ ok: true, value: {
          workspaceId: 'ws-1', mode: 'snapshot', clues: [], packs: [], snapshots: [],
          complete: false, partial: true, cancelled: false, requiresAcceptance: true,
          reasons: ['Snapshot unavailable: A note', 'Source not installed: third.party:docs'],
        } }), { status: 200 })
      }
      throw new Error('unexpected request ' + String(url))
    })
    const view = renderRoot(createElement(SharePage, {
      windows: recordingWindows().windows, workspaceId: 'ws-1', face, direction: 'import',
    }))
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File([new Uint8Array([1])], 'partial.cluepack')], configurable: true })
    act(() => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush(6)
    click(view.container, 'Import .cluepack')
    await flush(8)
    const reasons = view.container.querySelector('[data-clue-import-reasons]')!
    expect(reasons.getAttribute('role')).toBe('alert')
    expect(reasons.textContent).toContain('Snapshot unavailable: A note')
    expect(reasons.textContent).toContain('Source not installed: third.party:docs')
    click(view.container, 'Accept the imported subset')
    await flush()
    expect(view.container.querySelector('[data-clue-import-reasons]')?.textContent).toContain('Snapshot unavailable: A note')
    expect(imports).toBe(1)
    expect([...view.container.querySelectorAll('button')].find(button => button.textContent === 'Import .cluepack')?.disabled).toBe(true)
    view.unmount()
  })
})
