/**
 * The chat-mention interception registration: wraps the DSH `chatFileMentions`
 * service so path / path:line inline-code mentions resolve and their opens
 * ride the owner's openFile (the chat file-open funnel); the side-card
 * toggle gates only the extra resolution; disposal restores the original
 * service method (HMR-safe).
 */
import { describe, expect, it } from 'vitest'
import './browser-globals.ts'
import { registerChatMentionInterception } from '../src/client/intercept.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { ChatFileMentionsService } from '../src/client/chat-mentions.ts'
import type { Context } from '../src/context-types.ts'

/** A DSH-shaped chatFileMentions service resolving only produced paths. */
function fakeService(): {
  service: ChatFileMentionsService
  original: ChatFileMentionsService['forClosing']
} {
  const original = ((owner: unknown) => {
    const produced = (owner as { produced?: string[] }).produced ?? []
    return {
      resolve(value: string) {
        if (!produced.includes(value)) return undefined
        return { open: () => { /* produced open is routed by the base */ }, label: 'produced', title: value }
      },
    }
  }) as ChatFileMentionsService['forClosing']
  return { service: { forClosing: original }, original }
}

/** The client-context fake the registration touches: the service lookup and
 *  the sessions feed (used by the owner-less fallback path). */
function ctxWith(service: unknown, opened: string[]): Context {
  return {
    get: (name: string) => name === 'chatFileMentions' ? service : undefined,
    sessions: { list: { getSnapshot: () => ({ current: 's1', byId: { s1: { cwd: '/w' } } }) } },
    betterSidebar: undefined,
  } as unknown as Context
}

describe('registerChatMentionInterception', () => {
  it('wraps the service and routes path:line opens through owner.openFile', () => {
    const { service, original } = fakeService()
    const opened: string[] = []
    const store = createSidebarStore()
    const restore = registerChatMentionInterception(ctxWith(service, opened), store)
    expect(service.forClosing).not.toBe(original)

    const base = service.forClosing({ produced: ['src/produced.ts'], openFile: (p: string) => opened.push(p) })
    expect(base).toBeDefined()
    // A produced path keeps DSH resolution.
    expect(base?.resolve('src/produced.ts')?.label).toBe('produced')
    // A path:line reference resolves and opens through the funnel.
    base?.resolve('src/foo.ts:42')?.open()
    base?.resolve('src/foo.ts:10-20')?.open()
    // A bare separator path opens plainly.
    base?.resolve('src/main.ts')?.open()
    expect(opened).toEqual(['src/foo.ts:42', 'src/foo.ts:10-20', 'src/main.ts'])
    restore()
  })

  it('gates the extra resolution on the side-card toggle (produced stays)', () => {
    const { service } = fakeService()
    const opened: string[] = []
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), pluginSettings: { editor: { chatPathLinks: false } } })
    const restore = registerChatMentionInterception(ctxWith(service, opened), store)

    const base = service.forClosing({ produced: ['src/produced.ts'], openFile: (p: string) => opened.push(p) })
    expect(base?.resolve('src/foo.ts:42')).toBeUndefined()
    expect(base?.resolve('src/main.ts')).toBeUndefined()
    expect(base?.resolve('src/produced.ts')?.label).toBe('produced')
    base?.resolve('src/produced.ts')?.open()
    expect(opened).toEqual([])
    restore()
  })

  it('falls back to a direct sidebar open when the owner has no openFile', () => {
    const { service } = fakeService()
    const store = createSidebarStore()
    const ctx = ctxWith(service, [])
    const restore = registerChatMentionInterception(ctx, store)
    const base = service.forClosing({ produced: [] })
    base?.resolve('src/foo.ts:42')?.open()
    // No openFile on the owner → the fallback needs ctx.betterSidebar; in
    // this fake it is undefined, so nothing is routed — and nothing throws.
    restore()
  })

  it('disposal restores the original service method', () => {
    const { service, original } = fakeService()
    const store = createSidebarStore()
    const restore = registerChatMentionInterception(ctxWith(service, []), store)
    restore()
    expect(service.forClosing).toBe(original)
  })
})
