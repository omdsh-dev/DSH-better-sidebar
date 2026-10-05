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
import { appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { PAGE_URL, createHostApi, hostRpc, sendFirstMessage } from './host'

/** Git must not pick up the developer's identity/config inside the lane. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

/** This lane's own workspace (lanes run serially against one server). */
const WORKSPACE_PATH = process.env.DSH_E2E_SCROLL_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-scroll-workspace')

/** Rows seeded into the root, plus real directories to expand. */
const ROOT_FILES = 80
const DIRS = ['alpha', 'beta', 'gamma']

/** The offset written before switching away (well inside the scroll range). */
const SCROLL_TO = 320

/** The tree body (its CSS-module class carries a hashed prefix). */
/**
 * The tree body. Scoped to the VISIBLE panel: with `keepMounted` every visited
 * session keeps its seat in the DOM, so a bare class selector matches one body
 * per retained conversation.
 */
const TREE_BODY = '[class*="explorerBody"]:visible'
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
const GUIDE = '[data-sidebar-right-panel]:visible [data-sidebar-right-guide]'
const GUIDE_FILES = '[data-sidebar-right-panel]:visible [data-sidebar-right-guide-entry="files"]'
const SESSION_ROWS = '[role="tree"][aria-label="Sessions"] [role="treeitem"][data-row-key^="session:"]'

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
  // A git repo with ONE staged change: the changes tab needs somewhere to put
  // an unsaved commit message, and staging is what enables its commit button.
  // Idempotent: the lane's workspace persists between local runs, so an
  // existing repo is reset rather than re-initialised (and `rm -rf .git` would
  // be the only way to make a fresh `git init` + first commit work again).
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: WORKSPACE_PATH, env: GIT_ENV }) }
  if (!existsSync(join(WORKSPACE_PATH, '.git'))) git('init', '-q')
  git('config', 'user.email', 'lane@example.test')
  git('config', 'user.name', 'retention lane')
  git('add', '-A')
  // The first commit may have nothing to record (a re-run of a clean repo).
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: WORKSPACE_PATH, env: GIT_ENV }).toString()
  if (dirty.trim() !== '') git('commit', '-qm', 'seed', '--no-verify')
  appendFileSync(join(WORKSPACE_PATH, 'seed-000.txt'), 'staged change\n')
  git('add', 'seed-000.txt')

  // A LINKED worktree: it gives the changes tab a second checkout to choose
  // from, which is the state #712 parked in a module-level map. Created last so
  // the staged change above belongs to the primary checkout only.
  const linkedPath = join(WORKSPACE_PATH, 'linked-checkout')
  if (!existsSync(linkedPath)) git('worktree', 'add', '-q', '-b', 'lane-linked', linkedPath)

  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH })
  const workspaceId = workspace.value.workspace.workspaceId
  // ONE conversation is enough: the round trip creates its own second one
  // through the rail, because a seeded session that never received a message
  // does not get a rail row (see newConversation).
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
  const pane = page.locator('[data-sidebar-right-panel]:visible')
  const expand = page.locator('[data-sidebar-right-expand]:visible')
  if (await expand.count() > 0) await expand.first().click()
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
    chip: (await page.locator('[data-sidebar-right-panel]:visible [role="tab"][aria-selected="true"]').first().innerText()).trim(),
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

/**
 * The session id of the seat that is on screen (DSH's own marker on every
 * retained session container). Reading the IDENTITY rather than counting rows
 * keeps this lane honest: the rail re-sorts as sessions take turns, so
 * "the second row" is not a stable name for a conversation.
 *
 * 0.2.x marks BOTH every RETAINED seat and each seat's panel with
 * `data-sidebar-right-session` — one seat per retained Conversation stays in the
 * DOM — so the attribute alone names several conversations at once. The panel
 * that is actually laid out is the seat on screen, which is the same `:visible`
 * convention the rest of this lane already uses.
 */
async function onScreenSession(page: Page): Promise<string | undefined> {
  const panel = page.locator('[data-sidebar-right-panel]:visible').first()
  if ((await panel.count()) > 0) {
    return (await panel.getAttribute('data-sidebar-right-session')) ?? undefined
  }
  const seat = page.locator('[data-sidebar-right-session]:visible').first()
  if ((await seat.count()) > 0) {
    return (await seat.getAttribute('data-sidebar-right-session')) ?? undefined
  }
  return undefined
}

/**
 * Start a NEW conversation from the rail and wait until it owns the right
 * sidebar seat.
 *
 * The lane used to click "the second row" of the rail: the row list also
 * contains the WORKSPACE row, and a seeded session with no messages never gets
 * a row of its own — so that click re-selected the SAME conversation and the
 * "round trip" never left it. Creating one through the rail's own control is
 * the only switch that certainly changes the session.
 * @param page - the lane's page.
 * @param from - the session the lane built its state in.
 * @returns the new session's id.
 */
async function newConversation(page: Page, from: string | undefined): Promise<string> {
  await page.getByRole('button', { name: /^(New session|新建会话)$/ }).first().click()
  await expect.poll(() => onScreenSession(page), { timeout: 60_000 }).not.toBe(from)
  const now = await onScreenSession(page)
  if (now === undefined) throw new Error('the new conversation did not take the right sidebar seat')
  return now
}

/** Select one conversation by its own rail row key. */
async function selectConversation(page: Page, sessionId: string): Promise<void> {
  const row = page.locator(`${SESSION_ROWS}[data-row-key="session:${sessionId}"]`).first()
  await expect(row).toBeAttached({ timeout: 30_000 })
  await row.click()
  await expect.poll(() => onScreenSession(page), { timeout: 60_000 }).toBe(sessionId)
}

/**
 * The plugin-side reads a reader would notice being repeated, by URL fragment.
 * `keepMounted` is supposed to make a conversation switch a pure show/hide: the
 * body stays up, so its already-loaded levels must NOT be fetched again.
 *
 * The root level IS re-fetched on every activation on purpose (the tree is the
 * one view that has to show the disk as it is now), so it is excluded here and
 * asserted separately; what this counts is the work a kept-alive body should
 * never repeat.
 */
const REPEATABLE_READS = ['/sidebar/api/fs.tree', '/sidebar/api/fs.read']

test('the explorer keeps its state across a tab switch and a conversation round trip', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => { console.log('[page]', message.text()) })

  // Count the plugin's own reads so "state survived" is not confused with
  // "everything was silently reloaded". These routes are POSTs — the path
  // being listed or read travels in the BODY, not the URL — so the body is
  // what tells one level/file from another.
  const reads: Array<{ url: string; path: string; at: number }> = []
  page.on('request', (request) => {
    const url = request.url()
    if (!REPEATABLE_READS.some(fragment => url.includes(fragment))) return
    const body = request.postData() ?? ''
    const path = /"path"\s*:\s*"([^"]*)"/.exec(body)?.[1] ?? ''
    reads.push({ url, path: decodeURIComponent(path), at: Date.now() })
  })
  const readsSince = (mark: number, match?: string): string[] =>
    reads
      .filter(entry => entry.at >= mark && (match === undefined || entry.path.includes(match)))
      .map(entry => entry.path)


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

  const sessionA = await onScreenSession(page)
  expect(sessionA, 'the right sidebar seat must name its session').toBeDefined()
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

  // ── A FILE open in conversation A: the resource question ──────────────────
  // Opening a file in merged mode switches THIS tab to the editor, so the tree
  // component unmounts by design (its scroll does not survive that, and never
  // did). What must survive a CONVERSATION switch is the file itself: it stays
  // open, and its bytes are not read again.
  const fileMark = Date.now()
  await page.locator(innerRow('alpha')).first().click({ position: { x: 8, y: 8 } })
  await expect(
    page.locator('[data-sidebar-right-panel]:visible .cm-editor').first(),
    'the file must open in the plugin editor',
  ).toBeVisible({ timeout: 30_000 })
  expect(
    readsSince(fileMark, 'inner.txt'),
    'opening the file reads it exactly once',
  ).toHaveLength(1)

  // ── An UNSAVED EDIT in conversation A (the worst loss is data) ────────────
  // #712 parked drafts in a module-level map; this branch claims `keepMounted`
  // makes that unnecessary because the body never unmounts. That claim was
  // never exercised — the draft is the one loss a reader cannot re-derive.
  const DRAFT = 'edited by the retention lane'
  const content = page.locator('[data-sidebar-right-panel]:visible .cm-content').first()
  await content.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(`\n${DRAFT}`)
  await expect(content, 'the typing must land in the live document').toContainText(DRAFT)
  const draftDoc = async (): Promise<string> =>
    page.locator('[data-sidebar-right-panel]:visible .cm-content').first().innerText()

  // ── An UNSAVED COMMIT MESSAGE (the other typed-state loss) ────────────────
  const COMMIT_MSG = 'fix: an unsaved message from the lane'
  await page.locator('[data-dockkit-add-tab]').first().click()
  await expect(page.locator(GUIDE)).toBeVisible({ timeout: 30_000 })
  await page.locator('[data-sidebar-right-panel]:visible [data-sidebar-right-guide-entry="git"]').click()
  const commitBox = page.locator('[data-sidebar-right-panel]:visible')
    .getByRole('textbox', { name: /Commit message/i }).first()
  await expect(commitBox, 'the changes tab must render its commit box').toBeVisible({ timeout: 30_000 })
  await commitBox.fill(COMMIT_MSG)
  await expect(commitBox).toHaveValue(COMMIT_MSG)

  // ── A CHOSEN WORKTREE (the third painted-state loss #712 covered) ─────────
  // The lane's linked checkout is the non-auto choice: picking it must survive
  // the round trip, not be re-derived from the inventory. Paths are compared
  // through `realpathSync` because macOS /var is a symlink to /private/var and
  // git reports the resolved form.
  const linkedPath = realpathSync(join(WORKSPACE_PATH, 'linked-checkout'))
  const worktreeSelect = page.locator('[data-sidebar-right-panel]:visible select')
    .filter({ has: page.locator('option') }).first()
  await expect(worktreeSelect, 'the changes tab must offer its worktree selector').toBeVisible({ timeout: 30_000 })
  const linkedOption = await worktreeSelect.locator('option').evaluateAll(
    (options, path) => options.some(option => (option as HTMLOptionElement).value === path),
    linkedPath,
  )
  expect(linkedOption, 'the linked worktree must appear in the selector').toBe(true)
  await worktreeSelect.selectOption(linkedPath)
  await expect(worktreeSelect).toHaveValue(linkedPath)

  // Back to the Files window and RE-BUILD the scroll offset: opening the file
  // swapped this tab's content, so the tree remounted at the top (by design,
  // unrelated to session retention). The round trip below must then preserve
  // this second offset.
  await page.locator('[data-sidebar-right-panel]:visible [role="tab"]').filter({ hasText: /Files|文件/ }).first().click()
  await expect(page.locator(innerRow('alpha')).first()).toBeVisible({ timeout: 30_000 })
  const bodyAgain = page.locator(TREE_BODY).first()
  await bodyAgain.evaluate((el, top) => { el.scrollTop = top }, SCROLL_TO)
  await expect.poll(() => bodyAgain.evaluate(el => el.scrollTop), { timeout: 10_000 }).toBe(SCROLL_TO)
  const beforeTrip = await readState(page)
  expect(beforeTrip.expandedDir, 'alpha is still expanded after the file round trip').toBe('alpha')

  // ── A conversation round trip: A → B → A ──────────────────────────────────
  const firstConversationChip = beforeTrip.chip
  await page.evaluate(() => console.log('[mark] switching-to-B', Date.now() % 1000000))
  const sessionB = await newConversation(page, sessionA)
  await page.evaluate(() => console.log('[mark] in-B', Date.now() % 1000000))
  // A brand-new conversation can raise the same takeover the first one did.
  await dismissOnboarding(page)
  // ISOLATION (the probe this lane adds for the keepMounted experiment): B is
  // a DIFFERENT conversation whose native tab ids restart at `tab1`. If the
  // plugin's registry is keyed by the bare native id, B's Files window shows
  // A's expansion — the leak the registry must not have.
  await openFiles(page)
  const isolation = await readState(page)
  expect(
    isolation.expandedDir,
    'conversation B must not inherit conversation A tree expansion',
  ).toBe('')
  expect(
    isolation.scrollTop,
    'conversation B must not inherit conversation A scroll offset',
  ).toBe(0)
  expect(sessionB, 'the lane must have left conversation A').not.toBe(sessionA)
  await page.waitForTimeout(1_500)
  const backMark = Date.now()
  await page.evaluate(() => console.log('[mark] switching-back-to-A', Date.now() % 1000000))
  await selectConversation(page, sessionA!)
  await dismissOnboarding(page)
  // A's tab strip comes back with every tab it had (Files / the file / the
  // changes window) — asserted by the strip below, since the ACTIVE tab is
  // whichever the lane last showed.
  // The changes tab is where the unsaved message lives: it is the other claim
  // `keepMounted` makes on #712's behalf.
  const changesTab = page.locator('[data-sidebar-right-panel]:visible [role="tab"]').filter({ hasText: /Changes|文件变动/ })
  await expect(changesTab, 'the changes tab survives the round trip').toHaveCount(1, { timeout: 30_000 })
  await changesTab.first().click()
  const backCommitBox = page.locator('[data-sidebar-right-panel]:visible')
    .getByRole('textbox', { name: /Commit message/i }).first()
  await expect(backCommitBox, 'the changes tab still renders its commit box').toBeVisible({ timeout: 30_000 })
  await expect(
    backCommitBox,
    'an unsaved commit message survives the conversation round trip',
  ).toHaveValue(COMMIT_MSG)
  await expect(
    page.locator('[data-sidebar-right-panel]:visible select').first(),
    'the chosen worktree survives the conversation round trip',
  ).toHaveValue(linkedPath)
  // And the tree's own tab is still there too.
  await expect(
    page.locator('[data-sidebar-right-panel]:visible [role="tab"]').filter({ hasText: /Files|文件/ }),
    'the files tab survives the round trip',
  ).toHaveCount(1, { timeout: 30_000 })

  // The FILE opened in A is still open, and its bytes were NOT read again —
  // the editor body stayed mounted, so it still holds them. (Its tab is not
  // active on return, so it is asserted by opening it, which must be a plain
  // show of already-held content.)
  expect(
    readsSince(backMark, 'inner.txt'),
    'the file opened in A must not be re-read when the conversation comes back',
  ).toEqual([])
  const editorTab = page.locator('[data-sidebar-right-panel]:visible [role="tab"]').filter({ hasText: 'inner.txt' })
  await expect(editorTab, 'the file opened in A is still open after the round trip').toHaveCount(1, { timeout: 30_000 })
  await editorTab.first().click()
  await expect(
    page.locator('[data-sidebar-right-panel]:visible .cm-editor').first(),
    'selecting it shows the editor without a new read',
  ).toBeVisible({ timeout: 30_000 })
  expect(
    readsSince(backMark, 'inner.txt'),
    'and showing it again still re-read nothing',
  ).toEqual([])

  // THE DRAFT: the typing from before the switch must still be in the document.
  // This is the claim `keepMounted` makes on #712's behalf, and the only loss
  // here that a reader cannot recover by looking again.
  expect(
    await draftDoc(),
    'an unsaved edit survives the conversation round trip',
  ).toContain(DRAFT)

  // Back to the Files window for the remaining vector (its own tab is still
  // there, and selecting it is a plain show — not a reload).
  await page.locator('[data-sidebar-right-panel]:visible [role="tab"]').filter({ hasText: /Files|文件/ }).first().click()
  await expect(page.locator(innerRow('alpha')).first()).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => (await readState(page)).expandedDir, { timeout: 30_000 })
    .toBe('alpha')

  const afterRoundTrip = await readState(page)
  // The tree's own scroll offset is COMPONENT state, not record state: it
  // survives this trip only because the explorer body stays mounted — which
  // holds only while the plugin keeps the `files` takeover registration alive
  // across the pulse a Session switch emits (see the sync() note).
  expect(
    afterRoundTrip.scrollTop,
    'the tree scroll offset survives a conversation round trip',
  ).toBe(SCROLL_TO)
  expect(
    afterRoundTrip.expandedDir,
    'the tree expansion survives a conversation round trip',
  ).toBe(beforeTrip.expandedDir)
  expect(
    afterRoundTrip.chip,
    'the tab chip survives a conversation round trip',
  ).toBe(firstConversationChip)
  expect(pageErrors, 'no page errors during the round trip').toEqual([])

  await page.screenshot({ path: 'test-results/tree-state-restored.png' })
})
