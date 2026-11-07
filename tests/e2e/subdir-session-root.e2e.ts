/**
 * Subdirectory-session root regression.
 *
 * A relative path in a file link resolves against the sidebar root, so a
 * session whose cwd is a SUBDIRECTORY of its git repository must keep that cwd
 * as the root. Lifting it to the repository top level resolved
 * `tools/prompts/a.md` as `<repo>/tools/prompts/a.md`, and the editor reported
 * `cannot read "<repo>/tools/prompts/a.md": ENOENT` for a file that exists one
 * level below.
 *
 * The subdirectory is non-ASCII on purpose: a Unicode normalization artifact
 * could move a spelling, but it could never drop a whole path segment, so a
 * missing layer under a Chinese name still points at the root, not the
 * encoding.
 *
 * The lane runs against a real `dsh web` with the npm-packed plugin mounted
 * (see scripts/e2e-mount.sh); `DSH_E2E_WORKSPACE` is unused here because this
 * spec seeds its own repository, session and workspace through the host RPC.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { createHostApi, gotoPage, hostRpc, sendFirstMessage, sidebarApi } from './host'

/** This spec's own scratch tree; removed in afterAll. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'dsh-e2e-subdir-root-'))
/** The git repository whose top level must NOT become the sidebar root. */
const REPO = join(SCRATCH, 'repo')
/** The session cwd: a subdirectory of REPO. */
const SESSION_DIR = join(REPO, '社媒运营')
/** The relative destination the link and the read request carry. */
const RELATIVE_FILE = 'tools/prompts/a.md'
/** Content only the nested file has, so a wrong root cannot satisfy the assertion. */
const MARKER = 'marker-from-the-subdirectory'
/** The link text rendered inside README.md. */
const LINK_TEXT = 'open the nested file'
/** A file only the repository root has: the explorer must not reach it. */
const ROOT_ONLY_FILE = 'root-only.txt'
/**
 * The canonical spelling of the session cwd. The workspace registry stores the
 * REAL path, so on macOS a `/var` scratch dir comes back as `/private/var`.
 */
let sessionDirReal: string

let api: APIRequestContext
let sessionId: string

/**
 * Dismiss the keyless boot's onboarding takeovers, which mask the shell: a
 * welcome notice ("Continue") and, once acknowledged, a provider dialog
 * ("Configure later"). A DSH build without onboarding proceeds straight on.
 * @param page - the lane's page.
 */
async function dismissOnboarding(page: Page): Promise<void> {
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    console.warn('[e2e] no onboarding takeover appeared; proceeding without dismissal')
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
        // Masked by the takeover stacked above it; the next round tries the
        // other button first.
      }
    }
    if (!dismissed) break
  }
}

test.beforeAll(async () => {
  mkdirSync(join(SESSION_DIR, 'tools', 'prompts'), { recursive: true })
  writeFileSync(join(SESSION_DIR, RELATIVE_FILE), `# a\n\n${MARKER}\n`)
  sessionDirReal = realpathSync.native(SESSION_DIR)
  writeFileSync(join(SESSION_DIR, 'README.md'), `# index\n\n[${LINK_TEXT}](${RELATIVE_FILE})\n`)
  writeFileSync(join(REPO, ROOT_ONLY_FILE), 'the repository root only\n')
  // A repository with no commit is enough: `git rev-parse --show-toplevel`
  // answers from `.git` alone, which is all the root derivation needs.
  execFileSync('git', ['init', '-q'], { cwd: REPO })

  api = await createHostApi()
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: SESSION_DIR })
  const session = await hostRpc<{ sessionId: string }>(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
  sessionId = session.value.sessionId
})

test.afterAll(async () => {
  await api?.dispose()
  rmSync(SCRATCH, { recursive: true, force: true })
})

test('the sidebar scope reports the subdirectory session cwd', async () => {
  const response = await api.post(sidebarApi('session.cwd'), { data: { sessionId } })
  const body = (await response.json()) as { ok: boolean; value?: { cwd?: string } }
  expect(response.ok(), JSON.stringify(body)).toBe(true)
  expect(body.value?.cwd, 'the sidebar root must be the session cwd, not the repository top level').toBe(sessionDirReal)
})

test('a relative read resolves inside the session cwd', async () => {
  // The exact request the editor issues after the link click: a relative path,
  // no absolute spelling, and no client-supplied cwd to fall back on.
  const response = await api.post(sidebarApi('fs.read'), { data: { sessionId, path: RELATIVE_FILE } })
  const body = (await response.json()) as { ok: boolean; value?: { content?: string }; error?: unknown }
  expect(response.ok(), JSON.stringify(body)).toBe(true)
  expect(body.ok, `fs.read envelope: ${JSON.stringify(body)}`).toBe(true)
  expect(body.value?.content ?? '', 'the relative path must read the file one level below the repository root')
    .toContain(MARKER)
})

test('the explorer stays under the session cwd and a relative link opens the file', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await gotoPage(page)
  await dismissOnboarding(page)
  // The native Sidebar's control lives in the conversation header, which DSH
  // renders only for a session with content.
  await sendFirstMessage(page)

  const pane = page.locator('[data-sidebar-right-panel]')
  await page.locator('[data-sidebar-right-expand]').first().click()
  await expect(pane).toBeVisible({ timeout: 30_000 })
  if (await page.locator('[data-sidebar-right-guide]').count() === 0) {
    await page.locator('[data-dockkit-add-tab]').first().click()
  }
  // The plugin took the built-in `files` kind over, so this guide entry IS its
  // explorer.
  await page.locator('[data-sidebar-right-guide-entry="files"]').click()

  const readmeRow = pane.locator('[role="button"][title$="README.md"]:visible')
  await expect(readmeRow, 'the subdirectory\'s own file must appear in the explorer').toHaveCount(1, { timeout: 30_000 })
  await expect(
    pane.locator(`[role="button"][title$="${ROOT_ONLY_FILE}"]:visible`),
    'the explorer must not be rooted at the repository top level',
  ).toHaveCount(0)

  // Open the subdirectory's README, then click the RELATIVE file link inside
  // its preview: the destination is `tools/prompts/a.md`, exactly the shape the
  // chat prose link carries.
  await readmeRow.click({ position: { x: 8, y: 8 } })
  const link = pane.getByRole('button', { name: LINK_TEXT })
  await expect(link, 'the preview must render the relative link as a clickable file link')
    .toHaveCount(1, { timeout: 30_000 })
  await link.click()

  await expect(
    pane.getByText(MARKER),
    'the linked file must render from the session cwd, not from the repository root',
  ).toHaveCount(1, { timeout: 30_000 })
  expect(pageErrors, 'pageerrors while opening the relative link').toEqual([])
})
