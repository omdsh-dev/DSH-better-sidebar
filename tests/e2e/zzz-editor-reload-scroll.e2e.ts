/**
 * The editor keeps the reader's place across a reload, in a REAL browser — the
 * one half of this regression a jsdom spec cannot judge, because jsdom has no
 * layout.
 *
 * The header's refresh re-runs the load: `EditorHost` drops the viewer to a
 * loading placeholder and then mounts a fresh one, and `TextEditor` re-creates
 * its CodeMirror view whenever `content` changes. Without a remembered offset
 * the reloaded file comes back at `scrollTop` 0, and the reader has to find
 * their line again by hand.
 *
 * jsdom cannot see this: it keeps a detached element's `scrollTop` (so a
 * teardown read looks deceptively fine there), while a real browser reports 0
 * once the host has detached the scroller — which is exactly why the offset is
 * captured on SCROLL and restored by hand. `tests/editor-scroll-memory.spec.tsx`
 * pins the memory; this lane pins the screen.
 *
 * NOTE (lane order): this spec seeds its own workspace + session, and DSH
 * renders the session that is current — so it must run LAST, after
 * `zz-expand-refresh.e2e.ts` (hence the `zzz-` prefix). A later lane's seeding
 * must never change what an earlier lane's tree shows.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { PAGE_URL, createHostApi, hostRpc, sendFirstMessage } from './host'

/** A workspace of its own, so the file shape is deterministic. */
const WORKSPACE_PATH = process.env.DSH_E2E_EDITOR_SCROLL_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-editor-scroll-workspace')
/** Long enough to scroll inside CodeMirror. */
const LONG_FILE = 'long.txt'
const LONG_LINES = 400

let api: APIRequestContext | undefined

test.beforeAll(async () => {
  api = await createHostApi()
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(
    join(WORKSPACE_PATH, LONG_FILE),
    `${Array.from({ length: LONG_LINES }, (_, index) => `line ${index + 1}`).join('\n')}\n`,
  )
  // Seeded through the lane's dual-protocol RPC helper (./host).
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH })
  await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
})

test.afterAll(async () => {
  await api?.dispose()
})

/**
 * Dismiss the keyless-boot onboarding takeovers (a welcome notice with
 * "Continue", then a provider-config dialog with "Configure later"): they mask
 * the whole shell and swallow the composer click. Mirrors the mount lane — a
 * DSH build without onboarding proceeds straight through.
 */
async function dismissTakeovers(page: Page): Promise<void> {
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    // No takeover on this build; the composer is reachable as it is.
  }
  for (let round = 0; round < 8; round += 1) {
    let dismissed = false
    for (const name of ['Continue', 'Configure later']) {
      const button = page.getByRole('button', { name, exact: true }).first()
      if ((await button.count()) === 0) continue
      try {
        await button.click({ timeout: 4_000 })
        dismissed = true
        await page.waitForTimeout(1_000)
      } catch {
        // Masked by the takeover stacked above; the next round retries.
      }
    }
    if (!dismissed) break
  }
}

/** Load the shell and bring the plugin's explorer (the `files` page) up. */
async function openExplorer(page: Page): Promise<Locator> {
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  await dismissTakeovers(page)
  // DSH renders the right column's expand control in the conversation header,
  // and only for a session that has content — the seeded session starts blank,
  // so give it one message when the control does not show up on its own.
  const expand = page.locator('[data-sidebar-right-expand]').first()
  try {
    await expand.waitFor({ state: 'visible', timeout: 15_000 })
  } catch {
    await sendFirstMessage(page)
  }
  await expand.click()
  if (await page.locator('[data-sidebar-right-guide]').count() === 0) {
    await page.locator('[data-dockkit-add-tab]').first().click()
  }
  await page.locator('[data-sidebar-right-guide-entry="files"]').click()
  return page.locator('[data-sidebar-right-panel]')
}

/** One tree row by the absolute path it shows as its tooltip. */
function rowAt(pane: Locator, relative: string): Locator {
  return pane.locator(`[role="button"][title$="${relative}"]:visible`).first()
}

test('editor: the header refresh keeps the reader at the same line', async ({ page }) => {
  const pane = await openExplorer(page)
  await rowAt(pane, LONG_FILE).click({ position: { x: 8, y: 8 } })
  const editor = page.locator('.cm-editor').first()
  await expect(editor).toBeVisible({ timeout: 30_000 })

  const scroller = page.locator('.cm-scroller').first()
  await scroller.evaluate((element) => { element.scrollTop = 400 })
  const before = await scroller.evaluate((element) => element.scrollTop)
  expect(before, 'the editor must actually be scrolled before the refresh').toBeGreaterThan(0)

  // Arm the reload before the click: the host drops the viewer to its loading
  // placeholder and re-reads the file, so the assertion below waits for the
  // fresh document rather than the old one.
  const reload = page.waitForResponse(
    (response) => response.url().includes('/sidebar/api/fs.read'),
    { timeout: 30_000 },
  )
  await page.getByRole('button', { name: /刷新|Refresh/ }).first().click()
  await reload
  await expect(page.locator('.cm-scroller').first()).toBeVisible({ timeout: 30_000 })

  const after = await page.locator('.cm-scroller').first().evaluate((element) => element.scrollTop)
  expect(after, 'the reloaded file must reopen where the reader was').toBe(before)
})
