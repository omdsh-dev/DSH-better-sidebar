/** One mounted action API, local-file target detection, durable temporary draft ledger and fixed loopback commit route. */
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import type { Context } from '../context-types.ts'
import { ClueError } from './error.ts'
import { createClueDraftManager, type ClueDraftManager } from './drafts.ts'
import { createFeishuDraftBridge } from './drafts/feishu.ts'
import { createClueActionStartHandler, type ClueActionDelivery, type ClueLocalFileResolver } from './actions.ts'
import { CLUE_AGENT_COMMIT_ROUTE_PATH, installClueAgentDrafts } from './agent-drafts.ts'
import { LOCAL_FILE_SOURCE_ID, normalizeLocalFileLocator } from './local-files.ts'
import type { CluesService } from './service.ts'
import type { ClueApiContext, CluesReadParams, Locator } from './types.ts'
import type { ClueRuntime } from './runtime/types.ts'

/** The `node:path` dialect this host can actually edit. */
const HOST_DIALECT = process.platform === 'win32' ? 'win32' : 'posix'
type WorkspaceRegistryLike = { get(id: string): { readonly path?: unknown } | undefined }

/**
 * Detect an editable `builtin.files` target and answer the canonical absolute
 * path an agent should edit in place. A remote (or unknown) resource answers
 * `undefined` and keeps the existing draft + fixed-commit flow.
 *
 * The locator is authoritative: a direct resource already carries it, while a
 * clue id is read from the durable library instead of trusting a caller path.
 * `loadEdit` remains the single workspace/session/edit-capability gate, so
 * binary, directory, oversized and non-editable sources are rejected before a
 * prompt exists.
 */
export function createLocalFileTargetResolver(
  clues: Pick<CluesService, 'loadEdit' | 'listClues'>,
  resolveWorkspacePath: (workspaceId: string) => string | undefined,
): ClueLocalFileResolver {
  const locatorOf = async (resource: CluesReadParams): Promise<Locator | undefined> => {
    if (resource.clueId !== undefined) {
      const library = await clues.listClues(resource.workspaceId)
      const clue = library.clues.find(candidate => candidate.id === resource.clueId)
      return clue?.sourceId === LOCAL_FILE_SOURCE_ID ? clue.locator : undefined
    }
    return resource.sourceId === LOCAL_FILE_SOURCE_ID ? resource.locator : undefined
  }
  return async (resource, context: ClueApiContext) => {
    const locator = await locatorOf(resource)
    if (locator === undefined) return undefined
    const normalized = normalizeLocalFileLocator(locator)
    if (normalized.dialect !== HOST_DIALECT) throw new ClueError('unsupported', `a ${normalized.dialect} local file reference cannot be edited on a ${HOST_DIALECT} host`)
    let absolute: string
    if (normalized.root.kind === 'external') absolute = normalized.path
    else {
      if (normalized.root.workspaceId !== resource.workspaceId) throw new ClueError('invalid-request', `the local file reference belongs to workspace "${normalized.root.workspaceId}", not "${resource.workspaceId}"`)
      const workspacePath = resolveWorkspacePath(resource.workspaceId)
      if (workspacePath === undefined) throw new ClueError('dependency-missing', 'the workspace directory is unknown to the host registry')
      absolute = normalized.path === '' ? workspacePath : join(workspacePath, normalized.path)
    }
    // The source's own loadEdit is the edit-capability/workspace/session gate.
    const sessionId = context.sessionId ?? resource.sessionId
    await clues.loadEdit(resource, {
      caller: context.caller,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    })
    return resolvePath(absolute)
  }
}

export interface InstallClueActionsOptions {
  readonly clues: CluesService
  readonly runtime: ClueRuntime
  readonly deliver: (input: ClueActionDelivery) => Promise<{ readonly deliveryId?: string } | void>
}
export function installClueActions(ctx: Context, options: InstallClueActionsOptions): { readonly drafts: ClueDraftManager } {
  const { clues, runtime, deliver } = options
  const resolveWorkspacePath = (workspaceId: string): string | undefined => {
    const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    const path = registry?.get(workspaceId)?.path
    return typeof path === 'string' && path !== '' ? path : undefined
  }
  let manager: ClueDraftManager | undefined
  // Port is resolved only on invocation: during activation the OS listener may
  // not be bound yet. Same profile+port recovers drafts after plugin/server restart.
  const getManager = (): ClueDraftManager => {
    if (manager !== undefined) return manager
    const home = ctx.profileContext?.home, port = ctx.webServer.port
    if (home === undefined || port === undefined || !Number.isInteger(port) || port < 1) throw new ClueError('failed', 'the local draft workspace is unavailable')
    const feishu = createFeishuDraftBridge({ clues, getRuntime: () => runtime, resolveWorkspacePath })
    const instance = createHash('sha256').update(`${home}\u0000${port}`).digest('hex').slice(0, 24)
    manager = createClueDraftManager({ clues, root: join(tmpdir(), 'dsh-better-sidebar', instance), feishu })
    return manager
  }
  const drafts: ClueDraftManager = {
    prepare: (resource, call) => getManager().prepare(resource, call),
    commit: id => getManager().commit(id),
    discard: id => getManager().discard(id),
    list: () => getManager().list(),
  }
  const resolveLocalFile = createLocalFileTargetResolver(clues, resolveWorkspacePath)
  ctx.effect(() => clues.registerApi('clues.actions.start', createClueActionStartHandler({
    drafts, deliver, resolveLocalFile,
    getCommitUrl: () => {
      const port = ctx.webServer.port
      return port === undefined || port < 1 ? undefined : `http://127.0.0.1:${port}${CLUE_AGENT_COMMIT_ROUTE_PATH}`
    },
  })), 'dsh-better-sidebar: explicit clue selection actions')
  ctx.effect(() => installClueAgentDrafts(ctx, { drafts, getWebServer: () => ctx.webServer }), 'dsh-better-sidebar: fixed clue draft commit')
  ctx.effect(() => clues.registerApi('clues.drafts.list', async (_payload, context) => {
    if (context.caller !== 'ui') throw new ClueError('permission-denied', 'retained drafts are an interactive operation')
    return drafts.list()
  }), 'dsh-better-sidebar: retained clue drafts')
  ctx.effect(() => clues.registerApi('clues.drafts.discard', async (payload, context) => {
    if (context.caller !== 'ui') throw new ClueError('permission-denied', 'discarding a retained draft is an interactive operation')
    const input = payload as { draftId?: unknown } | null
    if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.draftId !== 'string') throw new ClueError('invalid-request', 'discard requires a draft identity')
    await drafts.discard(input.draftId)
    return { discarded: true }
  }), 'dsh-better-sidebar: discard retained clue draft')
  return { drafts }
}
