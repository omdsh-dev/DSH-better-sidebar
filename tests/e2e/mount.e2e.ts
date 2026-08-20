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
 *  4. expands the collapsed panel (openByDefault defaults off), sweeps every
 *     built-in tab (Files / Source Control / Tasks / Terminal / Browser) —
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
import { test, expect, request, type APIRequestContext } from '@playwright/test'

const BASE_URL = process.env.DSH_E2E_URL
if (!BASE_URL) {
  throw new Error('DSH_E2E_URL is not set — boot a DSH web instance with the plugin mounted and point this lane at it (see scripts/e2e-mount.sh)')
}

/** Workspace the sidebar renders against (created by the lane's seeding). */
const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-workspace')

/** A file seeded into the workspace, opened through the Files window's tree to
 *  exercise the file-open path (editor chunk = client-editor.js). */
const SEEDED_FILE = 'hello.txt'

/** A markdown file with a mermaid fence, opened through the Files window's
 *  tree to force the lazily-packed mermaid chunk (client-mermaid.js) to load
 *  and render a sanitized SVG diagram. */
const SEEDED_MD_FILE = 'diagram.md'

/**
 * The plugin's crash markers. The client mounts inside an error boundary that
 * renders a strip whose text starts with these prefixes instead of crashing
 * (see src/client/index.tsx `fail()` and src/client/RenderBoundary.tsx).
 */
const CRASH_STRIP_PATTERNS = [/^dsh-better-sidebar:/, /^\[dsh-better-sidebar\]/]

/** Built-in tab titles the sweep drives (en-US copy; follows DSH locale). */
const BUILTIN_TABS = ['Files', 'Source Control', 'Tasks', 'Terminal', 'Browser']

let api: APIRequestContext

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
  const workspace = await api.post(`${BASE_URL}/api/workspace.create`, {
    data: { type: 'client-request', rpcId: 'e2e-workspace', method: 'workspace.create', payload: { path: WORKSPACE_PATH } },
  })
  expect(workspace.ok(), `workspace.create: ${workspace.status()} ${await workspace.text()}`).toBe(true)
  const workspaceBody = (await workspace.json()) as {
    result: { ok: true; value: { workspace: { workspaceId: string } } } | { ok: false; error: unknown }
  }
  expect(workspaceBody.result.ok).toBe(true)
  const workspaceId = (workspaceBody.result as { value: { workspace: { workspaceId: string } } }).value.workspace.workspaceId

  const session = await api.post(`${BASE_URL}/api/session.create`, {
    data: { type: 'client-request', rpcId: 'e2e-session', method: 'session.create', payload: { workspaceId } },
  })
  expect(session.ok(), `session.create: ${session.status()} ${await session.text()}`).toBe(true)
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: BASE_URL })
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
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  // The unified panel host: the fixed containing block every panel lives in
  // (data-dsh-panel-host). Its presence is part of the injection contract.
  await expect(page.locator('[data-dsh-panel-host]')).toBeAttached({ timeout: 90_000 })

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
  // shell renders a disabled toggle cluster and the tab sweep is impossible.
  const tabBar = sidebar.locator('[title]')
  await expect(tabBar.first()).toBeAttached({ timeout: 90_000 })

  // openByDefault defaults OFF: a fresh session's panel starts collapsed.
  // Expand it through the toggle cluster before the layout push can apply.
  const expandButton = sidebar.getByRole('button', { name: 'Expand sidebar' })
  await expect(expandButton, 'the collapsed toggle cluster must offer the expand button').toHaveCount(1)
  await expandButton.click()

  // The skinning contract is token-driven (AGENTS.md §8): the panels consume
  // `--dsw-alias-bg-layer-1`, so switching a skin re-skins the sidebar with
  // no per-skin code. The layout push variable must be live once the panel
  // mounts (its absence would mean the panel never opened with the session).
  await expect
    .poll(async () => (
      await page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-sidebar-width'))
    ), { timeout: 90_000 })
    .not.toBe('')

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

  // Sweep every built-in tab through the "+" menu (the sidebar's own open-tab
  // affordance, reachable from any pane state). Each open may fetch a lazy
  // chunk (/sidebar/bundle/client-terminal.js / client-editor.js) and mount a
  // real viewer — the highest-risk crash surfaces. The pinned plugin must
  // offer every listed built-in: a missing or renamed descriptor is a real
  // regression and fails the lane loudly instead of silently narrowing the
  // sweep. A failure anywhere surfaces as a pageerror or a console error,
  // both of which the next assertion sees.
  const newTabButton = sidebar.getByRole('button', { name: 'New tab' }).first()
  for (const title of BUILTIN_TABS) {
    await newTabButton.click()
    const item = page.getByRole('menuitem', { name: title }).first()
    await expect(item, `built-in tab "${title}" is not offered by the + menu — descriptor removed or its label changed`).toHaveCount(1)
    await item.click()
    // Let the activation commit (including any lazy-chunk fetch) before the
    // crash assertions run.
    await page.waitForTimeout(1_500)
    await assertNoCrash()
  }

  // The editor chunk (client-editor.js) only loads when a files-window tab
  // renders. Exercise the file-open path explicitly through the Files window's
  // own tree: the seeded home tab ("Files") is already open with its tree
  // panel pinned — activate it from the tab strip, open the seeded file, and
  // require the chunk round-trip (armed before goto), so a missing/corrupt
  // editor chunk fails the lane.
  // Tab-strip tabs carry `draggable="true"`; the always-mounted (hidden)
  // bottom panel's empty-pane welcome cards repeat the + menu labels with
  // `title="Files"`, so a bare `[title="Files"]` match is ambiguous.
  const filesTab = sidebar.locator('[title="Files"][draggable="true"]').first()
  await expect(filesTab, 'the seeded files-window home tab must be in the tab strip').toHaveCount(1)
  await filesTab.click()
  // Inactive tabs stay mounted (display:none); only the ACTIVE files
  // window's tree is visible — match the visible row.
  const fileRow = sidebar.locator(`[role="button"][title$="${SEEDED_FILE}"]:visible`)
  await expect(fileRow, `the seeded "${SEEDED_FILE}" file must appear in the files window's tree`).toHaveCount(1, { timeout: 30_000 })
  // Click near the row's LEFT edge: hovering reveals an @-reference button at
  // the row's right end, and a center click on a narrow dock lands on it
  // (referencing the file into the composer instead of opening it).
  await fileRow.click({ position: { x: 8, y: 8 } })
  await editorChunk
  // Separate-mode default (editorExplorer off): the tree click OPENS A NEW
  // file tab (openSidebarFile, id `editor:<path>`) instead of rewriting the
  // home tab in place. The seeded "Files" home tab stays put — it is the
  // standalone explorer now, not a file window.
  await expect(
    sidebar.locator(`[title="${SEEDED_FILE}"][draggable="true"]`),
    'separate mode opens a new file tab for the tree click',
  ).toHaveCount(1)
  // The seeded home tab survives (separate mode never rewrites it). The
  // sweep's + menu opened a SECOND path-less Files window (each is its own
  // explorer in separate mode), so assert presence, not an exact count.
  await expect(
    sidebar.locator('[title="Files"][draggable="true"]').first(),
    'the seeded files-window home tab must survive the file open',
  ).toHaveCount(1)
  const pathInput = sidebar.locator('input[placeholder^="File path"]:visible')
  await expect(pathInput, 'the file tab header path input shows the opened file').toHaveValue(new RegExp(`${SEEDED_FILE}$`))
  await page.waitForTimeout(1_500)
  await assertNoCrash()

  // The mermaid chunk (client-mermaid.js) only loads when a previewed
  // markdown file contains a mermaid fence. Open the seeded diagram file
  // from the files window's tree and require the full round-trip: chunk
  // fetch + sanitized SVG diagram in the preview, so a missing/corrupt
  // mermaid chunk or a broken render fails the lane. In separate mode the
  // tree click above activated the hello.txt tab, so switch back to the
  // Files explorer first (its tree is the only one visible while active).
  const mermaidChunk = page.waitForResponse(
    (response) => response.url().includes('/sidebar/bundle/mermaid.js'),
    { timeout: 30_000 },
  )
  await sidebar.locator('[title="Files"][draggable="true"]').first().click()
  const mdRow = sidebar.locator(`[role="button"][title$="${SEEDED_MD_FILE}"]:visible`)
  await expect(mdRow, `the seeded "${SEEDED_MD_FILE}" file must appear in the files window's tree`).toHaveCount(1, { timeout: 30_000 })
  await mdRow.click({ position: { x: 8, y: 8 } })
  // Separate mode: the md file opens its own tab (like hello.txt above).
  await expect(
    sidebar.locator(`[title="${SEEDED_MD_FILE}"][draggable="true"]`),
    'separate mode opens a new tab for the markdown file',
  ).toHaveCount(1, { timeout: 30_000 })
  // The markdown PREVIEW must render before the mermaid chunk can be
  // requested — this assertion separates a preview/render regression from a
  // chunk-loading one. (sidebar is already scoped to [data-dsh-better-sidebar].)
  await expect(
    sidebar.getByText('tail text'),
    'the markdown preview must render the seeded document',
  ).toHaveCount(1, { timeout: 30_000 })
  await mermaidChunk
  await expect(
    sidebar.locator('[data-mermaid-diagram] svg'),
    'the mermaid fence must render into an SVG diagram in the markdown preview',
  ).toHaveCount(1, { timeout: 30_000 })
  // Labels must survive as real SVG <text> (htmlLabels stays off so the
  // sanitizer's foreignObject strip cannot eat the node text).
  await expect(
    sidebar.locator('[data-mermaid-diagram]').first(),
    'the diagram node labels must render inside the SVG',
  ).toContainText('Hello', { timeout: 30_000 })
  // Cross-fence semantics: the reference-style link [before][shared] must
  // resolve to the definition that sits AFTER the fence — proof that the
  // preview is a single markdown parse and not per-fence fragments.
  await expect(
    sidebar.locator('a[href="https://example.com"]').first(),
    'reference-style links with definitions across a mermaid fence must resolve',
  ).toContainText('before', { timeout: 30_000 })
  // Click-to-enlarge: clicking the diagram opens the zoom modal (portalled
  // to document.body), Esc closes it again.
  const modal = page.locator('[data-mermaid-modal]')
  await sidebar.locator('[data-mermaid-diagram] svg').first().click()
  await expect(modal, 'clicking the diagram must open the zoom modal').toHaveCount(1, { timeout: 10_000 })
  await page.keyboard.press('Escape')
  await expect(modal, 'Esc must close the zoom modal').toHaveCount(0, { timeout: 10_000 })
  // The preview/edit toggle is mutually exclusive: in preview mode the
  // CodeMirror surface must be hidden (regression guard — a stale css copy
  // in the page made the editor stay visible under the preview, breaking
  // the toggle semantics).
  await expect(
    sidebar.locator('.cm-editor').first(),
    'preview mode must hide the CodeMirror editor (mutually exclusive toggle)',
  ).toBeHidden()
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
  await page.goto(`${BASE_URL}?dsh-desktop-mode=advanced&dsh-desktop-platform=win32`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  await expect(
    page.locator('body[data-dsh-title-bar-compat]'),
    'stamps alone must NOT auto-enable title-bar compatibility under auto',
  ).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-title-bar-strip')))
    .toBe('')
  // The stable addressing surface for presets / custom CSS is mounted.
  await expect(page.locator('[data-dsh-toggle-cluster]')).toBeAttached()
  await expect(page.locator('[data-dsh-panel]').first()).toBeAttached()
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
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
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
  const update = await request.post(`${BASE_URL}/sidebar/api/settings.update`, {
    data: { patch: { titleBarScheme: 'preset', titleBarPresetId: 'dsh-desktop', titleBarCompat: true } },
  })
  expect(update.ok(), `settings.update: ${update.status()}`).toBe(true)
  try {
    await page.goto(`${BASE_URL}?dsh-desktop-mode=advanced&dsh-desktop-platform=win32`, { waitUntil: 'domcontentloaded' })
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
    await request.post(`${BASE_URL}/sidebar/api/settings.update`, {
      data: { patch: { titleBarScheme: 'auto', titleBarPresetId: '', customCss: '', titleBarCompat: false } },
    })
  }
})

test('custom scheme injects the user stylesheet live', async ({ request, page }) => {
  const update = await request.post(`${BASE_URL}/sidebar/api/settings.update`, {
    data: { patch: { titleBarScheme: 'custom', customCss: 'html { --dsh-e2e-marker: 1; }', titleBarCompat: true } },
  })
  expect(update.ok(), `settings.update: ${update.status()}`).toBe(true)
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
    await expect(page.locator('style[data-dsh-custom-css="custom"]')).toBeAttached()
    // The injected CSS is live (a custom property the page can read back).
    const marker = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dsh-e2e-marker').trim())
    expect(marker).toBe('1')
  } finally {
    await request.post(`${BASE_URL}/sidebar/api/settings.update`, {
      data: { patch: { titleBarScheme: 'auto', titleBarPresetId: '', customCss: '', titleBarCompat: false } },
    })
  }
})
