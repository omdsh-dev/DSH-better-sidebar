/** The mounted API registry and fixed route share one lifecycle; no actual conversation or provider calls. */
import { describe, expect, it, vi } from 'vitest'
import { installClueActions } from '../src/clues/install-actions.ts'
import { createCluesService } from '../src/clues/service.ts'
import type { ClueActionDelivery } from '../src/clues/actions.ts'
import type { Context, SidebarWebRoute } from '../src/context-types.ts'
import type { ClueRuntime } from '../src/clues/runtime/types.ts'

function fixture() {
  const disposers: Array<() => void> = [], routes: SidebarWebRoute[] = []
  const releaseRoute = vi.fn()
  const ctx = { profileContext: { home: '/fixture-profile' }, get: () => undefined,
    webServer: { port: 3080, register: (route: SidebarWebRoute) => { routes.push(route); return releaseRoute } },
    effect: (effect: () => () => void) => { disposers.push(effect()) },
  } as unknown as Context
  const clues = createCluesService(), deliver = vi.fn(async (_input: ClueActionDelivery) => ({ deliveryId: 'accepted-session' }))
  installClueActions(ctx, { clues, runtime: {} as ClueRuntime, deliver })
  return { clues, deliver, routes, releaseRoute, dispose: () => { for (const dispose of disposers.reverse()) dispose() } }
}
describe('mounted clue actions', () => {
  it('admits explicit read-only actions through the same service dispatcher and removes all APIs/routes on unload', async () => {
    const f = fixture()
    const payload = { workspaceId: 'w', sessionId: 's', resource: { clueId: 'c' }, action: 'explain', target: 'side', requestId: 'one', selection: 'Selected text' }
    expect(f.routes.map(route => route.path)).toEqual(['/sidebar/agent/clues/commit'])
    expect(await f.clues.invokeApi('clues.actions.start', payload, { caller: 'ui' })).toMatchObject({ action: 'explain', target: 'side', deliveryId: 'accepted-session' })
    expect(f.deliver.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's', target: 'side', requestId: 'one' })
    f.dispose()
    for (const name of ['clues.actions.start', 'clues.drafts.list', 'clues.drafts.discard']) expect(f.clues.hasApi(name)).toBe(false)
    expect(f.releaseRoute).toHaveBeenCalledOnce()
  })
  it('retains normal Agent read-only restrictions on starts, retained draft listing and discards', async () => {
    const f = fixture()
    for (const method of ['clues.actions.start', 'clues.drafts.list', 'clues.drafts.discard']) {
      await expect(f.clues.invokeApi(method, {}, { caller: 'agent' })).rejects.toMatchObject({ category: 'permission-denied' })
    }
    expect(f.deliver).not.toHaveBeenCalled()
    f.dispose()
  })
})
