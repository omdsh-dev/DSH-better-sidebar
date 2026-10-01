// @vitest-environment jsdom
/**
 * The prose-mention wiring (mention-open.ts) after upstream 0.21.1 deleted
 * intercept.tsx: a filename a turn's tool calls named opens in the sidebar
 * editor of the MAIN-view session, and switching the editor type off hands
 * the mention back to upstream's answer.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/client/api.ts', () => ({
  api: { fsTree: vi.fn(async () => ({ entries: [] })) },
}))

import type { Context } from '../src/context-types.ts'
import { registerMentionInterception } from '../src/client/mention-open.ts'
import { MENTION_SCOPE_KEY } from '../src/client/mention-scope.ts'
import type { ChatFileMentionsService } from '../src/client/mention-intercept.ts'
import { createSidebarStore } from '../src/client/state.ts'

function setup() {
  const opens: unknown[] = []
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({ byId: { s1: { id: 's1', cwd: '/site', displayTitle: 'x', retainedBy: { mainView: 1 } } } }),
      },
    },
    get: (name: string) => (name === 'betterSidebar' ? { openTab: (seed: unknown) => { opens.push(seed) } } : undefined),
  } as unknown as Context
  const store = createSidebarStore()
  const service: ChatFileMentionsService = { forClosing: () => undefined }
  const owner = { turn: { data: { get: (key: string) => (key === MENTION_SCOPE_KEY ? { paths: ['/site/wp-config.php'] } : undefined) } } }
  return { ctx, store, service, owner, opens }
}

describe('prose mention wiring', () => {
  it('opens a tool-named file in the editor of the main-view session', () => {
    const { ctx, store, service, owner, opens } = setup()
    const dispose = registerMentionInterception(ctx, store, service)
    const target = service.forClosing(owner)?.resolve('wp-config.php')
    expect(target).toBeDefined()
    target?.open()
    expect(opens).toEqual([{ type: 'editor', title: 'wp-config.php', path: '/site/wp-config.php', id: 'editor:/site/wp-config.php' }])
    dispose()
    expect(service.forClosing(owner)).toBeUndefined()
  })

  it('leaves upstream\'s answer alone while the editor type is switched off', () => {
    const { ctx, store, service, owner } = setup()
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { editor: false } })
    const dispose = registerMentionInterception(ctx, store, service)
    expect(service.forClosing(owner)).toBeUndefined()
    dispose()
  })
})
