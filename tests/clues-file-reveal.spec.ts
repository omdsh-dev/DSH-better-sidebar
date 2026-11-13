/** User file reveal resolves stable locator workspace identity, never current cwd, and refuses a different live tree root. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import type { ClueCandidate } from '../src/clues/types.ts'
import { BUILTIN_SOURCE_IDS } from '../src/clues/types.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { api } from '../src/client/api.ts'
import { fileRevealPathOf, revealClueFile } from '../src/client/clues/file-reveal.ts'
import { createNativeTabRecords } from '../src/client/native/tab-adapter.tsx'

const candidate = (path = 'src/nested/note.md', dialect = 'posix'): ClueCandidate => ({
  sourceId: BUILTIN_SOURCE_IDS.files, typeId: 'builtin.files.markdown', title: 'Note',
  locator: { root: { kind: 'workspace', workspaceId: 'target' }, path, dialect },
})
afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

function fixture(current = 's-current') {
  const store = createSidebarStore()
  store.setSession(current)
  const openTab = vi.fn(() => 'native-files')
  const isTabEnabled = () => true
  const byId = { 's-current': {}, 's-target': {}, 's-archived': {} }
  const ctx = {
    get: (name: string) => name === 'workspaces' ? { list: { getSnapshot: () => ({
      phase: 'ready', state: 'idle', archivedSessionIds: ['s-archived'], items: [
        { workspaceId: 'current', path: '/wrong-current-root', sessionIds: ['s-current'] },
        { workspaceId: 'target', path: '/real-workspace', sessionIds: ['s-archived', 's-target'] },
      ],
    }) } } : name === 'sidebarRight' ? { mounted: { getSnapshot: () => store.getSnapshot().sessionId } } : undefined,
    sessions: { list: { getSnapshot: () => ({ byId }) } },
  } as unknown as Context
  return { ctx, store, service: { openTab, isTabEnabled }, openTab }
}

describe('workspace locator path projection', () => {
  it('normalizes relative components inside a POSIX workspace and rejects escape/foreign paths', () => {
    expect(fileRevealPathOf(candidate('src/../docs/a.md').locator, '/repo')).toBe('/repo/docs/a.md')
    expect(fileRevealPathOf(candidate('../outside.md').locator, '/repo')).toBeUndefined()
    expect(fileRevealPathOf(candidate('/absolute.md').locator, '/repo')).toBeUndefined()
    expect(fileRevealPathOf(candidate('a.md', 'win32').locator, '/repo')).toBeUndefined()
    expect(fileRevealPathOf(candidate('C:other.md', 'win32').locator, 'C:\\repo')).toBeUndefined()
    expect(fileRevealPathOf(candidate('').locator, '/repo')).toBeUndefined()
  })
  it('uses the locator Windows dialect independently of the test host OS', () => {
    expect(fileRevealPathOf(candidate('src/nested\\note.md', 'win32').locator, 'C:\\repo')).toBe('C:\\repo\\src\\nested\\note.md')
    expect(fileRevealPathOf(candidate('a.md', 'win32').locator, '\\\\server\\share\\repo')).toBe('\\\\server\\share\\repo\\a.md')
    expect(fileRevealPathOf(candidate('..\\escape.md', 'win32').locator, 'C:\\repo')).toBeUndefined()
  })
})

it('updates the owning background session and opens pathless files without navigating or guessing current cwd', async () => {
  const fx = fixture()
  const sessionCwd = vi.spyOn(api, 'sessionCwd').mockImplementation(async scope => ({ sessionId: scope.sessionId, cwd: '/real-workspace', root: '/real-workspace', parent: null }))
  const result = await revealClueFile({ ...fx, candidate: candidate(), sessionId: 's-current' })
  expect(result).toEqual({ status: 'queued', sessionId: 's-target' })
  expect(sessionCwd).toHaveBeenCalledExactlyOnceWith({ sessionId: 's-target' })
  expect(fx.openTab).toHaveBeenCalledExactlyOnceWith({ type: 'editor' }, { sessionId: 's-target', cwd: '/real-workspace' })
  expect(fx.store.getSnapshot().sessionId).toBe('s-current')
  expect(fx.store.getSessionState('s-current')!.revealed).toEqual([])
  expect(fx.store.getSessionState('s-target')).toMatchObject({
    expanded: ['/real-workspace/src', '/real-workspace/src/nested'],
    revealed: ['/real-workspace/src/nested/note.md'],
  })
})

it('prefers the current member session and not another workspace member', async () => {
  const fx = fixture('s-target')
  vi.spyOn(api, 'sessionCwd').mockImplementation(async scope => ({ sessionId: scope.sessionId, cwd: '/real-workspace', root: '/real-workspace', parent: null }))
  expect(await revealClueFile({ ...fx, candidate: candidate(), sessionId: 's-target' })).toEqual({ status: 'revealed', sessionId: 's-target' })
  expect(fx.store.getSnapshot().state!.revealed).toEqual(['/real-workspace/src/nested/note.md'])
})

it('refuses external/unknown workspaces and a different effective linked-worktree root without mutating state or opening', async () => {
  const fx = fixture()
  const sessionCwd = vi.spyOn(api, 'sessionCwd').mockImplementation(async scope => ({ sessionId: scope.sessionId, cwd: '/linked-worktree', root: '/real-workspace', parent: null }))
  expect(await revealClueFile({ ...fx, candidate: candidate(), sessionId: 's-current' })).toMatchObject({ status: 'unavailable', reason: 'tree-root-mismatch' })
  const external = { ...candidate(), locator: { root: { kind: 'external' }, path: '/real-workspace/a.md', dialect: 'posix' } }
  expect(await revealClueFile({ ...fx, candidate: external, sessionId: 's-current' })).toMatchObject({ status: 'unavailable' })
  const unknown = { ...candidate(), locator: { ...candidate().locator, root: { kind: 'workspace', workspaceId: 'unknown' } } }
  expect(await revealClueFile({ ...fx, candidate: unknown, sessionId: 's-current' })).toMatchObject({ status: 'unavailable' })
  expect(sessionCwd).toHaveBeenCalledTimes(1)
  expect(fx.openTab).not.toHaveBeenCalled()
  expect(fx.store.getSessionState('s-target')).toBeUndefined()
})

it('projects revealed state into both new and already-mounted native records, including silent background updates', async () => {
  const fx = fixture('s-target')
  const records = createNativeTabRecords()
  records.attachStore(fx.store)
  const input = { sessionId: 's-target', id: 'native1', kind: 'editor', title: 'Files', params: undefined, scope: { sessionId: 's-target', cwd: '/real-workspace' } }
  const first = records.ensure(input)
  expect(first.revealed).toEqual([])
  vi.spyOn(api, 'sessionCwd').mockImplementation(async scope => ({ sessionId: scope.sessionId, cwd: '/real-workspace', root: '/real-workspace', parent: null }))
  await revealClueFile({ ...fx, candidate: candidate(), sessionId: 's-target' })
  expect(records.get('s-target', 'native1')!.revealed).toEqual(['/real-workspace/src/nested/note.md'])
  expect(records.ensure({ ...input, id: 'new-native' }).revealed).toEqual(['/real-workspace/src/nested/note.md'])
  const previousVersion = records.versionOf('s-target', 'native1')
  const expanded = fx.store.getSnapshot().state!.expanded
  fx.store.reduce(state => ({ ...state, revealed: ['/real-workspace/src/second.md'] }))
  expect(fx.store.getSnapshot().state!.expanded).toBe(expanded)
  expect(records.get('s-target', 'native1')!.revealed).toEqual(['/real-workspace/src/second.md'])
  expect(records.versionOf('s-target', 'native1')).toBe(previousVersion + 1)
  const version = records.versionOf('s-target', 'native1')
  fx.store.reduce(state => ({ ...state }))
  expect(records.versionOf('s-target', 'native1')).toBe(version)
  fx.store.setSession('s-current')
  fx.store.reduceFor('s-target', state => ({ ...state, revealed: ['/real-workspace/docs/next.md'] }))
  expect(records.ensure(input).revealed).toEqual(['/real-workspace/docs/next.md'])
})


it('refuses a request when the conversation changes while the live root read is in flight', async () => {
  const fx = fixture()
  let resolve!: (value: { sessionId: string; cwd: string; root: string; parent: null }) => void
  vi.spyOn(api, 'sessionCwd').mockImplementation(() => new Promise(done => { resolve = done }))
  const pending = revealClueFile({ ...fx, candidate: candidate(), sessionId: 's-current' })
  fx.store.setSession('different')
  resolve({ sessionId: 's-target', cwd: '/real-workspace', root: '/real-workspace', parent: null })
  expect(await pending).toMatchObject({ status: 'unavailable', reason: 'changed' })
  expect(fx.openTab).not.toHaveBeenCalled()
  expect(fx.store.getSessionState('s-target')).toBeUndefined()
})

it('rejects ambiguous workspaces and workspaces whose only member is archived', async () => {
  const fx = fixture()
  const sessionCwd = vi.spyOn(api, 'sessionCwd')
  const get = fx.ctx.get.bind(fx.ctx)
  for (const items of [
    [{ workspaceId: 'target', path: '/one', sessionIds: ['s-target'] }, { workspaceId: 'target', path: '/two', sessionIds: ['s-target'] }],
    [{ workspaceId: 'target', path: '/real-workspace', sessionIds: ['s-archived'] }],
  ]) {
    const ctx = { ...fx.ctx, get: (name: string) => name === 'workspaces' ? { list: { getSnapshot: () => ({
      phase: 'ready', state: 'idle', items, archivedSessionIds: ['s-archived'],
    }) } } : get(name) } as unknown as Context
    expect(await revealClueFile({ ...fx, ctx, candidate: candidate(), sessionId: 's-current' })).toMatchObject({ status: 'unavailable' })
  }
  expect(sessionCwd).not.toHaveBeenCalled()
  expect(fx.openTab).not.toHaveBeenCalled()
})

it('projects a Windows file using the effective tree root spelling, including case', async () => {
  const fx = fixture('s-target')
  const get = fx.ctx.get.bind(fx.ctx)
  const ctx = { ...fx.ctx, get: (name: string) => name === 'workspaces' ? { list: { getSnapshot: () => ({
    phase: 'ready', state: 'idle', archivedSessionIds: [], items: [{ workspaceId: 'target', path: 'C:\\Repo', sessionIds: ['s-target'] }],
  }) } } : get(name) } as unknown as Context
  vi.spyOn(api, 'sessionCwd').mockResolvedValue({ sessionId: 's-target', cwd: 'c:\\repo', root: 'c:\\repo', parent: null })
  expect(await revealClueFile({ ...fx, ctx, candidate: candidate('docs/a.md', 'win32'), sessionId: 's-target' })).toMatchObject({ status: 'revealed' })
  expect(fx.store.getSessionState('s-target')!.revealed).toEqual(['c:\\repo\\docs\\a.md'])
})


it('refuses an empty originating session instead of silently selecting a workspace member', async () => {
  const fx = fixture()
  const cwd = vi.spyOn(api, 'sessionCwd')
  expect(await revealClueFile({ ...fx, candidate: candidate(), sessionId: '' })).toEqual({ status: 'unavailable', reason: 'session' })
  expect(cwd).not.toHaveBeenCalled()
  expect(fx.openTab).not.toHaveBeenCalled()
})
