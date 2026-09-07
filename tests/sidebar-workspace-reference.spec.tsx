// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Sidebar } from '../src/client/Sidebar.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mount(cwd: string, options: { root?: string; phase?: 'pending' | 'ready'; state?: 'idle' | 'loading' | 'error'; chip?: boolean; workspaceService?: boolean } = {}) {
  vi.stubGlobal('WebSocket', class { close() {} })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = createSidebarStore()
  store.setSession('s1')
  const service = createBetterSidebarService(store)
  const sessions = { current: 's1', byId: { s1: { id: 's1', cwd } } }
  const locale = { active: 'en' }
  let draft = 'before'
  let draftRev = 1
  const setDraft = vi.fn((text: string) => { draft = text; draftRev++ })
  const emit = vi.fn((_event: string, _payload: unknown) => {
    if (options.chip) draftRev++
  })
  const input = { state: { getSnapshot: () => ({ draft, draftRev }) }, setDraft }
  const workspaces = { list: { getSnapshot: () => ({
    phase: options.phase ?? 'ready',
    state: options.state ?? 'idle',
    items: [
      { path: '/decoy', sessionIds: ['other'] },
      ...(options.root === undefined ? [] : [{ path: options.root, sessionIds: ['s1'] }]),
    ],
  }) } }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => locale },
    sessions: {
      list: { subscribe: () => () => {}, getSnapshot: () => sessions },
      scope: () => ({ emit }),
    },
    get: (name: string) => ({
      betterSidebar: service,
      conversation: { input: { for: () => input } },
      workspaces: options.workspaceService === false ? undefined : workspaces,
    })[name],
  }
  let reference: ((path: string, isDir: boolean) => void) | undefined
  service.registerTab({ id: 'reference-test', title: 'Reference', component: props => {
    reference = props.onReferenceFile
    return null
  } })
  service.openTab({ type: 'reference-test', title: 'Reference' })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx: ctx as never, store })) })
  expect(reference).toBeTypeOf('function')
  return {
    insert: (path: string, isDir: boolean) => { act(() => { reference!(path, isDir) }) },
    draft: () => draft, emit, setDraft, warn,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

describe('Sidebar workspace references', () => {
  it.each(['/work', '/work/src'])('uses workspace membership with session cwd %s', cwd => {
    const view = mount(cwd, { root: '/work' })
    try {
      view.insert('/work/my dir', true)
      expect(view.draft()).toBe('before @"my dir/" ')
      expect(view.emit).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('uses workspace-relative file chips outside the session cwd', () => {
    const view = mount('/work/src', { root: '/work', chip: true })
    try {
      view.insert('/work/docs/my notes.md', false)
      expect(view.emit).toHaveBeenCalledWith('slash/input-insert-reference', {
        reference: { source: 'reference', ref: '@"docs/my notes.md"', label: 'my notes.md', appearance: 'file', clipboardText: '@"docs/my notes.md"' },
        span: { draftRev: 1, start: 6, end: 6 },
      })
      expect(view.setDraft).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it.each(['src', 'my dir', 'docs/my dir'])('separates a directory %s from the next file chip', directory => {
    const view = mount('/work', { root: '/work', chip: true })
    try {
      view.insert(`/work/${directory}`, true)
      const beforeFile = view.draft()
      expect(beforeFile).toMatch(/\s$/)
      view.insert('/work/notes.md', false)
      expect(view.emit).toHaveBeenCalledWith('slash/input-insert-reference', {
        reference: { source: 'reference', ref: '@notes.md', label: 'notes.md', appearance: 'file', clipboardText: '@notes.md' },
        span: { draftRev: 2, start: beforeFile.length, end: beforeFile.length },
      })
      expect(view.setDraft).toHaveBeenCalledTimes(1)
    } finally { view.unmount() }
  })

  it('keeps quoted file text when the chip event is not handled', () => {
    const view = mount('/work', { root: '/work' })
    try {
      view.insert('/work/my notes.md', false)
      expect(view.draft()).toBe('before @"my notes.md"')
    } finally { view.unmount() }
  })

  it('normalizes Windows drive casing and mixed separators', () => {
    const view = mount('C:\\Work\\src', { root: 'C:\\Work\\' })
    try {
      view.insert('c:/WORK/my dir\\nested', true)
      expect(view.draft()).toBe('before @"my dir/nested/" ')
      view.insert('c:/work', true)
      expect(view.draft()).toBe('before @"my dir/nested/" @./ ')
    } finally { view.unmount() }
  })

  it.each([
    { root: undefined },
    { root: '/work', workspaceService: false },
    { root: '/work', phase: 'pending' as const },
    { root: '/work', state: 'loading' as const },
    { root: '/work', state: 'error' as const },
  ])('leaves the draft intact and logs when workspace data is unavailable: %j', options => {
    const view = mount('/work/src', options)
    try {
      view.insert('/work/src/a.ts', false)
      expect(view.draft()).toBe('before')
      expect(view.emit).not.toHaveBeenCalled()
      expect(view.warn).toHaveBeenCalled()
      // Resolve the host snapshot later: the next click must see fresh data.
      Object.assign(options, { root: '/work', phase: 'ready', state: 'idle', workspaceService: true })
      view.insert('/work/src', true)
      expect(view.draft()).toBe('before @src/ ')
    } finally { view.unmount() }
  })

  it.each(['/outside/file.ts', '/work/a"b', '/work/a\nb'])('never inserts an unsafe path %j as a file or directory', path => {
    const view = mount('/work', { root: '/work' })
    try {
      view.insert(path, false)
      view.insert(path, true)
      expect(view.draft()).toBe('before')
      expect(view.emit).not.toHaveBeenCalled()
      expect(view.warn).toHaveBeenCalled()
    } finally { view.unmount() }
  })
})
