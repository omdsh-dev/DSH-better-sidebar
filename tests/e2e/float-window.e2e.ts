/**
 * Free-window lane (v0.16.0): against a real `dsh web` instance with the
 * npm-packed plugin mounted (scripts/e2e-mount.sh, DSH_E2E_URL).
 *
 *  1. The tab context menu's "Move to Free Window" floats the seeded Files
 *     tab: `[data-dsh-float-window]` mounts and the tab leaves the strip.
 *  2. The header drag moves the window (geometry committed to the session
 *     state).
 *  3. A reload restores the window from the persisted session state.
 *  4. The header context menu's "Dock Back to Sidebar" returns the tab to
 *     the workbench and removes the window.
 *  5. The drag-out gesture itself (HTML5 DnD onto the conversation column)
 *     floats another tab with the hint overlay showing mid-drag.
 *
 * Crash discipline mirrors the mount lane: pageerror / plugin console errors
 * / dsh-better-sidebar strips fail the test at every step.
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { PAGE_URL, createHostApi, hostRpc } from './host'

const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-float-workspace')

const CRASH_STRIP_PATTERNS = [/^dsh-better-sidebar:/, /^\[dsh-better-sidebar\]/]

let api: APIRequestContext

async function seedSession(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
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

/** Dismiss DSH's first-run takeovers (onboarding modal etc.): stacked masks
 *  would intercept every subsequent pointer interaction. They mount only
 *  after the settings join resolves (seconds after load — also after a
 *  reload), so first wait bounded for one to appear, then sweep until none
 *  remain. Mirrors the mount lane's dance. */
async function dismissTakeovers(page: Page): Promise<void> {
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    return // A DSH build without onboarding takeovers: nothing to sweep.
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
        // Masked by a takeover stacked above; the next round retries.
      }
    }
    if (!dismissed) break
  }
}

/** Load the shell, dismiss onboarding takeovers, and expand the panel.
 *  Returns the sidebar host locator. (An arrow const, not a hoisted function
 *  declaration, so the module-level PAGE_URL narrowing carries in.) */
const bootExpanded = async (page: Page): Promise<ReturnType<Page['locator']>> => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  await dismissTakeovers(page)
  await expect(sidebar.locator('[title]').first()).toBeAttached({ timeout: 90_000 })
  const expandButton = sidebar.getByRole('button', { name: 'Expand sidebar' })
  if ((await expandButton.count()) === 1) await expandButton.click()
  await expect
    .poll(async () => (
      await page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-sidebar-width'))
    ), { timeout: 90_000 })
    .not.toBe('')
  expect(pageErrors, 'page errors during boot').toEqual([])
  expect(consoleErrors.filter(text => text.includes('dsh-better-sidebar')), 'plugin console errors during boot').toEqual([])
  return sidebar
}

/** The crash assertions shared by every step (mount-lane discipline). */
async function assertNoCrash(page: Page): Promise<void> {
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  const stripTexts = await sidebar.locator('div').evaluateAll(
    (nodes, patterns) => nodes.filter((node) => {
      const text = (node.textContent ?? '').trim()
      return patterns.some((pattern) => pattern.test(text))
    }).map((node) => (node.textContent ?? '').trim()),
    CRASH_STRIP_PATTERNS,
  )
  expect(stripTexts, 'a dsh-better-sidebar error strip is present').toEqual([])
}

/** The conversation column's viewport rect — the production drag-out target
 *  (Sidebar.tsx): the [data-slot="conversation"] WRAPPER may be zero-size (a
 *  slot pass-through), so the sized element is its parent column. */
async function conversationBox(page: Page): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return await page.evaluate(() => {
    const col = document.querySelector('#root [data-slot="conversation"]')?.parentElement
    if (col === null || col === undefined) return null
    const rect = col.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
}

/** The float's content cell must hand its child a real width (the
 *  column-flex contract): a collapsed 0px cell paints nothing — the tab is
 *  "in" the window but invisible. */
async function assertContentPainted(page: Page, label: string): Promise<void> {
  const width = await page.evaluate(() => {
    const cell = document.querySelector('[data-dsh-float-window] [class*="floatContent"]')
    const child = cell?.firstElementChild
    return child === null || child === undefined ? -1 : Math.round(child.getBoundingClientRect().width)
  })
  expect(width, `${label}: the floated tab's content must have real width`).toBeGreaterThan(200)
}

test('float a tab, move the window, reload restores it, dock it back', async ({ page }) => {
  const sidebar = await bootExpanded(page)

  // 1. The tab context menu floats the seeded Files home tab.
  const filesTab = sidebar.locator('[title="Files"][draggable="true"]').first()
  await expect(filesTab).toHaveCount(1)
  await filesTab.click({ button: 'right' })
  const floatItem = page.getByRole('menuitem', { name: 'Move to Free Window' }).first()
  await expect(floatItem, 'the tab context menu must offer "Move to Free Window"').toHaveCount(1)
  await floatItem.click()
  const floatWindow = sidebar.locator('[data-dsh-float-window]')
  await expect(floatWindow).toHaveCount(1, { timeout: 10_000 })
  // The tab left the strip with the window born over the conversation area
  // (center), well clear of the panel's right edge.
  await assertContentPainted(page, 'context-menu float')
  const leftBefore = await floatWindow.evaluate((node) => Number.parseFloat((node as HTMLElement).style.left))
  expect(Number.isFinite(leftBefore), `style.left must be numeric, got ${leftBefore}`).toBe(true)
  expect(leftBefore).toBeGreaterThan(0)
  expect(leftBefore).toBeLessThan(1440 - 390)
  await assertNoCrash(page)

  // 2. The header drag moves the window (pointer capture + commit).
  const header = floatWindow.locator('[class*="floatHeader"]')
  const box = await header.boundingBox()
  const conv = await conversationBox(page)
  expect(box, 'the float header must have geometry').not.toBeNull()
  expect(conv, 'the conversation column must have geometry').not.toBeNull()
  const dragToX = conv!.x + conv!.width * 0.35
  const dragToY = conv!.y + conv!.height * 0.35
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(dragToX, dragToY, { steps: 12 })
  await page.mouse.up()
  await expect
    .poll(async () => (
      await floatWindow.evaluate((node) => Number.parseFloat((node as HTMLElement).style.left))
    ), { timeout: 10_000 })
    .not.toBe(leftBefore)
  await assertNoCrash(page)

  // 3. A reload restores the window from the persisted session state. Give
  //    the store's debounced persist a beat first: reloading the instant the
  //    drag poll resolves can beat the 200ms flush timer.
  await page.waitForTimeout(500)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await dismissTakeovers(page)
  const sidebar2 = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar2.locator('[data-dsh-float-window]')).toHaveCount(1, { timeout: 90_000 })
  await assertNoCrash(page)

  // 4. The header context menu docks the tab back into the sidebar.
  const header2 = sidebar2.locator('[data-dsh-float-window] [class*="floatHeader"]')
  await header2.click({ button: 'right' })
  const dockItem = page.getByRole('menuitem', { name: 'Dock Back to Sidebar' }).first()
  await expect(dockItem, 'the float header context menu must offer "Dock Back to Sidebar"').toHaveCount(1)
  await dockItem.click()
  await expect(sidebar2.locator('[data-dsh-float-window]')).toHaveCount(0, { timeout: 10_000 })
  await expect(sidebar2.locator('[title="Files"][draggable="true"]').first()).toHaveCount(1)
  await assertNoCrash(page)
})

test('dragging a tab onto the conversation area floats it (drag-out gesture)', async ({ page }) => {
  const sidebar = await bootExpanded(page)

  // Open a terminal through the + menu (a second tab to drag out; the Files
  // home tab keeps the pane non-empty afterwards). The terminal tab's title
  // is the host shell name once resolved (fallback "Terminal"), so address
  // it by POSITION: the strip's second tab.
  await sidebar.getByRole('button', { name: 'New tab' }).first().click()
  const terminalItem = page.getByRole('menuitem', { name: 'Terminal' }).first()
  await expect(terminalItem).toHaveCount(1)
  await terminalItem.click()
  const stripTabs = sidebar.locator('[class*="tabList"] > [draggable="true"]')
  await expect(stripTabs, 'the strip must hold the seeded Files tab plus the terminal').toHaveCount(2, { timeout: 30_000 })
  const terminalTab = stripTabs.nth(1)
  const terminalTitle = (await terminalTab.getAttribute('title')) ?? 'Terminal'

  // Drag it onto the conversation column: the hint overlay appears mid-drag
  // and the drop floats the tab. ([class*="floatDropHint"] matches BOTH the
  // overlay and its label span — expect the pair.)
  const tabBox = await terminalTab.boundingBox()
  const conv = await conversationBox(page)
  expect(tabBox, 'the terminal tab must have geometry').not.toBeNull()
  expect(conv, 'the conversation column must have geometry').not.toBeNull()
  const hint = sidebar.locator('[class*="floatDropHint"]')
  await page.mouse.move(tabBox!.x + tabBox!.width / 2, tabBox!.y + tabBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(conv!.x + conv!.width / 2, conv!.y + conv!.height / 2, { steps: 12 })
  await expect(hint, 'the drag-out hint must mark the conversation column mid-drag').toHaveCount(2, { timeout: 10_000 })
  await page.mouse.up()
  const floatWindow = sidebar.locator('[data-dsh-float-window]')
  await expect(floatWindow, 'the drop must float the tab').toHaveCount(1, { timeout: 10_000 })
  await expect(hint).toHaveCount(0)
  // The terminal tab left the strip (only Files remains); the window shows
  // its title.
  await expect(stripTabs).toHaveCount(1)
  await expect(floatWindow.locator('[class*="floatTitle"]')).toHaveText(terminalTitle)
  await assertContentPainted(page, 'drag-out float')
  await assertNoCrash(page)
})
