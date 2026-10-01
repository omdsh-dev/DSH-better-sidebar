import { describe, expect, it } from 'vitest'
import { collectToolPaths, createMentionScopeDefinition, MENTION_SCOPE_KEY } from '../src/client/mention-scope.ts'
import {
  candidateDirectories,
  createMentionResolver,
  resolveMentionPath,
  wrapChatFileMentions,
  type ChatFileMentionsService,
  type MentionResolverDeps,
} from '../src/client/mention-intercept.ts'

const DIR = '/Users/lee/TracyHQ/.screenshots'

describe('tool-argument path extraction', () => {
  it('reads the path keys DSH tools actually use', () => {
    expect(collectToolPaths(JSON.stringify({ file_path: `${DIR}/shoot.mjs` }))).toEqual([`${DIR}/shoot.mjs`])
    expect(collectToolPaths(JSON.stringify({ target: DIR, title: 'x' }))).toEqual([DIR])
    expect(collectToolPaths(JSON.stringify({ command: 'node shoot.mjs', workdir: DIR }))).toEqual([DIR])
  })

  it('ignores a bash command string — it is full of path-shaped fragments that name nothing', () => {
    expect(collectToolPaths(JSON.stringify({ command: 'cd /a/b && ls -la ../c' }))).toEqual([])
  })

  it('declines malformed or non-object payloads instead of throwing', () => {
    expect(collectToolPaths('not json')).toEqual([])
    expect(collectToolPaths(JSON.stringify(['/a/b']))).toEqual([])
    expect(collectToolPaths(undefined)).toEqual([])
  })

  it('rejects multiline and wildcard values', () => {
    expect(collectToolPaths(JSON.stringify({ path: 'a\nb' }))).toEqual([])
    expect(collectToolPaths(JSON.stringify({ path: '/a/*.png' }))).toEqual([])
  })
})

describe('mention scope accumulator', () => {
  const definition = (touched: string[] = []) =>
    createMentionScopeDefinition((path) => { touched.push(path) }) as {
      kind: string
      match(event: unknown): unknown
      start(context: unknown, match: unknown): { turn: unknown; paths: readonly string[] }
      update(context: unknown, match: unknown): { paths: readonly string[] }
      buildLocationData(context: unknown, scope: string): { key: string; value: { paths: readonly string[] } } | null
    }

  it('claims turn/start and tool/call, ignores everything else', () => {
    const d = definition()
    expect(d.match({ type: 'turn/start', data: { turn: 3 } })).toEqual({ id: '3', role: 'start' })
    expect(d.match({ type: 'tool/call', data: { turn: 3 } })).toEqual({ id: '3', role: 'update' })
    expect(d.match({ type: 'tool/result', data: { turn: 3 } })).toBeNull()
  })

  it('accumulates touched paths in call order and warms each one once', () => {
    const touched: string[] = []
    const d = definition(touched)
    let state = d.start(undefined, { event: { type: 'turn/start', data: { turn: 1 } } })
    const call = (args: Record<string, unknown>) => {
      state = { turn: 1, ...d.update({ state }, { event: { type: 'tool/call', data: { turn: 1, arguments: JSON.stringify(args) } } }) }
    }
    call({ file_path: `${DIR}/shoot.mjs` })
    call({ target: DIR })
    call({ file_path: `${DIR}/shoot.mjs` })
    expect(state.paths).toEqual([`${DIR}/shoot.mjs`, DIR])
    expect(touched).toEqual([`${DIR}/shoot.mjs`, DIR])
  })

  it('publishes under the turn scope only', () => {
    const d = definition()
    const context = { state: { turn: 1, paths: [DIR] } }
    expect(d.buildLocationData(context, 'session')).toBeNull()
    expect(d.buildLocationData(context, 'turn')).toMatchObject({ key: MENTION_SCOPE_KEY, value: { paths: [DIR] } })
  })
})

describe('mention resolution', () => {
  const listings = (map: Record<string, string[]>) => (dir: string) =>
    map[dir] === undefined ? undefined : new Set(map[dir])

  it('resolves a token that is exactly a touched path', () => {
    expect(resolveMentionPath(`${DIR}/shoot.mjs`, [`${DIR}/shoot.mjs`], { listing: () => undefined }))
      .toBe(`${DIR}/shoot.mjs`)
  })

  it('resolves a token that is the basename of exactly one touched path', () => {
    expect(resolveMentionPath('shoot.mjs', [`${DIR}/shoot.mjs`, DIR], { listing: () => undefined }))
      .toBe(`${DIR}/shoot.mjs`)
  })

  it('stays inert when a basename matches two touched paths', () => {
    expect(resolveMentionPath('index.ts', ['/a/index.ts', '/b/index.ts'], { listing: () => undefined }))
      .toBeUndefined()
  })

  it('resolves a file that exists in a touched directory (the measured case)', () => {
    // The turn read shoot.mjs and ran bash with workdir=.screenshots; the five
    // PNGs it created appear in no tool argument at all.
    const paths = [`${DIR}/shoot.mjs`, DIR]
    const listing = listings({ [DIR]: ['shoot.mjs', 'mobile-360.png', 'mobile-390.png', 'desktop-1440.png'] })
    for (const name of ['mobile-360.png', 'mobile-390.png', 'desktop-1440.png']) {
      expect(resolveMentionPath(name, paths, { listing })).toBe(`${DIR}/${name}`)
    }
  })

  it('degrades to the touched paths when no listing has arrived yet', () => {
    const paths = [`${DIR}/shoot.mjs`, DIR]
    expect(resolveMentionPath('shoot.mjs', paths, { listing: () => undefined })).toBe(`${DIR}/shoot.mjs`)
    expect(resolveMentionPath('mobile-360.png', paths, { listing: () => undefined })).toBeUndefined()
  })

  it('stays inert when the same filename exists in two touched directories', () => {
    const listing = listings({ '/a': ['dup.png'], '/b': ['dup.png'] })
    expect(resolveMentionPath('dup.png', ['/a', '/b'], { listing })).toBeUndefined()
  })

  it('never invents a file the listing does not contain', () => {
    const listing = listings({ [DIR]: ['shoot.mjs'] })
    expect(resolveMentionPath('nope.png', [DIR], { listing })).toBeUndefined()
  })

  it('candidateDirectories offers each parent and each path itself', () => {
    expect(candidateDirectories([`${DIR}/shoot.mjs`, DIR])).toEqual([DIR, '/Users/lee/TracyHQ', `${DIR}/shoot.mjs`])
  })
})

describe('chatFileMentions takeover', () => {
  const deps = (overrides: Partial<MentionResolverDeps & { enabled(): boolean }> = {}) => {
    const opened: string[] = []
    return {
      opened,
      enabled: () => true,
      paths: () => [DIR],
      listing: (dir: string) => (dir === DIR ? new Set(['mobile-360.png']) : undefined),
      open: (path: string) => { opened.push(path) },
      label: (path: string) => `Open ${path}`,
      ...overrides,
    }
  }

  it('resolves on a turn upstream declined entirely (returned undefined)', () => {
    const service: ChatFileMentionsService = { forClosing: () => undefined }
    const d = deps()
    const restore = wrapChatFileMentions(service, d)
    const resolver = service.forClosing({})
    const target = resolver?.resolve('mobile-360.png')
    expect(target).toBeDefined()
    target?.open()
    expect(d.opened).toEqual([`${DIR}/mobile-360.png`])
    restore()
    expect(service.forClosing({})).toBeUndefined()
  })

  it('keeps upstream\'s answer when upstream resolves the token', () => {
    const upstreamTarget = { open: () => {}, label: 'upstream', title: '/produced/a.ts' }
    const service: ChatFileMentionsService = { forClosing: () => ({ resolve: (v) => (v === 'a.ts' ? upstreamTarget : undefined) }) }
    const d = deps()
    const restore = wrapChatFileMentions(service, d)
    const resolver = service.forClosing({})
    expect(resolver?.resolve('a.ts')).toBe(upstreamTarget)
    expect(resolver?.resolve('mobile-360.png')?.title).toBe(`${DIR}/mobile-360.png`)
    restore()
  })

  it('hands back upstream untouched while the takeover is disabled', () => {
    const upstream = { resolve: () => undefined }
    const service: ChatFileMentionsService = { forClosing: () => upstream }
    const restore = wrapChatFileMentions(service, deps({ enabled: () => false }))
    expect(service.forClosing({})).toBe(upstream)
    restore()
  })

  it('throws when the method is absent — a missing door must not read as a working one', () => {
    expect(() => wrapChatFileMentions({} as ChatFileMentionsService, deps())).toThrow(/forClosing/)
  })

  it('restores the original method on dispose (HMR-safe)', () => {
    const original = () => undefined
    const service: ChatFileMentionsService = { forClosing: original }
    const restore = wrapChatFileMentions(service, deps())
    expect(service.forClosing).not.toBe(original)
    restore()
    expect(service.forClosing).toBe(original)
  })

  it('createMentionResolver reads the scope once per turn', () => {
    let reads = 0
    const resolver = createMentionResolver({}, undefined, { ...deps(), paths: () => { reads++; return [DIR] } })
    resolver.resolve('mobile-360.png')
    resolver.resolve('mobile-360.png')
    expect(reads).toBe(1)
  })
})
