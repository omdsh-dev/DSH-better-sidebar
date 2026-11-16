/** Selection action preparation stays explicit: local files are edited in place, remote edits keep the draft+commit pipeline. */
import { join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  createClueActionStartHandler,
  type ClueActionStartDeps,
  type ClueLocalFileResolver,
} from '../src/clues/actions.ts'
import { createLocalFileTargetResolver } from '../src/clues/install-actions.ts'
import { ClueError } from '../src/clues/error.ts'
import { ClueWriterHeldError, createClueSessionDelivery } from '../src/clues/session-delivery.ts'
import type { ClueDraft, ClueDraftManager } from '../src/clues/drafts.ts'
import type { Context } from '../src/context-types.ts'
import type { CluesService } from '../src/clues/service.ts'
import type { Clue, ClueApiContext, CluesReadParams } from '../src/clues/types.ts'

const request = {
  workspaceId: 'ws',
  sessionId: 'session',
  resource: { clueId: 'clue' },
  target: 'side',
  action: 'humanize',
  requestId: 'intent',
  selection: 'chosen line',
}
const draft: ClueDraft = {
  draftId: 'd'.repeat(48),
  status: 'prepared',
  bodyPath: '/drafts/body.md',
  format: 'text/markdown',
  createdAt: '2026-01-01T00:00:00.000Z',
}
const HOST_DIALECT = process.platform === 'win32' ? 'win32' : 'posix'

interface FixtureOptions {
  readonly localPath?: string
  readonly resolveLocalFile?: ClueLocalFileResolver
  readonly deliver?: ClueActionStartDeps['deliver']
  readonly commitUrl?: string
}

function fixture(options: FixtureOptions = {}) {
  const prepare = vi.fn<ClueDraftManager['prepare']>().mockResolvedValue(draft)
  const deliver = vi.fn<ClueActionStartDeps['deliver']>(options.deliver ?? (async () => ({ deliveryId: 'side-thread' })))
  const getCommitUrl = vi.fn(() => 'commitUrl' in options ? options.commitUrl : 'http://127.0.0.1:12345/sidebar/agent/clues/commit')
  const resolveLocalFile = vi.fn<ClueLocalFileResolver>(options.resolveLocalFile ?? (async () => options.localPath))
  const handler = createClueActionStartHandler({
    drafts: { prepare, commit: vi.fn(), discard: vi.fn(), list: vi.fn() },
    deliver,
    getCommitUrl,
    resolveLocalFile,
  })
  return {
    start: (patch: Record<string, unknown> = {}) => handler({ ...request, ...patch }, { caller: 'ui', sessionId: 'session' }),
    prepare,
    deliver,
    getCommitUrl,
    resolveLocalFile,
  }
}

describe('local-file selection actions', () => {
  it('edits the original path directly without preparing a draft or a commit helper', async () => {
    const localPath = join(tmpdir(), 'notes.md')
    const { start, prepare, deliver, getCommitUrl, resolveLocalFile } = fixture({ localPath, commitUrl: undefined })
    const result = await start()
    expect(resolveLocalFile).toHaveBeenCalledTimes(1)
    expect(resolveLocalFile.mock.calls[0]?.[0]).toMatchObject({ workspaceId: 'ws', sessionId: 'session', clueId: 'clue' })
    expect(resolveLocalFile.mock.calls[0]?.[1]).toMatchObject({ caller: 'ui', sessionId: 'session' })
    expect(prepare).not.toHaveBeenCalled()
    expect(getCommitUrl).not.toHaveBeenCalled()
    expect(deliver).toHaveBeenCalledTimes(1)
    const delivery = deliver.mock.calls[0]![0]
    expect(delivery.prompt).toContain(JSON.stringify(localPath))
    expect(delivery.prompt).toContain('do not create a temporary draft')
    expect(delivery.prompt).toContain('encoding and line-ending style')
    expect(delivery.prompt).not.toContain('commit-draft.mjs')
    expect(delivery.scriptPath).toBeUndefined()
    expect(delivery.draft).toBeUndefined()
    expect(delivery.target).toBe('side')
    expect(result).toMatchObject({ action: 'humanize', target: 'side', deliveryId: 'side-thread', localFile: true })
    expect(result.draft).toBeUndefined()
  })

  it('prepareOnly returns the prompt without delivering and without a draft', async () => {
    const localPath = join(tmpdir(), 'notes.md')
    const { start, prepare, deliver, getCommitUrl } = fixture({ localPath, commitUrl: undefined })
    const result = await start({ prepareOnly: true, action: 'shorten' })
    expect(prepare).not.toHaveBeenCalled()
    expect(getCommitUrl).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    expect(result).toMatchObject({ action: 'shorten', target: 'side', localFile: true })
    expect(result.prompt).toContain(JSON.stringify(localPath))
    expect(result.draft).toBeUndefined()
    expect(result.deliveryId).toBeUndefined()
  })

  it('propagates an uneditable local target from the resolver', async () => {
    const resolveLocalFile = vi.fn<ClueLocalFileResolver>().mockRejectedValue(new ClueError('unsupported', 'a binary local file is read-only'))
    const { start, prepare, deliver } = fixture({ resolveLocalFile })
    await expect(start()).rejects.toMatchObject({ category: 'unsupported' })
    expect(prepare).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })
})

describe('remote selection actions', () => {
  it('keeps the draft pipeline and replaces only the operation instruction', async () => {
    const { start, prepare, deliver, getCommitUrl } = fixture()
    const result = await start({ instruction: 'Use shorter, more concrete sentences.' })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(getCommitUrl).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    const delivery = deliver.mock.calls[0]![0]
    expect(delivery.prompt).toContain('Use shorter, more concrete sentences.')
    expect(delivery.prompt).not.toContain('natural, fluent language')
    expect(delivery.prompt).toContain(JSON.stringify(draft.bodyPath))
    expect(delivery.prompt).toContain('commit-draft.mjs')
    expect(delivery.prompt).toContain('Never retry a different draft')
    expect(delivery.prompt).toContain(JSON.stringify(request.selection))
    expect(delivery.draft).toEqual(draft)
    expect(delivery.scriptPath).toContain('commit-draft.mjs')
    expect(result).toMatchObject({ action: 'humanize', target: 'side', deliveryId: 'side-thread' })
    expect(result.draft).toEqual(draft)
    expect(result.localFile).toBeUndefined()
  })

  it('uses the humanize natural-language default without inventing facts', async () => {
    const { start, deliver } = fixture()
    await start()
    const prompt = deliver.mock.calls[0]![0].prompt
    expect(prompt).toContain('natural, fluent language')
    expect(prompt).toContain('Do not invent facts')
  })

  it('prepareOnly prepares the retained draft but does not deliver', async () => {
    const { start, prepare, deliver } = fixture()
    const result = await start({ prepareOnly: true })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()
    expect(result).toMatchObject({ action: 'humanize', target: 'side', draft })
    expect(result.prompt).toContain(JSON.stringify(draft.bodyPath))
    expect(result.deliveryId).toBeUndefined()
    expect(result.localFile).toBeUndefined()
  })
})

describe('action validation and request identity', () => {
  it('rejects custom without an explicit instruction', async () => {
    const { start, prepare, deliver, resolveLocalFile } = fixture()
    await expect(start({ action: 'custom' })).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(start({ action: 'custom', instruction: '   ' })).rejects.toMatchObject({ category: 'invalid-request' })
    expect(resolveLocalFile).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('delivers a custom instruction as the operation instruction', async () => {
    const { start, deliver } = fixture()
    await start({ action: 'custom', instruction: 'Turn the passage into a checklist.' })
    const prompt = deliver.mock.calls[0]![0].prompt
    expect(prompt).toContain('Turn the passage into a checklist.')
    expect(prompt).toContain('commit-draft.mjs')
  })

  it('bounds the optional fields and rejects a non-boolean prepareOnly', async () => {
    const { start } = fixture()
    await expect(start({ instruction: 'x'.repeat(8193) })).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(start({ actionLabel: 'x'.repeat(101) })).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(start({ prepareOnly: 'yes' })).rejects.toMatchObject({ category: 'invalid-request' })
    await expect(start({ action: 'unknown' })).rejects.toMatchObject({ category: 'invalid-request' })
  })

  it('deduplicates an identical request id and rejects changed override fields', async () => {
    const first = fixture({ localPath: join(tmpdir(), 'notes.md') })
    const [one, two] = await Promise.all([first.start(), first.start()])
    expect(one).toEqual(two)
    expect(first.resolveLocalFile).toHaveBeenCalledTimes(1)
    expect(first.deliver).toHaveBeenCalledTimes(1)

    for (const patch of [{ instruction: 'different' }, { actionLabel: 'Different label' }, { prepareOnly: true }]) {
      const current = fixture({ localPath: join(tmpdir(), 'notes.md') })
      await current.start()
      await expect(current.start(patch)).rejects.toMatchObject({ category: 'conflict' })
    }
  })

  it('retains writer-held dedup and reuses the prepared draft on retry', async () => {
    const deliver = vi.fn<ClueActionStartDeps['deliver']>()
      .mockRejectedValueOnce(new ClueWriterHeldError())
      .mockResolvedValueOnce({ deliveryId: 'side-thread' })
    const { start, prepare } = fixture({ deliver })
    const legacy = { action: 'rewrite', target: 'main' }
    await expect(start(legacy)).rejects.toMatchObject({ category: 'conflict', meta: { draftId: draft.draftId } })
    const receipt = await start(legacy)
    expect(receipt).toMatchObject({ action: 'rewrite', target: 'main', deliveryId: 'side-thread', draft })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(deliver.mock.calls[1]![0].prompt).toBe(deliver.mock.calls[0]![0].prompt)
  })

  it('rejects rewrites on comment selections but still explains them', async () => {
    const rejected = fixture({ localPath: join(tmpdir(), 'notes.md') })
    await expect(rejected.start({ comment: true, action: 'rewrite' })).rejects.toMatchObject({ category: 'permission-denied' })
    await expect(rejected.start({ comment: true, action: 'humanize' })).rejects.toMatchObject({ category: 'permission-denied' })
    await expect(rejected.start({ comment: true, action: 'custom', instruction: 'Rewrite it.' })).rejects.toMatchObject({ category: 'permission-denied' })
    expect(rejected.resolveLocalFile).not.toHaveBeenCalled()
    expect(rejected.deliver).not.toHaveBeenCalled()

    const explain = fixture()
    const result = await explain.start({ comment: true, action: 'explain', prepareOnly: true, instruction: '', actionLabel: 'Explain' })
    expect(result.prompt).toContain('Explain the selected resource content in the conversation language.')
    expect(result.prompt).toContain('Do not edit any file or resource')
    expect(result.localFile).toBeUndefined()
    expect(explain.resolveLocalFile).not.toHaveBeenCalled()
    expect(explain.prepare).not.toHaveBeenCalled()
    expect(explain.deliver).not.toHaveBeenCalled()
  })
})

describe('local-file target resolution', () => {
  function resolverFixture(options: { workspacePath?: string; clues?: readonly Clue[]; loadEditError?: ClueError } = {}) {
    const loadEdit = vi.fn<Pick<CluesService, 'loadEdit'>['loadEdit']>()
    loadEdit.mockImplementation(async () => {
      if (options.loadEditError !== undefined) throw options.loadEditError
      return { format: 'text/markdown', data: { text: 'body' } }
    })
    const listClues = vi.fn<Pick<CluesService, 'listClues'>['listClues']>().mockResolvedValue({ clues: options.clues ?? [], revision: 1 })
    const resolver = createLocalFileTargetResolver(
      { loadEdit, listClues },
      id => id === 'ws' ? options.workspacePath : undefined,
    )
    return { resolver, loadEdit, listClues }
  }

  const context: ClueApiContext = { caller: 'ui', sessionId: 'session' }

  it('resolves a stored workspace locator against the registry path', async () => {
    const workspacePath = join(tmpdir(), 'dsh-clue-workspace')
    const clue: Clue = {
      id: 'clue',
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { root: { kind: 'workspace', workspaceId: 'ws' }, path: 'docs/notes.md', dialect: HOST_DIALECT },
      title: 'notes.md',
      workspaceId: 'ws',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const { resolver, loadEdit, listClues } = resolverFixture({ workspacePath, clues: [clue] })
    const resource: CluesReadParams = { workspaceId: 'ws', sessionId: 'session', clueId: 'clue' }
    await expect(resolver(resource, context)).resolves.toBe(join(workspacePath, 'docs/notes.md'))
    expect(listClues).toHaveBeenCalledWith('ws')
    expect(loadEdit).toHaveBeenCalledWith(resource, { caller: 'ui', sessionId: 'session' })
  })

  it('resolves a direct workspace locator against the registry path', async () => {
    const workspacePath = join(tmpdir(), 'dsh-clue-workspace')
    const { resolver, loadEdit, listClues } = resolverFixture({ workspacePath })
    const resource: CluesReadParams = {
      workspaceId: 'ws',
      sessionId: 'session',
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { root: { kind: 'workspace', workspaceId: 'ws' }, path: 'notes.md', dialect: HOST_DIALECT },
    }
    await expect(resolver(resource, context)).resolves.toBe(join(workspacePath, 'notes.md'))
    expect(listClues).not.toHaveBeenCalled()
    expect(loadEdit).toHaveBeenCalledWith(resource, { caller: 'ui', sessionId: 'session' })
  })

  it('resolves a direct external locator and ignores the workspace registry', async () => {
    const externalPath = join(tmpdir(), 'outside.md')
    const { resolver, loadEdit } = resolverFixture({ workspacePath: join(tmpdir(), 'dsh-clue-workspace') })
    const resource: CluesReadParams = {
      workspaceId: 'ws',
      sessionId: 'session',
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { root: { kind: 'external' }, path: externalPath, dialect: HOST_DIALECT },
    }
    await expect(resolver(resource, context)).resolves.toBe(resolvePath(externalPath))
    expect(loadEdit).toHaveBeenCalledWith(resource, { caller: 'ui', sessionId: 'session' })
  })

  it('leaves non-local sources on the remote pipeline', async () => {
    const { resolver, loadEdit, listClues } = resolverFixture()
    const resource: CluesReadParams = {
      workspaceId: 'ws',
      sourceId: 'github',
      typeId: 'github.file',
      locator: { path: 'README.md' },
    }
    await expect(resolver(resource, context)).resolves.toBeUndefined()
    expect(loadEdit).not.toHaveBeenCalled()
    expect(listClues).not.toHaveBeenCalled()
  })

  it('leaves a remote clue id on the remote pipeline', async () => {
    const clue: Clue = {
      id: 'remote',
      sourceId: 'github',
      typeId: 'github.file',
      locator: { path: 'README.md' },
      title: 'README.md',
      workspaceId: 'ws',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const { resolver, loadEdit } = resolverFixture({ clues: [clue] })
    await expect(resolver({ workspaceId: 'ws', clueId: 'remote' }, context)).resolves.toBeUndefined()
    expect(loadEdit).not.toHaveBeenCalled()
  })

  it('rejects a foreign workspace locator and a missing workspace directory', async () => {
    const foreign = resolverFixture({ workspacePath: join(tmpdir(), 'dsh-clue-workspace') })
    const foreignResource: CluesReadParams = {
      workspaceId: 'ws',
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { root: { kind: 'workspace', workspaceId: 'other' }, path: 'notes.md', dialect: HOST_DIALECT },
    }
    await expect(foreign.resolver(foreignResource, context)).rejects.toMatchObject({ category: 'invalid-request' })
    expect(foreign.loadEdit).not.toHaveBeenCalled()

    const missing = resolverFixture()
    const missingResource: CluesReadParams = {
      workspaceId: 'ws',
      sourceId: 'builtin.files',
      typeId: 'builtin.files.markdown',
      locator: { root: { kind: 'workspace', workspaceId: 'ws' }, path: 'notes.md', dialect: HOST_DIALECT },
    }
    await expect(missing.resolver(missingResource, context)).rejects.toMatchObject({ category: 'dependency-missing' })
    expect(missing.loadEdit).not.toHaveBeenCalled()
  })

  it('propagates loadEdit edit-capability failures', async () => {
    const { resolver } = resolverFixture({
      workspacePath: join(tmpdir(), 'dsh-clue-workspace'),
      loadEditError: new ClueError('unsupported', 'a binary local file is read-only'),
    })
    const resource: CluesReadParams = {
      workspaceId: 'ws',
      sourceId: 'builtin.files',
      typeId: 'builtin.files.binary',
      locator: { root: { kind: 'workspace', workspaceId: 'ws' }, path: 'image.png', dialect: HOST_DIALECT },
    }
    await expect(resolver(resource, context)).rejects.toMatchObject({ category: 'unsupported' })
  })
})

describe('selection action admission', () => {
  function sessionFixture() {
    const prompt = vi.fn().mockRejectedValueOnce({ code: 'session/writer-held' }).mockResolvedValue({ accepted: true })
    const ctx = { get: () => ({ prompt }) } as unknown as Context
    const send = createClueSessionDelivery(ctx, vi.fn())
    const prepare = vi.fn<ClueDraftManager['prepare']>().mockResolvedValue(draft)
    const handler = createClueActionStartHandler({
      drafts: { prepare, commit: vi.fn(), discard: vi.fn(), list: vi.fn() },
      getCommitUrl: () => 'http://127.0.0.1:12345/sidebar/agent/clues/commit',
      deliver: async operation => ({ deliveryId: (await send(operation)).sessionId }),
    })
    return { start: () => handler({ ...request, target: 'main', action: 'rewrite' }, { caller: 'ui' }), prepare, prompt }
  }

  it('retries a writer refusal with the same request and draft, then reuses the receipt', async () => {
    const { start, prepare, prompt } = sessionFixture()
    await expect(start()).rejects.toMatchObject({ category: 'conflict', meta: { draftId: draft.draftId } })
    const [receipt, joined] = await Promise.all([start(), start()])
    expect(joined).toEqual(receipt)
    await expect(start()).resolves.toEqual(receipt)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(prompt.mock.calls[1]?.[0]).toEqual(prompt.mock.calls[0]?.[0])
  })

  it('does not retry an admission whose outcome is uncertain', async () => {
    const prompt = vi.fn().mockRejectedValue(new Error('connection interrupted'))
    const ctx = { get: () => ({ prompt }) } as unknown as Context
    const send = createClueSessionDelivery(ctx, vi.fn())
    const prepare = vi.fn<ClueDraftManager['prepare']>().mockResolvedValue(draft)
    const handler = createClueActionStartHandler({
      drafts: { prepare, commit: vi.fn(), discard: vi.fn(), list: vi.fn() },
      getCommitUrl: () => 'http://127.0.0.1:12345/sidebar/agent/clues/commit',
      deliver: async operation => ({ deliveryId: (await send(operation)).sessionId }),
    })
    const start = () => handler({ ...request, target: 'main', action: 'rewrite' }, { caller: 'ui' })
    await expect(start()).rejects.toMatchObject({ category: 'failed' })
    await expect(start()).rejects.toMatchObject({ category: 'failed' })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(1)
  })
})
