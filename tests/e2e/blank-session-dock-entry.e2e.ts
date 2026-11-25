/**
 * 空白会话的面板入口 —— issue #698 / #623 的**部署级**门（0.2.0-rc.2 实测现场）。
 *
 * 0.2.0 里空白会话仍渲染会话头，但只渲染 leading + corner（宿主的「Open right sidebar」
 * 按钮）；`header.utilities` / `header.actions` 两个槽**不渲染**，插件挂在 utilities 上的
 * 底部工作台开关随之不可达。本插件在 `conversation.composer.dock`（blank 态渲染且为空）
 * 补一个备用入口，仅在会话仍为 blank 时出现；发出第一条消息后退场，入口交回会话头。
 *
 * 判据：插件自己的稳定 data 属性（`data-dsh-dock-fallback` / `data-dsh-bottom-toggle`），
 * 且「屏幕内可见的底部入口」任意时刻恰好 1 个 —— 宿主会为每个保留会话渲染隐藏副本
 * （transform 平移出视口，rect 仍在），所以计数必须按与视口相交过滤。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { PAGE_URL, createHostApi, dismissOnboarding, hostRpc, sendFirstMessage } from './host'

/** 本用例自己的 workspace（与其它 spec 互不干扰）。 */
const WORKSPACE_PATH = join(tmpdir(), 'dsh-e2e-blank-session-workspace')

let api: APIRequestContext

test.beforeAll(async () => {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, 'seed.txt'), 'blank-session lane\n')
  api = await createHostApi()
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(
    api, 'workspace.create', { path: WORKSPACE_PATH },
  )
  // 只建会话、不发消息：会话落在宿主 `session.blank === true` 的状态。
  await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
})

test.afterAll(async () => {
  await api?.dispose()
})


/** 屏幕内可见的底部入口数量（与插件探针同一判据：rect 与视口相交）。 */
async function onScreenCount(page: Page): Promise<number> {
  return page.evaluate(() => [...document.querySelectorAll('[data-dsh-bottom-toggle]')].filter((element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
      && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth
  }).length)
}

test('a blank session keeps the bottom workbench reachable from the top-right entry', async ({ page }) => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  await dismissOnboarding(page)

  // 新建会话进入 blank 相位：右上角出现备用入口（宿主的侧边栏按钮旁边）。
  await page.getByRole('button', { name: /^(New session|新建会话)$/i }).first().click({ timeout: 30_000 })
  const fallback = page.locator('[data-dsh-dock-fallback]')
  await expect(fallback, '空白会话的备用入口').toBeVisible({ timeout: 60_000 })
  await expect(page.locator('[data-sidebar-right-expand]'), '宿主的侧边栏按钮仍在').toBeVisible()
  await expect.poll(() => onScreenCount(page), { timeout: 30_000 }).toBe(1)

  // 点击 → 打开态 + 底部面板真的展开。
  const bottomEntry = fallback.locator('[data-dsh-bottom-toggle]')
  await bottomEntry.click()
  await expect(bottomEntry).toHaveAttribute('data-active', 'true')
  await expect(page.locator('[data-dsh-bottom-panel]').first()).toBeVisible()

  // 发出第一条消息 → 会话脱离 blank：备用入口退场，入口交回会话头，仍只有一套。
  await sendFirstMessage(page)
  await expect(fallback, '会话头恢复后备用入口退场').toHaveCount(0, { timeout: 60_000 })
  await expect.poll(() => onScreenCount(page), { timeout: 30_000 }).toBe(1)

  expect(pageErrors, 'uncaught page errors').toEqual([])
  expect(consoleErrors, 'console errors').toEqual([])
})

/**
 * Issue #989: a blank session must keep the entry while the host right panel is
 * EXPANDED.
 *
 * In a blank session the host draws no session-header utilities, so this
 * fallback is the ONLY bottom-workbench opener — hiding it while the panel is
 * open leaves the workbench unreachable until the panel is collapsed (the same
 * trap #1053 fixed for the header entry). The expanded panel moves the host's
 * Split / Fullscreen / Collapse cluster inside the panel, so the entry anchors
 * to the panel's own left edge instead: it must stay left of the panel, never
 * on top of panel content.
 */
test('a blank session keeps the bottom workbench reachable while the right panel is expanded (#989)', async ({ page }) => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  await dismissOnboarding(page)

  await page.getByRole('button', { name: /^(New session|新建会话)$/i }).first().click({ timeout: 30_000 })
  const fallback = page.locator('[data-dsh-dock-fallback]')
  await expect(fallback, '空白会话的备用入口').toBeVisible({ timeout: 60_000 })

  // Expand the host's own right column from its corner control.
  await page.locator('[data-sidebar-right-expand]').first().click({ timeout: 60_000 })
  await expect(page.locator('[data-sidebar-right-toggle]').first(), '右侧栏已展开').toBeVisible({ timeout: 30_000 })

  // The entry survives the expand, still exactly one on screen.
  await expect(fallback, '右侧栏展开后空白会话的入口仍应在').toBeVisible({ timeout: 30_000 })
  await expect.poll(() => onScreenCount(page), { timeout: 30_000 }).toBe(1)

  // And it sits LEFT of the panel: never over panel content. Polled rather than
  // measured once — the panel slides in, and the entry follows the measured edge
  // on its own 500ms tick, so a single read can catch the two mid-animation.
  await expect.poll(async () => {
    const entryBox = await fallback.boundingBox()
    const panelBox = await page.locator('[data-sidebar-right-panel]').first().boundingBox()
    if (entryBox === null || panelBox === null) return Number.POSITIVE_INFINITY
    return Math.round(entryBox.x + entryBox.width - panelBox.x)
  }, { timeout: 30_000, message: '入口右缘不得越过面板左缘' }).toBeLessThanOrEqual(0)

  // Clicking it opens the bottom workbench, with the panel still expanded.
  await fallback.locator('[data-dsh-bottom-toggle]').click()
  await expect(page.locator('[data-dsh-bottom-panel]').first()).toBeVisible({ timeout: 30_000 })

  expect(pageErrors, 'uncaught page errors').toEqual([])
  expect(consoleErrors, 'console errors').toEqual([])
})

/**
 * Issue #1218: a brand-new session's right Sidebar must render this plugin's
 * content on the FIRST expand — no host Split control in between.
 *
 * Every other lane expands the right column on a session that already has a
 * message (the header corner is only drawn for a session with content), so the
 * blank-session open path had no coverage. The start page is the plugin's
 * `guideTakeover` chain replacement of the host guide body; the marker
 * `[data-dsh-guide-grid]` exists only on the plugin's own grid, so a visible
 * grid proves the takeover rendered rather than the host's shipped guide.
 */
test('a blank session renders the plugin start page on the first right-sidebar expand (#1218)', async ({ page }) => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  await dismissOnboarding(page)
  await page.getByRole('button', { name: /^(New session|新建会话)$/i }).first().click({ timeout: 30_000 })

  // One click on the host's own control, and nothing else.
  await page.locator('[data-sidebar-right-expand]').first().click({ timeout: 60_000 })

  await expect(
    page.locator('[data-sidebar-right-guide]'),
    'a freshly expanded blank-session surface shows the guide page',
  ).toBeVisible({ timeout: 30_000 })
  await expect(
    page.locator('[data-dsh-guide-grid]'),
    "the plugin's start-page takeover owns the guide body on the first expand",
  ).toBeVisible({ timeout: 30_000 })
  // A slot that failed to resolve draws a host "nothing here" notice instead of
  // the grid; assert the pane holds no such error slot either.
  await expect(page.locator('[data-sidebar-right-panel] [data-slot-error]')).toHaveCount(0)

  expect(pageErrors, 'uncaught page errors').toEqual([])
  expect(consoleErrors, 'console errors').toEqual([])
})
