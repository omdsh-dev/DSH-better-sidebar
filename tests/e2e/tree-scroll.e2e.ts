/**
 * Cross-conversation state retention, on a REAL host — the comparison the
 * review asked for: build state in conversation A, switch to conversation B,
 * switch back to A, and compare the whole observable state vector before vs
 * after.
 *
 * Why a vector and not one scalar: the host mounts ONE tab body per pane and
 * native tab ids restart in every session (`tab1`, `tab2`, …), so the entering
 * conversation's tab meets the leaving one's id. A registry keyed by the bare
 * id hands the leaving session's state to the entering one and destroys it —
 * tree expansion, the file opened in place, the unsaved commit message. A lone
 * `scrollTop` assertion cannot see any of that.
 *
 * Determinism: the workspace is seeded wide enough that the tree overflows;
 * every wait is on a DOM/poll marker; the suite is serial.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { PAGE_URL, createHostApi, hostRpc, sendFirstMessage } from './host'

/** This lane's own workspace (lanes run serially against one server). */
const WORKSPACE_PATH = process.env.DSH_E2E_SCROLL_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-scroll-workspace')

/** Rows seeded into the root, plus real directories to expand. */
const ROOT_FILES = 80
const DIRS = ['alpha', 'beta', 'gamma']

/** The offset written before switching away (well inside the scroll range). */
const SCROLL_TO = 320

/** The tree body (its CSS-module class carries a hashed prefix). */
const TREE_BODY = '[class*="explorerBody"]'
/**
 * A directory row by its label. Directory rows carry NO `title` attribute
 * (only file rows do — they show the full path there), so a directory is
 * addressed by its name span, which is also what the reader clicks.
 */
function dirRow(dir: string) {
  return `${TREE_BODY} [role="button"]:has([class*="explorerName"]:text-is("${dir}"))`
}
/** The file row inside an expanded directory (file rows DO carry `title`). */
function innerRow(dir: string) {
  return `${TREE_BODY} [role="button"][title$="${dir}/inner.txt"]:visible, ${TREE_BODY} [role="button"][title$="${dir}\\\\inner.txt"]:visible`
}
const GUIDE = '[data-sidebar-right-guide]'
const GUIDE_FILES = '[data-sidebar-right-guide-entry="files"]'
const SESSION_ROWS = '[role="tree"][aria-label="Sessions"] [role="treeitem"]'

let api: APIRequestContext

async function seedSessions(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  for (let index = 0; index < ROOT_FILES; index++) {
    writeFileSync(join(WORKSPACE_PATH, `seed-${String(index).padStart(3, '0')}.txt`), `row ${index}\n`)
  }
  for (const dir of DIRS) {
    mkdirSync(join(WORKSPACE_PATH, dir), { recursive: true })
    writeFileSync(join(WORKSPACE_PATH, dir, 'inner.txt'), `${dir} inner\n`)
  }
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH })
  const workspaceId = workspace.value.workspace.workspaceId
  // TWO conversations, so a switch is possible.
  await hostRpc(api, 'session.create', { workspaceId })
  await hostRpc(api, 'session.create', { workspaceId })
}

test.beforeAll(async () => {
  api = await createHostApi()
  await seedSessions()
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

/** Open the native Sidebar, then the plugin's Files page inside it. */
async function openFiles(page: Page): Promise<void> {
  const pane = page.locator('[data-sidebar-right-panel]')
  if (await page.locator('[data-sidebar-right-expand]').count() > 0) {
    await page.locator('[data-sidebar-right-expand]').first().click()
  }
  await expect(pane).toBeVisible({ timeout: 30_000 })
  if (await page.locator(GUIDE).count() > 0) await page.locator(GUIDE_FILES).click()
  await expect(
    page.locator(`${TREE_BODY} [role="button"][title$="seed-000.txt"]:visible`),
    'the plugin explorer must render the seeded rows',
  ).toHaveCount(1, { timeout: 30_000 })
}

/**
 * The observable state vector of the Files window. Every field is something a
 * reader would notice losing — the comparison the review asked for.
 */
interface StateVector {
  /** The tree's scroll offset. */
  scrollTop: number
  /** The directory whose children are on screen ('' when none is expanded). */
  expandedDir: string
  /** The active tab's chip text (an in-place file open rewrites it). */
  chip: string
}

async function readState(page: Page): Promise<StateVector> {
  // Whatever directory is expanded shows its inner.txt; report which one.
  const expandedDir = await page.locator(`${TREE_BODY} [role="button"][title*="inner.txt"]:visible`)
    .evaluateAll(nodes => nodes.length === 0
      ? ''
      : (nodes[0]!.getAttribute('title') ?? '').split(/[\\/]/).slice(-2, -1)[0] ?? '')
  return {
    scrollTop: await page.locator(TREE_BODY).first().evaluate(el => el.scrollTop),
    expandedDir,
    chip: (await page.locator('[data-sidebar-right-panel] [role="tab"][aria-selected="true"]').first().innerText()).trim(),
  }
}

/** Expand one directory in the tree and require its child to appear. */
async function expandDir(page: Page, dir: string): Promise<void> {
  await page.locator(dirRow(dir)).first().click()
  await expect(
    page.locator(innerRow(dir)).first(),
    `expanding ${dir} must reveal its child`,
  ).toBeVisible({ timeout: 30_000 })
}

/** Switch the active conversation (the left rail's session tree). */
async function switchToConversation(page: Page, index: number): Promise<void> {
  const rows = page.locator(SESSION_ROWS)
  await expect(rows.nth(index)).toBeAttached({ timeout: 30_000 })
  await rows.nth(index).click()
  await page.waitForTimeout(1_000)
}

test('the explorer keeps its state across a tab switch and a conversation round trip', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)
  await sendFirstMessage(page)
  await openFiles(page)

  const body = page.locator(TREE_BODY).first()
  await expect(body).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => body.evaluate(el => el.scrollHeight - el.clientHeight), { timeout: 30_000 })
    .toBeGreaterThan(100)

  // ── Build state up in the FIRST conversation ──────────────────────────────
  await expandDir(page, 'alpha')
  await body.evaluate((el, top) => { el.scrollTop = top }, SCROLL_TO)
  await expect.poll(() => body.evaluate(el => el.scrollTop), { timeout: 10_000 }).toBe(SCROLL_TO)

  const before = await readState(page)
  expect(before.expandedDir, 'alpha must be recorded as expanded before switching').toBe('alpha')

  // ── A tab switch inside the same conversation ─────────────────────────────
  await page.locator('[data-dockkit-add-tab]').first().click()
  await expect(page.locator(GUIDE)).toBeVisible({ timeout: 30_000 })
  await page.locator(GUIDE_FILES).click()
  await expect(
    page.locator(innerRow('alpha')).first(),
    'a same-conversation tab switch must keep the expansion',
  ).toBeVisible({ timeout: 30_000 })

  const afterTab = await readState(page)
  expect(afterTab.expandedDir, 'the expansion survives a tab switch').toBe(before.expandedDir)
  expect(afterTab.scrollTop, 'the scroll position survives a tab switch').toBe(SCROLL_TO)
  expect(afterTab.chip, 'the chip keeps its title across a tab switch').toBe(before.chip)

  // ── A conversation round trip: A → B → A ──────────────────────────────────
  const firstConversationChip = afterTab.chip
  await switchToConversation(page, 1)
  await page.waitForTimeout(1_500)
  await switchToConversation(page, 0)
  await openFiles(page)
  await expect
    .poll(async () => (await readState(page)).expandedDir, { timeout: 30_000 })
    .toBe('alpha')

  const afterRoundTrip = await readState(page)
  expect(
    afterRoundTrip.expandedDir,
    'the tree expansion survives a conversation round trip',
  ).toBe(before.expandedDir)
  expect(
    afterRoundTrip.chip,
    'the tab chip survives a conversation round trip',
  ).toBe(firstConversationChip)
  expect(pageErrors, 'no page errors during the round trip').toEqual([])

  await page.screenshot({ path: 'test-results/tree-state-restored.png' })
})
