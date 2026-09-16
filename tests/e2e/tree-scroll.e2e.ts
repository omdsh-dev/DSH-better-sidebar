/**
 * The explorer's scroll position across tab switches, on a REAL host.
 *
 * The comment this lane answers (PR #637): "打开过的侧栏「文件」，滚动位置跨切换
 * 也保留". The native right Sidebar mounts ONE tab body per pane, so looking at
 * another tab unmounts the tree; without a memory the reader is returned to the
 * root. The unit spec (tests/tree-scroll-memory.spec.tsx) pins the logic against
 * stubbed geometry — this lane proves it in the browser, where the tree loads
 * its levels asynchronously and the body has real layout.
 *
 * Determinism: the workspace is seeded with enough root entries that the tree
 * always overflows its pane (scrollHeight > clientHeight), the scroll is written
 * directly (a programmatic `scrollTop` assignment fires the same `scroll` event
 * a wheel does), and every wait is on a DOM/poll marker.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { PAGE_URL, createHostApi, hostRpc, sendFirstMessage } from './host'

/** This lane's own workspace (lanes run serially against one server). */
const WORKSPACE_PATH = process.env.DSH_E2E_SCROLL_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-scroll-workspace')

/** Rows seeded into the root: 34px each, so the tree overflows any pane. */
const ROOT_FILES = 80

/** The offset written before switching away (well inside the scroll range). */
const SCROLL_TO = 320

let api: APIRequestContext

async function seedSession(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  for (let index = 0; index < ROOT_FILES; index++) {
    writeFileSync(join(WORKSPACE_PATH, `seed-${String(index).padStart(3, '0')}.txt`), `row ${index}\n`)
  }
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH })
  await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
}

test.beforeAll(async () => {
  api = await createHostApi()
  await seedSession()
})

test.afterAll(async () => {
  await api?.dispose()
})

/** Dismiss whatever onboarding takeover is present (the other lanes' dance). */
async function dismissOnboarding(page: Page): Promise<void> {
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    console.warn('[e2e-scroll] no onboarding takeover appeared; proceeding')
  }
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
        // Masked by the takeover stacked above; retry in the next round.
      }
    }
    if (!dismissed) break
  }
}

/** The scrollable tree body, found by its CSS-module class (hashed prefix). */
function treeBody(page: Page) {
  return page.locator('[class*="explorerBody"]').first()
}

test('the explorer keeps its scroll position across a native tab switch', async ({ page }) => {
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)
  // DSH renders the native Sidebar's way in only for a session with content.
  await sendFirstMessage(page)

  // Open the native right Sidebar and pick the Files entry in its guide.
  const pane = page.locator('[data-sidebar-right-panel]')
  await page.locator('[data-sidebar-right-expand]').first().click()
  await expect(pane).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-sidebar-right-guide]')).toBeVisible({ timeout: 30_000 })
  await page.locator('[data-sidebar-right-guide-entry="files"]').click()

  const row = pane.locator(`[role="button"][title$="seed-000.txt"]:visible`)
  await expect(row, 'the seeded root files must appear in the plugin explorer').toHaveCount(1, { timeout: 30_000 })

  const body = treeBody(page)
  await expect(body).toBeVisible({ timeout: 30_000 })
  // The pane must really be scrollable, or the assertion below is vacuous.
  await expect
    .poll(() => body.evaluate(el => el.scrollHeight - el.clientHeight), { timeout: 30_000 })
    .toBeGreaterThan(100)

  // Scroll the way a reader does (the assignment fires a real scroll event).
  await body.evaluate((el, top) => { el.scrollTop = top }, SCROLL_TO)
  await expect.poll(() => body.evaluate(el => el.scrollTop), { timeout: 10_000 }).toBe(SCROLL_TO)

  // Look at another tab: the native pane mounts only the active tab's body, so
  // this unmounts the tree (the leaving tab stays open).
  await page.locator('[data-dockkit-add-tab]').first().click()
  await expect(page.locator('[data-sidebar-right-guide]')).toBeVisible({ timeout: 30_000 })
  await expect(body, 'the tree must be gone while another tab is active').toHaveCount(0)

  // Come back to Files and require the reader's place, not the root. The tree
  // reloads its level asynchronously, so the restore lands once the body can
  // hold the offset — poll rather than asserting on the first frame.
  await pane.getByRole('tab', { name: /Files|文件/ }).first().click()
  await expect(pane.locator(`[role="button"][title$="seed-000.txt"]:visible`)).toHaveCount(1, { timeout: 30_000 })
  await expect
    .poll(() => treeBody(page).evaluate(el => el.scrollTop), { timeout: 30_000 })
    .toBe(SCROLL_TO)

  await page.screenshot({ path: 'test-results/tree-scroll-restored.png' })
})
