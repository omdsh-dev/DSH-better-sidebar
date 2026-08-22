/**
 * The subfolder-scoped built-in tabs (`folder` / `repo-git`): they are
 * multi-instance per folder path, so opening several different folders of
 * the same type must create separate tabs (the id is path-derived, like the
 * editor's `editor:<path>`), while opening the SAME path again focuses the
 * existing one (per-path dedupe).
 */
import { describe, expect, it } from 'vitest'
import './browser-globals.ts'
import type { Context } from '../src/context-types.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore, type SidebarSnapshot } from '../src/client/state.ts'
import { allLeaves } from '../src/client/state.ts'
import { registerBuiltins } from '../src/client/builtins/index.ts'

function setup() {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  const dispose = registerBuiltins({} as Context, service, {})
  return { store, service, dispose }
}

function tabsOfType(state: NonNullable<SidebarSnapshot['state']>, type: string) {
  return allLeaves(state.splits).concat(allLeaves(state.bottomSplits)).flatMap(leaf => leaf.tabs).filter(t => t.type === type)
}

describe('folder / repo-git tabs (subfolder-scoped builtins)', () => {
  it('opening the SAME folder type in two different paths creates two tabs (path-derived ids)', () => {
    const { store, service } = setup()
    store.setSession('s1')
    service.openTab({ type: 'folder', id: 'folder:/ws/a', path: '/ws/a', title: 'a' })
    service.openTab({ type: 'folder', id: 'folder:/ws/b', path: '/ws/b', title: 'b' })
    const state = store.getSnapshot().state!
    expect(tabsOfType(state, 'folder').map(t => t.path).sort()).toEqual(['/ws/a', '/ws/b'])
  })

  it('opening the SAME folder path again focuses the existing tab (per-path dedupe)', () => {
    const { store, service } = setup()
    store.setSession('s1')
    service.openTab({ type: 'repo-git', id: 'repo-git:/ws/my-repo', path: '/ws/my-repo', title: 'my-repo' })
    service.openTab({ type: 'repo-git', id: 'repo-git:/ws/my-repo', path: '/ws/my-repo', title: 'my-repo' })
    const state = store.getSnapshot().state!
    expect(tabsOfType(state, 'repo-git')).toHaveLength(1)
    expect(tabsOfType(state, 'repo-git')[0]?.path).toBe('/ws/my-repo')
  })

  it('a repo-git tab carries the folder path (the git cwd seed)', () => {
    const { store, service } = setup()
    store.setSession('s1')
    service.openTab({ type: 'repo-git', id: 'repo-git:/ws/my-repo', path: '/ws/my-repo', title: 'my-repo' })
    const state = store.getSnapshot().state!
    const tab = tabsOfType(state, 'repo-git')[0]
    expect(tab?.path).toBe('/ws/my-repo')
    expect(tab?.id).toBe('repo-git:/ws/my-repo')
  })
})
