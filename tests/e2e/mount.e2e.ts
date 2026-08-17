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
 *  4. sweeps every built-in tab (Explorer / Source Control / Tasks /
 *     Terminal / Browser) — including the lazily-fetched terminal chunk —
 *     and then opens a seeded file through the Explorer to force the
 *     lazily-fetched editor chunk (client-editor.js) to load as well.
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

/** A file seeded into the workspace, opened through the Explorer to force the
 *  lazily-packed editor chunk (client-editor.js) to load. */
const SEEDED_FILE = 'hello.txt'

/**
 * The plugin's crash markers. The client mounts inside an error boundary that
 * renders a strip whose text starts with these prefixes instead of crashing
 * (see src/client/index.tsx `fail()` and src/client/RenderBoundary.tsx).
 */
const CRASH_STRIP_PATTERNS = [/^dsh-better-sidebar:/, /^\[dsh-better-sidebar\]/]

/** Built-in tab titles the sweep drives (en-US copy; follows DSH locale). */
const BUILTIN_TABS = ['Explorer', 'Source Control', 'Tasks', 'Terminal', 'Browser']

let api: APIRequestContext

/** Seed one workspace + one session (plus a file for the editor-chunk probe)
 *  through the host's unary RPC surface. */
async function seedSession(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, SEEDED_FILE), 'hello from the mount lane\n')
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
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })

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
    const strips = await sidebar.locator('div').evaluateAll(
      (nodes, patterns) => nodes.filter((node) => {
        const text = (node.textContent ?? '').trim()
        return patterns.some((pattern) => pattern.test(text))
      }).length,
      CRASH_STRIP_PATTERNS,
    )
    expect(strips, 'a dsh-better-sidebar error strip is present in the sidebar').toBe(0)
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

  // The editor tab is hidden from the + menu — its CodeMirror chunk
  // (client-editor.js) only loads when a file is opened. Exercise that path
  // explicitly: reopen Explorer, open the seeded file, and require the chunk
  // round-trip, so a missing/corrupt editor chunk fails the lane.
  await newTabButton.click()
  const explorerItem = page.getByRole('menuitem', { name: 'Explorer' }).first()
  await expect(explorerItem, 'Explorer must be re-openable for the editor-chunk probe').toHaveCount(1)
  await explorerItem.click()
  const editorChunk = page.waitForResponse(
    (response) => response.url().includes('/sidebar/bundle/editor.js'),
    { timeout: 30_000 },
  )
  const fileRow = sidebar.locator(`[role="button"][title$="${SEEDED_FILE}"]`)
  await expect(fileRow, `the seeded "${SEEDED_FILE}" file must appear in the Explorer tree`).toHaveCount(1, { timeout: 30_000 })
  // The icon theme must serve its assets in the packed profile: the
  // explorer's rows render <img src="/sidebar/icons/<file>.svg">. A
  // response wait can't prove it here — the explorer already mounted (and
  // fetched its icons) during the sweep, and re-focusing the open tab does
  // not re-request the images, so no new /sidebar/icons response fires.
  // Instead: fetch a bundled icon through the plugin route (must be a 200
  // in the real shell) and require the seeded file's row to reference an
  // icon-theme asset in the DOM. Together they prove icons/ ships in the
  // npm package and the route is mounted.
  const iconStatus = await page.evaluate(async () => {
    const response = await fetch('/sidebar/icons/default_file.svg')
    return response.status
  })
  expect(iconStatus, 'the icon asset route must serve in the packed profile').toBe(200)
  const rowIcon = fileRow.locator('img[src*="/sidebar/icons/"]')
  await expect(rowIcon, 'the seeded file row must render an icon-theme image').toHaveCount(1)
  expect(await rowIcon.getAttribute('src'), 'file row icon must point at the icon route').toMatch(/^\/sidebar\/icons\//)
  await fileRow.click()
  await editorChunk
  await page.waitForTimeout(1_500)
  await assertNoCrash()

  // The plugin's own console prefix must never appear in errors, and no
  // unhandled rejection may escape the sweep.
  const pluginErrors = consoleErrors.filter((text) => /dsh-better-sidebar|Unhandled/.test(text))
  expect(pluginErrors, 'plugin-prefixed or unhandled console errors during the sweep').toEqual([])
  expect(pageErrors, 'pageerrors during the sweep').toEqual([])

  // Final screenshot: the rendered panel with a session is the lane's proof.
  await page.screenshot({ path: 'test-results/mount-final.png' })
})
