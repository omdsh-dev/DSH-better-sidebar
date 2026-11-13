/** One mounted action API, durable temporary draft ledger and fixed loopback commit route. */
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '../context-types.ts'
import { ClueError } from './error.ts'
import { createClueDraftManager, type ClueDraftManager } from './drafts.ts'
import { createFeishuDraftBridge } from './drafts/feishu.ts'
import { createClueActionStartHandler, type ClueActionDelivery } from './actions.ts'
import { CLUE_AGENT_COMMIT_ROUTE_PATH, installClueAgentDrafts } from './agent-drafts.ts'
import type { CluesService } from './service.ts'
import type { ClueRuntime } from './runtime/types.ts'

export interface InstallClueActionsOptions {
  readonly clues: CluesService
  readonly runtime: ClueRuntime
  readonly deliver: (input: ClueActionDelivery) => Promise<{ readonly deliveryId?: string } | void>
}
export function installClueActions(ctx: Context, options: InstallClueActionsOptions): { readonly drafts: ClueDraftManager } {
  const { clues, runtime, deliver } = options
  let manager: ClueDraftManager | undefined
  // Port is resolved only on invocation: during activation the OS listener may
  // not be bound yet. Same profile+port recovers drafts after plugin/server restart.
  const getManager = (): ClueDraftManager => {
    if (manager !== undefined) return manager
    const home = ctx.profileContext?.home, port = ctx.webServer.port
    if (home === undefined || port === undefined || !Number.isInteger(port) || port < 1) throw new ClueError('failed', 'the local draft workspace is unavailable')
    const resolveWorkspacePath = (workspaceId: string): string | undefined => {
      const registry = ctx.get('workspaceRegistry') as { get(id: string): { path: string } | undefined } | undefined
      return registry?.get(workspaceId)?.path
    }
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
  ctx.effect(() => clues.registerApi('clues.actions.start', createClueActionStartHandler({
    drafts, deliver,
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
