/**
 * Opt-in perf audit lane — SKIPPED unless `DSH_E2E_AUDIT=1`.
 *
 * Measures, on a real mounted `dsh web` (same scratch-profile boot as
 * scripts/e2e-mount.sh), every sidebar page and the plugin's HTTP routes:
 *
 *   - wall time per page + the interactions users repeat (tree expand, file
 *     open, markdown/mermaid preview, search, git changes + graph + diff,
 *     tasks, side chat, terminal);
 *   - every `/sidebar/*` request's duration (Node-side request/response
 *     events), grouped by route;
 *   - long tasks (>50ms) and DOM size per phase;
 *   - a 10s steady-state request census.
 *
 * Run: `DSH_E2E_AUDIT=1 bash scripts/e2e-mount.sh --grep "audit:"`
 * Numbers, method and the 2026-10-30 verdict live in
 * docs/plans/2026-10-30-perf-audit.md. Print-only: no thresholds — the audit
 * informs a human decision, it does not gate CI.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext, type Locator, type Page, type Request } from '@playwright/test'
import { PAGE_URL, createHostApi, dismissOnboarding, hostRpc, sendFirstMessage } from './host'

/** Opt-in: the mount lane runs every *.e2e.ts, so this file must stay skipped
 *  for everyone who did not ask for an audit. */
const AUDIT_ENABLED = process.env.DSH_E2E_AUDIT === '1'
test.skip(!AUDIT_ENABLED, 'perf audit lane: set DSH_E2E_AUDIT=1 to run it')

/** A FRESH directory per run: a reused path let a stale host/git handle race
 *  the seed's `git commit` (one audit run died on `rev 5`). */
let WORKSPACE = ''

function writeSeedWorkspace(): void {
  WORKSPACE = process.env.DSH_E2E_AUDIT_WORKSPACE ?? mkdtempSync(join(tmpdir(), 'dsh-e2e-audit-'))
  mkdirSync(WORKSPACE, { recursive: true })
  for (let d = 0; d < 30; d++) {
    const dir = join(WORKSPACE, `d${String(d).padStart(2, '0')}`)
    mkdirSync(dir, { recursive: true })
    for (let f = 0; f < 40; f++) writeFileSync(join(dir, `f${String(f).padStart(3, '0')}.md`), `# ${d}/${f}\n`)
  }
  // A node_modules-sized directory. The host caps one level at 1,000 rows and
  // the tree shows its truncation notice, so this exercises the capped render.
  mkdirSync(join(WORKSPACE, 'many'), { recursive: true })
  for (let f = 0; f < 5_000; f++) writeFileSync(join(WORKSPACE, 'many', `m${String(f).padStart(4, '0')}.md`), `# ${f}\n`)
  const big: string[] = ['# Audit Document', '']
  for (let i = 0; i < 20; i++) {
    big.push(`## section ${i}`, '', `BIGPROSE line ${i}`, '', '```mermaid', 'graph TD', `  A${i}[Hello] --> B${i}[World]`, '```', '')
  }
  writeFileSync(join(WORKSPACE, 'big.md'), big.join('\n'))
  writeFileSync(join(WORKSPACE, 'large.txt'), Array.from({ length: 30_000 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n'))
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', WORKSPACE, ...args], { encoding: 'utf8', env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'audit', GIT_AUTHOR_EMAIL: 'audit@example.com',
      GIT_COMMITTER_NAME: 'audit', GIT_COMMITTER_EMAIL: 'audit@example.com',
    } })
  }
  git('init', '-q')
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(WORKSPACE, 'history.md'), `# rev ${i}\n`)
    git('add', '-A')
    git('commit', '-qm', `rev ${i}`)
  }
  // HTML preview assets (relative css/js resolution) and a ~300KB git patch.
  writeFileSync(join(WORKSPACE, 'page.html'), '<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><h1>AUDIT PAGE</h1><script src="./app.js"></script></body></html>')
  writeFileSync(join(WORKSPACE, 'style.css'), 'body { color: #333 }\n/*' + 'x'.repeat(20_000) + '*/\n')
  writeFileSync(join(WORKSPACE, 'app.js'), 'window.__auditPage = 1\n//' + 'y'.repeat(20_000) + '\n')
  const huge = Array.from({ length: 20_000 }, (_, i) => `huge line ${i}`).join('\n')
  writeFileSync(join(WORKSPACE, 'huge.txt'), huge)
  git('add', '-A')
  git('commit', '-qm', 'huge base')
  writeFileSync(join(WORKSPACE, 'huge.txt'), huge.split('\n').map(line => `${line} changed`).join('\n'))
  writeFileSync(join(WORKSPACE, 'history.md'), '# rev 20 modified\n')
  writeFileSync(join(WORKSPACE, 'untracked.md'), '# new\n')
}

const LONG_TASK_PROBE = `(() => {
  window.__lt = []
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__lt.push({ start: entry.startTime, duration: entry.duration })
  }).observe({ entryTypes: ['longtask'] })
})()`

interface Phase { name: string; ms: number; ok: boolean; longtasks: number; longtaskMs: number; heapMB: number; dom: number }
interface Req { route: string; ms: number; status: number }

function summarizeReq(reqs: Req[]): Array<{ route: string; count: number; p50: number; p95: number; max: number }> {
  const groups = new Map<string, number[]>()
  for (const req of reqs) {
    const list = groups.get(req.route) ?? []
    list.push(req.ms)
    groups.set(req.route, list)
  }
  const percentile = (values: number[], p: number): number => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!
  }
  return [...groups.entries()]
    .map(([route, values]) => ({
      route,
      count: values.length,
      p50: Math.round(percentile(values, 50)),
      p95: Math.round(percentile(values, 95)),
      max: Math.round(Math.max(...values)),
    }))
    .sort((a, b) => b.p95 - a.p95)
}

const TAB_NAME: Record<string, RegExp> = {
  files: /^Files$|^文件$/,
  git: /^Git$|^文件变动$|^改动$/,
  subagent: /^Tasks$|^任务$/,
  sidechat: /^Side chat$|^侧边对话$/,
  terminal: /^Terminal$|^终端$/,
}

let api: APIRequestContext
let sessionId = ''

test.beforeAll(async () => {
  if (!AUDIT_ENABLED) return
  writeSeedWorkspace()
  api = await createHostApi()
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE })
  const session = await hostRpc<{ sessionId: string }>(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
  sessionId = session.value.sessionId
})

test.afterAll(async () => { await api?.dispose() })

function paneOf(page: Page): Locator {
  return page.locator('[data-sidebar-right-panel]')
}

function fileRow(page: Page, name: string): Locator {
  return paneOf(page).locator(`[role="button"][title$="${name}"]:visible`).first()
}

async function openTab(page: Page, kind: keyof typeof TAB_NAME): Promise<void> {
  const pane = paneOf(page)
  const tab = pane.getByRole('tab', { name: TAB_NAME[kind] })
  if (await tab.count() > 0) {
    await tab.first().click({ timeout: 10_000 })
    return
  }
  const guide = page.locator('[data-sidebar-right-guide]')
  if (await guide.count() === 0) {
    await page.locator('[data-dockkit-add-tab]').first().click({ timeout: 10_000 })
    await expect(guide).toHaveCount(1, { timeout: 15_000 })
  }
  await page.locator(`[data-sidebar-right-guide-entry="${kind}"]`).click({ timeout: 10_000 })
}

test('audit: every sidebar page and every /sidebar route', async ({ page }) => {
  test.setTimeout(300_000)
  const phases: Phase[] = []
  const requests: Req[] = []
  const startedAt = new Map<Request, number>()

  page.on('request', (request) => {
    if (request.url().includes('/sidebar/')) startedAt.set(request, Date.now())
  })
  const record = (request: Request, status: number): void => {
    const started = startedAt.get(request)
    if (started === undefined) return
    startedAt.delete(request)
    requests.push({ route: new URL(request.url()).pathname, ms: Date.now() - started, status })
  }
  page.on('response', (response) => record(response.request(), response.status()))
  page.on('requestfailed', (request) => record(request, 0))

  const drainLongTasks = async (): Promise<{ count: number; total: number }> => {
    const entries = await page.evaluate(() => {
      const list = (window as unknown as { __lt?: Array<{ duration: number }> }).__lt ?? []
      ;(window as unknown as { __lt?: Array<{ duration: number }> }).__lt = []
      return list
    }).catch(() => [])
    return {
      count: entries.length,
      total: Math.round(entries.reduce((sum, entry) => sum + entry.duration, 0)),
    }
  }

  const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
    console.log(`AUDIT_PHASE_START ${name}`)
    const started = Date.now()
    let ok = true
    let error = ''
    try { await fn() } catch (caught) {
      ok = false
      error = caught instanceof Error ? caught.message.split('\n')[0]! : String(caught)
    }
    const ms = Date.now() - started
    const lt = await drainLongTasks()
    const usage = await page.evaluate(() => ({
      heap: ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / (1024 * 1024),
      dom: document.getElementsByTagName('*').length,
    })).catch(() => ({ heap: 0, dom: 0 }))
    const phase = { name, ms, ok, longtasks: lt.count, longtaskMs: lt.total, heapMB: Math.round(usage.heap), dom: usage.dom }
    phases.push(phase)
    console.log(`AUDIT_PHASE ${JSON.stringify({ ...phase, error })}`)
  }

  await page.addInitScript(LONG_TASK_PROBE)
  await run('boot', async () => {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 60_000 })
    await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 60_000 })
  })

  await run('shell-ready', async () => {
    await dismissOnboarding(page)
    await sendFirstMessage(page)
  })

  await run('files-page', async () => {
    await page.locator('[data-sidebar-right-expand]').first().click()
    await expect(paneOf(page)).toBeVisible({ timeout: 30_000 })
    if (await page.locator('[data-sidebar-right-guide]').count() === 0) {
      await page.locator('[data-dockkit-add-tab]').first().click()
    }
    await page.locator('[data-sidebar-right-guide-entry="files"]').click({ timeout: 10_000 })
    await expect(fileRow(page, 'd00')).toHaveCount(1, { timeout: 30_000 })
  })

  await run('expand-folder', async () => {
    await fileRow(page, 'd00').click({ timeout: 10_000 })
    await expect(fileRow(page, 'f000.md')).toHaveCount(1, { timeout: 30_000 })
  })

  await run('expand-capped-5000-dir', async () => {
    // The host caps one level at 1,000 rows and the tree says so: this phase
    // measures the capped render + the truncation notice.
    await fileRow(page, 'many').click({ timeout: 10_000 })
    const pane = paneOf(page)
    await expect(pane.getByText('This folder has too many entries; only the first ones are shown')).toBeVisible({ timeout: 60_000 })
    await expect(fileRow(page, 'm0999.md')).toHaveCount(1, { timeout: 30_000 })
  })

  await run('search-by-name', async () => {
    const input = paneOf(page).locator('input').first()
    await expect(input).toBeVisible({ timeout: 15_000 })
    // In-page marks: the fetch completion (post-debounce) and the first
    // rendered result row. Their delta is the render cost, not the debounce.
    await page.evaluate(() => {
      const marks = { apiAt: 0, domAt: 0 }
      ;(window as unknown as { __searchMarks: typeof marks }).__searchMarks = marks
      const original = window.fetch
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args)
        const input = args[0]
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('fs.search')) marks.apiAt = performance.now()
        return response
      }
      const observer = new MutationObserver(() => {
        if (marks.domAt !== 0) return
        if (document.querySelector('[class*="editorSearchResult"]') === null) return
        marks.domAt = performance.now()
        observer.disconnect()
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
    const fillAt = await page.evaluate(() => performance.now())
    await input.fill('f01', { timeout: 10_000 })
    await expect(paneOf(page).getByText(/f01\d\.md/).first()).toBeVisible({ timeout: 30_000 })
    const marks = await page.evaluate(() => (window as unknown as { __searchMarks: { apiAt: number; domAt: number } }).__searchMarks)
    const resultCount = await page.evaluate(() => document.querySelectorAll('[class*="editorSearchResult"]').length)
    console.log(`AUDIT_JSON ${JSON.stringify({
      metric: 'search-detail',
      debouncePlusNetworkMs: Math.round(marks.apiAt - fillAt),
      renderMs: Math.round(marks.domAt - marks.apiAt),
      resultCount,
    })}`)
    await input.fill('', { timeout: 10_000 })
  })

  await run('open-markdown+mermaid', async () => {
    await fileRow(page, 'big.md').click({ timeout: 10_000 })
    const pane = paneOf(page)
    await expect(pane.getByText('BIGPROSE line 19').filter({ visible: true })).toHaveCount(1, { timeout: 45_000 })
    await expect(pane.locator('[data-mermaid-diagram] svg').first()).toHaveCount(1, { timeout: 60_000 })
  })

  await run('open-large-file', async () => {
    await openTab(page, 'files')
    await fileRow(page, 'large.txt').click({ timeout: 10_000 })
    await expect(paneOf(page).getByText(/line 0 /).first()).toBeVisible({ timeout: 45_000 })
  })

  await run('git-page', async () => {
    try {
      await openTab(page, 'git')
      await expect(paneOf(page).locator('[data-scm-section="changes"]')).toBeVisible({ timeout: 30_000 })
    } catch (error) {
      const tabs = await paneOf(page).getByRole('tab').allTextContents().catch(() => [])
      const text = await paneOf(page).innerText().catch(() => '')
      console.log(`AUDIT_JSON ${JSON.stringify({ metric: 'git-page-failure', tabs, text: text.slice(0, 300).replace(/\s+/g, ' ') })}`)
      throw error
    }
  })

  await run('git-graph', async () => {
    const header = page.getByRole('button', { name: 'Graph', exact: true }).first()
    if (await header.count() > 0 && await header.getAttribute('aria-expanded') !== 'true') {
      await header.click({ timeout: 10_000 })
    }
    const graph = paneOf(page).locator('[data-git-graph]:visible')
    await expect(graph).toBeVisible({ timeout: 30_000 })
    await expect(graph.getByText('rev 19', { exact: true }).first()).toBeVisible({ timeout: 45_000 })
  })

  await run('open-huge-diff', async () => {
    const pane = paneOf(page)
    const row = pane.locator('[data-scm-section="changes"] [data-row="huge.txt"]').first()
    await row.click({ timeout: 10_000 })
    await expect(pane.locator('[class*="diffPane"]')).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(5_000)
    const info = await page.evaluate(() => {
      const diff = document.querySelector('[class*="diffPane"]') as HTMLElement | null
      return {
        text: (diff?.innerText ?? '').slice(0, 300).replace(/\s+/g, ' '),
        nodes: diff?.getElementsByTagName('*').length ?? 0,
        cmLines: diff?.querySelectorAll('.cm-line').length ?? 0,
        hugeLines: (diff?.innerText ?? '').split('\n').filter(line => line.includes('huge line')).length,
      }
    })
    console.log(`AUDIT_JSON ${JSON.stringify({ metric: 'huge-diff-dom', ...info })}`)
  })

  await run('tasks-page', async () => {
    await openTab(page, 'subagent')
    // Keyless lanes have no jobs/subagents: measure the empty-state render (2s
    // settle) and rely on the captured subagents.live / workflows.list timings.
    await page.waitForTimeout(2_000)
  })

  await run('sidechat-page', async () => {
    await openTab(page, 'sidechat')
    await expect(paneOf(page).locator('[class*="sidechatComposer"]').first()).toBeVisible({ timeout: 15_000 })
  })

  await run('terminal-page', async () => {
    await openTab(page, 'terminal')
    await expect(paneOf(page).locator('.xterm').first()).toBeVisible({ timeout: 20_000 })
  })

  await run('settings-get', async () => {
    const result = await page.evaluate(async () => {
      const started = performance.now()
      const response = await fetch('/sidebar/api/settings.get', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      await response.text()
      return { ms: Math.round(performance.now() - started), status: response.status }
    })
    console.log(`AUDIT_JSON ${JSON.stringify({ metric: 'settings.get', ...result })}`)
  })

  const beforeSteady = requests.length
  await run('steady-state-10s', async () => { await page.waitForTimeout(10_000) })
  const steady = requests.slice(beforeSteady)

  const bundles = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter(entry => /\/sidebar\/bundle\//.test(entry.name))
    .map(entry => ({ name: entry.name.replace(/^https?:\/\/[^/]+/, ''), bytes: (entry as PerformanceResourceTiming).transferSize })))

  console.log(`AUDIT_JSON ${JSON.stringify({ metric: 'phases', phases })}`)
  console.log(`AUDIT_JSON ${JSON.stringify({ metric: 'requests', routes: summarizeReq(requests) })}`)
  console.log(`AUDIT_JSON ${JSON.stringify({ metric: 'steady', routes: summarizeReq(steady) })}`)
  console.log(`AUDIT_JSON ${JSON.stringify({ metric: 'bundles', bundles })}`)
  console.log(`AUDIT_SUMMARY ${phases.map(p => `${p.name}:${p.ms}ms/${p.longtasks}lt`).join(' ')}`)
})
/** Direct route timings for the paths the page flows above do not reach:
 *  media/preview streams, upload/write, a large git diff and blame. */
test('audit: heavy routes', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)

  interface Timing { label: string; ms: number; status: number; bytes: number }
  const results: Timing[] = []

  const callApi = async (label: string, method: string, payload: Record<string, unknown>): Promise<void> => {
    const timing = await page.evaluate(async (input) => {
      const started = performance.now()
      const response = await fetch('/sidebar/api/' + input.method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input.payload, sessionId: input.sessionId }),
      })
      const text = await response.text()
      return { ms: Math.round(performance.now() - started), status: response.status, bytes: text.length }
    }, { method, payload, sessionId })
    results.push({ label, ...timing })
  }

  const getRoute = async (label: string, url: string): Promise<void> => {
    const timing = await page.evaluate(async (target) => {
      const started = performance.now()
      const response = await fetch(target)
      const buffer = await response.arrayBuffer()
      return { ms: Math.round(performance.now() - started), status: response.status, bytes: buffer.byteLength }
    }, url)
    results.push({ label, ...timing })
  }

  const postRoute = async (
    label: string,
    url: string,
    body: { kind: 'text'; text: string } | { kind: 'bytes'; size: number },
  ): Promise<void> => {
    const timing = await page.evaluate(async (target) => {
      const payload = target.body.kind === 'text' ? target.body.text : new Uint8Array(target.body.size)
      const started = performance.now()
      const response = await fetch(target.url, {
        method: 'POST',
        headers: target.body.kind === 'text' ? { 'content-type': 'text/plain; charset=utf-8' } : undefined,
        body: payload,
      })
      const text = await response.text()
      return { ms: Math.round(performance.now() - started), status: response.status, bytes: text.length }
    }, { url, body })
    results.push({ label, ...timing })
  }

  const abs = (name: string): string => WORKSPACE + '/' + name
  const fileUrl = (name: string): string =>
    '/sidebar/file?' + new URLSearchParams({ sessionId, path: abs(name), cwd: WORKSPACE }).toString()
  const htmlUrl = '/sidebar/html/' + encodeURIComponent(sessionId)
    + WORKSPACE.split('/').filter(segment => segment !== '').map(segment => '/' + encodeURIComponent(segment)).join('')
    + '/' + encodeURIComponent('page.html')

  await callApi('fs.read large.txt (1.5MB)', 'fs.read', { path: 'large.txt', cwd: WORKSPACE })
  await callApi('fs.readPage large.txt', 'fs.readPage', { path: 'large.txt', offset: 0, cwd: WORKSPACE })
  await callApi('fs.search f01', 'fs.search', { query: 'f01', cwd: WORKSPACE })
  await callApi('fs.trees 30 paths', 'fs.trees', { paths: Array.from({ length: 30 }, (_, i) => `d${String(i).padStart(2, '0')}`), cwd: WORKSPACE })
  await callApi('git.status', 'git.status', { cwd: WORKSPACE })
  await callApi('git.diff huge.txt (~300KB patch)', 'git.diff', { path: 'huge.txt', staged: false, cwd: WORKSPACE })
  await callApi('git.graph', 'git.graph', { cwd: WORKSPACE })
  await callApi('git.blame history.md', 'git.blame', { path: 'history.md', startLine: 1, endLine: 40, cwd: WORKSPACE })
  await callApi('changes.ops', 'changes.ops', { afterSeq: 0, cwd: WORKSPACE })
  await callApi('settings.get', 'settings.get', {})
  await getRoute('GET /sidebar/file large.txt (1.5MB)', fileUrl('large.txt'))
  await getRoute('GET /sidebar/file big.md', fileUrl('big.md'))
  await getRoute('GET /sidebar/html page.html', htmlUrl)
  await postRoute('POST /sidebar/upload 1MB', '/sidebar/upload?' + new URLSearchParams({
    sessionId, dir: WORKSPACE, relativePath: 'upload-audit.bin', cwd: WORKSPACE,
  }).toString(), { kind: 'bytes', size: 1024 * 1024 })
  await postRoute('POST /sidebar/write 200KB', '/sidebar/write?' + new URLSearchParams({
    sessionId, path: abs('written-audit.txt'), cwd: WORKSPACE,
  }).toString(), { kind: 'text', text: 'z'.repeat(200 * 1024) })

  /** The tree's "download" flow: build (async) → poll → stream the bytes. */
  const archiveDir = async (label: string, dir: string): Promise<void> => {
    const timing = await page.evaluate(async (target) => {
      const post = async (method: string, payload: unknown): Promise<Response> => fetch('/sidebar/api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const started = performance.now()
      const build = await post('archive.build', { sessionId: target.sessionId, paths: [target.dir], name: 'audit' })
      const built = await build.json() as { value?: { id?: string } }
      const id = built.value?.id
      if (id === undefined) return { ms: Math.round(performance.now() - started), status: build.status, bytes: 0, error: 'no id' }
      let state = 'building'
      while (state === 'building' && performance.now() - started < 120_000) {
        await new Promise(resolve => setTimeout(resolve, 50))
        const status = await post('archive.status', { sessionId: target.sessionId, id })
        const body = await status.json() as { value?: { state?: string } }
        state = body.value?.state ?? 'error'
      }
      const download = await fetch('/sidebar/archive?' + new URLSearchParams({ sessionId: target.sessionId, id }))
      const bytes = (await download.arrayBuffer()).byteLength
      return { ms: Math.round(performance.now() - started), status: download.status, bytes, state }
    }, { dir, sessionId })
    results.push({ label, ...timing })
  }
  await archiveDir('archive d00 (40 files)', WORKSPACE + '/d00')
  await archiveDir('archive many (5,000 files)', WORKSPACE + '/many')

  console.log(`AUDIT_JSON ${JSON.stringify({ metric: 'heavy-routes', results })}`)
})