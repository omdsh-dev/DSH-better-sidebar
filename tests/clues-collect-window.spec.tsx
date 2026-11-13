// @vitest-environment jsdom
/**
 * The ONE collection window contract.
 *
 * The browser tray, the row menu, a detail window and a composer chip all open
 * `windows/collect.tsx`; none of them owns a second write loop. These cases
 * pin the two paths that cannot rely on a mounted clues Tab:
 * - a composer chip opens the detail, and that detail adds to a pack;
 * - the collection window opens and completes with no tab (or after the tab's
 *   React tree was unmounted), because its lifecycle belongs to the window
 *   service.
 *
 * The window identity is the workspace + target set, so the same resources
 * focus one instance and a different set is a distinct prefixed instance.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()
beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

import { createWindowHost } from '../src/client/windows/host.ts'
import { WindowHost } from '../src/client/windows/WindowHost.tsx'
import type { WindowHostController } from '../src/client/windows/types.ts'
import { openClueReference } from '../src/client/clues/open-reference.ts'
import { openPackManagementWindow } from '../src/client/clues/windows/pack.tsx'
import {
  clearClueCollectionDrafts,
  collectWindowId,
  openClueCollectionForTarget,
  openClueCollectionWindow,
} from '../src/client/clues/windows/collect.tsx'
import type { BetterSidebarCluesClientFace } from '../src/client/clues/registry.ts'
import type { ClueCandidate, CluePack, ClueReadResult } from '../src/clues/types.ts'

const hosts: WindowHostController[] = []
const views: RenderedRoot[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.unmount()
  act(() => { for (const host of hosts.splice(0)) host.dispose() })
})
beforeEach(clearClueCollectionDrafts)

function flush(rounds = 4): Promise<void> {
  return act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')]
    .find(candidate => (candidate.textContent ?? '').trim() === label || candidate.getAttribute('aria-label') === label)
  if (found === undefined) throw new Error(`button "${label}" not found`)
  return found
}

function click(container: ParentNode, label: string): void {
  const target = button(container, label)
  act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function formOf(windowId: string): HTMLFormElement {
  const found = document.querySelector<HTMLFormElement>(
    `[data-window-owner="${windowId}"] form[data-clue-collection]`,
  )
  if (found === null) throw new Error(`collection form for ${windowId} not found`)
  return found
}

/** Choose a destination radio inside one collection form. */
function choose(formNode: ParentNode, value: string): void {
  const radio = formNode.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)
  if (radio === null) throw new Error(`destination ${value} not found`)
  act(() => { radio.click() })
}

/** Set a controlled input's value through React's change pipeline. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function form(): HTMLFormElement {
  const found = document.querySelector<HTMLFormElement>('form[data-clue-collection]')
  if (found === null) throw new Error('collection form not found')
  return found
}

function candidate(id: string, title: string, path: string): ClueCandidate {
  return { sourceId: 'builtin.files', typeId: 'builtin.files.markdown', clueId: id, title, locator: { path } }
}

const PACK: CluePack = {
  id: 'p1', name: 'Release clues', workspaceId: 'w1', members: ['c1'], revision: 1,
  createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z',
}

/** A real window host plus the minimum clue face the detail/collect paths read. */
function harness(options: {
  clue?: ClueCandidate
  addMember?: (input: Record<string, unknown>) => Promise<{ pack: CluePack; revision: number; packRevision: number }>
} = {}) {
  const host = createWindowHost({ viewport: () => ({ width: 1280, height: 900 }) })
  hosts.push(host)
  const clue = options.clue ?? candidate('c1', 'A note', 'a.md')
  const addMemberCalls: Record<string, unknown>[] = []
  const packsListCalls: string[] = []
  const read: ClueReadResult = {
    format: 'text/markdown',
    data: { text: '# A note' },
    fetchedAt: '2026-10-17T00:00:00Z',
  }
  const face: BetterSidebarCluesClientFace = {
    api: {
      sources: async () => ({
        sources: [{
          sourceId: 'builtin.files', name: 'Local files', order: 0, pluginId: 'test',
          types: [], transport: 'files',
          capabilities: { resolve: true, list: true, search: true, read: true, edit: false, portable: true },
        }],
        types: [],
      }),
      clues: async () => ({
        clues: [{
          id: clue.clueId!, sourceId: clue.sourceId, typeId: clue.typeId,
          title: clue.title, locator: clue.locator,
          workspaceId: 'w1', createdAt: '', updatedAt: '',
        }],
        revision: 1,
      }),
      read: async () => read,
      loadEdit: async () => ({ format: 'text/markdown', data: { text: '# A note' }, baseRevision: 'r1' }),
      saveEdit: async () => ({ savedAt: '2026-10-17T00:00:00Z' }),
      pinsList: async () => ({ pins: [], revision: 0 }),
      packsList: async (workspaceId: string) => {
        packsListCalls.push(workspaceId)
        return { packs: [PACK], revision: 3 }
      },
      ensure: async () => ({ clue: { id: clue.clueId ?? 'c-ensured' }, created: false }),
      packsAddMember: async (_workspaceId: string, input: Record<string, unknown>) => {
        addMemberCalls.push(input)
        return options.addMember?.(input) ?? { pack: PACK, revision: 4, packRevision: 2 }
      },
      packsCreate: async (_workspaceId: string, input: Record<string, unknown>) => ({
        pack: { ...PACK, id: 'p-new', name: String(input.name), members: input.members as string[] ?? [] },
        revision: 4, packRevision: 1,
      }),
      bindingsList: async () => ({ bindings: [], revision: 0 }),
      bindingsAdd: async () => ({ bindings: [], revision: 1 }),
      bindingsRemove: async () => ({ bindings: [], revision: 2 }),
    } as never,
    registerSourceDisplay: () => () => {},
    getSourceDisplays: () => [],
    registerFormatRenderer: () => () => {},
    getFormatRenderer: () => undefined,
    getFormatRenderers: () => new Map(),
    subscribe: () => () => {},
    isSourceEnabled: () => true,
    isSourceMentionEnabled: () => true,
    isPacksMentionEnabled: () => true,
  }
  const workspaces = {
    list: {
      getSnapshot: () => ({
        phase: 'ready' as const,
        state: 'idle' as const,
        items: [{ path: '/repo', sessionIds: ['s1'], workspaceId: 'w1' }],
      }),
    },
  }
  const service = { clues: face, windows: host }
  const ctx = {
    get: (name: string) => (name === 'betterSidebar' ? service : name === 'workspaces' ? workspaces : undefined),
    sessions: { scope: () => ({}) },
  }
  const view = renderRoot(createElement(WindowHost, { host, formats: face }))
  views.push(view)
  return { host, face, ctx, view, addMemberCalls, packsListCalls, clue }
}

describe('one clue collection window', () => {
  it('opens from a composer-chip detail without a mounted clues tab and writes once', async () => {
    const fx = harness()
    act(() => { openClueReference(fx.ctx as never, { kind: 'clue', id: 'c1', sessionId: 's1' }) })
    await flush()
    const detail = [...document.querySelectorAll<HTMLElement>('[data-floating-window]')]
      .find(node => node.querySelector('[data-clue-detail-add-to-pack]') !== null)
    expect(detail).toBeDefined()
    const add = detail!.querySelector<HTMLButtonElement>('[data-clue-detail-add-to-pack]')!
    act(() => { add.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    expect(form()).not.toBeNull()
    expect(form().parentElement!.textContent).toContain('1 selected')
    // Choosing a destination writes nothing.
    const radio = form().querySelector<HTMLInputElement>('input[type="radio"][value="p1"]')!
    act(() => { radio.click() })
    expect(fx.addMemberCalls).toHaveLength(0)
    click(form(), 'Add to pack')
    await flush()
    expect(fx.addMemberCalls).toEqual([{ packId: 'p1', clueId: 'c1' }])
    expect(document.querySelector('form[data-clue-collection]')).toBeNull()
    expect(fx.packsListCalls).toEqual(['w1'])
  })

  it('forwards Add to pack through a pack-window member detail', async () => {
    const fx = harness()
    act(() => {
      openPackManagementWindow({
        windows: fx.host,
        workspaceId: 'w1',
        face: fx.face,
        workspaces: [{ workspaceId: 'w1', title: '/repo' }],
        pack: PACK,
        onInsertClue: () => true,
        onInsertPack: () => true,
        onNotice: () => undefined,
        onAddToPack: (target) => {
          void openClueCollectionForTarget({
            windows: fx.host, face: fx.face, workspaceId: 'w1', target, onNotice: () => undefined,
          })
        },
      })
    })
    await flush()
    const member = [...document.querySelectorAll<HTMLButtonElement>('[data-clue-pack-window] button')]
      .find(node => (node.textContent ?? '').trim() === 'A note')
    expect(member).toBeDefined()
    act(() => { member!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()
    const detail = [...document.querySelectorAll<HTMLElement>('[data-floating-window]')]
      .find(node => node.querySelector('[data-clue-detail-add-to-pack]') !== null)
    expect(detail).toBeDefined()
    act(() => {
      detail!.querySelector<HTMLButtonElement>('[data-clue-detail-add-to-pack]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(form()).not.toBeNull()
    expect(form().parentElement!.textContent).toContain('1 selected')
  })

  it('opens and completes after the clues-tab React tree is unmounted', async () => {
    const fx = harness()
    const tab = renderRoot(createElement('div', { 'data-clue-tab': '' }))
    tab.unmount()
    act(() => {
      openClueCollectionWindow({
        windows: fx.host,
        face: fx.face,
        workspaceId: 'w1',
        targets: [candidate('c1', 'A note', 'a.md')],
        onNotice: () => undefined,
      })
    })
    await flush()
    expect(form()).not.toBeNull()
    const radio = form().querySelector<HTMLInputElement>('input[type="radio"][value="p1"]')!
    act(() => { radio.click() })
    click(form(), 'Add to pack')
    await flush()
    expect(fx.addMemberCalls).toEqual([{ packId: 'p1', clueId: 'c1' }])
    expect(document.querySelector('form[data-clue-collection]')).toBeNull()
  })

  it('keeps one prefixed instance per workspace and target set, and Cancel writes nothing', async () => {
    const a = candidate('c1', 'A note', 'a.md')
    const b = candidate('c2', 'B note', 'b.md')
    expect(collectWindowId('w1', [a, b])).toBe(collectWindowId('w1', [b, a]))
    expect(collectWindowId('w1', [a])).not.toBe(collectWindowId('w2', [a]))
    expect(collectWindowId('w1', [a])).not.toBe(collectWindowId('w1', [b]))
    expect(collectWindowId('w1', [a]).startsWith('clue-collect:')).toBe(true)

    const fx = harness()
    const open = () => openClueCollectionWindow({
      windows: fx.host,
      face: fx.face,
      workspaceId: 'w1',
      targets: [a, b],
      onNotice: () => undefined,
    })
    act(() => { open() })
    await flush()
    act(() => { open() })
    await flush()
    expect(document.querySelectorAll('form[data-clue-collection]')).toHaveLength(1)
    click(form(), 'Cancel')
    await flush()
    expect(document.querySelector('form[data-clue-collection]')).toBeNull()
    expect(fx.addMemberCalls).toHaveLength(0)
    expect(fx.packsListCalls).toEqual(['w1'])
  })

  it('keeps the failed and later targets after a partial write, and retries them', async () => {
    let failSecond = true
    const a = candidate('c1', 'A note', 'a.md')
    const b = candidate('c2', 'B note', 'b.md')
    const fx = harness({
      addMember: async (input) => {
        if (input.clueId === 'c2' && failSecond) throw new Error('member rejected')
        return { pack: PACK, revision: 4, packRevision: 2 }
      },
    })
    act(() => {
      openClueCollectionWindow({
        windows: fx.host,
        face: fx.face,
        workspaceId: 'w1',
        targets: [a, b],
        onNotice: () => undefined,
      })
    })
    await flush()
    const radio = form().querySelector<HTMLInputElement>('input[type="radio"][value="p1"]')!
    act(() => { radio.click() })
    click(form(), 'Add to pack')
    await flush()
    expect(fx.addMemberCalls.map(call => call.clueId)).toEqual(['c1', 'c2'])
    // The failed member is still collected; the successful prefix left.
    expect(form().parentElement!.textContent).toContain('1 selected')
    expect(form().querySelector<HTMLInputElement>('input[type="radio"][value="p1"]')!.checked).toBe(true)
    expect(form().querySelector('[role="alert"]')).not.toBeNull()

    failSecond = false
    click(form(), 'Add to pack')
    await flush()
    expect(fx.addMemberCalls.map(call => call.clueId)).toEqual(['c1', 'c2', 'c2'])
    expect(document.querySelector('form[data-clue-collection]')).toBeNull()
  })

  it('keeps destination, New name and unfinished targets across a close', async () => {
    let failSecond = true
    const a = candidate('c1', 'A note', 'a.md')
    const b = candidate('c2', 'B note', 'b.md')
    const fx = harness({
      addMember: async (input) => {
        if (input.clueId === 'c2' && failSecond) throw new Error('member rejected')
        return { pack: PACK, revision: 4, packRevision: 2 }
      },
    })
    const open = () => openClueCollectionWindow({
      windows: fx.host, face: fx.face, workspaceId: 'w1', targets: [a, b], onNotice: () => undefined,
    })
    act(() => { open() })
    await flush()
    choose(form(), '__new')
    typeInto(form().querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!, 'Keep me')
    act(() => { open()!.close() })
    await flush()

    act(() => { open() })
    await flush()
    expect(form().parentElement!.textContent).toContain('2 selected')
    expect(form().querySelector<HTMLInputElement>('input[value="__new"]')!.checked).toBe(true)
    expect(form().querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!.value).toBe('Keep me')

    // Leave one target unfinished, close, and reopen: both the destination
    // and the failed target survive.
    choose(form(), 'p1')
    click(form(), 'Add to pack')
    await flush()
    expect(form().parentElement!.textContent).toContain('1 selected')
    act(() => { open()!.close() })
    await flush()
    act(() => { open() })
    await flush()
    expect(form().parentElement!.textContent).toContain('1 selected')
    expect(form().querySelector<HTMLInputElement>('input[value="p1"]')!.checked).toBe(true)
    failSecond = false
  })

  it('does not retain a fully completed batch', async () => {
    const a = candidate('c1', 'A note', 'a.md')
    const fx = harness()
    const open = () => openClueCollectionWindow({
      windows: fx.host, face: fx.face, workspaceId: 'w1', targets: [a], onNotice: () => undefined,
    })
    act(() => { open() })
    await flush()
    choose(form(), 'p1')
    click(form(), 'Add to pack')
    await flush()
    expect(document.querySelector('form[data-clue-collection]')).toBeNull()

    act(() => { open() })
    await flush()
    expect(form().parentElement!.textContent).toContain('1 selected')
    expect(form().querySelector<HTMLInputElement>('input[value="p1"]')!.checked).toBe(false)
    expect(form().querySelector('input[aria-label="Pack name"]')).toBeNull()
  })

  it('does not let many other instances evict an active window draft', async () => {
    const a = candidate('c1', 'A note', 'a.md')
    const fx = harness()
    const active = openClueCollectionWindow({
      windows: fx.host, face: fx.face, workspaceId: 'w1', targets: [a], onNotice: () => undefined,
    })!
    const activeId = collectWindowId('w1', [a])
    await flush()
    choose(formOf(activeId), '__new')
    typeInto(formOf(activeId).querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!, 'Active draft')

    // More than the closed-draft cap: an ACTIVE surface must never sit in the
    // cache, so these cannot evict it.
    for (let index = 0; index < 31; index += 1) {
      act(() => {
        openClueCollectionWindow({
          windows: fx.host,
          face: fx.face,
          workspaceId: 'w1',
          targets: [candidate(`other-${index}`, `Other ${index}`, `other-${index}.md`)],
          onNotice: () => undefined,
        })
      })
    }
    await flush()
    await act(async () => { await active.close() })
    await flush()

    act(() => {
      openClueCollectionWindow({
        windows: fx.host, face: fx.face, workspaceId: 'w1', targets: [a], onNotice: () => undefined,
      })
    })
    await flush()
    expect(formOf(activeId).parentElement!.textContent).toContain('1 selected')
    expect(formOf(activeId).querySelector<HTMLInputElement>('input[value="__new"]')!.checked).toBe(true)
    expect(formOf(activeId).querySelector<HTMLInputElement>('input[aria-label="Pack name"]')!.value)
      .toBe('Active draft')
  })
})
