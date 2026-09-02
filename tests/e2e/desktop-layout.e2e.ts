/** Desktop layout regression: opening the right panel must not make Harness enter narrow mode. */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { PAGE_URL } from './host'

const WORKSPACE_PATH = process.env.DSH_E2E_DESKTOP_WORKSPACE
  ?? (process.env.DSH_E2E_WORKSPACE === undefined
    ? join(homedir(), 'dsh-e2e-desktop-layout-workspace')
    : `${process.env.DSH_E2E_WORKSPACE}-desktop-layout`)

async function dismissOnboarding(page: Page): Promise<void> {
  await expect
    .poll(() => page.getByRole('button', { name: /^(Continue|Configure later|继续|稍后配置)$/ }).count(), { timeout: 60_000 })
    .toBeGreaterThan(0)
  for (let round = 0; round < 8; round++) {
    let dismissed = false
    for (const name of [/^(Continue|继续)$/, /^(Configure later|稍后配置)$/]) {
      const button = page.getByRole('button', { name }).first()
      if ((await button.count()) === 0) continue
      await button.click()
      dismissed = true
      await expect(button).toBeHidden()
    }
    if (!dismissed) return
  }
  throw new Error('onboarding takeovers did not settle after visible dismissal')
}

test.beforeAll(() => {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
})

test('right panel keeps desktop session actions in their header positions', async ({ page }) => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const requestFailures: string[] = []
  const badResponses: string[] = []
  page.on('pageerror', error => pageErrors.push(error.stack ?? error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('requestfailed', request => requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'unknown'}`))
  page.on('response', response => { if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`) })

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await dismissOnboarding(page)

  await page.getByRole('button', { name: /^(Choose workspace|选择工作区)$/ }).click()
  const picker = page.getByRole('dialog', { name: /^(Select Workspace Directory|选择工作区目录)$/ })
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: /^(Edit path|编辑路径)$/ }).click()
  const pathInput = picker.getByRole('textbox', { name: /^(Edit path|编辑路径)$/ })
  await pathInput.fill(WORKSPACE_PATH)
  await pathInput.press('Enter')
  await expect(pathInput).toBeHidden()
  await picker.getByRole('button', { name: /^(Open|打开)$/ }).click()

  // Target the ACTIVE composer by its accessible name. DSH 0.1.2-alpha hosts
  // keep an INERT `data-composer-input` "Choose workspace" textbox (with
  // contenteditable="false") later in DOM order than the real composer — a
  // bare `getByRole('textbox').last()` resolved to that one and fill() threw
  // ("not an <input>, <textarea> or [contenteditable] element").
  const composer = page.getByRole('textbox', { name: /^(Describe what you want to build|描述你想要构建)/ })
  await expect(composer).toBeVisible()
  await composer.fill('Create a desktop side-card layout test session.')
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()

  const root = page.locator('#root')
  const frame = page.locator('#root [data-dsh-frame], #root > [data-slot="root"] > div').first()
  const appSidebarExpanded = root.getByRole('button', { name: /^(Collapse sidebar|收起侧边栏)$/ })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  const sessionLog = page.getByRole('button', { name: 'Session log', exact: true })
  const sessionLogLabel = sessionLog.getByText('Session log', { exact: true })
  await expect(sessionLogLabel, 'the desktop session-log action starts as a text button').toBeVisible({ timeout: 30_000 })
  await expect(appSidebarExpanded, 'the desktop frame starts with its app sidebar expanded').toBeVisible()
  const beforeRoot = await root.boundingBox()
  const beforeFrame = await frame.boundingBox()
  expect(beforeRoot).not.toBeNull()
  expect(beforeFrame).not.toBeNull()

  await sidebar.getByRole('button', { name: /^(Expand sidebar|展开侧边栏)$/ }).click()
  const panel = page.locator('[data-dsh-panel]:not([data-dsh-bottom-panel])')
  await expect(panel).toBeVisible()
  await expect
    .poll(async () => {
      const center = page.locator('#root [data-dsh-frame] > [data-pane="conversation"], #root :has(> [data-slot="conversation"])').first()
      const [centerBox, panelBox] = await Promise.all([center.boundingBox(), panel.boundingBox()])
      if (centerBox === null || panelBox === null) return Number.POSITIVE_INFINITY
      return Math.abs(centerBox.x + centerBox.width - panelBox.x)
    }, { timeout: 30_000 })
    .toBeLessThanOrEqual(2)

  const afterRoot = await root.boundingBox()
  const afterFrame = await frame.boundingBox()
  expect(afterRoot).not.toBeNull()
  expect(afterFrame).not.toBeNull()
  expect(Math.abs(afterRoot!.width - beforeRoot!.width), 'opening the plugin panel must not shrink #root').toBeLessThanOrEqual(1)
  expect(Math.abs(afterFrame!.width - beforeFrame!.width), 'opening the plugin panel must not shrink AppFrame').toBeLessThanOrEqual(1)
  await expect(appSidebarExpanded, 'a desktop window must not enter the host narrow layout').toBeVisible()
  await expect(sessionLogLabel, 'the session-log action must keep its desktop label').toBeVisible()
  expect(await sessionLog.evaluate(element => getComputedStyle(element).position), 'the session-log action must stay in the header flow').not.toBe('fixed')

  const [sessionLogBox, panelBox] = await Promise.all([sessionLog.boundingBox(), panel.boundingBox()])
  expect(sessionLogBox).not.toBeNull()
  expect(panelBox).not.toBeNull()
  expect(sessionLogBox!.width, 'the desktop session-log action must keep its full button width').toBeGreaterThanOrEqual(110)
  expect(sessionLogBox!.x + sessionLogBox!.width, 'the session-log action must not overlap the plugin panel chrome').toBeLessThanOrEqual(panelBox!.x - 8)
  expect(pageErrors).toEqual([])
  expect(consoleErrors).toEqual([])
  expect(requestFailures).toEqual([])
  expect(badResponses).toEqual([])
})
