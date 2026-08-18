import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test'

const BASE_URL = process.env.DSH_E2E_URL
if (!BASE_URL) throw new Error('DSH_E2E_URL is required')
const WORKSPACE = process.env.DSH_E2E_WORKSPACE ?? join(process.cwd(), '.tmp-file-workbench-e2e')
const SESSION_TITLE = process.env.DSH_E2E_SESSION_TITLE
const DRAFT = 'workbench-e2e-draft.md'
const RENAMED = 'workbench-e2e-renamed.md'
const ASSETS = 'workbench-e2e-assets'
let api: APIRequestContext

async function seedSession(): Promise<void> {
  mkdirSync(WORKSPACE, { recursive: true })
  writeFileSync(join(WORKSPACE, 'workbench-e2e-seed.md'), '# Workbench\n\nStarting text.\n')
  if (SESSION_TITLE !== undefined) return
  const workspace = await api.post(`${BASE_URL}/api/workspace.create`, {
    data: { type: 'client-request', rpcId: 'file-workbench-workspace', method: 'workspace.create', payload: { path: WORKSPACE } },
  })
  expect(workspace.ok()).toBe(true)
  const body = await workspace.json() as { result: { ok: boolean; value?: { workspace: { workspaceId: string } } } }
  expect(body.result.ok).toBe(true)
  const workspaceId = body.result.value!.workspace.workspaceId
  const session = await api.post(`${BASE_URL}/api/session.create`, {
    data: { type: 'client-request', rpcId: 'file-workbench-session', method: 'session.create', payload: { workspaceId } },
  })
  expect(session.ok()).toBe(true)
}

async function dismissOnboarding(page: Page): Promise<void> {
  for (let round = 0; round < 8; round++) {
    let found = false
    for (const name of ['Continue', 'Configure later']) {
      const button = page.getByRole('button', { name, exact: true }).first()
      if (await button.count() === 0) continue
      found = true
      await button.click({ timeout: 4_000 }).catch(() => {})
      await page.waitForTimeout(400)
    }
    if (!found) return
  }
}

async function ensureSidebarOpen(page: Page): Promise<void> {
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  const expand = sidebar.getByRole('button', { name: 'Expand sidebar' })
  if (await expand.count() > 0) await expand.click()
  await expect(sidebar.getByRole('button', { name: 'New tab' }).first()).toBeVisible({ timeout: 30_000 })
}

async function chooseFilesTab(page: Page): Promise<void> {
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  const filesTab = sidebar.locator('[title="Files"][draggable="true"]:visible').first()
  if (await filesTab.count() > 0) {
    await filesTab.click()
  } else {
    await sidebar.getByRole('button', { name: 'New tab' }).first().click()
    await page.getByRole('menuitem', { name: 'Files' }).first().click()
  }
  await expect(sidebar.locator('input[placeholder^="File path"]:visible')).toHaveCount(1, { timeout: 30_000 })
}

async function deleteFromTree(page: Page, name: string): Promise<void> {
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  const row = sidebar.locator(`[role="button"][title$="${name}"]:visible`).first()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(row).toHaveCount(0)
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: BASE_URL })
  await seedSession()
})
test.afterAll(async () => { await api.dispose() })

test('CRUD, uploads, durable drafts, conflicts, and visual GFM work together', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await dismissOnboarding(page)
  if (SESSION_TITLE !== undefined) {
    await page.getByText(basename(WORKSPACE), { exact: true }).first().click()
    await page.getByText(SESSION_TITLE, { exact: true }).first().click()
  }
  await ensureSidebarOpen(page)
  await chooseFilesTab(page)
  const sidebar = page.locator('[data-dsh-better-sidebar]')

  // Create a Markdown file from the visible explorer quick action.
  await sidebar.locator('button[aria-label="New file"]:visible').first().click()
  let dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('Enter a name').fill(DRAFT)
  const initialVisualChunk = page.waitForResponse(response => response.url().includes('/sidebar/bundle/markdown-editor.js'))
  await dialog.getByRole('button', { name: 'Create' }).click()
  await initialVisualChunk
  await expect(sidebar.locator('.ProseMirror:visible')).toBeVisible({ timeout: 30_000 })
  const pathInput = sidebar.locator('input[placeholder^="File path"]:visible')
  await expect(pathInput).toHaveValue(new RegExp(`${DRAFT.replace('.', '\\.')}$`))

  // Type without saving, reload the entire GUI, and recover the IndexedDB draft.
  await sidebar.getByRole('button', { name: 'Source', exact: true }).click()
  let source = sidebar.locator('.cm-content:visible')
  await source.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('# Durable draft marker')
  await expect(source).toContainText('Durable draft marker')
  const draftRow = sidebar.locator(`[role="button"][title$="${DRAFT}"]:visible`).first()
  await expect(draftRow.locator('[data-editor-dirty]')).toBeVisible({ timeout: 10_000 })

  // A second tree click keeps the draft tab and opens another top-level file tab.
  await sidebar.locator('[role="button"][title$="workbench-e2e-seed.md"]:visible').first().click({ position: { x: 8, y: 8 } })
  await expect(sidebar.locator(`[title="${DRAFT}"][draggable="true"]`)).toHaveCount(1)
  await expect(sidebar.locator('[title="workbench-e2e-seed.md"][draggable="true"]')).toHaveCount(1)
  await expect(pathInput).toHaveValue(/workbench-e2e-seed\.md$/)
  await expect(sidebar.locator(`[role="button"][title$="${DRAFT}"]:visible`).first().locator('[data-editor-dirty]')).toBeVisible()
  await sidebar.locator(`[title="${DRAFT}"][draggable="true"]`).click()
  await expect(pathInput).toHaveValue(new RegExp(`${DRAFT.replace('.', '\\.')}$`))
  await expect(sidebar.locator(`[role="button"][title$="${DRAFT}"]:visible`).first().locator('[data-editor-dirty]')).toBeVisible()

  await page.reload({ waitUntil: 'domcontentloaded' })
  await dismissOnboarding(page)
  await ensureSidebarOpen(page)
  await page.locator(`[data-dsh-better-sidebar] [title="${DRAFT}"][draggable="true"]`).click()
  source = page.locator('[data-dsh-better-sidebar] .cm-content:visible')
  await expect(source).toContainText('Durable draft marker', { timeout: 30_000 })

  // The already-loaded Milkdown chunk reopens the restored source draft as rendered GFM.
  await page.locator('[data-dsh-better-sidebar]').getByRole('button', { name: 'Visual', exact: true }).click()
  await expect(page.locator('[data-dsh-better-sidebar] .ProseMirror:visible')).toContainText('Durable draft marker', { timeout: 30_000 })

  // A disk race produces an explicit conflict instead of silently overwriting.
  await page.locator('[data-dsh-better-sidebar]').getByRole('button', { name: 'Source', exact: true }).click()
  source = page.locator('[data-dsh-better-sidebar] .cm-content:visible')
  await source.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nConflict-safe text')
  writeFileSync(join(WORKSPACE, DRAFT), '# changed outside the editor\n')
  await page.locator('[data-dsh-better-sidebar] button[aria-label="Save"]:visible').click()
  await expect(page.getByText('An agent or another program changed this file. The disk copy was not overwritten.')).toBeVisible()
  await page.getByRole('button', { name: 'Overwrite with this draft' }).click()
  await expect.poll(() => readFileSync(join(WORKSPACE, DRAFT), 'utf8')).toContain('Conflict-safe text')
  await expect(page.locator(`[data-dsh-better-sidebar] [role="button"][title$="${DRAFT}"]:visible`).first().locator('[data-editor-dirty]')).toHaveCount(0)

  // Rename keeps the open tab/path synchronized.
  let row = page.locator(`[data-dsh-better-sidebar] [role="button"][title$="${DRAFT}"]:visible`).first()
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('Enter a name').fill(RENAMED)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(pathInput).toHaveValue(new RegExp(`${RENAMED.replace('.', '\\.')}$`))

  // Create a folder, upload bytes, then move the upload with native drag/drop.
  await page.locator('[data-dsh-better-sidebar] button[aria-label="New folder"]:visible').first().click()
  dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('Enter a name').fill(ASSETS)
  await dialog.getByRole('button', { name: 'Create' }).click()
  const chooserPromise = page.waitForEvent('filechooser')
  await page.locator('[data-dsh-better-sidebar] button[aria-label="Upload files"]:visible').first().click()
  const chooser = await chooserPromise
  await chooser.setFiles({ name: 'upload.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded bytes\n') })
  const uploadRow = page.locator('[data-dsh-better-sidebar] [role="button"][title$="upload.txt"]:visible').first()
  const folderRow = page.locator(`[data-dsh-better-sidebar] [role="button"][title$="${ASSETS}"]:visible`).first()
  await expect(uploadRow).toBeVisible({ timeout: 30_000 })
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await uploadRow.dispatchEvent('dragstart', { dataTransfer: transfer })
  await folderRow.dispatchEvent('dragenter', { dataTransfer: transfer })
  await folderRow.dispatchEvent('dragover', { dataTransfer: transfer })
  await folderRow.dispatchEvent('drop', { dataTransfer: transfer })
  await folderRow.click()
  await expect(page.locator('[data-dsh-better-sidebar] [role="button"][title$="upload.txt"]:visible')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => {
    try { return readFileSync(join(WORKSPACE, ASSETS, 'upload.txt'), 'utf8') } catch { return null }
  }).toBe('uploaded bytes\n')

  await deleteFromTree(page, ASSETS)
  await deleteFromTree(page, RENAMED)
  await deleteFromTree(page, 'workbench-e2e-seed.md')
  expect(errors).toEqual([])
})
