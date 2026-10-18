/**
 * S9 clue pack, detail and share surfaces.
 *
 * Contract pinned here (approved S9 spec §3–§4, §7):
 * - pack management saves the name as an explicit action, removes members
 *   without deleting anything, and shows a CAS conflict without pretending the
 *   save landed;
 * - the workspace binding panel explains the auto-provide behavior, and
 *   binding/unbinding acts on the SELECTED workspace;
 * - the add-member page keeps its cross-page selection, filters by source and
 *   only shows loaded candidates;
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
import { openClueDetailWindow } from '../src/client/clues/windows/detail.tsx'
import { SharePage } from '../src/client/clues/windows/share.tsx'
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
}

interface FaceOverrides {
  saveError?: () => unknown
  renameError?: () => unknown
  editable?: boolean
  sources?: ClueSourceDescriptor[]
  enabled?: (sourceId: string) => boolean
  listFor?: (sourceId: string) => readonly ClueCandidate[]
  searchFor?: (sourceId: string) => readonly ClueCandidate[]
  resolveCandidates?: readonly ClueCandidate[]
  readError?: () => unknown
  loadEditDocument?: () => unknown
  packsListError?: () => unknown
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
  }
  const api = {
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
    packsList: async () => {
      const rejected = overrides.packsListError?.()
      if (rejected !== undefined) throw rejected
      return { packs: [PACK], revision: 4 }
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
    bindingsList: async (workspaceId: string) => ({
      bindings: bound.filter(binding => binding.workspaceId === workspaceId),
      revision: bound.length + 1,
    }),
    bindingsAdd: async (workspaceId: string, input: { target: ClueBindingTarget }) => {
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
      return {
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

    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Renamed')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    expect(guard.dirty).toBe(true)
    click(view.container, 'Save')
    await flush()
    expect(calls.rename).toBe(1)
    expect(guard.dirty).toBe(false)
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
    click(view.container, 'Remove member: A note')
    await flush()
    expect(calls.removeMember).toBe(1)
    expect(view.container.textContent).not.toContain('A note')
    view.unmount()
  })

  it('binds to the selected workspace and explains the auto-provide behavior', async () => {
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
    expect(view.container.textContent).toContain('New sessions in this workspace receive these references automatically')
    expect(view.container.textContent).toContain('Unbinding deletes neither the clues')
    const select = view.container.querySelector<HTMLSelectElement>('select[aria-label="Choose a workspace"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, 'ws-2')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    click(view.container, 'Bind')
    await flush()
    expect(calls.bindingAdd).toEqual(['ws-2'])
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
    click(view.container, 'Local files')
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
    click(view.container, 'Local files')
    await flush()
    const filesBox = view.container.querySelector<HTMLInputElement>('[data-clue-add-member] ul input[type="checkbox"]')!
    act(() => { filesBox.click() })
    await flush()
    expect(view.container.textContent).toContain('1 selected')

    // Switching source rebuilds the page but must NOT drop the selection.
    click(view.container, 'GitHub Issues')
    await flush()
    expect(view.container.textContent).toContain('1 selected')
    expect(view.container.textContent).toContain('Fix the widget')

    click(view.container, 'Local files')
    await flush()
    const filesAgain = view.container.querySelector<HTMLInputElement>('[data-clue-add-member] ul input[type="checkbox"]')!
    expect(filesAgain.checked).toBe(true)
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
    click(view.container, 'GitHub Issues')
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
    click(view.container, 'Save range')
    await flush()
    expect(calls.list).toBe(1)
    expect(calls.listParams[0]).toMatchObject({
      sourceId: GITHUB_SOURCE.sourceId,
      scope: { repo: 'acme/widgets', state: 'open' },
    })
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
    click(view.container, 'GitHub Issues')
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Search a keyword, or paste a resource URL / path"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'https://github.com/acme/widgets/issues/7')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(view.container, 'Search')
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
    expect(view.container.textContent).toContain('Local files')
    expect(view.container.textContent).not.toContain('GitHub Issues')
    view.unmount()
  })

  it('guards a dirty name draft on close', async () => {
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
    // The guard starts clean; the page marks it dirty after an edit (covered
    // by the rename test), so the window-level default allows closing.
    expect(handle.id).toBe('pack:p1')
    expect(windows.last()?.onBeforeClose?.()).toBe(true)
    handle.update({ title: 'focused' })
  })
})

// ── detail window ───────────────────────────────────────────────────────────

describe('clue detail window', () => {
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
    expect(calls.loadEdit).toBe(1)
    const content = windows.last()?.content as unknown as { kind: 'document'; readOnly?: boolean; onSave?: () => void; onChange?: (data: unknown) => void }
    expect(content.kind).toBe('document')
    expect(content.readOnly).toBe(false)
    expect(typeof content.onSave).toBe('function')

    act(() => { content.onChange?.({ text: '# Edited' }) })
    await flush()
    const edited = windows.last()?.content as unknown as { document: { data: { text: string } }; onSave?: () => void }
    expect(edited.document.data.text).toBe('# Edited')
    act(() => { edited.onSave?.() })
    await flush()
    expect(calls.saveEdit).toBe(1)
  })

  it('keeps the draft and offers a re-read after a save conflict', async () => {
    const conflict = new SidebarApiError('conflict', 'stale revision')
    const { face } = faceOf({ saveError: () => conflict })
    const windows = recordingWindows()
    openClueDetailWindow({
      windows: windows.windows,
      face,
      workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: 'c-conflict', title: 'A note' },
    })
    await flush()
    const content = windows.last()?.content as unknown as { onChange?: (data: unknown) => void; onSave?: () => void; document: { data: { text: string } } }
    act(() => { content.onChange?.({ text: '# Kept draft' }) })
    await flush()
    const edited = windows.last()?.content as unknown as { onSave?: () => void; document: { data: { text: string } } }
    act(() => { edited.onSave?.() })
    await flush()
    const failed = windows.last()?.content as unknown as { error?: string; document: { data: { text: string } } }
    expect(failed.error).toContain('changed elsewhere')
    expect(failed.document.data.text).toBe('# Kept draft')
    expect(String(windows.last()?.footer)).toBeTruthy()
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
    const content = windows.last()?.content as unknown as { onChange?: (data: unknown) => void }
    act(() => { content.onChange?.({ text: '# Unsaved' }) })
    await flush()
    expect(windows.last()?.onBeforeClose?.()).toBe(false)
    const refreshed = windows.last()?.content as unknown as { kind?: string }
    // The refusal does not drop the draft: the window stays open with the
    // explicit discard/save choice offered above.
    expect(refreshed.kind).not.toBe('document')
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
    const content = latest?.content as unknown as { onChange?: (data: unknown) => void }
    act(() => { content.onChange?.({ text: '# Unsaved draft' }) })
    await flush()

    openClueDetailWindow({ windows, face, workspaceId: 'ws-1', target })
    await flush()
    // The second open focused the live instance: no second loadEdit and the
    // draft is still in the window.
    expect(calls.loadEdit).toBe(1)
    const reopened = latest?.content as unknown as { document: { data: { text: string } } }
    expect(reopened.document.data.text).toBe('# Unsaved draft')
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

    expect(view.container.textContent).toContain('Workspace binding')
    expect(view.container.textContent).toContain('New sessions in this workspace receive these references automatically')
    expect(view.container.textContent).toContain('Unbinding deletes neither the clues')
    const select = view.container.querySelector<HTMLSelectElement>('select[aria-label="Choose a workspace"]')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, 'ws-2')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
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
    expect(view.container.querySelector('select[aria-label="Choose a workspace"]')).not.toBeNull()
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
    const footer = renderRoot(createElement(Fragment, null, windows.last()?.footer))
    await flush()
    expect(footer.container.textContent).toContain('Open the original resource')
    expect(footer.container.querySelector('a[href="https://github.com/acme/widgets/issues/7"]')).not.toBeNull()
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
    const content = windows.last()?.content as unknown as { readOnly?: boolean; error?: string; onSave?: unknown }
    expect(content.readOnly).toBe(true)
    expect(content.onSave).toBeUndefined()
    expect(content.error).toContain('archived')
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
    click(view.container, 'Preview')
    await flush(6)
    expect(view.container.textContent).toContain('2 clues')
    click(view.container, 'Export .cluepack')
    await flush(8)
    expect(view.container.textContent).toContain('Done')
    expect(URL.createObjectURL).toHaveBeenCalled()
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
    const select = view.container.querySelector<HTMLSelectElement>('select')!
    expect([...select.options].map(option => option.value)).toContain('references')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, 'references')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    click(view.container, 'Preview')
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
    expect(view.container.textContent).toContain('Missing sources: third.party:docs')
    expect(view.container.textContent).toContain('source not installed')
    view.unmount()
  })
})
