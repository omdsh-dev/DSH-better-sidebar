/**
 * Headless-render mount lane: prove the npm-packed plugin mounts into a real
 * `dsh web` instance and renders without crashing the shell.
 *
 * The server is NOT started here — `scripts/e2e-mount.sh` boots `dsh web`
 * (with the plugin mounted through the official `dsh plugin add` channel) and
 * injects the base URL via `DSH_E2E_URL`. This spec:
 *
 *  1. seeds one workspace + one session through the host's own RPC surface
 *     (the same `workspace.create` / `session.create` calls the UI makes),
 *     so the sidebar has a real session to render;
 *  2. loads the page in headless Chromium and asserts the shell and the
 *     plugin's `[data-dsh-better-sidebar]` host mount;
 *  3. asserts the plugin's crash markers never appear (no RenderBoundary /
 *     fail() strips, no `pageerror`, no plugin-prefixed console errors);
 *  4. expands DSH's native right Sidebar, sweeps every built-in tab type
 *     through its guide page (Files / Changes / Tasks / Terminal / Browser) —
 *     including the lazily-fetched terminal chunk — and then opens seeded
 *     files through the Files window's tree (separate mode: each file opens
 *     its own new tab, the seeded home "Files" tab stays the explorer),
 *     while response waits armed before goto prove the lazily-fetched editor
 *     chunk (client-editor.js) and the mermaid chunk (client-mermaid.js,
 *     rendered SVG diagram + zoom modal) loaded.
 *
 * Deterministic by construction: every wait is on a DOM/network marker, the
 * suite is serial (one server instance), and any crash trips the very next
 * assertion.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { PAGE_URL, createHostApi, gotoPage, hostRpc, sendFirstMessage, sidebarApi } from './host'

/** Workspace the sidebar renders against (created by the lane's seeding). */
const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-workspace')

/** A file seeded into the workspace, opened through the Files window's tree to
 *  exercise the file-open path (editor chunk = client-editor.js). */
const SEEDED_FILE = 'hello.txt'

/** A markdown file with a mermaid fence, opened through the Files window's
 *  tree to force the lazily-packed mermaid chunk (client-mermaid.js) to load
 *  and render a sanitized SVG diagram. */
const SEEDED_MD_FILE = 'diagram.md'

/** A GitHub-style README markdown (badge div, <details> nesting markdown,
 *  inline tags in table cells), opened through the Files window's tree to
 *  prove raw-HTML runs render as sanitized DOM and the TOC outline works. */
const SEEDED_README_FILE = 'readme-style.md'

/**
 * The plugin's crash markers. The client mounts inside an error boundary that
 * renders a strip whose text starts with these prefixes instead of crashing
 * (see src/client/index.tsx `fail()` and src/client/RenderBoundary.tsx).
 */
const CRASH_STRIP_PATTERNS = [/^dsh-better-sidebar:/, /^\[dsh-better-sidebar\]/]

/** Built-in tab titles the sweep drives (en-US copy; follows DSH locale). */
const NATIVE_TABS = ['files', 'git', 'plan', 'subagent', 'sidechat', 'terminal', 'browser']

let api: APIRequestContext
/** The seeded session id (captured by seedSession; the Side Chat smoke's parent). */
let seededSessionId: string

/** Seed one workspace + one session (plus files for the editor/mermaid-chunk
 *  probes) through the host's unary RPC surface. */
async function seedSession(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, SEEDED_FILE), 'hello from the mount lane\n')
  // The mermaid-chunk probe file: a markdown doc whose preview must fetch
  // client-mermaid.js and render the fence into an SVG diagram. The
  // reference-style link's definition sits AFTER the fence: it only
  // resolves when the preview is one single markdown parse (the mermaid
  // path must not split the document into independent MarkdownText blocks).
  writeFileSync(join(WORKSPACE_PATH, SEEDED_MD_FILE), [
    '# Diagram',
    '',
    '[before][shared]',
    '',
    '```mermaid',
    'graph TD',
    '  A[Hello] --> B[World]',
    '```',
    '',
    '[shared]: https://example.com',
    '',
    'tail text',
    '',
  ].join('\n'))
  // The README-style probe file: raw-HTML runs (badge wall div with an
  // embedded script, a <details> nesting a fence + heading) plus inline tags
  // inside a table cell. The script must be sanitized away in the preview.
  writeFileSync(join(WORKSPACE_PATH, SEEDED_README_FILE), [
    '# Readme Style',
    '',
    '<div align="center">',
    '  <img alt="badge" src="https://img.shields.io/badge/x-y-blue" />',
    '  <script>alert(1)</script>',
    '</div>',
    '',
    '## Setup',
    '',
    '[docs link][def]',
    '',
    '<details>',
    '<summary><b>Steps</b></summary>',
    '',
    '### Inside',
    '',
    '```sh',
    'dsh plugin --profile web add x',
    '```',
    '',
    '</details>',
    '',
    '## Table',
    '',
    '| col | note |',
    '| --- | --- |',
    '| alpha | line one<br/>line two |',
    '',
    '[def]: https://example.com/def',
    '',
  ].join('\n'))
  // Seeded through the lanes' dual-protocol RPC helper (./host): 0.1.1-rc.x
  // dot endpoints first, 0.1.2-alpha.1+ slash endpoints on 404 fallback, and
  // the request context carries the auth cookie when the launch URL had a
  // one-time token.
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH })
  const session = await hostRpc<{ sessionId: string }>(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
  seededSessionId = session.value.sessionId
}

test.beforeAll(async () => {
  api = await createHostApi()
  await seedSession()
})

test.afterAll(async () => {
  await api?.dispose()
})

test('plugin mounts into the DSH shell and survives a built-in tab sweep', async ({ page }) => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  // Load the shell. The app renders into #root; the plugin appends its own
  // [data-dsh-better-sidebar] host once its client half activates.
  //
  // The editor chunk (client-editor.js) loads as soon as ANY files-window tab
  // renders — the seeded home tab mounts the moment the panel expands, long
  // before the tree click below — so the response wait must be armed BEFORE
  // goto, or it misses the fetch and times out.
  const editorChunk = page.waitForResponse(
    (response) => response.url().includes('/sidebar/bundle/editor.js'),
    { timeout: 120_000 },
  )
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  // The unified panel host: the fixed containing block every panel lives in
  // (data-dsh-panel-host). Its presence is part of the injection contract.
  await expect(page.locator('[data-dsh-panel-host]')).toBeAttached({ timeout: 90_000 })
  // The host's global z-index is part of the layering contract: it must
  // sit above the AppFrame overlay layer (20) and below DSH's ui-cordis
  // dynamic-plugin panel (fixed, 30) so that surface is never hidden behind
  // the workbench, and below the DSH float stack (100+).
  const hostZ = await page.locator('[data-dsh-panel-host]').evaluate(
    (el) => Number.parseFloat(getComputedStyle(el).zIndex),
  )
  expect(hostZ).toBeGreaterThan(20)
  expect(hostZ).toBeLessThan(30)

  // A keyless boot stacks onboarding takeovers that mask the whole shell: a
  // versioned welcome notice ("Continue", persists its acknowledgement to
  // settings) and, once that is acknowledged, a provider-config dialog
  // ("Configure later", session-only — always present while no credential is
  // configured). Both mount only after the settings join resolves. Wait
  // (bounded) for one to appear; a DSH build without onboarding proceeds
  // straight to the sweep.
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    console.warn('[e2e] no onboarding takeover appeared; proceeding without dismissal')
  }
  // Dismiss whatever takeover is present, in any stacking order, until none
  // remain — a masked click is retried next round instead of failing.
  for (let round = 0; round < 8; round++) {
    let dismissed = false
    for (const name of ['Continue', 'Configure later']) {
      const button = page.getByRole('button', { name, exact: true }).first()
      if ((await button.count()) === 0) continue
      try {
        await button.click({ timeout: 4_000 })
        dismissed = true
        await page.waitForTimeout(1_000)
      } catch {
        // Masked by the takeover stacked above it; the next round tries the
        // other button first.
      }
    }
    if (!dismissed) break
  }

  // The seeded session must give the sidebar a session scope: without it the
  // workbench has no pane to render and the tab sweep is impossible.
  const tabBar = sidebar.locator('[title]')
  await expect(tabBar.first()).toBeAttached({ timeout: 90_000 })

  // Regression: with the panels still COLLAPSED, the document must not grow
  // beyond the viewport. Collapsed panels are slid off-screen with
  // `transform: translate(102%)`, and a transformed element still
  // contributes to its ancestors' scrollable overflow — unclipped, the
  // hidden panels extended the document's scroll area and the whole page
  // became draggable left-right and up-down. The panel host clips at the
  // viewport edge (overflow: hidden), so scrollWidth/scrollHeight must stay
  // within the viewport here. (Assert <= not == : a classic scrollbar
  // narrows clientWidth, so scrollWidth may sit slightly under innerWidth.)
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          overflowX: document.documentElement.scrollWidth <= window.innerWidth,
          overflowY: document.documentElement.scrollHeight <= window.innerHeight,
        })),
      { timeout: 30_000 },
    )
    .toEqual({ overflowX: true, overflowY: true })

  // Crash-marker assertions shared by every step.
  const assertNoCrash = async (): Promise<void> => {
    await expect
      .poll(async () => pageErrors, { timeout: 5_000 })
      .toEqual([])
    // Fail with the actual strip text so a regression is diagnosable from
    // the test report alone (a strip renders the client fail() message).
    const stripTexts = await sidebar.locator('div').evaluateAll(
      (nodes, patterns) => nodes.filter((node) => {
        const text = (node.textContent ?? '').trim()
        return patterns.some((pattern) => pattern.test(text))
      }).map((node) => (node.textContent ?? '').trim()),
      CRASH_STRIP_PATTERNS,
    )
    expect(stripTexts, 'a dsh-better-sidebar error strip is present in the sidebar').toEqual([])
  }

  // The native Sidebar's way in lives in the conversation header's corner,
  // which DSH renders only for a session with content — the seeded session
  // starts blank, so give it one message first.
  await sendFirstMessage(page)

  // The plugin's own surface is the bottom workbench: its expand/collapse
  // control is registered into DSH's session-header utilities (the header's
  // corner belongs to the native sidebar), and the workbench host itself is
  // mounted. Both are stable addressing surfaces for user CSS / presets.
  await expect(page.locator('[data-dsh-bottom-toggle]')).toBeAttached({ timeout: 30_000 })
  await expect(page.locator('[data-dsh-bottom-panel]')).toBeAttached()

  // DSH 0.1.5 owns the right column: the plugin contributes tab TYPES to the
  // host's native right Sidebar instead of drawing its own panel. Open it
  // through the host's own control (the conversation header's corner) and
  // drive the plugin's content from the guide page the surface seeds.
  const pane = page.locator('[data-sidebar-right-panel]')
  const addTab = page.locator('[data-dockkit-add-tab]').first()
  await page.locator('[data-sidebar-right-expand]').first().click()
  await expect(pane).toBeVisible({ timeout: 30_000 })
  await expect(
    page.locator('[data-sidebar-right-guide]'),
    'a freshly expanded surface shows the guide page',
  ).toBeVisible({ timeout: 30_000 })

  // Every built-in descriptor must be registered as a native tab type: the
  // guide lists one entry per type, so a missing entry is a real regression
  // (descriptor removed, registration failed, or the type got disabled).
  for (const kind of NATIVE_TABS) {
    await expect(
      page.locator(`[data-sidebar-right-guide-entry="${kind}"]`),
      `the plugin's native tab type "${kind}" is not offered by the guide`,
    ).toHaveCount(1)
  }

  // Sweep every type through the guide. Each open mounts a real viewer (the
  // terminal fetches its lazy chunk); a failure anywhere surfaces as a
  // pageerror or a crash strip, both of which the next assertion sees. A pane
  // holds one guide tab, so re-seed it through the strip's add control before
  // every pick.
  for (const kind of NATIVE_TABS) {
    if (await page.locator('[data-sidebar-right-guide]').count() === 0) await addTab.click()
    const entry = page.locator(`[data-sidebar-right-guide-entry="${kind}"]`)
    await expect(entry, `guide entry "${kind}" must be reachable`).toHaveCount(1, { timeout: 30_000 })
    await entry.click()
    await page.waitForTimeout(1_500)
    await assertNoCrash()
  }

  // The plan page is served from a lazy chunk (lib/client-plan.js): the sweep
  // above must have fetched it with a 200. A missing or unbundled chunk renders
  // the wrapper's error placeholder instead — not a crash, so assertNoCrash
  // alone would let the page ship broken.
  await expect
    .poll(
      () => page.evaluate(() =>
        performance.getEntriesByType('resource')
          .filter(entry => entry.name.includes('/sidebar/bundle/plan.js'))
          .map(entry => (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus)),
      { timeout: 30_000 },
    )
    .toContain(200)

  // The sweep opened the Side Chat type, whose view auto-creates a thread and
  // polls the transcript — that poll MUST ride the plugin's own
  // sidechat.events route (the host transport this lane locks). The poll runs
  // only while the tab is visible, so activate its chip first.
  await pane.getByRole('tab', { name: /Side Chat|侧边对话|侧边聊天/ }).first().click()
  await expect
    .poll(
      () => page.evaluate(() =>
        performance.getEntriesByType('resource').some(entry => entry.name.includes('/sidebar/api/sidechat.events'))),
      { timeout: 30_000 },
    )
    .toBe(true)

  // The native tab body host is a BLOCK scroller with a definite height, not a
  // flex container, so a tab root that only declares `flex: 1` collapses to its
  // content height — exactly how the side-chat composer used to drift away from
  // the pane bottom. The native adapter wraps every body in a full-height column
  // host; assert the box really fills its pane and the composer sits on the
  // pane's floor. This is the regression guard for that fill contract.
  await expect
    .poll(
      () => page.evaluate(() => {
        const hosts = [...document.querySelectorAll('[data-dsh-native-tab-host]')]
        const host = hosts.find(element => element.getBoundingClientRect().height > 0)
        if (host === undefined) return 'no visible native tab host'
        // The wrapper's parent is the SLOT HOST, which renders with
        // `display: contents` and therefore has no box of its own; the pane
        // body is the first ancestor that actually draws one.
        const view = host.ownerDocument.defaultView
        let paneBody = host.parentElement
        while (paneBody !== null && (view?.getComputedStyle(paneBody).display ?? '') === 'contents') {
          paneBody = paneBody.parentElement
        }
        if (paneBody === null) return 'the native tab host has no boxed ancestor'
        const fillGap = Math.round(paneBody.getBoundingClientRect().height - host.getBoundingClientRect().height)
        if (Math.abs(fillGap) > 2) return `tab body does not fill its pane: gap ${fillGap}px`
        const composer = document.querySelector('[class*="sidechatComposer"]')
        if (composer === null) return 'the side-chat composer is not rendered'
        // The composer's own 8px bottom margin is the only allowed gap.
        const bottomGap = Math.round(paneBody.getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom)
        return bottomGap <= 12 ? 'filled' : `the composer sits ${bottomGap}px above the pane bottom`
      }),
      { timeout: 30_000 },
    )
    .toBe('filled')

  // DSH 0.1.5-rc.1+ renders a guide entry's `description` line only while
  // the guide lists at most 4 entries (`MAX_DESCRIBED_ENTRIES` in the host's
  // GuideBody) — a longer list drops every description and shows titles
  // alone. Shrink the enabled set through the plugin's OWN settings route
  // (scratch-profile prefs only, never the user's) so three types stay
  // enabled (files / sidechat / browser), then require the Files capsule to
  // really grow its description line. This is the host-side proof of the
  // rc.1 description restore: before it every entry was a title-only
  // capsule, so no entry count could ever surface the text.
  const settingsGet = await api.post(sidebarApi('settings.get'), { data: {} })
  expect(settingsGet.ok(), `settings.get: ${settingsGet.status()}`).toBe(true)
  const settingsGetBody = (await settingsGet.json()) as { value?: { tabsEnabled?: Record<string, boolean> } }
  const originalTabsEnabled = settingsGetBody.value?.tabsEnabled ?? {}
  /** The types this check switches off (leaving three entries, i.e. ≤4). */
  const shrunken = ['git', 'plan', 'subagent', 'terminal'] as const
  try {
    // Send the FULL map back (the route's patch is key-wise merged, so a
    // full map is correct whether the host merges or replaces).
    const tabsEnabled: Record<string, boolean> = { ...originalTabsEnabled }
    for (const id of shrunken) tabsEnabled[id] = false
    const tabsUpdate = await api.post(sidebarApi('settings.update'), { data: { patch: { tabsEnabled } } })
    expect(tabsUpdate.ok(), `settings.update (tabsEnabled): ${tabsUpdate.status()} ${await tabsUpdate.text()}`).toBe(true)
    // Re-seed the guide (a pane holds one guide tab) and wait for the
    // shrunken list: the three remaining entries render their descriptions.
    if (await page.locator('[data-sidebar-right-guide]').count() === 0) await addTab.click()
    const filesCapsule = page.locator('[data-sidebar-right-guide-entry="files"]')
    await expect(filesCapsule, 'the Files entry must still be offered after the shrink').toHaveCount(1, { timeout: 30_000 })
    await expect(
      filesCapsule,
      'with ≤4 guide entries the Files capsule must render its description line',
    ).toContainText('workspace tree', { timeout: 30_000 })
    for (const disabled of shrunken) {
      await expect(
        page.locator(`[data-sidebar-right-guide-entry="${disabled}"]`),
        `the disabled "${disabled}" type must leave the guide`,
      ).toHaveCount(0)
    }
  } finally {
    // Restore the profile's original prefs even on failure. The patch merges
    // key-wise, so sending the original map back is NOT enough — the three
    // `false` entries written above would survive. Every key this check
    // touched is restored explicitly (an absent key means enabled, so a key
    // the profile never set goes back to `true`). This lane's later tests
    // (perf.e2e.ts) sweep the guide and would otherwise find types missing.
    const restored: Record<string, boolean> = { ...originalTabsEnabled }
    for (const id of shrunken) restored[id] = originalTabsEnabled[id] ?? true
    const restore = await api.post(sidebarApi('settings.update'), { data: { patch: { tabsEnabled: restored } } })
    expect(restore.ok(), `settings.update (restore tabsEnabled): ${restore.status()} ${await restore.text()}`).toBe(true)
  }

  // Side Chat host-route smoke against the REAL host: create a thread child
  // under the seeded session (custom-seed creation through AgentRegistry),
  // deliver a follow-up, cancel, and release it. The turn itself cannot run
  // (keyless boot has no model route), but admission + creation + the wire
  // envelope must all succeed — this is the deepest functional proof the
  // mount lane can make without a provider, and it is what caught the 0.1.5
  // `sessionPersistence.inspect` removal.
  const start = await api.post(sidebarApi('sidechat.start'), {
    data: { sessionId: seededSessionId, question: 'mount lane smoke' },
  })
  expect(start.ok(), `sidechat.start: ${start.status()} ${await start.text()}`).toBe(true)
  const startBody = (await start.json()) as { ok: boolean; value?: { childId?: string }; error?: { code?: string; message?: string } }
  expect(startBody.ok, `sidechat.start envelope: ${JSON.stringify(startBody)}`).toBe(true)
  const childId = startBody.value?.childId
  expect(childId, 'sidechat.start must return a child session id').toMatch(/^session-/)
  const list = await hostRpc<{ items: Array<{ sessionId: string }> }>(api, 'session.list', {})
  expect(
    list.value.items.some(item => item.sessionId === childId),
    'the thread child must appear in the host session list',
  ).toBe(true)
  const eventsLive = await api.post(sidebarApi('sidechat.events'), { data: { childId } })
  expect(eventsLive.ok(), `sidechat.events (live): ${eventsLive.status()} ${await eventsLive.text()}`).toBe(true)
  const eventsLiveBody = (await eventsLive.json()) as { ok: boolean; value?: { events?: Array<{ type: string }>; live?: unknown[] } }
  expect(eventsLiveBody.ok, `sidechat.events envelope: ${JSON.stringify(eventsLiveBody)}`).toBe(true)
  expect(Array.isArray(eventsLiveBody.value?.events), 'sidechat.events must answer an events array').toBe(true)
  expect(Array.isArray(eventsLiveBody.value?.live), 'sidechat.events must answer a live-delta array').toBe(true)
  for (const method of ['sidechat.prompt', 'sidechat.cancel', 'sidechat.dispose']) {
    const response = await api.post(sidebarApi(method), {
      data: method === 'sidechat.prompt' ? { childId, text: 'follow-up' } : { childId },
    })
    expect(response.ok(), `${method}: ${response.status()} ${await response.text()}`).toBe(true)
  }
  // After dispose the agent is gone: the same read must fall back to the
  // PERSISTED log (the cold path a re-opened tab polls).
  const eventsCold = await api.post(sidebarApi('sidechat.events'), { data: { childId } })
  expect(eventsCold.ok(), `sidechat.events (cold): ${eventsCold.status()} ${await eventsCold.text()}`).toBe(true)

  // The editor chunk (client-editor.js) only loads when the plugin's files
  // window renders. The plugin took the built-in `files` kind over, so the
  // guide's Files entry IS the plugin's explorer: open it and click the seeded
  // file in its tree — the highest-risk surface (CodeMirror chunk + fs routes).
  if (await page.locator('[data-sidebar-right-guide]').count() === 0) await addTab.click()
  await page.locator('[data-sidebar-right-guide-entry="files"]').click()
  const fileRow = pane.locator(`[role="button"][title$="${SEEDED_FILE}"]:visible`)
  await expect(fileRow, `the seeded "${SEEDED_FILE}" file must appear in the plugin's explorer`).toHaveCount(1, { timeout: 30_000 })
  // Click near the row's LEFT edge: hovering reveals an @-reference button at
  // the row's right end, and a center click on a narrow dock lands on it
  // (referencing the file into the composer instead of opening it).
  await fileRow.click({ position: { x: 8, y: 8 } })
  await editorChunk
  await expect(
    pane.locator('.cm-editor').first(),
    'the plugin editor must render the seeded file inside the native tab',
  ).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_500)
  await assertNoCrash()

  // The mermaid chunk (client-mermaid.js) only loads when a previewed markdown
  // file contains a mermaid fence. Open the seeded diagram file from the
  // explorer and require the full round-trip: chunk fetch + sanitized SVG
  // diagram in the preview.
  const mermaidChunk = page.waitForResponse(
    (response) => response.url().includes('/sidebar/bundle/mermaid.js'),
    { timeout: 30_000 },
  )
  await pane.getByRole('tab', { name: /Files|文件/ }).first().click()
  const mdRow = pane.locator(`[role="button"][title$="${SEEDED_MD_FILE}"]:visible`)
  await expect(mdRow, `the seeded "${SEEDED_MD_FILE}" file must appear in the plugin's explorer`).toHaveCount(1, { timeout: 30_000 })
  await mdRow.click({ position: { x: 8, y: 8 } })
  await expect(
    pane.getByText('tail text'),
    'the markdown preview must render the seeded document',
  ).toHaveCount(1, { timeout: 30_000 })
  await mermaidChunk
  await expect(
    pane.locator('[data-mermaid-diagram] svg'),
    'the mermaid fence must render into an SVG diagram in the markdown preview',
  ).toHaveCount(1, { timeout: 30_000 })
  await expect(
    pane.locator('[data-mermaid-diagram]').first(),
    'the diagram node labels must render inside the SVG',
  ).toContainText('Hello', { timeout: 30_000 })
  // Cross-fence semantics: the reference-style link [before][shared] must
  // resolve to the definition that sits AFTER the fence — proof that the
  // preview is a single markdown parse and not per-fence fragments.
  await expect(
    pane.locator('a[href="https://example.com"]').first(),
    'reference-style links with definitions across a mermaid fence must resolve',
  ).toContainText('before', { timeout: 30_000 })
  // Click-to-enlarge: clicking the diagram opens the zoom modal (portalled to
  // document.body), Esc closes it again.
  const modal = page.locator('[data-mermaid-modal]')
  await pane.locator('[data-mermaid-diagram] svg').first().click()
  await expect(modal, 'clicking the diagram must open the zoom modal').toHaveCount(1, { timeout: 10_000 })
  await page.keyboard.press('Escape')
  await expect(modal, 'Esc must close the zoom modal').toHaveCount(0, { timeout: 10_000 })
  await assertNoCrash()

  // README-style markdown (raw-HTML runs + TOC): open the seeded file and
  // require the full round-trip — sanitized HTML leaves (badge image as a real
  // element, active content stripped), markdown nested inside the unclosed
  // <details> run, the inline pass turning the table cell's <br/> into an
  // element, the reference link resolving across the HTML run, and the TOC
  // outline jumping into the collapsed details (auto-expanding it).
  await pane.getByRole('tab', { name: /Files|文件/ }).first().click()
  const readmeRow = pane.locator(`[role="button"][title$="${SEEDED_README_FILE}"]:visible`)
  await expect(
    readmeRow,
    `the seeded "${SEEDED_README_FILE}" file must appear in the plugin's explorer`,
  ).toHaveCount(1, { timeout: 30_000 })
  await readmeRow.click({ position: { x: 8, y: 8 } })
  await expect(
    pane.locator('[data-dsh-html-segment] img[src*="img.shields.io"]'),
    'the badge-wall div must render its image as a real element',
  ).toHaveCount(1, { timeout: 30_000 })
  await expect(
    pane.locator('script'),
    'the embedded <script> must be sanitized away',
  ).toHaveCount(0)
  const details = pane.locator('details')
  await expect(details, 'the details run must render as a real element').toHaveCount(1, { timeout: 30_000 })
  await expect(details.locator('summary'), 'the details summary must render').toHaveCount(1)
  await expect(
    details.locator('h3', { hasText: 'Inside' }),
    'the heading between the details tags must nest inside the element',
  ).toHaveCount(1)
  await expect(
    pane.locator('[data-html-inline] br'),
    'the table cell <br/> must render as a real element',
  ).toHaveCount(1, { timeout: 30_000 })
  await expect(
    pane.locator('a[href="https://example.com/def"]'),
    'reference links must resolve across lifted HTML runs',
  ).toHaveCount(1, { timeout: 30_000 })
  const tocButton = pane.locator('[data-dsh-md-toc]')
  await expect(
    tocButton,
    'the TOC button must appear once the document has enough headings',
  ).toHaveCount(1, { timeout: 30_000 })
  await tocButton.click()
  const tocPanel = pane.locator('[data-dsh-md-toc-panel]')
  await expect(tocPanel, 'the TOC panel must open').toHaveCount(1)
  const insideItem = tocPanel.locator('button', { hasText: 'Inside' })
  await expect(insideItem, 'the nested heading must appear in the outline').toHaveCount(1)
  await insideItem.click()
  await expect(
    details,
    'jumping into a collapsed details must expand it',
  ).toHaveAttribute('open', '')
  await assertNoCrash()

  // The plugin's own console prefix must never appear in errors, and no
  // unhandled rejection may escape the sweep.
  const pluginErrors = consoleErrors.filter((text) => /dsh-better-sidebar|Unhandled/.test(text))
  expect(pluginErrors, 'plugin-prefixed or unhandled console errors during the sweep').toEqual([])
  expect(pageErrors, 'pageerrors during the sweep').toEqual([])

  // Final screenshot: the rendered panel with a session is the lane's proof.
  await page.screenshot({ path: 'test-results/mount-final.png' })
})

test('conservative auto: URL stamps alone never modify the layout; plugin chrome carries the stable data attributes', async ({ page }) => {
  // The official DSH Desktop shell stamps every render URL with
  // dsh-desktop-mode / dsh-desktop-platform. Under the conservative AUTO
  // scheme, shell stamps are REPORTS, not geometry: without the standard
  // Window Controls Overlay API the layout must stay untouched (plain-web
  // semantics) — the strip/body attribute appear only for real standard
  // geometry (see the WCO scenario below) or an opt-in preset.
  await gotoPage(page, { 'dsh-desktop-mode': 'advanced', 'dsh-desktop-platform': 'win32' })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  await expect(
    page.locator('body[data-dsh-title-bar-compat]'),
    'stamps alone must NOT auto-enable title-bar compatibility under auto',
  ).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-title-bar-strip')))
    .toBe('')
  // The stable addressing surface for presets / custom CSS is mounted: the
  // plugin's own host (its bottom workbench and the header toggle live in
  // DSH's session header, which this stamp-only page has no session for —
  // the native-surface sweep asserts those once a session exists).
  await expect(page.locator('[data-dsh-panel-host]')).toBeAttached()
  // The plugin's interactive chrome opts out of Electron drag regions
  // (issues #103/#111) — inert in plain browsers, present in the bundle
  // (the bundler minifies the property's whitespace, so match loosely).
  const hasNoDragRule = await page.evaluate(() => {
    for (const tag of document.querySelectorAll('style')) {
      if (tag.textContent !== null && /-webkit-app-region:\s*no-drag/.test(tag.textContent)) return true
    }
    return false
  })
  expect(hasNoDragRule, 'the bundle must ship the drag-region opt-out rule').toBe(true)
})

test('standard WCO geometry drives the strip reactively (issue #257)', async ({ page }) => {
  // The Window Controls Overlay API is the STANDARD signal for shells that
  // draw the native caption buttons over web content (Electron
  // `titleBarOverlay`). Mock it with the real API shape: the strip must
  // follow the reported rect and react to geometrychange (maximize/restore).
  await page.addInitScript(() => {
    const rect = { x: 0, y: 0, width: 138, height: 36 }
    const listeners = new Set<() => void>()
    Object.defineProperty(navigator, 'windowControlsOverlay', {
      configurable: true,
      value: {
        visible: true,
        getTitlebarAreaRect: () => ({ ...rect }),
        addEventListener: (type: string, listener: () => void) => { if (type === 'geometrychange') listeners.add(listener) },
        removeEventListener: (type: string, listener: () => void) => { if (type === 'geometrychange') listeners.delete(listener) },
      },
    })
    ;(globalThis as { __wcoMock?: { setHeight: (height: number) => void } }).__wcoMock = {
      setHeight: (height: number) => {
        rect.height = height
        for (const listener of listeners) listener()
      },
    }
  })
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  // Real reported height (36px, not a hardcoded 32) drives the strip.
  await expect(page.locator('body[data-dsh-title-bar-compat]')).toBeAttached({ timeout: 90_000 })
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-title-bar-strip')))
    .toBe('36px')
  // Maximize → the overlay reports a zero rect → the strip is removed.
  await page.evaluate(() => (globalThis as { __wcoMock?: { setHeight: (height: number) => void } }).__wcoMock?.setHeight(0))
  await expect(page.locator('body[data-dsh-title-bar-compat]')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-title-bar-strip')))
    .toBe('')
  // Restore → the strip comes back.
  await page.evaluate(() => (globalThis as { __wcoMock?: { setHeight: (height: number) => void } }).__wcoMock?.setHeight(36))
  await expect(page.locator('body[data-dsh-title-bar-compat]')).toBeAttached()
})

test('opt-in shell preset applies its strip when WCO is absent (data-driven, manual)', async ({ request, page }) => {
  // The anywhere-labs DSH Desktop preset (shell-presets.ts) is OPT-IN: under
  // the preset scheme the win32 advanced stamp resolves to its 32px fallback
  // even without the WCO API; auto never does this.
  const update = await request.post(sidebarApi('settings.update'), {
    data: { patch: { titleBarScheme: 'preset', titleBarPresetId: 'dsh-desktop', titleBarCompat: true } },
  })
  expect(update.ok(), `settings.update: ${update.status()}`).toBe(true)
  try {
    await gotoPage(page, { 'dsh-desktop-mode': 'advanced', 'dsh-desktop-platform': 'win32' })
    await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
    await expect(page.locator('body[data-dsh-title-bar-compat]')).toBeAttached({ timeout: 90_000 })
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-title-bar-strip')))
      .toBe('32px')
    // The v1 anywhere-labs preset is PURE STRIP DATA (no extra CSS — the
    // injection mechanism is exercised by the custom-scheme test). Assert
    // the absence explicitly: a future preset that ADDS css would trip
    // here instead of silently shipping unstyled.
    await expect(page.locator('style[data-dsh-preset-css]')).toHaveCount(0)
  } finally {
    // Restore the shared server state for the lanes after this one.
    await request.post(sidebarApi('settings.update'), {
      data: { patch: { titleBarScheme: 'auto', titleBarPresetId: '', customCss: '', titleBarCompat: false } },
    })
  }
})

test('custom scheme injects the user stylesheet live', async ({ request, page }) => {
  const update = await request.post(sidebarApi('settings.update'), {
    data: { patch: { titleBarScheme: 'custom', customCss: 'html { --dsh-e2e-marker: 1; }', titleBarCompat: true } },
  })
  expect(update.ok(), `settings.update: ${update.status()}`).toBe(true)
  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
    await expect(page.locator('style[data-dsh-custom-css="custom"]')).toBeAttached()
    // The injected CSS is live (a custom property the page can read back).
    const marker = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dsh-e2e-marker').trim())
    expect(marker).toBe('1')
  } finally {
    await request.post(sidebarApi('settings.update'), {
      data: { patch: { titleBarScheme: 'auto', titleBarPresetId: '', customCss: '', titleBarCompat: false } },
    })
  }
})
