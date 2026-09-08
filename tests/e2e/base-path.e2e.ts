/**
 * Reverse-proxy base-path lane: prove the packed plugin keeps the live page
 * prefix on every browser-to-host transport, even when DSH's own
 * `<base href="/">` resets document.baseURI. scripts/e2e-base-path.sh boots
 * `dsh web` behind scripts/prefix-proxy.mjs.
 *
 * The DSH shell itself still talks to origin-root `/api`, so this lane does
 * not depend on the session list UI. It seeds a session through the prefixed
 * host RPC, then exercises plugin routes from inside the real page.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { PAGE_URL, PATHNAME, createHostApi, hostRpc, sidebarApi } from './host'
import { encodeHtmlUrl } from '../../src/html-route.ts'

const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-workspace')
const SEEDED_FILE = 'hello.txt'
const SEEDED_PNG = 'shot.png'
const SEEDED_HTML_FILE = 'preview.html'

let api: APIRequestContext
let seededSessionId = ''

test.skip(PATHNAME === '/', 'requires a reverse-proxy prefix (scripts/e2e-base-path.sh)')

test.beforeAll(async () => {
  if (PATHNAME === '/') return
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, SEEDED_FILE), 'hello from the base-path lane\n')
  writeFileSync(join(WORKSPACE_PATH, SEEDED_PNG), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ))
  writeFileSync(join(WORKSPACE_PATH, SEEDED_HTML_FILE), '<h1>preview</h1>\n')
  api = await createHostApi()
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH })
  const session = await hostRpc<{ sessionId: string }>(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
  seededSessionId = session.value.sessionId
})

test.afterAll(async () => {
  await api?.dispose()
})

test('keeps the reverse-proxy prefix on API, bundles, media, HTML, upload, and terminal WebSocket', async ({ page }) => {
  expect(PATHNAME, 'this lane must run behind a non-root prefix').not.toBe('/')
  const prefix = PATHNAME.replace(/\/$/, '')

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })

  const loc = await page.evaluate(() => ({
    href: location.href,
    pathname: location.pathname,
    baseURI: document.baseURI,
    baseHref: document.querySelector('base')?.getAttribute('href') ?? null,
  }))
  expect(loc.pathname.startsWith(prefix), `page stayed under ${prefix}: ${JSON.stringify(loc)}`).toBe(true)

  const constructed = await page.evaluate(() => {
    function directoryBase(baseUrl: string): string {
      const url = new URL(baseUrl, 'http://dsh.internal')
      url.search = ''
      url.hash = ''
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      return url.href
    }
    function hostDocumentBase(): string {
      const doc = document.baseURI
      const locHref = location.href
      const docPath = new URL(doc).pathname
      const locPath = new URL(locHref).pathname
      return locPath.length > docPath.length ? locHref : doc
    }
    function hostRouteUrl(path: string): string {
      return new URL(path.replace(/^\/+/, ''), directoryBase(hostDocumentBase())).href
    }
    function hostWebSocketUrl(path: string): string {
      const url = new URL(hostRouteUrl(path))
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      return url.href
    }
    return {
      documentBase: hostDocumentBase(),
      api: hostRouteUrl('sidebar/api/settings.get'),
      upload: hostRouteUrl('sidebar/upload'),
      file: hostRouteUrl('sidebar/file'),
      html: hostRouteUrl('sidebar/html/x'),
      bundle: hostRouteUrl('sidebar/bundle/editor.js'),
      terminal: hostWebSocketUrl('sidebar/ws/terminal'),
      agentTerminals: hostWebSocketUrl('sidebar/ws/agent-terminals'),
      agentOpens: hostWebSocketUrl('sidebar/ws/agent-opens'),
    }
  })

  for (const [name, url] of Object.entries(constructed)) {
    if (name === 'documentBase') continue
    expect(url, `${name} must keep the reverse-proxy prefix`).toContain(`${prefix}/sidebar/`)
  }

  const settings = await api.post(constructed.api, { data: {} })
  expect(settings.ok(), `settings.get: ${settings.status()} ${await settings.text()}`).toBe(true)

  const bundle = await api.get(constructed.bundle)
  expect(bundle.ok(), `editor chunk: ${bundle.status()}`).toBe(true)

  const fileParams = new URLSearchParams({
    sessionId: seededSessionId,
    path: join(WORKSPACE_PATH, SEEDED_PNG),
    cwd: WORKSPACE_PATH,
  })
  const media = await api.get(`${constructed.file}?${fileParams.toString()}`)
  expect(media.ok(), `media route: ${media.status()} ${await media.text()}`).toBe(true)

  const htmlPath = encodeHtmlUrl(seededSessionId, join(WORKSPACE_PATH, SEEDED_HTML_FILE))
  const html = await api.get(`${new URL(PAGE_URL).origin}${prefix}${htmlPath}`)
  expect(html.ok(), `html preview: ${html.status()} ${await html.text()}`).toBe(true)

  const uploadUrl = `${constructed.upload}?${new URLSearchParams({
    sessionId: seededSessionId,
    dir: WORKSPACE_PATH,
    relativePath: 'uploaded.txt',
    cwd: WORKSPACE_PATH,
  }).toString()}`
  const uploaded = await api.post(uploadUrl, {
    headers: { 'content-type': 'application/octet-stream' },
    data: Buffer.from('uploaded-via-prefix\n'),
  })
  expect(uploaded.ok(), `upload: ${uploaded.status()} ${await uploaded.text()}`).toBe(true)

  const ping = await api.post(sidebarApi('settings.get'), { data: {} })
  expect(ping.ok(), `host.ts sidebarApi prefix: ${ping.status()}`).toBe(true)

  const wsResult = await page.evaluate(async ({ terminalUrl, sessionId, cwd }) => {
    const url = new URL(terminalUrl)
    url.search = new URLSearchParams({ sessionId, tab: 'terminal:e2e-base-path', cwd }).toString()
    return await new Promise<{ opened: boolean; closedCode: number | null }>((resolve) => {
      const socket = new WebSocket(url.href)
      const timer = window.setTimeout(() => {
        socket.close()
        resolve({ opened: socket.readyState === WebSocket.OPEN, closedCode: null })
      }, 8_000)
      socket.onopen = () => {
        window.clearTimeout(timer)
        socket.close()
        resolve({ opened: true, closedCode: null })
      }
      socket.onclose = (event) => {
        window.clearTimeout(timer)
        resolve({ opened: false, closedCode: event.code })
      }
    })
  }, { terminalUrl: constructed.terminal, sessionId: seededSessionId, cwd: WORKSPACE_PATH })

  expect(
    wsResult.opened || wsResult.closedCode === 1000,
    `terminal websocket under prefix should connect (got ${JSON.stringify(wsResult)})`,
  ).toBe(true)
})
