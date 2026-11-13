/** Fixed loopback POST for an explicitly initiated, already prepared draft. No arbitrary write dispatcher. */
import type { SidebarHttpRequest, SidebarHttpResponse, SidebarWebRoute, SidebarWebServer } from '../context-types.ts'
import { clueStatusOf, readJsonBody, SidebarError, writeJson, writeOk } from '../wire.ts'
import { ClueError } from './error.ts'
import { isLoopbackAddress } from './tools.ts'
import type { ClueDraftManager } from './drafts.ts'

export const CLUE_AGENT_COMMIT_ROUTE_PATH = '/sidebar/agent/clues/commit'
export interface ClueAgentDraftDeps {
  readonly drafts: ClueDraftManager
  readonly getWebServer: () => { readonly port?: number } | undefined
}
function reject(res: SidebarHttpResponse, status = 403): void {
  writeJson(res, status, { ok: false, error: { code: status === 405 ? 'method-error' : 'forbidden', message: status === 405 ? 'method not allowed' : 'forbidden' } })
}
/** Same literal peer/listener/browser/proxy restrictions as the fixed read route. */
function admitted(req: SidebarHttpRequest, port: number | undefined): boolean {
  const raw = req.url ?? ''
  if (raw !== CLUE_AGENT_COMMIT_ROUTE_PATH || port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) return false
  if (!isLoopbackAddress(req.socket?.remoteAddress ?? '') || req.socket?.localPort !== port) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/u.exec(host.trim().toLowerCase())
  if (match === null || Number(match[3]) !== port) return false
  const hostname = match[1] ?? match[2]!
  if (hostname !== 'localhost' && !isLoopbackAddress(hostname)) return false
  for (const key of Object.keys(req.headers)) {
    const lower = key.toLowerCase()
    if (lower === 'origin' || lower.startsWith('sec-fetch-') || lower === 'forwarded' || lower.startsWith('x-forwarded-')) return false
  }
  return true
}
export function createClueAgentDraftRoute(deps: ClueAgentDraftDeps): SidebarWebRoute {
  return {
    kind: 'exact', path: CLUE_AGENT_COMMIT_ROUTE_PATH,
    async handler(req, res) {
      // Admission is deliberately before body iteration and draft lookup.
      if (req.method !== 'POST') { reject(res, 405); return }
      if (!admitted(req, deps.getWebServer()?.port)) { reject(res); return }
      const contentType = req.headers['content-type']
      if (typeof contentType !== 'string' || contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        writeJson(res, 415, { ok: false, error: { code: 'bad-request', message: 'Content-Type must be application/json' } }); return
      }
      try {
        const body = await readJsonBody(req, 1024)
        if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { draftId?: unknown }).draftId !== 'string' || !/^[a-f0-9]{48}$/u.test((body as { draftId: string }).draftId)) throw new ClueError('invalid-request', 'the commit request accepts only a valid draftId')
        // Do not bind source cancellation to socket close: losing the response must not
        // interrupt a multi-step write. The durable ledger records its final outcome.
        const value = await deps.drafts.commit((body as { draftId: string }).draftId)
        writeOk(res, value)
      } catch (error) {
        if (error instanceof ClueError) writeJson(res, clueStatusOf(error.category), { ok: false, error: { code: error.category, message: error.message } })
        else if (error instanceof SidebarError) writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
        else writeJson(res, 500, { ok: false, error: { code: 'internal', message: 'the draft commit failed; the draft was retained' } })
      }
    },
  }
}
/** Parent entry installs this only beside its explicit user-action start handler. */
export function installClueAgentDrafts(ctx: { readonly webServer: SidebarWebServer }, deps: ClueAgentDraftDeps): () => void {
  return ctx.webServer.register(createClueAgentDraftRoute(deps))
}
