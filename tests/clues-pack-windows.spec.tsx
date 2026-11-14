/**
 * S9 clue pack, detail and share surfaces.
 *
 * Contract pinned here (approved S9 spec §3–§4, §7):
 * - pack management saves the name as an explicit action, removes members
 *   without deleting anything, and shows a CAS conflict without pretending the save landed;
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
beforeAll(() => { Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true }) })
import { PackManagementPage, openPackManagementWindow, type PackDraftGuard } from '../src/client/clues/windows/pack.tsx'
import { CluePacksSection } from '../src/client/clues/tab/packs.tsx'
import { openClueDetailWindow, type ClueDetailTarget } from '../src/client/clues/windows/detail.tsx'
import { SharePage, openShareWindow } from '../src/client/clues/windows/share.tsx'
import type { BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import type { WindowOpenOptions, WindowHandle } from '../src/client/windows/types.ts'
import type { ClueBinding, ClueBindingTarget, ClueCandidate, CluePack, ClueSourceDescriptor } from '../src/clues/types.ts'
import { SidebarApiError } from '../src/client/api.ts'
const PACK: CluePack = {
  id: 'p1', name: 'Release clues', workspaceId: 'ws-1', members: ['c1', 'c2'], revision: 3,
  createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z',
}
interface FaceCalls {
  rename: number; removeMember: number; addMember: number; bindingAdd: string[]; bindingRemove: string[]
  bindingAddTargets: { workspaceId: string; target: ClueBindingTarget }[]; bindingRemoveTargets: { workspaceId: string; target: ClueBindingTarget }[]
  loadEdit: number; saveEdit: number; list: number; search: number; resolve: number
  listParams: Record<string, unknown>[]; searchParams: Record<string, unknown>[]; resolveParams: Record<string, unknown>[]
  packsList: string[]; packsDelete: { packId: string; expectedRevision?: number }[]
}
interface FaceOverrides {
  saveError?: () => unknown; renameError?: () => unknown; editable?: boolean; sources?: ClueSourceDescriptor[]
  enabled?: (sourceId: string) => boolean; listFor?: (sourceId: string) => readonly ClueCandidate[]
  searchFor?: (sourceId: string) => readonly ClueCandidate[]
  listResultFor?: (sourceId: string, input: Record<string, unknown>) => { items: readonly ClueCandidate[]; nextCursor?: string }
  listDeferred?: Promise<{ items: readonly ClueCandidate[]; nextCursor?: string }>; resolveCandidates?: readonly ClueCandidate[]
  packs?: readonly CluePack[]; readError?: () => unknown; loadEditDocument?: () => unknown
  packsListError?: () => unknown; bindingsListError?: () => unknown; bindingAddError?: () => unknown }
const FILES_SOURCE: ClueSourceDescriptor = {
  sourceId: 'builtin.files', name: 'Local files', order: 0, pluginId: 'dsh-better-sidebar', types: ['builtin.files.markdown'], transport: 'files',
  capabilities: { resolve: true, list: true, search: true, read: true, edit: true, portable: true },
}
const GITHUB_SOURCE: ClueSourceDescriptor = {
  sourceId: 'builtin.github.issues', name: 'GitHub Issues', order: 10, pluginId: 'dsh-better-sidebar', types: ['builtin.github.issue'], transport: 'cli',
  capabilities: { resolve: true, list: true, search: true, read: true, edit: true, portable: true },
}
function faceOf(overrides: FaceOverrides = {}): { face: BetterSidebarCluesClientFace; calls: FaceCalls } {
  const bound: ClueBinding[] = []
  const calls: FaceCalls = {
    rename: 0, removeMember: 0, addMember: 0, bindingAdd: [], bindingRemove: [], bindingAddTargets: [], bindingRemoveTargets: [],
    loadEdit: 0, saveEdit: 0, list: 0, search: 0, resolve: 0, listParams: [], searchParams: [], resolveParams: [], packsList: [], packsDelete: [],
  }
  const catalogue = () => {
    const sources = (overrides.sources ?? [FILES_SOURCE]).map(source => ({ ...source, capabilities: { ...source.capabilities, edit: overrides.editable !== false && source.capabilities.edit } }))
    return {
      sources,
      types: sources.flatMap(source => source.types.map(typeId => ({ typeId, sourceId: source.sourceId, formats: ['text/markdown'], capabilities: { read: true, edit: overrides.editable !== false, concurrency: 'check-before-save' as const } }))),
    }
  }
  const bindingsFor = (workspaceId: string) => ({ bindings: bound.filter(binding => binding.workspaceId === workspaceId), revision: bound.length + 1 })
  const api = {
    defaultScope: async () => ({ reason: 'no-github-remote' as const }),
    sources: async () => catalogue(),
    packsList: async (workspaceId: string) => {
      calls.packsList.push(workspaceId)
      const rejected = overrides.packsListError?.()
      if (rejected !== undefined) throw rejected
      return { packs: overrides.packs ?? [PACK], revision: 4 }
    },
    pinsList: async () => ({ pins: [], revision: 0 }),
    packsDelete: async (_w: string, input: { packId: string; expectedRevision?: number }) => { calls.packsDelete.push(input); return { deleted: true as const, packs: (overrides.packs ?? [PACK]).filter(pack => pack.id !== input.packId), revision: 5, packRevision: 3 } },
    packsRename: async (_w: string, input: { name: string }) => {
      calls.rename += 1
      if (overrides.renameError !== undefined) throw overrides.renameError()
      return { pack: { ...PACK, name: input.name, revision: 4 }, revision: 5, packRevision: 4 }
    },
    packsRemoveMember: async (_w: string, input: { clueId: string }) => { calls.removeMember += 1; return { pack: { ...PACK, members: PACK.members.filter(id => id !== input.clueId), revision: 4 }, revision: 5, packRevision: 4 } },
    packsAddMember: async (_w: string, input: { clueId: string }) => { calls.addMember += 1; return { pack: { ...PACK, members: [...PACK.members, input.clueId], revision: 4 }, revision: 5, packRevision: 4 } },
    clues: async () => ({
      clues: [
        { id: 'c1', sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'a.md' }, title: 'A note', workspaceId: 'ws-1', createdAt: '', updatedAt: '' },
        { id: 'c2', sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'b.md' }, title: 'B note', workspaceId: 'ws-1', createdAt: '', updatedAt: '', unresolved: { reason: 'source missing' } },
      ], revision: 2,
    }),
    bindingsList: async (workspaceId: string) => {
      const rejected = overrides.bindingsListError?.()
      if (rejected !== undefined) throw rejected
      return bindingsFor(workspaceId)
    },
    bindingsAdd: async (workspaceId: string, input: { target: ClueBindingTarget }) => {
      const rejected = overrides.bindingAddError?.()
      if (rejected !== undefined) throw rejected
      calls.bindingAdd.push(workspaceId)
      calls.bindingAddTargets.push({ workspaceId, target: input.target })
      bound.push({ workspaceId, target: input.target, createdAt: '' })
      return bindingsFor(workspaceId)
    },
    bindingsRemove: async (workspaceId: string, input: { target: ClueBindingTarget }) => {
      calls.bindingRemove.push(workspaceId)
      calls.bindingRemoveTargets.push({ workspaceId, target: input.target })
      const index = bound.findIndex(binding => binding.workspaceId === workspaceId && binding.target.kind === input.target.kind && JSON.stringify(binding.target) === JSON.stringify(input.target))
      if (index !== -1) bound.splice(index, 1)
      return bindingsFor(workspaceId)
    },
    list: async (_w: string, input: Record<string, unknown>) => { calls.list += 1; calls.listParams.push(input); if (overrides.listDeferred !== undefined) return overrides.listDeferred; return overrides.listResultFor?.(String(input.sourceId), input) ?? { items: overrides.listFor?.(String(input.sourceId)) ?? [{ sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'c.md' }, title: 'C note' }] } },
    search: async (_w: string, input: Record<string, unknown>) => { calls.search += 1; calls.searchParams.push(input); return { items: overrides.searchFor?.(String(input.sourceId)) ?? [{ sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'd.md' }, title: 'D note' }] } },
    resolve: async (_w: string, input: Record<string, unknown>) => { calls.resolve += 1; calls.resolveParams.push(input); return { candidates: overrides.resolveCandidates ?? [] } },
    ensure: async () => ({ clue: { id: 'c9' }, created: true }),
    read: async () => { const rejected = overrides.readError?.(); if (rejected !== undefined) throw rejected; return { format: 'text/markdown', data: { text: '# Read only' }, fetchedAt: '2026-10-17T00:00:00.000Z' } },
    loadEdit: async () => { calls.loadEdit += 1; if (overrides.loadEditDocument !== undefined) return overrides.loadEditDocument(); return { format: 'text/markdown', data: { text: '# Draft' }, baseRevision: 'r1' } },
    saveEdit: async () => { calls.saveEdit += 1; if (overrides.saveError !== undefined) throw overrides.saveError(); return { revision: 'r2', savedAt: '2026-10-17T00:00:00.000Z' } },
  }
  const face = {
    api, registerSourceDisplay: () => () => {}, getSourceDisplays: () => [], registerFormatRenderer: () => () => {},
    getFormatRenderer: () => undefined, getFormatRenderers: () => new Map(), subscribe: () => () => {},
    isSourceEnabled: (sourceId: string) => overrides.enabled?.(sourceId) ?? true,
    isSourceMentionEnabled: () => true, isPacksMentionEnabled: () => true,
  } as unknown as BetterSidebarCluesClientFace
  return { face, calls }
}
/** A window host that records opens/updates. */
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
function click(container: ParentNode, label: string): void {
  const button = [...container.querySelectorAll('button')].find(candidate => (candidate.textContent ?? '').trim() === label || candidate.getAttribute('aria-label') === label)
  if (button === undefined) throw new Error('button "' + label + '" not found')
  act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
/** Set one controlled input's value through React's change pipeline. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
/** Choose a source through the shared source select menu. */
function chooseSource(container: ParentNode, label: string): void {
  const trigger = container.querySelector<HTMLButtonElement>('[data-clue-source-navigation] button[aria-haspopup="menu"]')
  if (trigger === null) throw new Error('source selector not found')
  if (trigger.textContent?.trim() === label) return
  act(() => { trigger.click() })
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitemradio"], [role="menu"] [role="menuitem"]')]
    .find(button => button.textContent?.trim() === label)
  if (option === undefined) throw new Error('source option not found: ' + label)
  act(() => { option.click() })
}
/** Choose a detail binding workspace through its real disclosure and portaled menu. */
function chooseBindingWorkspace(container: ParentNode, title: string): void {
  const advanced = container.querySelector<HTMLDetailsElement>('[data-clue-detail-advanced]')!
  if (!advanced.open) act(() => { advanced.querySelector('summary')!.click() })
  expect(advanced.open).toBe(true)
  const trigger = advanced.querySelector<HTMLButtonElement>('button[aria-label="Choose a workspace"][aria-haspopup="menu"]')!
  act(() => { trigger.click() })
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitemradio"], [role="menu"] [role="menuitem"]')].find(button => button.textContent?.trim() === title)!
  act(() => { option.click() })
  expect(trigger.textContent).toContain(title)
}
/** The structural subset of a detail descriptor/state these specs probe. */
interface DetailProbe {
  kind?: string; mode?: 'preview' | 'edit'; readOnly?: boolean; presentation?: string
  document?: { data: unknown }; error?: string
  onModeChange?(next: 'preview' | 'edit'): void; onChange?(data: unknown): void; onSave?(): void
}
/** Enter edit through the detail's controlled seam: the edit document is lazy. */
async function enterDetailEdit(windows: ReturnType<typeof recordingWindows>): Promise<DetailProbe> {
  const preview = windows.last()?.content as DetailProbe
  expect(preview.mode).toBe('preview')
  expect(preview.onModeChange).toBeTypeOf('function')
  act(() => { preview.onModeChange?.('edit') })
  await flush()
  return windows.last()?.content as DetailProbe
}
/**
 * jsdom has no layout and no IntersectionObserver, so the add page's real
 * scroll-fallback path is exercised with a geometry stub: a 240px reader with
 * the sentinel just inside the preload zone. A real "scroll" event then runs
 * the same listener a browser runs — no synthetic onLoad and no Next button.
 */
function scrollAddToEnd(container: ParentNode, times = 1): void {
  const scroll = container.querySelector<HTMLElement>('[data-clue-pack-scroll]')
  if (scroll === null) throw new Error('no add scroll root')
  const sentinel = scroll.querySelector<HTMLElement>('[data-clue-add-sentinel]')
  if (sentinel === null) throw new Error('no add sentinel')
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 240 })
  scroll.getBoundingClientRect = () => ({ top: 0, bottom: 240 } as DOMRect)
  sentinel.getBoundingClientRect = () => ({ top: 250, bottom: 251 } as DOMRect)
  act(() => { for (let index = 0; index < times; index += 1) scroll.dispatchEvent(new Event('scroll', { bubbles: true })) })
}
interface MountPackExtra {
  windows?: ReturnType<typeof recordingWindows>; workspaces?: { workspaceId: string; title: string }[]
  scopes?: Record<string, Record<string, string>>; guard?: PackDraftGuard; pack?: CluePack }
/** Render the pack management page with the defaults every pack test shares. */
function mountPack(face: BetterSidebarCluesClientFace, extra: MountPackExtra = {}) {
  const windows = extra.windows ?? recordingWindows()
  const view = renderRoot(createElement(PackManagementPage, {
    windows: windows.windows, workspaceId: 'ws-1', face, workspaces: extra.workspaces ?? [{ workspaceId: 'ws-1', title: '/repo' }],
    pack: extra.pack ?? PACK, guard: extra.guard ?? { dirty: false }, scopes: extra.scopes,
    onInsertClue: () => true, onInsertPack: () => true, onNotice: () => undefined,
  }))
  return { view, windows }
}
/** Mount the pack page, open Add members, and select one source. */
async function mountAddPage(face: BetterSidebarCluesClientFace, extra: MountPackExtra & { source?: string } = {}) {
  const { view, windows } = mountPack(face, extra)
  await flush()
  click(view.container, 'Add members')
  await flush()
  chooseSource(view.container, extra.source ?? FILES_SOURCE.name)
  await flush()
  return { view, windows, page: view.container.querySelector<HTMLElement>('[data-clue-add-member]')! }
}
/** Open one detail window over a recording host and flush the preview read. */
async function openDetail(face: BetterSidebarCluesClientFace, target: ClueDetailTarget, extra: {
  onInsertClue?: (clueId: string, title: string) => boolean; onAddToPack?: (target: ClueDetailTarget) => void; workspaces?: { workspaceId: string; title: string }[]
} = {}) {
  const windows = recordingWindows()
  openClueDetailWindow({
    windows: windows.windows, face, workspaceId: 'ws-1', target,
    ...(extra.onInsertClue === undefined ? {} : { onInsertClue: extra.onInsertClue }), ...(extra.onAddToPack === undefined ? {} : { onAddToPack: extra.onAddToPack }), ...(extra.workspaces === undefined ? {} : { workspaces: extra.workspaces }),
  })
  await flush()
  return windows
}
const detailTarget = (clueId: string, title = 'A note', extra: Partial<ClueDetailTarget> = {}): ClueDetailTarget =>
  ({ sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId, title, ...extra })
const footerOf = (windows: ReturnType<typeof recordingWindows>) => renderRoot(createElement(Fragment, null, windows.last()?.footer))
const headerOf = (windows: ReturnType<typeof recordingWindows>) => renderRoot(createElement(Fragment, null, (windows.last()?.content as { header?: ReactNode }).header))
  it('saves the name explicitly, never on blur, and discards it on Cancel', async () => {
    const { face, calls } = faceOf()
    const guard: PackDraftGuard = { dirty: false }
    const { view } = mountPack(face, { guard })
    await flush()
    const name = (): HTMLInputElement => view.container.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    const footerLabels = (): string[] => [...view.container.querySelectorAll('[data-clue-pack-footer] button')].map(button => button.textContent ?? '')
    expect(name().value).toBe('Release clues')
    expect(view.container.textContent).toContain('A note')
    expect(footerLabels()).toEqual(['Insert pack reference'])
    typeInto(name(), 'Blurred name')
    await flush()
    expect(guard.dirty).toBe(true)
    expect(footerLabels()).toEqual(['Cancel', 'Save'])
    act(() => { name().dispatchEvent(new FocusEvent('blur', { bubbles: true })) })
    await flush()
    expect(calls.rename).toBe(0)
    click(view.container, 'Cancel')
    await flush()
    expect(name().value).toBe('Release clues')
    typeInto(name(), 'Renamed')
    await flush()
    click(view.container, 'Save')
    await flush()
    expect(calls.rename).toBe(1)
    expect(guard.dirty).toBe(false)
    expect(footerLabels()).toEqual(['Insert pack reference'])
    view.unmount()
  })
  it.each([
    { name: 'request failure', error: () => new SidebarApiError('network', 'offline'), copy: 'Saving the pack failed.', roleAlert: true },
    { name: 'CAS conflict', error: () => new SidebarApiError('conflict', 'stale revision'), copy: 'This pack changed elsewhere', roleAlert: false },
  ])('shows a $name rename failure without pretending the save landed', async ({ error, copy, roleAlert }) => {
    const { face, calls } = faceOf({ renameError: error })
    const { view } = mountPack(face)
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    typeInto(input, 'Network draft')
    await flush()
    click(view.container, 'Save')
    await flush()
    expect(calls.rename).toBe(1)
    expect(roleAlert ? view.container.querySelector('[role="alert"]')?.textContent : view.container.textContent).toContain(copy)
    expect(input.value).toBe('Network draft')
    if (!roleAlert) {
      click(view.container, 'Retry')
      await flush()
      expect(view.container.textContent).not.toContain('This pack changed elsewhere')
      expect(input.value).toBe('Network draft')
    } else {
      expect(view.container.textContent).not.toContain('This pack changed elsewhere')
    }
    view.unmount()
  })
  it('opens the member context menu for preview and removal by cursor and keyboard', async () => {
    const { face, calls } = faceOf()
    const windows = recordingWindows()
    const { view } = mountPack(face, { windows })
    await flush()
    expect(view.container.textContent).toContain('Source unavailable')
    const rowOf = (title: string): HTMLElement => [...view.container.querySelectorAll('button')].find(button => (button.textContent ?? '').trim() === title)!.closest('li')!
    const menuItem = (label: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('[role="menu"] button')].find(button => (button.textContent ?? '').trim() === label)!
    act(() => { rowOf('A note').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })) })
    await flush()
    act(() => { menuItem('Preview').click() })
    await flush()
    expect(calls.loadEdit).toBe(0)
    expect(windows.last()?.title).toBe('A note')
    act(() => { rowOf('A note').dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })) })
    await flush()
    act(() => { menuItem('Remove from pack: A note').click() })
    await flush()
    expect(calls.removeMember).toBe(1)
    expect(view.container.textContent).not.toContain('A note')
    view.unmount()
  })
  it('coalesces add-page keyword search and cancels it on IME or leaving the page', async () => {
    const { face, calls } = faceOf()
    const { view } = await mountAddPage(face)
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!
    const loaded = calls.search
    typeInto(input, 'rel')
    typeInto(input, 'rele')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    expect(calls.search).toBe(loaded + 1)
    expect(calls.searchParams.at(-1)?.query).toBe('rele')
    act(() => { input.dispatchEvent(new Event('compositionstart', { bubbles: true })) })
    typeInto(input, '设计')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    expect(calls.search).toBe(loaded + 1)
    act(() => { input.dispatchEvent(new Event('compositionend', { bubbles: true })) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    expect(calls.search).toBe(loaded + 2)
    expect(calls.searchParams.at(-1)?.query).toBe('设计')
    const settled = calls.search
    typeInto(input, 'draft')
    click(view.container, 'Back')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    expect(calls.search).toBe(settled)
    view.unmount()
  })
  it('recovers a failed binding read with Retry, then binds to the selected workspace and unbinds', async () => {
    let fail = true
    const { face, calls } = faceOf({ bindingsListError: () => (fail ? new SidebarApiError('network', 'offline') : undefined) })
    const { view } = mountPack(face, { workspaces: [{ workspaceId: 'ws-1', title: '/repo' }, { workspaceId: 'ws-2', title: '/other' }] })
    await flush()
    const panel = view.container.querySelector<HTMLDetailsElement>('[data-clue-binding-panel]')!
    // The panel starts collapsed and a failed read says request-failed, never "unbound".
    expect(panel.open).toBe(false)
    expect(panel.querySelector('summary')?.textContent).toBe('Workspace binding')
    expect(view.container.textContent).not.toContain('New sessions in this workspace receive these references automatically')
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain('Request failed')
    expect(panel.querySelector('button[aria-label="Choose a workspace"]')).toBeNull()
    fail = false
    click(panel, 'Retry')
    await flush()
    expect(panel.querySelector('[role="alert"]')).toBeNull()
    const live = view.container.querySelector<HTMLDetailsElement>('[data-clue-binding-panel]')!
    live.open = true
    act(() => { live.querySelector<HTMLButtonElement>('button[aria-label="Choose a workspace"]')!.click() })
    act(() => { [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === '/other')!.click() })
    click(live, 'Bind')
    await flush()
    expect(calls.bindingAdd).toEqual(['ws-2'])
    expect(live.textContent).toContain('Bound')
    expect(live.querySelector('button[aria-label="Choose a workspace"]')).toBeNull()
    click(live, 'Unbind')
    await flush()
    expect(calls.bindingRemove).toEqual(['ws-2'])
    expect(live.textContent).not.toContain('Bound')
    expect(live.querySelector('button[aria-label="Choose a workspace"]')).not.toBeNull()
    view.unmount()
  })
  it('keeps the cross-source selection while switching sources and never reads pins', async () => {
    const filesCandidate: ClueCandidate = { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'a.md' }, title: 'A note' }
    const githubCandidate: ClueCandidate = { sourceId: 'builtin.github.issues', typeId: 'builtin.github.issue', locator: { host: 'github.com', owner: 'acme', repo: 'widgets', kind: 'issue', number: 7 }, title: 'Fix the widget' }
    const { face } = faceOf({ sources: [FILES_SOURCE, GITHUB_SOURCE], listFor: sourceId => sourceId === GITHUB_SOURCE.sourceId ? [githubCandidate] : [filesCandidate] })
    const pinsList = vi.fn(face.api.pinsList)
    face.api.pinsList = pinsList
    const { view } = await mountAddPage(face, { scopes: { [GITHUB_SOURCE.sourceId]: { repo: 'acme/widgets', state: 'open' } } })
    expect(pinsList).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-clue-add-pins]')).toBeNull()
    expect(view.container.textContent).not.toContain('Pin frequently used clues to keep them here.')
    act(() => { view.container.querySelector<HTMLInputElement>('[data-clue-add-member] ul input[type="checkbox"]')!.click() })
    await flush()
    expect(view.container.textContent).toContain('1 selected')
    const navigation = view.container.querySelector<HTMLElement>('[data-clue-add-member] [data-clue-source-navigation]')!
    expect(navigation.dataset.clueActiveSource).toBe(FILES_SOURCE.sourceId)
    expect(navigation.getAttribute('data-source-count')).toBe('2')
    expect(navigation.querySelector('button[aria-haspopup="menu"]')).not.toBeNull()
    chooseSource(view.container, 'GitHub Issues')
    await flush()
    expect(view.container.textContent).toContain('1 selected')
    expect(view.container.textContent).toContain('Fix the widget')
    expect(navigation.dataset.clueActiveSource).toBe(GITHUB_SOURCE.sourceId)
    chooseSource(view.container, 'Local files')
    await flush()
    expect(view.container.querySelector<HTMLInputElement>('[data-clue-add-member] ul input[type="checkbox"]')!.checked).toBe(true)
    view.unmount()
  })
  it('appends the next cursor on scroll, dedupes, and keeps the selection', async () => {
    const pageOne: ClueCandidate = { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'page-1.md' }, title: 'Page one' }
    const pageTwo: ClueCandidate = { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'page-2.md' }, title: 'Page two' }
    const { face, calls } = faceOf({
      // The second page repeats page one: the growing list keeps one row per identity.
      listResultFor: (_sourceId, input) => input.cursor === 'cursor-2' ? { items: [pageOne, pageTwo] } : { items: [pageOne], nextCursor: 'cursor-2' },
    })
    const { view, page } = await mountAddPage(face)
    expect(page.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(1)
    act(() => { page.querySelector<HTMLInputElement>('ul input[type="checkbox"]')!.click() })
    await flush()
    expect(view.container.textContent).toContain('1 selected')
    // A real scroll appends the cursor page without Prev/Next; coalesced events issue ONE request.
    scrollAddToEnd(view.container, 2)
    await flush()
    expect(calls.list).toBe(2)
    expect(calls.listParams.at(-1)).toMatchObject({ cursor: 'cursor-2' })
    expect(page.textContent).toContain('Page one')
    expect(page.textContent).toContain('Page two')
    expect(page.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(2)
    expect(page.querySelector<HTMLInputElement>('[data-clue-add-scroll] ul input[type="checkbox"]')!.checked).toBe(true)
    expect(page.querySelector('[data-clue-add-sentinel]')).not.toBeNull()
    const labels = [...page.querySelectorAll('button')].map(button => (button.textContent ?? '').trim())
    expect(labels).not.toContain('Prev')
    expect(labels).not.toContain('Previous')
    expect(labels).not.toContain('Next')
    const requests = calls.list
    scrollAddToEnd(view.container)
    await flush()
    expect(calls.list).toBe(requests)
    expect(page.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(2)
    view.unmount()
  })
  it('walks empty pages with distinct cursors and stops on a repeated cursor', async () => {
    const first: ClueCandidate = { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'walk-1.md' }, title: 'Walk first' }
    const loopFirst: ClueCandidate = { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'loop-1.md' }, title: 'Loop first' }
    const loopSecond: ClueCandidate = { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'loop-2.md' }, title: 'Loop second' }
    let mode: 'walk' | 'loop' = 'walk'
    const { face, calls } = faceOf({
      listResultFor: (_sourceId, input) => {
        if (mode === 'walk') {
          if (input.cursor === undefined) return { items: [first], nextCursor: 'walk-2' }
          if (input.cursor === 'walk-2') return { items: [], nextCursor: 'walk-3' }
          return { items: [] }
        }
        if (input.cursor === undefined) return { items: [loopFirst], nextCursor: 'loop-2' }
        return { items: [loopSecond], nextCursor: 'loop-2' }
      },
    })
    const { view, page } = await mountAddPage(face)
    expect(calls.list).toBe(1)
    // Empty pages with DISTINCT cursors are a normal walk: the hook re-arms.
    scrollAddToEnd(view.container)
    await flush()
    expect(calls.list).toBe(3)
    expect(calls.listParams.at(-1)).toMatchObject({ cursor: 'walk-3' })
    expect(page.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(1)
    expect(page.querySelector('[data-clue-add-more-error]')).toBeNull()
    // Stop the auto-walk; a changed range starts a fresh list.
    Object.defineProperty(view.container.querySelector<HTMLElement>('[data-clue-pack-scroll]')!, 'clientHeight', { configurable: true, value: 0 })
    mode = 'loop'
    click(view.container, 'Choose range')
    await flush()
    click(view.container, 'Save range')
    await flush()
    expect(calls.list).toBe(4)
    expect(page.textContent).toContain('Loop first')
    scrollAddToEnd(view.container)
    await flush()
    expect(calls.list).toBe(5)
    const loopError = page.querySelector<HTMLElement>('[data-clue-add-more-error]')!
    expect(loopError.getAttribute('role')).toBe('alert')
    expect(loopError.querySelector('button')?.textContent).toBe('Retry')
    // The looping page is not merged and its cursor is not silently cleared.
    expect(page.textContent).toContain('Loop first')
    expect(page.textContent).not.toContain('Loop second')
    expect(page.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(1)
    // No automatic retry after the loop error.
    scrollAddToEnd(view.container, 2)
    await flush()
    expect(calls.list).toBe(5)
    expect(page.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(1)
    view.unmount()
  })
  it('keeps the rows on a failed next page and retries from the bottom', async () => {
    const pageOne: ClueCandidate = { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'retry-1.md' }, title: 'Retry page one' }
    const pageTwo: ClueCandidate = { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'retry-2.md' }, title: 'Retry page two' }
    let failNext = true
    const { face, calls } = faceOf({
      listResultFor: (_sourceId, input) => {
        if (input.cursor === undefined) return { items: [pageOne], nextCursor: 'cursor-2' }
        if (failNext) { failNext = false; throw new SidebarApiError('network', 'offline') }
        return { items: [pageTwo] }
      },
    })
    const { view, page } = await mountAddPage(face)
    act(() => { page.querySelector<HTMLInputElement>('ul input[type="checkbox"]')!.click() })
    await flush()
    scrollAddToEnd(view.container)
    await flush()
    expect(page.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(1)
    expect(page.textContent).toContain('Retry page one')
    const retry = page.querySelector<HTMLElement>('[data-clue-add-more-error]')!
    expect(retry.getAttribute('role')).toBe('alert')
    expect(retry.querySelector('button')?.textContent).toBe('Retry')
    expect(calls.list).toBe(2)
    // The failed cursor is not re-requested by scrolling; only Retry does.
    scrollAddToEnd(view.container)
    await flush()
    expect(calls.list).toBe(2)
    click(view.container, 'Retry')
    await flush()
    expect(calls.list).toBe(3)
    expect(calls.listParams.at(-1)).toMatchObject({ cursor: 'cursor-2' })
    expect(page.querySelector('[data-clue-add-more-error]')).toBeNull()
    expect(page.textContent).toContain('Retry page two')
    expect(page.querySelectorAll('[data-clue-add-scroll] ul li')).toHaveLength(2)
    expect(page.querySelector<HTMLInputElement>('ul input[type="checkbox"]')!.checked).toBe(true)
    view.unmount()
  })
  it('ignores a superseded list response when the query changes', async () => {
    const staleRow: ClueCandidate = { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', locator: { path: 'stale.md' }, title: 'Stale row' }
    let resolvePending!: (value: { items: readonly ClueCandidate[] }) => void
    const pending = new Promise<{ items: readonly ClueCandidate[] }>((resolve) => { resolvePending = resolve })
    const { face } = faceOf({ listDeferred: pending })
    const { view, page } = await mountAddPage(face)
    // The source list is still pending when the reader searches: the new view wins.
    typeInto(page.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!, 'design')
    click(view.container, 'Search')
    await flush()
    expect(page.textContent).toContain('D note')
    await act(async () => { resolvePending({ items: [staleRow] }); await Promise.resolve() })
    await flush()
    expect(page.textContent).toContain('D note')
    expect(page.textContent).not.toContain('Stale row')
    view.unmount()
  })
  it('asks for a range before listing GitHub members instead of surfacing invalid-request', async () => {
    const { face, calls } = faceOf({ sources: [GITHUB_SOURCE] })
    const { view } = await mountAddPage(face, { source: GITHUB_SOURCE.name })
    expect(calls.list).toBe(0)
    expect(view.container.textContent).toContain('No range chosen yet')
    expect(view.container.textContent).not.toContain('Failed to load')
    click(view.container, 'Choose range')
    await flush()
    const repoInput = view.container.querySelector<HTMLInputElement>('input[placeholder="owner/repo or repository URL"]')!
    typeInto(repoInput, 'acme/widgets')
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
    expect(calls.listParams[0]).toMatchObject({ sourceId: GITHUB_SOURCE.sourceId, scope: { repo: 'acme/widgets', state: 'closed' } })
    view.unmount()
  })
  it('searches Feishu account-wide, adds a pasted URL without a browse range, and hides disabled sources', async () => {
    const feishu: ClueSourceDescriptor = {
      sourceId: 'builtin.feishu.docs', name: 'Feishu docs', order: 30, pluginId: 'dsh-better-sidebar', types: ['builtin.feishu.docs'], transport: 'cli',
      capabilities: { resolve: true, list: true, search: true, read: true, edit: true, portable: true },
    }
    const githubCandidate: ClueCandidate = { sourceId: 'builtin.github.issues', typeId: 'builtin.github.issue', locator: { host: 'github.com', owner: 'acme', repo: 'widgets', kind: 'issue', number: 7 }, title: 'Fix the widget' }
    const { face, calls } = faceOf({ sources: [feishu, GITHUB_SOURCE], resolveCandidates: [githubCandidate] })
    const { view, page } = await mountAddPage(face, { source: feishu.name })
    // Browse defaults to Drive; a keyword below still searches the account.
    expect(calls.list).toBe(1)
    typeInto(page.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!, 'design')
    click(view.container, 'Search')
    await flush()
    expect(calls.search).toBe(1)
    expect(calls.searchParams[0]).toMatchObject({ sourceId: 'builtin.feishu.docs', query: 'design' })
    expect(calls.searchParams[0]).not.toHaveProperty('scope')
    expect(view.container.querySelector('[data-add-global-search]')?.textContent).toContain('searching all documents visible to this account')
    // A pasted complete URL resolves without browsing a range (no extra list call).
    chooseSource(view.container, GITHUB_SOURCE.name)
    await flush()
    typeInto(page.querySelector<HTMLInputElement>('input[aria-label="Keyword, resource link or file path"]')!, 'https://github.com/acme/widgets/issues/7')
    click(view.container, 'Resolve')
    await flush()
    expect(calls.list).toBe(1)
    expect(calls.resolve).toBe(1); expect(calls.resolveParams[0]).toMatchObject({ text: 'https://github.com/acme/widgets/issues/7' })
    expect(view.container.textContent).toContain('Fix the widget')
    act(() => { page.querySelector<HTMLInputElement>('ul input[type="checkbox"]')!.click() })
    await flush()
    click(view.container, 'Add selected')
    await flush(6)
    expect(calls.addMember).toBe(1)
    view.unmount()
    const disabled = mountPack(faceOf({ sources: [FILES_SOURCE, GITHUB_SOURCE], enabled: sourceId => sourceId !== GITHUB_SOURCE.sourceId }).face)
    await flush()
    click(disabled.view.container, 'Add members')
    await flush()
    const disabledNav = disabled.view.container.querySelector<HTMLElement>('[data-clue-source-navigation]')!
    const disabledTrigger = disabledNav.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
    act(() => { disabledTrigger.click() })
    const sourceOptions = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemradio"], [role="menu"] [role="menuitem"]')]
      .map(item => item.textContent?.trim())
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(sourceOptions).toContain('Local files')
    expect(sourceOptions).not.toContain('GitHub Issues')
    disabled.view.unmount()
  })
  it('guards a dirty name draft on close with a visible unsaved marker', async () => {
    const { face } = faceOf()
    const windows = recordingWindows()
    const handle = openPackManagementWindow({
      windows: windows.windows, workspaceId: 'ws-1', face, workspaces: [{ workspaceId: 'ws-1', title: '/repo' }], pack: PACK,
      onInsertClue: () => true, onInsertPack: () => true, onNotice: () => undefined,
    })
    await flush()
    const view = renderRoot(createElement(Fragment, null, windows.last()?.content as ReactNode))
    await flush()
    expect(handle.id).toBe('pack:p1')
    await expect(windows.last()?.onBeforeClose?.()).resolves.toBe(true)
    const input = view.container.querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!
    typeInto(input, 'Unsaved draft')
    await flush()
    await expect(windows.last()?.onBeforeClose?.()).resolves.toBe(false)
    expect(windows.last()?.dirty).toBe(true)
    expect(windows.last()?.title).toContain('Unsaved pack name')
    click(view.container, 'Cancel')
    await flush()
    await expect(windows.last()?.onBeforeClose?.()).resolves.toBe(true)
    expect(windows.last()?.title).toBe('Release clues')
    view.unmount()
  })
  it('deletes a pack only after the confirmation and never touches its clues', async () => {
    const other: CluePack = { ...PACK, id: 'p2', name: 'Design notes', members: [], updatedAt: '2026-10-16T00:00:00.000Z' }
    const { face, calls } = faceOf({ packs: [PACK, other] })
    const view = renderRoot(createElement(CluePacksSection, {
      workspaceId: 'ws-1', face, windows: recordingWindows().windows, visible: true, settings: {},
      onSettingsChange: () => undefined, onInsertPack: () => true, onOpenPack: () => undefined, onImport: () => undefined, onNotice: () => undefined,
    }))
    await flush()
    const name = [...view.container.querySelectorAll<HTMLElement>('[data-clue-pack-name]')].find(element => element.textContent === 'Release clues')!
    act(() => { name.closest('li')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 })) })
    await flush()
    act(() => { [...document.querySelectorAll<HTMLElement>('[role="menu"] button')].find(button => (button.textContent ?? '').trim() === 'Delete')!.click() })
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
  })
  it('edits through loadEdit/saveEdit, offers insert separately, and keeps Save for changed drafts only', async () => {
    const { face, calls } = faceOf()
    const windows = recordingWindows()
    const inserted: string[] = []
    const added: ClueDetailTarget[] = []
    openClueDetailWindow({
      windows: windows.windows, face, workspaceId: 'ws-1', target: detailTarget('c-edit'),
      onInsertClue: clueId => { inserted.push(clueId); return true }, onAddToPack: target => { added.push(target) },
    })
    await flush()
    // Opening reads the preview only; Edit is the lazy request that fetches the save baseline.
    expect(calls.loadEdit).toBe(0)
    const preview = windows.last()?.content as DetailProbe
    expect(preview.kind).toBe('document')
    expect(preview.readOnly).toBe(true)
    const footer = footerOf(windows)
    expect([...footer.container.querySelectorAll('button')].some(button => button.textContent === 'Save')).toBe(false)
    const find = (label: string): HTMLButtonElement | undefined => [...footer.container.querySelectorAll('button')].find(button => (button.textContent ?? '').trim() === label)
    const add = find('Add to pack')
    const insert = find('Insert resources')
    expect(add).toBeDefined()
    // The reference actions sit in this order; adding a member never writes.
    expect(add!.compareDocumentPosition(insert!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    act(() => { add!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(added).toEqual([expect.objectContaining({ clueId: 'c-edit' })])
    expect(calls.saveEdit).toBe(0)
    click(footer.container, 'Insert resources')
    await flush()
    expect(inserted).toEqual(['c-edit']); expect(calls.saveEdit).toBe(0)
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
    footer.rerender(createElement(Fragment, null, windows.last()?.footer))
    expect(find('Save')!.className).toMatch(/primary/i)
    expect(find('Add to pack')!.className).not.toMatch(/primary/i)
    click(footer.container, 'Save')
    await flush()
    expect(calls.saveEdit).toBe(1)
    footer.unmount()
    // Editing the draft back to its baseline removes Save again.
    openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', target: detailTarget('c-draft') })
    await flush(6)
    const draft = await enterDetailEdit(windows)
    const draftFooter = footerOf(windows)
    act(() => { draft.onChange?.({ text: '# Changed' }) })
    draftFooter.rerender(createElement(Fragment, null, windows.last()?.footer))
    expect([...draftFooter.container.querySelectorAll('button')].some(button => button.textContent === 'Save')).toBe(true)
    act(() => { draft.onChange?.({ text: '# Draft' }) })
    draftFooter.rerender(createElement(Fragment, null, windows.last()?.footer))
    expect([...draftFooter.container.querySelectorAll('button')].some(button => button.textContent === 'Save')).toBe(false)
    expect(windows.last()?.dirty).toBe(false)
    draftFooter.unmount()
  })
  it.each([
    { name: 'unknown edit format', overrides: { loadEditDocument: () => ({ format: 'application/x-opaque', data: { n: 1 } }) }, target: detailTarget('c-opaque'), readOnlyCopy: false },
    { name: 'read-only source type', overrides: { editable: false }, target: { sourceId: GITHUB_SOURCE.sourceId, typeId: 'builtin.github.issue', locator: { host: 'github.com', owner: 'acme', repo: 'widgets', kind: 'issue', number: 7 }, title: '#7' }, readOnlyCopy: true },
  ])('never offers Save for a $name', async ({ overrides, target, readOnlyCopy }) => {
    const { face, calls } = faceOf(overrides)
    const windows = await openDetail(face, target)
    const content = windows.last()?.content as { readOnly?: boolean; error?: string; onSave?: () => void }
    expect(content.readOnly).toBe(true); expect(content.onSave).toBeUndefined()
    if (readOnlyCopy) {
      expect(content.error).toContain('read-only')
      expect(windows.last()?.actions).toBeUndefined()
      const header = headerOf(windows)
      expect(header.container.textContent).toContain('Open the original resource')
      expect(header.container.querySelector('a[href="https://github.com/acme/widgets/issues/7"]')).not.toBeNull()
      expect(header.container.querySelector('[data-clue-detail-toolbar]')).not.toBeNull()
      header.unmount()
    }
    const footer = footerOf(windows)
    expect([...footer.container.querySelectorAll('button')].some(button => button.textContent === 'Save')).toBe(false)
    expect(calls.saveEdit).toBe(0)
    footer.unmount()
  })
  it('removes Save when a source renderer disappears and blocks its stale save callback', async () => {
    const { face, calls } = faceOf({ loadEditDocument: () => ({ format: 'application/x-removable', data: { n: 1 } }) })
    let renderer: ReturnType<BetterSidebarCluesClientFace['getFormatRenderer']> = () => createElement('div', null, 'source')
    const listeners = new Set<() => void>()
    const liveFace = { ...face, getFormatRenderer: () => renderer, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
    const windows = recordingWindows()
    openClueDetailWindow({ windows: windows.windows, face: liveFace, workspaceId: 'ws-1', target: detailTarget('c-removable') })
    await flush()
    const initial = await enterDetailEdit(windows)
    expect(calls.loadEdit).toBe(1)
    act(() => { initial.onChange?.({ n: 2 }) })
    const edited = windows.last()?.content as DetailProbe
    expect(edited.onSave).toBeTypeOf('function')
    const footer = footerOf(windows)
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
    act(() => { openClueDetailWindow({ windows: host, face, workspaceId: 'ws-1', target: detailTarget('c-visible-draft', 'Visible draft') }) })
    await flush()
    const frame = document.querySelector<HTMLElement>('[data-floating-window]')!
    expect(frame.querySelector<HTMLElement>('[data-window-document-preview]')!.hidden).toBe(false)
    expect(frame.querySelector<HTMLElement>('[data-window-document-editor]')!.hidden).toBe(true)
    act(() => { frame.querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    await flush()
    const editor = frame.querySelector<HTMLTextAreaElement>('[data-window-text-editor]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => { setter.call(editor, '# Retained draft'); editor.dispatchEvent(new Event('input', { bubbles: true })) })
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
    expect([...frame.querySelectorAll('button')].find(button => button.textContent === 'Save')!.disabled).toBe(false)
    // Returning to the unsaved preview keeps Preview selected on the next refusal.
    act(() => { frame.querySelector<HTMLButtonElement>('[data-window-mode-tab="preview"]')!.click() })
    await act(async () => { close.click(); await Promise.resolve() })
    expect(frame.querySelector<HTMLElement>('[data-window-document-preview]')!.hidden).toBe(false)
    expect(frame.querySelector<HTMLElement>('[data-window-document-editor]')!.hidden).toBe(true)
    expect(frame.querySelector('[data-window-text-editor]')).toBe(editor)
    expect(frame.querySelector('[data-window-document-preview] h1')?.textContent).toBe('Retained draft')
    // Save settles the draft; the clean window then closes.
    act(() => { frame.querySelector<HTMLButtonElement>('[data-window-mode-tab="edit"]')!.click() })
    act(() => { [...frame.querySelectorAll('button')].find(button => button.textContent === 'Save')!.click() })
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
  it('keeps the draft and offers a re-read after a save conflict', async () => {
    const { face, calls } = faceOf({ saveError: () => new SidebarApiError('conflict', 'stale revision') })
    const windows = recordingWindows()
    openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', target: detailTarget('c-conflict') })
    await flush()
    const content = await enterDetailEdit(windows)
    act(() => { content.onChange?.({ text: '# Kept draft' }) })
    await flush()
    const footer = footerOf(windows)
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
  it('refuses to close with an unsaved edit and allows closing a clean window', async () => {
    const { face } = faceOf()
    const windows = recordingWindows()
    openClueDetailWindow({ windows: windows.windows, face, workspaceId: 'ws-1', target: detailTarget('c-unsaved') })
    await flush()
    const content = await enterDetailEdit(windows)
    act(() => { content.onChange?.({ text: '# Unsaved' }) })
    await flush()
    expect(windows.last()?.onBeforeClose?.()).toBe(false)
    const refreshed = windows.last()?.content as DetailProbe
    // The refusal does not drop the draft: the window stays open with an explicit choice.
    expect(refreshed.kind).toBe('document')
    expect((refreshed.document?.data as { text: string }).text).toBe('# Unsaved')
    expect(refreshed.error).toContain('Unsaved edits')
    // A load is the saved baseline: a never-edited window closes freely.
    const clean = recordingWindows()
    openClueDetailWindow({ windows: clean.windows, face, workspaceId: 'ws-1', target: detailTarget('c-clean') })
    await flush()
    expect(clean.last()?.dirty).toBe(false)
    expect(clean.last()?.onBeforeClose?.()).toBe(true)
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
          id: options.id, update(patch) { latest = { ...(latest ?? options), ...patch } as WindowOpenOptions },
          focus: () => undefined, close: async () => undefined,
          navigation: { push: () => undefined, pop: () => false, back: () => false, canGoBack: () => false, depth: () => 1 },
        }
        handles.set(options.id, handle)
        return handle
      },
    }
    const target = detailTarget('c-draft')
    openClueDetailWindow({ windows, face, workspaceId: 'ws-1', target })
    await flush()
    expect(calls.loadEdit).toBe(0)
    act(() => { (latest?.content as DetailProbe).onModeChange?.('edit') })
    await flush()
    act(() => { (latest?.content as DetailProbe).onChange?.({ text: '# Unsaved draft' }) })
    await flush()
    openClueDetailWindow({ windows, face, workspaceId: 'ws-1', target })
    await flush()
    // The second open focused the live instance: no second loadEdit and the draft is still there.
    expect(calls.loadEdit).toBe(1)
    expect(((latest?.content as DetailProbe).document?.data as { text: string }).text).toBe('# Unsaved draft')
  })
  it('binds a single clue to a workspace and unbinds without deleting it', async () => {
    const { face, calls } = faceOf()
    const windows = await openDetail(face, detailTarget('c-bind'), { workspaces: [{ workspaceId: 'ws-1', title: '/repo' }, { workspaceId: 'ws-2', title: '/other' }] })
    const view = footerOf(windows)
    await flush()
    const advanced = view.container.querySelector<HTMLDetailsElement>('[data-clue-detail-advanced]')!
    expect(advanced.open).toBe(false)
    expect(advanced.querySelector('summary')?.textContent).toBe('Workspace binding')
    act(() => { advanced.open = true })
    expect(view.container.textContent).toContain('New sessions in this workspace receive these references automatically')
    expect(view.container.textContent).toContain('Unbinding deletes neither the clues')
    chooseBindingWorkspace(view.container, '/other')
    await flush()
    click(view.container, 'Bind')
    await flush()
    expect(calls.bindingAddTargets).toEqual([{ workspaceId: 'ws-2', target: { kind: 'clue', clueId: 'c-bind' } }])
    expect(view.container.textContent).toContain('Bound')
    click(view.container, 'Unbind')
    await flush()
    expect(calls.bindingRemoveTargets).toEqual([{ workspaceId: 'ws-2', target: { kind: 'clue', clueId: 'c-bind' } }])
    expect(view.container.querySelector('button[aria-label="Choose a workspace"][aria-haspopup="menu"]')).not.toBeNull()
    view.unmount()
  })
  it('uses the binding copy on add/list failures and explains a cross-workspace clue', async () => {
    const cases: { overrides: FaceOverrides; copy: string }[] = [
      { overrides: { bindingAddError: () => new SidebarApiError('network', 'offline') }, copy: 'The workspace binding operation failed.' },
      { overrides: { bindingsListError: () => new SidebarApiError('network', 'offline') }, copy: 'The workspace binding operation failed.' },
      { overrides: { bindingAddError: () => new SidebarApiError('not-found', 'clue "c-cross" does not exist in this workspace') }, copy: 'not in the selected workspace' },
    ]
    for (const { overrides, copy } of cases) {
      const { face } = faceOf(overrides)
      const windows = await openDetail(face, detailTarget('c-bind-fail'), { workspaces: [{ workspaceId: 'ws-1', title: '/repo' }, { workspaceId: 'ws-2', title: '/other' }] })
      const view = footerOf(windows)
      await flush()
      if (overrides.bindingAddError !== undefined) {
        chooseBindingWorkspace(view.container, '/other')
        click(view.container, 'Bind')
        await flush()
      }
      const alert = view.container.querySelector('[role="alert"]')
      expect(alert?.textContent).toContain(copy)
      if (copy === 'not in the selected workspace') expect(alert?.textContent).toContain('before binding')
      else expect(alert?.textContent).not.toContain('Saving the pack failed.')
      view.unmount()
    }
  })
  it('treats a source-locked edit document (archived) as read-only with the reason', async () => {
    const { face, calls } = faceOf({ sources: [GITHUB_SOURCE], loadEditDocument: () => ({ format: 'text/markdown', data: { text: '# Locked', readOnly: true, readOnlyReason: 'archived' }, baseRevision: 'r1' }) })
    const windows = await openDetail(face, { sourceId: GITHUB_SOURCE.sourceId, typeId: 'builtin.github.issue', clueId: 'c-archived', title: '#7' })
    // A source lock is discovered by the lazy edit load, not the preview read.
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
    const { face } = faceOf({ editable: false, readError: () => (fail ? new SidebarApiError('permission-denied', 'no access') : undefined) })
    const windows = await openDetail(face, { sourceId: GITHUB_SOURCE.sourceId, typeId: 'builtin.github.issue', locator: { host: 'github.com', owner: 'acme', repo: 'widgets', kind: 'pull', number: 9 }, title: '#9' })
    const failure = renderRoot(createElement(Fragment, null, windows.last()?.content as ReactNode))
    await flush()
    expect(failure.container.textContent).toContain('Insufficient permissions')
    expect(failure.container.textContent).toContain('Retry')
    expect(failure.container.querySelector('a[href="https://github.com/acme/widgets/pull/9"]')).not.toBeNull()
    fail = false
    click(failure.container, 'Retry')
    await flush()
    expect((windows.last()?.content as { readOnly?: boolean }).readOnly).toBe(true)
    failure.unmount()
  })
describe('clue share window', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:cluepack'), revokeObjectURL: vi.fn() }))
  })
  const jsonResponse = (value: unknown) => new Response(JSON.stringify({ ok: true, value }), { status: 200, headers: { 'content-type': 'application/json' } })
  const exportPreview = (mode = 'snapshot') => ({ mode, fileName: 'release.cluepack', items: [], packs: [{ packId: 'p1', name: 'Release clues', members: 2 }], warnings: [], totals: { clues: 2, packs: 1, sources: 1 } })
  const zipResponse = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="release.cluepack"', 'x-cluepack-complete': 'true', 'x-cluepack-issues': '0' } })
  const importPreviewBody = (extra: Record<string, unknown> = {}) => ({
    workspaceId: 'ws-1', mode: 'snapshot', exportedAt: '2026-10-17T00:00:00.000Z', packNames: [], packs: [], items: [],
    missingSources: [], snapshotCount: 0, unresolvedCount: 0, warnings: [], ...extra,
  })
  const sharePage = (face: BetterSidebarCluesClientFace, extra: { packIds?: string[]; direction?: 'export' | 'import' } = {}) =>
    renderRoot(createElement(SharePage, { windows: recordingWindows().windows, workspaceId: 'ws-1', face, ...extra }))
  /** A singleton host: the second open returns the first handle and only publishes an update. */
  function shareWindows(): { windows: { open(options: WindowOpenOptions): WindowHandle }; content(): ReactNode } {
    const handles = new Map<string, WindowHandle>()
    let content: ReactNode
    const open = (options: WindowOpenOptions): WindowHandle => {
      const existing = handles.get(options.id)
      if (existing !== undefined) return existing
      content = options.content as ReactNode
      const handle: WindowHandle = { id: options.id, update: () => undefined, focus: () => undefined, close: async () => undefined, navigation: { push: () => undefined, pop: () => false, back: () => false, canGoBack: () => false, depth: () => 1 } }
      handles.set(options.id, handle)
      return handle
    }
    return { windows: { open }, content: () => content }
  }
  it('previews the export payload, downloads the archive, and clears on Reset', async () => {
    const { face } = faceOf()
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/sidebar/api/clues.share.exportPreview')) return jsonResponse(exportPreview())
      if (String(url).includes('/sidebar/clues/share/export')) return zipResponse()
      throw new Error('unexpected fetch ' + String(url))
    })
    const view = sharePage(face, { packIds: ['p1'] })
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
    click(view.container, 'Reset')
    await flush()
    expect(view.container.textContent).not.toContain('2 clues'); expect(view.container.textContent).not.toContain('Done')
    view.unmount()
  })
  it('locks preview inputs while busy and only cancels an in-flight preview when a later open changes its inputs', async () => {
    const { face } = faceOf()
    const host = shareWindows()
    let signal: AbortSignal | undefined, finish!: (response: Response) => void
    fetchMock.mockImplementation((_url: string, init: RequestInit) => { signal = init.signal ?? undefined; return new Promise<Response>(resolve => { finish = resolve }) })
    const windows = host.windows
    openShareWindow({ windows, workspaceId: 'ws-1', face, packIds: ['p1'], direction: 'export' })
    const view = renderRoot(createElement(Fragment, null, host.content()))
    await flush()
    click(view.container, 'Preview selection')
    await flush()
    expect(view.container.querySelector<HTMLFieldSetElement>('fieldset[aria-label="Share content"]')?.disabled).toBe(true)
    const checks = [...view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]; expect(checks.length).toBeGreaterThan(0)
    expect(checks.every(input => input.disabled)).toBe(true)
    const panel = view.container.querySelector('[role="tabpanel"]')!
    const previewAction = [...view.container.querySelectorAll('button')].find(button => button.textContent?.includes('Preview selection'))!
    expect(panel.contains(previewAction)).toBe(false)
    expect(previewAction.disabled).toBe(true)
    await act(async () => { finish(jsonResponse(exportPreview())); await Promise.resolve() })
    await flush()
    expect(view.container.querySelector<HTMLFieldSetElement>('fieldset[aria-label="Share content"]')?.disabled).toBe(false)
    expect(previewAction.disabled).toBe(false)
    // A same-inputs reopen never aborts the new pending preview; changed inputs do.
    click(view.container, 'Check source references')
    await flush()
    expect(signal?.aborted).toBe(false)
    act(() => { openShareWindow({ windows, workspaceId: 'ws-1', face, packIds: ['p1'], direction: 'export' }) })
    expect(signal?.aborted).toBe(false)
    act(() => { openShareWindow({ windows, workspaceId: 'ws-1', face, packIds: ['p2'], direction: 'export' }) })
    expect(signal?.aborted).toBe(true)
    expect(view.container.querySelector<HTMLFieldSetElement>('fieldset[aria-label="Share content"]')?.disabled).toBe(false)
    await act(async () => {
      finish(jsonResponse({ ...exportPreview(), totals: { clues: 999, packs: 1, sources: 1 } }))
      await Promise.resolve()
    })
    await flush()
    expect(view.container.textContent).not.toContain('999 clues')
    view.unmount()
  })
  it('exports with the protocol mode "references" (not the singular client spelling)', async () => {
    const { face } = faceOf()
    const bodies: Record<string, unknown>[] = []
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      if (String(url).includes('/sidebar/api/clues.share.exportPreview')) return jsonResponse(exportPreview('references'))
      if (String(url).includes('/sidebar/clues/share/export')) return zipResponse()
      throw new Error('unexpected fetch ' + String(url))
    })
    const view = sharePage(face, { packIds: ['p1'] })
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
    // Progress polls are a different payload shape; only preview/export carry the archive mode.
    const archiveBodies = bodies.filter(body => body.workspaceId === 'ws-1')
    expect(archiveBodies).toHaveLength(2)
    expect(archiveBodies.every(body => body.mode === 'references')).toBe(true)
    expect(bodies.some(body => body.mode === 'reference')).toBe(false)
    view.unmount()
  })
  it('turns a failed pack list into a retryable error and exposes an accessible tab set', async () => {
    let fail = true
    const { face } = faceOf({ packsListError: () => (fail ? new SidebarApiError('network', 'offline') : undefined) })
    const view = sharePage(face)
    await flush()
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Failed to load')
    expect(view.container.textContent).not.toContain('No clue packs yet')
    fail = false
    click(view.container, 'Retry')
    await flush()
    expect(view.container.textContent).toContain('Release clues')
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
  it('merges later pack selections and direction into the already-open window', async () => {
    const second: CluePack = { ...PACK, id: 'p2', name: 'Design notes', members: [], revision: 1 }
    const { face } = faceOf({ packs: [PACK, second] })
    const host = shareWindows()
    openShareWindow({ windows: host.windows, workspaceId: 'ws-1', face, packIds: ['p1'] })
    const view = renderRoot(createElement(Fragment, null, host.content()))
    await flush(6)
    openShareWindow({ windows: host.windows, workspaceId: 'ws-1', face, packIds: ['p2'], direction: 'import' })
    await flush()
    expect(view.container.querySelector('#clue-share-tab-import')?.getAttribute('aria-selected')).toBe('true')
    click(view.container, 'Export')
    await flush()
    expect([...view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter(input => input.checked)).toHaveLength(2)
    view.unmount()
  })
  it('retargets an open window to the workspace of a later Import request', async () => {
    const { face, calls } = faceOf()
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/sidebar/clues/share/import-preview')) return jsonResponse(importPreviewBody({ workspaceId: 'ws-2' }))
      throw new Error('unexpected fetch ' + String(url))
    })
    const host = shareWindows()
    openShareWindow({ windows: host.windows, workspaceId: 'ws-1', face, direction: 'import' })
    const view = renderRoot(createElement(Fragment, null, host.content()))
    await flush(6)
    expect(calls.packsList).toEqual(['ws-1'])
    act(() => { openShareWindow({ windows: host.windows, workspaceId: 'ws-2', face, direction: 'import' }) })
    await flush(6)
    expect(calls.packsList).toEqual(['ws-1', 'ws-2'])
    // The file chosen AFTER the switch is previewed against ws-2, never ws-1.
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File([new Uint8Array([1, 2, 3])], 'share.cluepack')], configurable: true })
    act(() => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush(6)
    const urls = fetchMock.mock.calls.map(call => String(call[0]))
    expect(urls.some(url => url.includes('workspaceId=ws-2'))).toBe(true)
    expect(urls.some(url => url.includes('workspaceId=ws-1'))).toBe(false)
    view.unmount()
  })
  it('previews unresolved import rows and shows partial reasons until explicit acceptance', async () => {
    const { face } = faceOf()
    let imports = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/sidebar/clues/share/import-preview')) return jsonResponse(importPreviewBody({
        packNames: ['Release clues'], packs: [{ key: 'p1', name: 'Release clues', members: 1 }],
        items: [{ key: 'k1', title: 'A note', sourceId: 'third.party:docs', typeId: 'third.party:doc', portable: false, snapshot: true,
          snapshotFetchedAt: '2026-10-17T00:00:00.000Z', willBeUnresolved: true, unresolvedReason: 'source not installed' }],
        missingSources: ['third.party:docs'], snapshotCount: 1, unresolvedCount: 1,
      }))
      if (String(url).includes('/sidebar/clues/share/import')) {
        imports += 1
        return jsonResponse({
          workspaceId: 'ws-1', mode: 'snapshot', clues: [], packs: [], snapshots: [], complete: false, partial: true, cancelled: false,
          requiresAcceptance: true, reasons: ['Snapshot unavailable: A note', 'Source not installed: third.party:docs'],
        })
      }
      throw new Error('unexpected fetch ' + String(url))
    })
    const view = sharePage(face, { direction: 'import' })
    await flush()
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [new File([new Uint8Array([1, 2, 3])], 'share.cluepack')], configurable: true })
    act(() => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    await flush(6)
    expect(view.container.textContent).toContain('share.cluepack')
    expect(view.container.textContent).toContain('Release clues')
    expect(view.container.textContent).toContain('1 member')
    expect(view.container.textContent).toContain('Missing sources: third.party:docs')
    expect(view.container.textContent).toContain('source not installed')
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
