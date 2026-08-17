/**
 * The chat-mention interception registration: wraps the DSH `chatFileMentions`
 * service so inline-code path / path:line references resolve into mentions
 * ONLY when the file is verified to exist (workspace index scan + probe
 * fallback); mentions route their opens through the owner's openFile (the
 * chat file-open funnel); the side-card toggle gates the extra resolution;
 * disposal restores the original service method (HMR-safe).
 */
import { describe, expect, it, vi } from 'vitest'
import './browser-globals.ts'
import { registerChatMentionInterception } from '../src/client/intercept.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { ChatFileMentionsService } from '../src/client/chat-mentions.ts'
import type { Context } from '../src/context-types.ts'

/** A DSH-shaped chatFileMentions service resolving only "produced" paths. */
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
 *  the sessions feed (current session + cwd + subscribe). */
function ctxWith(service: unknown): Context {
  return {
    get: (name: string) => name === 'chatFileMentions' ? service : undefined,
    sessions: {
      list: {
        getSnapshot: () => ({ current: 's1', byId: { s1: { cwd: '/w' } } }),
        subscribe: () => () => {},
      },
    },
    betterSidebar: undefined,
  } as unknown as Context
}

/** A probe seam answering only the listed absolute paths. */
function probeFor(existing: string[]) {
  return vi.fn(async (_scope: unknown, absolute: string) => existing.includes(absolute))
}

/** Flush microtasks so an in-flight probe settles. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('registerChatMentionInterception', () => {
  it('wraps the service; a verified path:line mention routes through owner.openFile', async () => {
    const { service, original } = fakeService()
    const opened: string[] = []
    const probe = probeFor(['/w/src/foo.ts'])
    const store = createSidebarStore()
    const restore = registerChatMentionInterception(ctxWith(service), store, probe)
    expect(service.forClosing).not.toBe(original)

    const base = service.forClosing({ produced: ['src/produced.ts'], openFile: (p: string) => opened.push(p) })
    expect(base).toBeDefined()
    // A produced path keeps DSH resolution (always a mention).
    expect(base?.resolve('src/produced.ts')?.label).toBe('produced')
    // A path:line reference resolves only after the probe confirms the file.
    expect(base?.resolve('src/foo.ts:42')).toBeUndefined()
    await flush()
    expect(probe).toHaveBeenCalledWith(expect.anything(), '/w/src/foo.ts')
    expect(base?.resolve('src/foo.ts:42')?.title).toBe('src/foo.ts:42')
    base?.resolve('src/foo.ts:42')?.open()
    base?.resolve('src/foo.ts:10-20')?.open()
    base?.resolve('src/main.ts')?.open()  // unverified → no mention
    expect(opened).toEqual(['src/foo.ts:42', 'src/foo.ts:10-20'])
    restore()
  })

  it('a non-existent path never becomes a mention (plain code stays plain)', async () => {
    const { service } = fakeService()
    const probe = probeFor(['/w/src/real.ts'])
    const store = createSidebarStore()
    const restore = registerChatMentionInterception(ctxWith(service), store, probe)
    const base = service.forClosing({ openFile: () => {} })
    expect(base?.resolve('src/ghost.ts:42')).toBeUndefined()
    expect(base?.resolve('src/ghost.ts')).toBeUndefined()
    await flush()
    // Even after the probe answered "missing", no mention ever appears.
    expect(base?.resolve('src/ghost.ts:42')).toBeUndefined()
    restore()
  })

  it('gates the extra resolution on the side-card toggle (produced stays)', () => {
    const { service } = fakeService()
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), pluginSettings: { editor: { chatPathLinks: false } } })
    const restore = registerChatMentionInterception(ctxWith(service), store, probeFor(['/w/src/foo.ts']))

    const base = service.forClosing({ produced: ['src/produced.ts'], openFile: () => {} })
    expect(base?.resolve('src/foo.ts:42')).toBeUndefined()
    expect(base?.resolve('src/main.ts')).toBeUndefined()
    expect(base?.resolve('src/produced.ts')?.label).toBe('produced')
    restore()
  })

  it('falls back to a direct sidebar open when the owner has no openFile (verified path)', async () => {
    const { service } = fakeService()
    const store = createSidebarStore()
    const restore = registerChatMentionInterception(ctxWith(service), store, probeFor(['/w/src/foo.ts']))
    const base = service.forClosing({ produced: [] })
    expect(base?.resolve('src/foo.ts:42')).toBeUndefined()
    await flush()
    const mention = base?.resolve('src/foo.ts:42')
    expect(mention).toBeDefined()
    // No openFile on the owner → the fallback needs ctx.betterSidebar; in
    // this fake it is undefined, so nothing is routed — and nothing throws.
    mention?.open()
    restore()
  })

  it('disposal restores the original service method', () => {
    const { service, original } = fakeService()
    const store = createSidebarStore()
    const restore = registerChatMentionInterception(ctxWith(service), store)
    restore()
    expect(service.forClosing).toBe(original)
  })
})
