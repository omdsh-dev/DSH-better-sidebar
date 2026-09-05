// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  isSubagentTool,
  findSubagentForTool,
  jumpToSubagent,
  registerSubagentToolJump,
} from '../src/client/subagent-tool-jump.ts'
import type { Context, SidebarSessionList } from '../src/context-types.ts'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('isSubagentTool', () => {
  it('returns true for subagent delegation and control tools', () => {
    expect(isSubagentTool('subagent')).toBe(true)
    expect(isSubagentTool('subagent_explorer')).toBe(true)
    expect(isSubagentTool('subagent_fixer')).toBe(true)
    expect(isSubagentTool('subagent_oracle')).toBe(true)
    expect(isSubagentTool('subagent_librarian')).toBe(true)
    expect(isSubagentTool('subagent_designer')).toBe(true)
    expect(isSubagentTool('subagent_councillor_alpha')).toBe(true)
    expect(isSubagentTool('subagent_council')).toBe(true)
    expect(isSubagentTool('subagent_fork')).toBe(true)
    expect(isSubagentTool('subagent_anything')).toBe(true)
    expect(isSubagentTool('send_message')).toBe(true)
    expect(isSubagentTool('interrupt_agent')).toBe(true)
  })

  it('returns false for non-subagent tools or null/undefined', () => {
    expect(isSubagentTool('bash')).toBe(false)
    expect(isSubagentTool('read')).toBe(false)
    expect(isSubagentTool('write')).toBe(false)
    expect(isSubagentTool('edit')).toBe(false)
    expect(isSubagentTool('glob')).toBe(false)
    expect(isSubagentTool('')).toBe(false)
    expect(isSubagentTool(null)).toBe(false)
    expect(isSubagentTool(undefined)).toBe(false)
  })
})

describe('findSubagentForTool', () => {
  const parentId = 'parent-123'
  const child1Id = '11111111-2222-3333-4444-555555555555'
  const child2Id = '22222222-3333-4444-5555-666666666666'

  const mockSessionList: SidebarSessionList = {
    current: parentId,
    byId: {
      [parentId]: { id: parentId, displayTitle: 'Main Parent' },
      [child1Id]: {
        id: child1Id,
        parentId,
        displayTitle: 'Explorer Task',
        origin: 'subagent',
      },
      [child2Id]: {
        id: child2Id,
        parentId,
        displayTitle: 'Fixer Task',
        origin: 'subagent',
      },
    },
    subagentsByParent: {
      [parentId]: {
        entries: [
          {
            kind: 'child',
            id: child1Id,
            label: 'Search codebase for models',
            activity: 'inactive',
            hasChildren: false,
            mode: 'one-shot',
          },
          {
            kind: 'child',
            id: child2Id,
            label: 'Implement fix for diff view',
            activity: 'running',
            hasChildren: false,
            mode: 'one-shot',
          },
        ],
        parentAvailable: true,
        state: 'ready',
      },
    },
  }

  it('matches child by explicit UUID in tool element text', () => {
    const el = document.createElement('div')
    el.textContent = `Tool finished for child ${child1Id} successfully`
    expect(findSubagentForTool(el, parentId, mockSessionList)).toBe(child1Id)
  })

  it('matches child by catalog entry label', () => {
    const el = document.createElement('div')
    el.textContent = 'subagent_explorer · Search codebase for models'
    expect(findSubagentForTool(el, parentId, mockSessionList)).toBe(child1Id)

    const el2 = document.createElement('div')
    el2.textContent = 'subagent_fixer · Implement fix for diff view'
    expect(findSubagentForTool(el2, parentId, mockSessionList)).toBe(child2Id)
  })

  it('matches child by displayTitle in byId', () => {
    const el = document.createElement('div')
    el.textContent = 'subagent_explorer · Explorer Task'
    expect(findSubagentForTool(el, parentId, mockSessionList)).toBe(child1Id)
  })

  it('resolves unambiguously when there is only one child', () => {
    const singleList: SidebarSessionList = {
      current: parentId,
      byId: {
        [parentId]: { id: parentId, displayTitle: 'Main Parent' },
        [child1Id]: { id: child1Id, parentId, displayTitle: 'Child 1', origin: 'subagent' },
      },
      subagentsByParent: {
        [parentId]: {
          entries: [
            { kind: 'child', id: child1Id, label: 'Single Child', activity: 'running', hasChildren: false, mode: 'one-shot' },
          ],
          parentAvailable: true,
          state: 'ready',
        },
      },
    }
    const el = document.createElement('div')
    el.textContent = 'subagent · some generic prompt'
    expect(findSubagentForTool(el, parentId, singleList)).toBe(child1Id)
  })
})

describe('jumpToSubagent', () => {
  it('calls ctx.sessions.openSubagent with parent and child ids', () => {
    const openSubagent = vi.fn()
    const openTab = vi.fn()
    const reduce = vi.fn()
    const ctx = {
      sessions: { openSubagent },
      get: vi.fn(() => ({ openTab })),
    } as unknown as Context
    const store = { reduce } as unknown as SidebarStore

    jumpToSubagent(ctx, store, 'p-1', 'c-1')

    expect(openSubagent).toHaveBeenCalledWith({
      parentSessionId: 'p-1',
      childSessionId: 'c-1',
      mode: 'one-shot',
    })
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ type: 'subagent' }))
  })

  it('falls back to ctx.sessions.open when openSubagent is missing', () => {
    const open = vi.fn()
    const openTab = vi.fn()
    const ctx = {
      sessions: { open },
      get: vi.fn(() => ({ openTab })),
    } as unknown as Context
    const store = { reduce: vi.fn() } as unknown as SidebarStore

    jumpToSubagent(ctx, store, 'p-1', 'c-1')

    expect(open).toHaveBeenCalledWith('c-1')
  })
})

describe('registerSubagentToolJump', () => {
  it('intercepts clicks on subagent tools and calls openSubagent', () => {
    const openSubagent = vi.fn()
    const openTab = vi.fn()
    const ctx = {
      sessions: {
        openSubagent,
        list: {
          getSnapshot: () => ({
            current: 'p-1',
            byId: {
              'p-1': { id: 'p-1', displayTitle: 'Parent' },
              'c-1': { id: 'c-1', parentId: 'p-1', displayTitle: 'Subagent 1', origin: 'subagent' },
            },
            subagentsByParent: {
              'p-1': {
                entries: [
                  { kind: 'child', id: 'c-1', label: 'Explore Code', activity: 'inactive', hasChildren: false, mode: 'one-shot' },
                ],
                parentAvailable: true,
                state: 'ready',
              },
            },
          }),
        },
      },
      get: vi.fn(() => ({ openTab })),
    } as unknown as Context
    const store = { reduce: vi.fn() } as unknown as SidebarStore

    const dispose = registerSubagentToolJump(ctx, store)

    const toolEl = document.createElement('div')
    toolEl.setAttribute('data-tool', 'subagent_explorer')
    const summarySpan = document.createElement('span')
    summarySpan.className = 'summary'
    summarySpan.textContent = 'Explore Code'
    toolEl.appendChild(summarySpan)
    document.body.appendChild(toolEl)

    summarySpan.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    )

    expect(openSubagent).toHaveBeenCalledWith({
      parentSessionId: 'p-1',
      childSessionId: 'c-1',
      mode: 'one-shot',
    })

    dispose()
  })

  it('allows clicking chevron without triggering jump', () => {
    const openSubagent = vi.fn()
    const ctx = {
      sessions: {
        openSubagent,
        list: {
          getSnapshot: () => ({
            current: 'p-1',
            byId: {},
          }),
        },
      },
      get: vi.fn(),
    } as unknown as Context
    const store = { reduce: vi.fn() } as unknown as SidebarStore

    const dispose = registerSubagentToolJump(ctx, store)

    const toolEl = document.createElement('div')
    toolEl.setAttribute('data-tool', 'subagent_fixer')
    const chevron = document.createElement('span')
    chevron.className = 'toolChevron'
    toolEl.appendChild(chevron)
    document.body.appendChild(toolEl)

    chevron.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    )

    expect(openSubagent).not.toHaveBeenCalled()

    dispose()
  })

  it('clicking a read tool row opens the file in editor', async () => {
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({
            current: 'p-1',
            byId: {
              'p-1': { id: 'p-1', cwd: '/workspace', displayTitle: 'Parent' },
            },
          }),
        },
      },
      get: vi.fn(),
    } as unknown as Context
    const store = createSidebarStore()
    store.setSession('p-1')
    store.setPrefs({ ...store.getPrefs(), editOpensDiff: true })

    const dispose = registerSubagentToolJump(ctx, store)

    const toolEl = document.createElement('div')
    toolEl.setAttribute('data-tool', 'read')
    toolEl.setAttribute('data-variant', 'read')
    const titleSpan = document.createElement('span')
    titleSpan.className = 'toolTitle'
    titleSpan.textContent = '读取'
    const summarySpan = document.createElement('span')
    summarySpan.className = 'summary'
    summarySpan.textContent = 'src/test.ts'
    toolEl.appendChild(titleSpan)
    toolEl.appendChild(summarySpan)
    document.body.appendChild(toolEl)

    titleSpan.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    )

    await new Promise<void>(resolve => setTimeout(resolve, 0))

    const splits = store.getSnapshot().state!.splits as {
      tabs: Array<{ id: string; type: string; path?: string; diff?: unknown }>
    }
    const tab = splits.tabs.find(t => t.id === 'chat-preview')
    expect(tab).toBeDefined()
    expect(tab?.type).toBe('editor')
    expect(tab?.path).toBe('/workspace/src/test.ts')
    expect(tab?.diff).toBeUndefined()

    dispose()
  })
})
