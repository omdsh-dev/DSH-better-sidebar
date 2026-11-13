/** Fixed local commit HTTP seam: admission before body; draft ID is the complete protocol. */
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createClueAgentDraftRoute } from '../src/clues/agent-drafts.ts'
import type { SidebarHttpRequest, SidebarHttpResponse } from '../src/context-types.ts'
import type { ClueDraftManager } from '../src/clues/drafts.ts'
const ID = 'a'.repeat(48)
async function send(options: { method?: string; url?: string; headers?: Record<string, string | undefined>; peer?: string; localPort?: number; body?: unknown } = {}) {
  const commit = vi.fn(async () => ({ draftId: ID, status: 'committed', bodyPath: '/private/body.md', format: 'text/markdown', createdAt: 'now' }))
  const route = createClueAgentDraftRoute({ drafts: { commit } as unknown as ClueDraftManager, getWebServer: () => ({ port: 2222 }) })
  const req = Readable.from([JSON.stringify(options.body ?? { draftId: ID })]) as unknown as SidebarHttpRequest
  Object.assign(req, { method: options.method ?? 'POST', url: options.url ?? '/sidebar/agent/clues/commit', headers: { host: '127.0.0.1:2222', 'content-type': 'application/json', ...options.headers }, socket: { remoteAddress: options.peer ?? '127.0.0.1', localPort: options.localPort ?? 2222 } })
  let status = 0
  let body = ''
  const headers: Record<string, unknown> = {}
  const res = { writeHead: (value: number, next: object) => { status = value; Object.assign(headers, next) }, end: (value: string) => { body = value } } as unknown as SidebarHttpResponse
  await route.handler(req, res)
  return { status, body: JSON.parse(body), commit, headers }
}
describe('fixed draft commit route', () => {
  it('passes only draftId to the stored-draft manager', async () => {
    const result = await send()
    expect(result.status).toBe(200)
    expect(result.body.value.status).toBe('committed')
    expect(result.commit).toHaveBeenCalledExactlyOnceWith(ID)
  })
  it.each([
    { method: 'GET' }, { method: 'OPTIONS' }, { peer: '10.0.0.1' }, { localPort: 2223 },
    { headers: { origin: 'http://127.0.0.1:2222' } }, { headers: { 'sec-fetch-site': 'same-origin' } },
    { headers: { 'x-forwarded-for': '127.0.0.1' } }, { headers: { forwarded: 'host=localhost' } },
    { headers: { host: 'example.com:2222' } }, { headers: { host: 'localhost:2223' } },
    { headers: { 'content-type': 'text/plain' } }, { url: 'http://127.0.0.1:2222/sidebar/agent/clues/commit' },
    { url: '/sidebar/agent/clues/commit?draftId=x' },
  ])('rejects browser/proxy/non-loopback/incorrect listener requests before committing', async options => {
    const result = await send(options)
    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(result.commit).not.toHaveBeenCalled()
    expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })
  it.each([{ draftId: ID, path: '/etc/passwd' }, { draftId: ID, command: 'touch anything' }, { draftId: '../body.md' }, { draftId: ID, method: 'saveEdit' }])('rejects caller paths, methods, commands and malformed IDs', async body => {
    const result = await send({ body })
    expect(result.status).toBe(400)
    expect(result.commit).not.toHaveBeenCalled()
  })
})
