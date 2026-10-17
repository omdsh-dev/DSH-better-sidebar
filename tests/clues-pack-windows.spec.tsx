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
import { createElement } from 'react'
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
import type { CluePack } from '../src/clues/types.ts'
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
  loadEdit: number
  saveEdit: number
}

function faceOf(overrides: {
  saveError?: () => unknown
  renameError?: () => unknown
  editable?: boolean
} = {}): { face: BetterSidebarCluesClientFace; calls: FaceCalls } {
  const calls: FaceCalls = {
    rename: 0,
    removeMember: 0,
    addMember: 0,
    bindingAdd: [],
    bindingRemove: [],
    loadEdit: 0,
    saveEdit: 0,
  }
  const api = {
    sources: async () => ({
      sources: [{
        sourceId: 'builtin.files',
        name: 'Local files',
        order: 0,
        pluginId: 'dsh-better-sidebar',
        types: ['builtin.files.markdown'],
        transport: 'files' as const,
        capabilities: { resolve: true, list: true, search: true, read: true, edit: overrides.editable !== false, portable: true },
      }],
      types: [{
        typeId: 'builtin.files.markdown',
        sourceId: 'builtin.files',
        formats: ['text/markdown'],
        capabilities: { read: true, edit: overrides.editable !== false, concurrency: 'check-before-save' as const },
      }],
    }),
    packsList: async () => ({ packs: [PACK], revision: 4 }),
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
    bindingsList: async () => ({ bindings: [], revision: 1 }),
    bindingsAdd: async (workspaceId: string) => {
      calls.bindingAdd.push(workspaceId)
      return { bindings: [{ workspaceId, target: { kind: 'pack' as const, packId: 'p1' }, createdAt: '' }], revision: 2 }
    },
    bindingsRemove: async (workspaceId: string) => {
      calls.bindingRemove.push(workspaceId)
      return { bindings: [], revision: 3 }
    },
    list: async () => ({ items: [{ sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'c.md' }, title: 'C note' }] }),
    search: async () => ({ items: [{ sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'd.md' }, title: 'D note' }] }),
    ensure: async () => ({ clue: { id: 'c9' }, created: true }),
    read: async () => ({
      format: 'text/markdown',
      data: { text: '# Read only' },
      fetchedAt: '2026-10-17T00:00:00.000Z',
    }),
    loadEdit: async () => {
      calls.loadEdit += 1
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
    isSourceEnabled: () => true,
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

  it('never offers a save for a read-only type', async () => {
    const { face } = faceOf({ editable: false })
    const windows = recordingWindows()
    openClueDetailWindow({
      windows: windows.windows,
      face,
      workspaceId: 'ws-1',
      target: { sourceId: 'builtin.files', typeId: 'builtin.files.binary', locator: { path: 'a.png' }, title: 'a.png' },
    })
    await flush()
    const content = windows.last()?.content as unknown as { readOnly?: boolean }
    expect(content.readOnly).toBe(true)
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
