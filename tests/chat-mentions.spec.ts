/**
 * The enhanced `chatFileMentions` resolution: produced-path mentions keep
 * DSH precedence, `path:line` / `path:start-end` references resolve only
 * for VERIFIED (existing) paths, and the side-card toggle gates the extra
 * resolution. The service wrap is HMR-safe (restores the original method,
 * never clobbering a later wrap).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  enhanceMentionResolver,
  wrapChatFileMentions,
  type ChatFileMentionsService,
  type ChatMentionDeps,
} from '../src/client/chat-mentions.ts'

/** A deps factory recording every routed open (path, with the line suffix). */
function deps(overrides: Partial<ChatMentionDeps> & { existing?: string[] } = {}): ChatMentionDeps & { opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    enabled: () => true,
    // Default: only paths pre-declared as existing are "verified".
    verified: (path: string) => (overrides.existing ?? []).includes(path),
    openPath: (path: string) => { opened.push(path) },
    label: (value, line) => line !== undefined ? `open ${line.path}:${line.start}` : `open ${value}`,
    ...overrides,
  }
}

describe('enhanceMentionResolver', () => {
  it('keeps the DSH produced-path resolution first (produced files always open)', () => {
    const d = deps()
    const base = { resolve: (value: string) => value === 'src/a.ts' ? {
      open: () => d.openPath('src/a.ts'), label: 'produced', title: 'src/a.ts',
    } : undefined }
    const resolver = enhanceMentionResolver(base, d).resolve
    const mention = resolver('src/a.ts')
    expect(mention?.label).toBe('produced')
    mention?.open()
    expect(d.opened).toEqual(['src/a.ts'])
  })

  it('resolves a verified path:line reference into a line-carrying open', () => {
    const d = deps({ existing: ['src/foo.ts'] })
    const resolver = enhanceMentionResolver(undefined, d).resolve
    const mention = resolver('src/foo.ts:42')
    expect(mention).toBeDefined()
    expect(mention?.title).toBe('src/foo.ts:42')
    mention?.open()
    // The suffix rides the chat file-open funnel; the interception splits it.
    expect(d.opened).toEqual(['src/foo.ts:42'])
  })

  it('resolves a verified start-end range and a line:col reference', () => {
    const d = deps({ existing: ['src/foo.ts'] })
    const resolver = enhanceMentionResolver(undefined, d).resolve
    resolver('src/foo.ts:42-56')?.open()
    resolver('src/foo.ts:42:13')?.open()
    expect(d.opened).toEqual(['src/foo.ts:42-56', 'src/foo.ts:42'])
  })

  it('resolves a verified bare separator-carrying path as a plain open', () => {
    const d = deps({ existing: ['src/main.ts'] })
    const resolver = enhanceMentionResolver(undefined, d).resolve
    const mention = resolver('src/main.ts')
    expect(mention).toBeDefined()
    mention?.open()
    expect(d.opened).toEqual(['src/main.ts'])
  })

  it('NEVER links an unverified path — a non-existent file stays plain code', () => {
    const d = deps({ existing: ['src/real.ts'] })
    const resolver = enhanceMentionResolver(undefined, d).resolve
    expect(resolver('src/ghost.ts:42')).toBeUndefined()
    expect(resolver('src/ghost.ts')).toBeUndefined()
    expect(resolver('src/real.ts:42')).toBeDefined()
    expect(d.opened).toEqual([])
  })

  it('rejects non-path inline code (no mention)', () => {
    const d = deps({ existing: ['src/main.ts'] })
    const resolver = enhanceMentionResolver(undefined, d).resolve
    expect(resolver('obj.method')).toBeUndefined()
    expect(resolver('npm install')).toBeUndefined()
    expect(resolver('host:8080')).toBeUndefined()
    expect(d.opened).toEqual([])
  })

  it('falls back to the base resolver alone when the feature is disabled', () => {
    const d = deps({ enabled: () => false, existing: ['src/foo.ts'] })
    const baseResolve = vi.fn(() => undefined)
    const resolver = enhanceMentionResolver({ resolve: baseResolve }, d).resolve
    expect(resolver('src/foo.ts:42')).toBeUndefined()
    expect(resolver('src/foo.ts')).toBeUndefined()
    expect(baseResolve).toHaveBeenCalledWith('src/foo.ts:42')
    expect(baseResolve).toHaveBeenCalledWith('src/foo.ts')
  })

  it('labels line mentions with the parsed path and line', () => {
    const d = deps({ existing: ['src/foo.ts'] })
    const resolver = enhanceMentionResolver(undefined, d).resolve
    const mention = resolver('src/foo.ts:42-56')
    expect(mention?.label).toBe('open src/foo.ts:42')
  })
})

describe('wrapChatFileMentions', () => {
  const service = (): ChatFileMentionsService & { calls: unknown[] } => {
    const fake = {
      calls: [] as unknown[],
      forClosing(owner: unknown) {
        this.calls.push(owner)
        return { resolve: () => undefined }
      },
    }
    return fake
  }

  it('wraps forClosing so every call resolves through the enhanced resolver', () => {
    const svc = service()
    const d = deps({ existing: ['src/foo.ts'] })
    const restore = wrapChatFileMentions(svc, () => d)
    const base = svc.forClosing({ seq: 1 })
    const mention = base?.resolve('src/foo.ts:42')
    expect(mention).toBeDefined()
    mention?.open()
    expect(d.opened).toEqual(['src/foo.ts:42'])
    restore()
  })

  it('passes the owner through and restores the original method on dispose', () => {
    const svc = service()
    const original = svc.forClosing
    const d = deps({ existing: ['src/foo.ts'] })
    const restore = wrapChatFileMentions(svc, owner => ({
      ...d,
      openPath: (path: string) => { d.opened.push(`${String((owner as { id?: number }).id)}:${path}`) },
    }))
    const base = svc.forClosing({ id: 7 })
    base?.resolve('src/foo.ts:42')?.open()
    expect(d.opened).toEqual(['7:src/foo.ts:42'])
    restore()
    expect(svc.forClosing).toBe(original)
    // Restoring twice is idempotent and never clobbers a later wrapper.
    restore()
    expect(svc.forClosing).toBe(original)
  })

  it('an undefined base (no produced files) still yields verified path mentions', () => {
    const svc: ChatFileMentionsService = {
      forClosing: () => undefined,
    }
    const d = deps({ existing: ['src/foo.ts'] })
    const restore = wrapChatFileMentions(svc, () => d)
    const base = svc.forClosing({ seq: 1 })
    expect(base).toBeDefined()
    expect(base?.resolve('src/foo.ts:42')?.title).toBe('src/foo.ts:42')
    expect(base?.resolve('src/ghost.ts:42')).toBeUndefined()
    restore()
  })
})
