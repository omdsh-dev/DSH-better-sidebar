/**
 * Real dual-plugin lane: `dsh-better-sidebar` + the REAL `dsh-context@0.72.0`
 * mounted side by side into one scratch `dsh web` profile (see
 * `scripts/e2e-context.sh`), driven headless by Chromium.
 *
 * What it proves, and how — the three entry points of
 * `src/client/context-diagnostics-ui.tsx` against the REAL third-party plugin
 * (never a stub of it):
 *
 *  1. `session` (the session header's utilities row) — renders only while the
 *     `dsh-context` tab type AND its keyed body are both registered, opens the
 *     Context view of the CURRENT session, and REUSES the pane's existing
 *     Context tab instead of minting a second one;
 *  2. `agent` (an agent card's detail popover on the Tasks page) — opens the
 *     CHILD conversation's Context view: the controller switches the mounted
 *     session to the child and focuses the child's own Context pane, which is
 *     a different host-owned subtree from the parent's;
 *  3. `job` (a background job's output window) — targets the job's REAL
 *     `owner`, not the session the reader happens to be on.
 *
 * The `no-context` variant of the same spec boots the SAME profile shape
 * WITHOUT dsh-context and proves the entries and the tab type are simply
 * absent (the plugin still mounts).
 *
 * Provenance of the data (stated plainly, because it is not model execution):
 * the parent session is created by this spec through the public
 * `session/create` RPC; the child session and the background job are seeded by
 * the lane's host fixture (`./context-fixture-plugin.mjs`, installed ONLY into
 * the lane's scratch profile) through the host's public `ctx.agents` /
 * `ctx.jobs` services, with the standard version-3 `subagent/descriptor` seed.
 * No agent turn is started: content is appended as fixture data, so nothing
 * here claims a real model execution ran.
 *
 * Not covered here (see the lane report): the controller's 10 s deadline, the
 * user-navigation cancel and the continue-after-source-unmount paths need a
 * target that never becomes ready or a precisely timed navigation; they are
 * covered by `tests/context-diagnostics.spec.ts` on a real cordis lifecycle
 * instead of being raced here.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { createHostApi, gotoPage } from './host'
import {
  ALERT_SELECTOR,
  CHILD_LABEL,
  CHILD_SESSION_ID,
  CONTEXT_INSIGHTS_LABEL,
  CONTEXT_KIND,
  CONTEXT_TAB_NAME,
  DASHBOARD_CARD,
  JOB_LABEL,
  PARENT_SESSION_ID,
  activeTabTexts,
  dismissOnboarding,
  entrySelector,
  expectActiveTab,
  onScreenCount,
  openGuideEntry,
  seedParentSession,
  sessionOwner,
  sessionRow,
} from './context-fixture'

/** The dedicated runner selects dual, tab-only, or no-context. */
const VARIANT = process.env.DSH_E2E_CONTEXT_VARIANT
test.skip(VARIANT === undefined, 'requires the dedicated Context integration profile')

/** The lane's workspace (the script owns the directory). */
const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-context-workspace')

let api: APIRequestContext

test.beforeAll(async () => {
  api = await createHostApi()
  await seedParentSession(api, WORKSPACE_PATH)
})

test.afterAll(async () => {
  await api?.dispose()
})

/**
 * The header's utilities row is live: the blank-session lane documents that
 * DSH 0.2.0 draws the header's utilities only for a session with content (in
 * the blank state the plugin's own dock fallback stands in) — and that row is
 * exactly where the `session` entry rides.
 */
async function expectHeaderRowLive(page: Page): Promise<void> {
  await expect(page.locator('[data-dsh-bottom-toggle]').first()).toBeVisible({ timeout: 60_000 })
  await expect(
    page.locator('[data-dsh-dock-fallback]'),
    'the session must have left the blank state (header utilities row live)',
  ).toHaveCount(0, { timeout: 60_000 })
}

/** Collect the shell's crash markers for the frame. */
function watchFrame(page: Page): { pageErrors: string[]; consoleErrors: string[] } {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  return { pageErrors, consoleErrors }
}

/** Load the shell and wait for the plugin's host element. */
async function boot(page: Page): Promise<void> {
  await gotoPage(page)
  await dismissOnboarding(page)
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
}

/**
 * Mount one seeded session in the main column through the host's own workspace
 * tree (`data-row-key="session:<id>"`, `role="treeitem"`: click = open). The
 * blank-session lane documents that the session's header only grows its
 * utilities row once the conversation has content, so the caller sends a first
 * message afterwards.
 */
async function mountSession(page: Page, sessionId: string): Promise<void> {
  const row = sessionRow(page, sessionId)
  await expect(
    row,
    `host session row [data-row-key="session:${sessionId}"] must be visible in the workspace tree `
    + '(if this fails, check whether the shell renders/expands the workspace tree by default — '
    + 'the lane needs the host’s own row to open the seeded session)',
  ).toBeVisible({ timeout: 60_000 })
  await row.click()
  await expect(row, `clicking the row must open ${sessionId}`).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
}

test('without dsh-context the diagnostics entries never render', async ({ page }) => {
  test.skip(VARIANT !== 'no-context', 'dual variant: covered by the next test')
  const { pageErrors, consoleErrors } = watchFrame(page)

  await boot(page)
  await mountSession(page, PARENT_SESSION_ID)
  await expectHeaderRowLive(page)

  // The third-party tab type is genuinely absent from this profile …
  await page.locator('[data-sidebar-right-expand]').first().click()
  if (await page.locator('[data-sidebar-right-guide]').count() === 0) {
    await page.locator('[data-dockkit-add-tab]').first().click()
  }
  await expect(page.locator('[data-sidebar-right-guide]')).toBeVisible({ timeout: 30_000 })
  await expect(
    page.locator(`[data-sidebar-right-guide-entry="${CONTEXT_KIND}"]`),
    'dsh-context must NOT be installed in this variant',
  ).toHaveCount(0)

  // … so no entry point of any kind may render (not one, not a disabled one).
  await expect(page.locator('[data-dsh-ctx-entry]'), 'no entry may render without dsh-context').toHaveCount(0)
  await expect(page.locator(ALERT_SELECTOR), 'no alert may render without dsh-context').toHaveCount(0)

  expect(pageErrors, 'uncaught page errors').toEqual([])
  expect(consoleErrors, 'console errors').toEqual([])
})

test('with dsh-context placed as a conversation view only, the entries hide', async ({ page }) => {
  test.skip(VARIANT !== 'tab-only', 'the tab-only variant of the same profile shape')
  const { pageErrors, consoleErrors } = watchFrame(page)

  await boot(page)
  await mountSession(page, PARENT_SESSION_ID)
  await expectHeaderRowLive(page)

  // dsh-context IS mounted — its placement-independent Context Insights panel
  // entry is on the host's panel list — but this profile was configured (with
  // the plugin's own `defaultPlacement: tab` setting) to keep its Context view
  // in the conversation and to register NO right-column tab type …
  await expect(
    page.getByRole('button', { name: CONTEXT_INSIGHTS_LABEL }).first(),
    'dsh-context must still be mounted in this variant (its Insights panel entry proves it)',
  ).toBeVisible({ timeout: 60_000 })

  await page.locator('[data-sidebar-right-expand]').first().click()
  if (await page.locator('[data-sidebar-right-guide]').count() === 0) {
    await page.locator('[data-dockkit-add-tab]').first().click()
  }
  await expect(page.locator('[data-sidebar-right-guide]')).toBeVisible({ timeout: 30_000 })
  await expect(
    page.locator(`[data-sidebar-right-guide-entry="${CONTEXT_KIND}"]`),
    'defaultPlacement=tab must leave the right column without the dsh-context type',
  ).toHaveCount(0)

  // … so no entry point of any kind may render — the controller's own rule is
  // "the tab type AND its keyed body, or nothing".
  await expect(page.locator('[data-dsh-ctx-entry]'), 'no entry may render without the type').toHaveCount(0)
  await expect(page.locator(ALERT_SELECTOR), 'no alert may render without the type').toHaveCount(0)

  expect(pageErrors, 'uncaught page errors').toEqual([])
  expect(consoleErrors, 'console errors').toEqual([])
})

test('the three entries drive the REAL dsh-context view for parent and child', async ({ page }) => {
  test.skip(VARIANT !== 'dual', 'no-context variant: covered by the previous test')
  const { pageErrors, consoleErrors } = watchFrame(page)
  const details = new Map<string, unknown>()
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/api/dsh-context/detail') return
    const request = response.request()
    if (request.method() !== 'POST') return
    const sessionId = (request.postDataJSON() as { sessionId: string }).sessionId
    void response.json().then(
      (body: unknown) => { details.set(sessionId, body) },
      (error: unknown) => { consoleErrors.push(String(error)) },
    )
  })

  await boot(page)
  await mountSession(page, PARENT_SESSION_ID)
  await expectHeaderRowLive(page)

  // ── 0. The real third-party plugin is mounted ─────────────────────────────
  // Its own guide row opens its tab; this is the ground truth the entries must
  // ride on (and it also opens the parent's Context pane, so the `session`
  // entry below exercises the REUSE branch).
  const pane = await openGuideEntry(page, CONTEXT_KIND)
  const parent = sessionOwner(page, PARENT_SESSION_ID)
  await expectActiveTab(parent, CONTEXT_TAB_NAME)
  await expect(
    parent.getByText(DASHBOARD_CARD).first(),
    'the real dsh-context dashboard must render inside the parent session owner',
  ).toBeVisible({ timeout: 30_000 })
  expect(await pane.count(), 'the native right panel must exist').toBeGreaterThan(0)
  const contextTabs = parent.getByRole('tab').filter({ hasText: CONTEXT_TAB_NAME })
  const tabsBefore = await contextTabs.count()
  expect(tabsBefore, 'opening the Context guide entry must create its tab').toBeGreaterThan(0)

  // ── 1. `session`: the header utilities entry reuses the current pane ─────
  // Select another type first, so the entry has something to re-focus.
  await openGuideEntry(page, 'files')
  await expect.poll(async () => (await activeTabTexts(parent)).join('|'), { timeout: 30_000 }).not.toMatch(CONTEXT_TAB_NAME)

  const sessionEntry = page.locator(entrySelector('session'))
  await expect.poll(() => onScreenCount(page, entrySelector('session')), {
    timeout: 60_000,
    message: 'exactly one session entry must be on screen for the mounted session',
  }).toBe(1)
  await sessionEntry.click()
  await expectActiveTab(parent, CONTEXT_TAB_NAME)

  // Reuse, not mint: this session's pane gains no second Context tab.
  await expect(
    contextTabs,
    'the entry must focus the existing Context tab, never mint a second one',
  ).toHaveCount(tabsBefore)
  await expect(page.locator(ALERT_SELECTOR), 'a successful open must not alert').toHaveCount(0)

  // ── 2. `agent`: a child agent's detail popover opens the CHILD's view ────
  await openGuideEntry(page, 'subagent')
  const childCard = page.locator(`[data-graph-node="${CHILD_SESSION_ID}"]`)
  const completed = page.getByRole('button', { name: /^(Expand the completed nodes|展开已完成的节点)$/ })
  await expect(childCard.or(completed).first()).toBeVisible({ timeout: 60_000 })
  if (await completed.isVisible()) await completed.click()
  await expect(
    childCard,
    `the fixture child "${CHILD_LABEL}" must be a node of the parent's topology`,
  ).toBeVisible({ timeout: 60_000 })
  await childCard.click()

  const agentEntry = page.locator(entrySelector('agent'))
  await expect(agentEntry, 'the agent detail popover must offer the Context entry').toBeVisible({ timeout: 30_000 })
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('context-agent.png') })
  await agentEntry.click()
  await expect(agentEntry, 'the source detail popover must close').toHaveCount(0)

  const child = sessionOwner(page, CHILD_SESSION_ID)
  await expectActiveTab(child, CONTEXT_TAB_NAME)
  await expect(child.getByText(DASHBOARD_CARD).first()).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => details.get(CHILD_SESSION_ID), { timeout: 30_000 }).toMatchObject({
    ok: true,
    value: { nodes: expect.arrayContaining([expect.objectContaining({ text: 'E2E_CHILD_CONTEXT_MARKER' })]) },
  })
  expect(JSON.stringify(details.get(CHILD_SESSION_ID))).not.toContain('E2E_PARENT_CONTEXT_MARKER')
  await expect.poll(() => details.get(PARENT_SESSION_ID), { timeout: 30_000 }).toMatchObject({
    ok: true,
    value: { nodes: expect.arrayContaining([expect.objectContaining({ text: 'E2E_PARENT_CONTEXT_MARKER' })]) },
  })

  // Focus really moved: the CHILD's right column is the one on screen.
  await expect.poll(() => onScreenCount(page, `[data-sidebar-right-session="${CHILD_SESSION_ID}"]`), {
    timeout: 30_000,
    message: 'the controller must switch the mounted session to the child',
  }).toBeGreaterThan(0)
  await expect.poll(() => onScreenCount(page, `[data-sidebar-right-session="${PARENT_SESSION_ID}"]`), {
    timeout: 30_000,
    message: 'the parent column must leave the screen once the child is mounted',
  }).toBe(0)
  await expect(page.locator(ALERT_SELECTOR), 'a successful child open must not alert').toHaveCount(0)

  // ── 3. `job`: the entry targets the job's REAL owner (the parent) ────────
  // The reader is on the CHILD now and the job is owned by the PARENT, so the
  // entry can only succeed by resolving `job.owner`. The Tasks page is
  // per-session chrome: reopen it in the CHILD's pane (native tabs are keyed
  // per session — the parent's copy is parked, not on screen).
  await openGuideEntry(page, 'subagent', CHILD_SESSION_ID)
  const jobRow = child.getByRole('button', { name: new RegExp(`^${JOB_LABEL}`) })
  await expect(
    jobRow,
    'the fixture job (owned by the parent) must appear in the tree’s jobs drawer',
  ).toBeVisible({ timeout: 60_000 })
  await jobRow.click()

  const jobWindow = page.getByRole('dialog').filter({ hasText: JOB_LABEL }).last()
  await expect(jobWindow, 'the job output window must open').toBeVisible({ timeout: 30_000 })
  const jobEntry = jobWindow.locator(entrySelector('job'))
  await expect(jobEntry, 'the job window must offer the Context entry').toBeVisible({ timeout: 30_000 })
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('context-job.png') })
  await jobEntry.click()
  await expect(jobWindow, 'the source output window must close').toHaveCount(0)

  await expectActiveTab(parent, CONTEXT_TAB_NAME)
  await expect.poll(() => onScreenCount(page, `[data-sidebar-right-session="${PARENT_SESSION_ID}"]`), {
    timeout: 30_000,
    message: 'the job entry must bring the OWNER session (the parent) back on screen',
  }).toBeGreaterThan(0)
  await expect.poll(() => onScreenCount(page, `[data-sidebar-right-session="${CHILD_SESSION_ID}"]`), {
    timeout: 30_000,
    message: 'the mounted child column must leave the screen after the owner switch',
  }).toBe(0)
  await expect(page.locator(ALERT_SELECTOR), 'a successful job open must not alert').toHaveCount(0)

  // Both conversations retain their own tab identity. dsh-context does not
  // request keepMounted, so its inactive body is intentionally unmounted.
  await expectActiveTab(parent, CONTEXT_TAB_NAME)
  await expect(child.getByRole('tab', { includeHidden: true }).filter({ hasText: CONTEXT_TAB_NAME })).toHaveCount(1)
  await expect(contextTabs, 'returning to the owner must reuse its Context tab').toHaveCount(tabsBefore)
  await expect(
    parent.getByText(DASHBOARD_CARD).first(),
    'the parent Context pane must still render its dashboard',
  ).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('context-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath('context-narrow.png') })

  expect(pageErrors, 'uncaught page errors').toEqual([])
  expect(consoleErrors, 'console errors').toEqual([])
})
