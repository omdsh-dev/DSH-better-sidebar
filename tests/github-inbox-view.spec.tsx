/**
 * GitHub inbox view render smoke (jsdom): the mounted card renders the
 * unconfigured guide and the thread list from the shared store, the filter
 * chips write the same prefs keys the settings popup binds, and expanding
 * a thread renders its comment body. Locale falls back to the browser
 * language (en) — assertions use the English copy.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitHubInboxView } from '../src/client/GitHubInboxView.tsx'
import { createGithubInboxStore, type GithubInboxStore } from '../src/client/github-inbox.ts'
import { createSidebarStore, type SidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import type { Context } from '../src/context-types.ts'
import type { GithubStateResult, GithubThread } from '../src/github-shared.ts'

/** One client-visible thread (shared fixture for the seeded snapshots). */
function mappedThread(id: string, reason: string, type: string, repo = 'o/r'): GithubThread {
  return {
    id,
    unread: true,
    reason,
    repo,
    title: 'PR title needs review',
    url: `https://api.example.test/repos/${repo}/pulls/1`,
    htmlUrl: `https://github.com/${repo}/pull/1`,
    type,
    updatedAt: '2024-01-01T00:00:00Z',
  }
}

const thread: GithubThread = mappedThread('t1', 'review_requested', 'PullRequest')

/** A store whose api face always answers with the given snapshot. */
function seededStore(snapshot: GithubStateResult): { store: GithubInboxStore; sidebarStore: SidebarStore } {
  const sidebarStore = createSidebarStore()
  const service = createBetterSidebarService(sidebarStore)
  const store = createGithubInboxStore({ githubState: vi.fn().mockResolvedValue(snapshot) }, service)
  return { store, sidebarStore }
}

function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(node) })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GithubInboxStore poll/mutation interplay', () => {
  it('discards a poll that started before a local mutation (no resurrected threads)', async () => {
    const sidebarStore = createSidebarStore()
    const service = createBetterSidebarService(sidebarStore)
    const oneThread: GithubStateResult = {
      configured: true,
      ghAvailable: true,
      allowMerge: false,
      threads: [mappedThread('t1', 'review_requested', 'PullRequest')],
      pollIntervalSec: 60,
    }
    const resolvers: ((value: GithubStateResult) => void)[] = []
    const apiState = vi.fn(() => new Promise<GithubStateResult>(resolve => { resolvers.push(resolve) }))
    const store = createGithubInboxStore({ githubState: apiState }, service)
    // Seed the store with one thread (resolve AFTER starting the refresh —
    // the refresh promise awaits the fetch).
    const first = store.refresh()
    resolvers.shift()?.(oneThread)
    await first
    // Start a second refresh (in flight), then remove the thread locally.
    const second = store.refresh()
    store.removeLocal('t1')
    // The stale in-flight result (still carrying t1) must be discarded.
    resolvers.shift()?.(oneThread)
    await second
    expect(store.getState().snapshot?.threads).toEqual([])
    store.dispose()
  })
})

describe('GithubInboxStore badge bridge', () => {
  it('bumps open GitHub tabs through updateTab when the badge value changes', async () => {
    const sidebarStore = createSidebarStore()
    const service = createBetterSidebarService(sidebarStore)
    // Register a minimal github descriptor + open one instance, so the
    // store's bump loop has a real tab id to patch.
    service.registerTab({ id: 'github', title: 'GitHub', single: true, component: () => null })
    sidebarStore.setSession('s1')
    service.openTab({ type: 'github' })
    const updateSpy = vi.spyOn(service, 'updateTab')
    const snapshotOf = (count: number): GithubStateResult => ({
      configured: true,
      ghAvailable: true,
      allowMerge: false,
      threads: Array.from({ length: count }, (_, index) => ({
        ...mappedThread(String(index + 1), 'review_requested', 'PullRequest'),
      })),
      pollIntervalSec: 60,
    })
    const store = createGithubInboxStore({ githubState: vi.fn().mockResolvedValue(snapshotOf(1)) }, service)
    await store.refresh()
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledWith(expect.any(String), { meta: 1 })
    // A poll settle with the SAME badge value must not bump the strip again.
    await store.refresh()
    expect(updateSpy).toHaveBeenCalledTimes(1)
    // A changed unread count bumps again.
    const store2 = createGithubInboxStore({ githubState: vi.fn().mockResolvedValue(snapshotOf(2)) }, service)
    await store2.refresh()
    expect(updateSpy).toHaveBeenCalledTimes(2)
    expect(updateSpy).toHaveBeenLastCalledWith(expect.any(String), { meta: 2 })
    store.dispose()
    store2.dispose()
  })
})

describe('GitHubInboxView detail race and comment gating', () => {
  it('ignores a stale detail fetch that settles after switching threads', async () => {
    const configured: GithubStateResult = {
      configured: true,
      ghAvailable: true,
      allowMerge: true,
      threads: [mappedThread('t1', 'review_requested', 'PullRequest'), mappedThread('t2', 'mention', 'PullRequest')],
      pollIntervalSec: 60,
    }
    const sidebarStore = createSidebarStore()
    const service = createBetterSidebarService(sidebarStore)
    const store = createGithubInboxStore({ githubState: vi.fn().mockResolvedValue(configured) }, service)
    await store.refresh()
    const pending: ((value: Response) => void)[] = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { pending.push(resolve) })))
    const mounted = mount(createElement(GitHubInboxView, {
      githubStore: store, sidebarStore, ctx: {} as Context, scope: { sessionId: 's1' },
    }))
    const rows = [...mounted.container.querySelectorAll('button')].filter(button => button.textContent?.includes('PR title needs review'))
    expect(rows).toHaveLength(2)
    // Expand t1, then t2; both detail fetches are pending.
    await act(async () => { rows[0]!.click() })
    await act(async () => { rows[1]!.click() })
    expect(pending).toHaveLength(2)
    // t2's fetch settles first with ITS body; then t1's stale settle arrives.
    await act(async () => {
      pending[1]!(new Response(JSON.stringify({ ok: true, value: { thread: configured.threads[1], commentBody: 'body of t2' } }), { status: 200 }))
    })
    await act(async () => {
      pending[0]!(new Response(JSON.stringify({ ok: true, value: { thread: configured.threads[0], commentBody: 'body of t1 (stale)' } }), { status: 200 }))
    })
    expect(mounted.container.textContent).toContain('body of t2')
    expect(mounted.container.textContent).not.toContain('body of t1')
    mounted.unmount()
    store.dispose()
  })

  it('hides the comment box on threads without an issue/PR number', async () => {
    const commitThread: GithubThread = {
      ...mappedThread('c1', 'subscribed', 'Commit', 'o/r'),
      url: 'https://api.example.test/repos/o/r/commits/abc123',
      htmlUrl: '',
    }
    const configured: GithubStateResult = {
      configured: true,
      ghAvailable: true,
      allowMerge: false,
      threads: [commitThread],
      pollIntervalSec: 60,
    }
    const sidebarStore = createSidebarStore()
    const service = createBetterSidebarService(sidebarStore)
    const store = createGithubInboxStore({ githubState: vi.fn().mockResolvedValue(configured) }, service)
    await store.refresh()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, value: { thread: commitThread } }), { status: 200 })))
    const mounted = mount(createElement(GitHubInboxView, {
      githubStore: store, sidebarStore, ctx: {} as Context, scope: { sessionId: 's1' },
    }))
    const row = [...mounted.container.querySelectorAll('button')].find(button => button.textContent?.includes('PR title needs review'))
    await act(async () => { row!.click() })
    await act(async () => {})
    expect(mounted.container.textContent).not.toContain('Write a comment')
    expect(mounted.container.textContent).not.toContain('Send')
    mounted.unmount()
    store.dispose()
  })
})

describe('GitHubInboxView render smoke', () => {
  it('renders the setup guide while unconfigured (gh available variant)', async () => {
    const unconfigured: GithubStateResult = { configured: false, ghAvailable: true, allowMerge: false, threads: [], pollIntervalSec: 60 }
    const { store, sidebarStore } = seededStore(unconfigured)
    await store.refresh()
    const mounted = mount(createElement(GitHubInboxView, {
      githubStore: store, sidebarStore, ctx: {} as Context, scope: { sessionId: 's1' },
    }))
    expect(mounted.container.textContent).toContain('GitHub is not configured')
    expect(mounted.container.textContent).toContain('gh auth login')
    mounted.unmount()
    store.dispose()
  })

  it('renders the thread list, toggles a filter chip through the shared prefs, and expands a thread', async () => {
    const configured: GithubStateResult = {
      configured: true,
      ghAvailable: true,
      allowMerge: true,
      threads: [thread],
      fetchedAt: '2024-01-01T00:00:00Z',
      pollIntervalSec: 60,
    }
    const { store, sidebarStore } = seededStore(configured)
    await store.refresh()
    const setPrefsSpy = vi.spyOn(sidebarStore, 'setPrefs')
    // Route the view's own api calls (settings patch + thread detail) through
    // a stubbed fetch — jsdom has no backend behind /sidebar/api.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('github.thread')) {
        return new Response(JSON.stringify({ ok: true, value: { thread, commentBody: '# hello from comment' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, value: { value: {}, revision: 0 } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const ctx = { betterSidebar: { openTab: vi.fn() } } as unknown as Context
    const mounted = mount(createElement(GitHubInboxView, {
      githubStore: store, sidebarStore, ctx, scope: { sessionId: 's1' },
    }))
    expect(mounted.container.textContent).toContain('GitHub Inbox')
    expect(mounted.container.textContent).toContain('1 unread')
    expect(mounted.container.textContent).toContain('PR title needs review')
    // Toggle the CI chip (default off → on) through the shared prefs keys.
    const buttons = [...mounted.container.querySelectorAll('button')]
    const ciChip = buttons.find(button => button.textContent === 'CI status')
    expect(ciChip).toBeDefined()
    act(() => { ciChip!.click() })
    expect(setPrefsSpy).toHaveBeenCalledWith(expect.objectContaining({ githubShowCi: true }))
    // Expanding the row fetches the thread detail (stubbed at fetch level).
    const row = buttons.find(button => button.textContent?.includes('PR title needs review'))
    expect(row).toBeDefined()
    await act(async () => { row!.click() })
    await act(async () => {})
    expect(mounted.container.textContent).toContain('hello from comment')
    expect(mounted.container.textContent).toContain('Approve')
    expect(mounted.container.textContent).toContain('Merge')
    mounted.unmount()
    store.dispose()
  })
})
