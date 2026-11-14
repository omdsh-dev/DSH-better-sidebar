/**
 * Acceptance against the officially installed candidate, never a component mock.
 * A private local repository supplies Files/editor/Git; Tasks shows its real root
 * session, and Side chat keeps an unsent draft. Only the commit-message response
 * is controlled to observe pending/error states without invoking a model.
 * Screenshots and computed style JSON are evidence from the served client bundle.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { createHostApi, dismissOnboarding, gotoPage, hostRpc, sendFirstMessage } from './host'
import type { WorkflowRunView } from '../../src/workflow-runs'
import { clueView, expectNoOverflow, floatClueWindow, selectMenu, setTheme, stableWidth } from './ui-helpers'

async function openGuide(page: Page, kind: string): Promise<void> {
  const panel = page.locator('[data-sidebar-right-panel]:visible')
  if (await panel.locator('[data-sidebar-right-guide]').count() === 0) await panel.locator('[data-dockkit-add-tab]').first().click()
  await panel.locator('[data-sidebar-right-guide-entry="' + kind + '"]').click()
}

async function controlStyle(control: Locator) {
  return control.evaluate(node => {
    const s = getComputedStyle(node)
    return { fontSize: s.fontSize, lineHeight: s.lineHeight, minHeight: s.minHeight,
      borderWidth: s.borderWidth, borderStyle: s.borderStyle, borderRadius: s.borderRadius,
      boxShadow: s.boxShadow, backgroundImage: s.backgroundImage, padding: s.padding,
      color: s.color, backgroundColor: s.backgroundColor }
  })
}

async function screenshotMatrix(page: Page, surface: Locator, name: string, info: TestInfo): Promise<void> {
  const layouts: unknown[] = []
  const recordLayout = async (theme: 'light' | 'dark'): Promise<void> => {
    layouts.push({ theme, viewport: page.viewportSize(), surface: await surface.evaluate(node => {
      const rect = node.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }
    }) })
  }
  try {
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme)
    await page.setViewportSize({ width: 1440, height: 900 })
    await recordLayout(theme)
    await expectNoOverflow(surface)
    await surface.screenshot({ animations: 'disabled', path: info.outputPath(name + '-' + theme + '.png') })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme)
    await recordLayout(theme)
    await expectNoOverflow(surface)
    const box = (await surface.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(-1)
    expect(box.x + box.width).toBeLessThanOrEqual(391)
    await surface.screenshot({ animations: 'disabled', path: info.outputPath(name + '-' + theme + '-390.png') })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await setTheme(page, 'light')
  } finally {
    const path = info.outputPath(name + '-layout.json')
    writeFileSync(path, JSON.stringify(layouts, null, 2))
    await info.attach(name + '-layout.json', { path, contentType: 'application/json' })
  }
}

async function keyboardFocus(page: Page, control: Locator): Promise<void> {
  await control.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(control).toBeFocused()
  const focus = await control.evaluate(node => ({ visible: node.matches(':focus-visible'), width: getComputedStyle(node).outlineWidth, style: getComputedStyle(node).outlineStyle }))
  expect(focus.visible).toBe(true)
  expect(Number.parseFloat(focus.width)).toBeGreaterThanOrEqual(1)
  expect(focus.style).toBe('solid')
}

async function menuStyle(page: Page, trigger: Locator) {
  await trigger.click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  expect(await menu.evaluate(node => node.closest('[data-sidebar-right-panel]') === null)).toBe(true)
  const surface = await controlStyle(menu)
  expect(surface.borderWidth).toBe('1px')
  expect(surface.borderStyle).toBe('solid')
  expect(surface.boxShadow).toBe('none')
  expect(surface.backgroundImage).toBe('none')
  const item = await controlStyle(menu.getByRole('menuitem').first())
  expect(Number.parseFloat(item.minHeight)).toBeGreaterThanOrEqual(await page.evaluate(() => matchMedia('(pointer: coarse)').matches) ? 44 : 26)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
  return { surface, item }
}

for (const touch of [false, true]) {
  test('all main surfaces share controls and fit themes and mobile' + (touch ? ' with touch' : ''), async ({ browser }, info) => {
    test.setTimeout(240_000)
    const context = await browser.newContext({ hasTouch: touch, viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    const api = await createHostApi()
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const root = mkdtempSync(join(process.env.DSH_E2E_WORKSPACE ?? tmpdir(), 'uiux-global-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
    git('init', '-b', 'main')
    git('config', 'user.name', 'UI fixture')
    git('config', 'user.email', 'ui@example.invalid')
    writeFileSync(join(root, 'acceptance.md'), '# Browser acceptance\n\nLocal document for preview and keyboard editing.\n')
    writeFileSync(join(root, 'acceptance.html'), '<!doctype html><html><body><h1>Local sandbox preview</h1></body></html>')
    writeFileSync(join(root, 'sample.ts'), 'export const value = 1\n')
    mkdirSync(join(root, 'folder'))
    writeFileSync(join(root, 'folder', 'nested.md'), '# Nested local content\n')
    git('add', '.')
    git('commit', '-m', 'Acceptance baseline')
    git('branch', 'review')
    writeFileSync(join(root, 'sample.ts'), 'export const value = 2\n')
    const before = { head: git('rev-parse', 'HEAD'), refs: git('show-ref'), status: git('status', '--porcelain') }
    const metrics: Record<string, unknown> = { touch }
    try {
      const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: root })
      await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
      await gotoPage(page)
      await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
      await dismissOnboarding(page)
      await sendFirstMessage(page)
      await page.locator('[data-sidebar-right-expand]:visible').first().click()
      const panel = page.locator('[data-sidebar-right-panel]:visible')

      await openGuide(page, 'files')
      const files = panel.locator('[data-sidebar-surface="files"]:visible').first()
      const row = panel.locator('[role="button"][title$="acceptance.md"]:visible')
      await expect(row).toBeVisible()
      await screenshotMatrix(page, files, 'files', info)
      await row.click({ position: { x: 8, y: 8 } })
      const editor = panel.locator('[data-sidebar-surface="editor"]:visible')
      const modes = editor.getByRole('tablist', { name: 'Preview / Edit', exact: true })
      const previewTab = modes.getByRole('tab', { name: 'Preview', exact: true })
      const editTab = modes.getByRole('tab', { name: 'Edit', exact: true })
      await expect(editor.getByRole('heading', { name: 'Browser acceptance', exact: true })).toBeVisible()
      await keyboardFocus(page, previewTab)
      await page.keyboard.press('ArrowRight')
      await expect(editTab).toBeFocused()
      await expect(editTab).toHaveAttribute('aria-selected', 'true')
      await expect(previewTab).toHaveAttribute('tabindex', '-1')
      await expect(editor.locator('.cm-editor')).toBeVisible()
      await screenshotMatrix(page, editor, 'markdown-edit', info)
      await editTab.press('Home')
      await expect(previewTab).toBeFocused()
      await screenshotMatrix(page, editor, 'markdown-preview', info)
      metrics.editorTab = await controlStyle(previewTab)
      for (const [filename, name] of [['sample.ts', 'code-editor'], ['acceptance.html', 'html-preview']] as const) {
        await openGuide(page, 'files')
        await panel.locator('[role="button"][title$="' + filename + '"]:visible').click({ position: { x: 8, y: 8 } })
        await expect(editor).toBeVisible()
        await expect(editor.locator(filename.endsWith('.html') ? 'iframe' : '.cm-editor')).toBeVisible()
        await screenshotMatrix(page, editor, name, info)
      }

      await openGuide(page, 'git')
      const gitRoot = panel.locator('[data-git-root]:visible')
      const changesTabs = panel.getByRole('tablist', { name: 'Git', exact: true })
      const gitTab = changesTabs.getByRole('tab', { name: 'Git', exact: true })
      await keyboardFocus(page, gitTab)
      await gitTab.press('ArrowRight')
      const sessionTab = changesTabs.getByRole('tab', { name: 'Session', exact: true })
      await expect(sessionTab).toBeFocused()
      await expect(gitRoot).toBeHidden()
      await screenshotMatrix(page, sessionTab.locator('xpath=../..'), 'session-files', info)
      await sessionTab.press('Home')
      await expect(gitRoot).toBeVisible()
      await expect(gitRoot.locator('[data-row="sample.ts"]')).toBeVisible()
      await screenshotMatrix(page, gitRoot, 'git', info)
      await gitRoot.locator('[data-row="sample.ts"] [data-path="sample.ts"]').click()
      await expect(panel.locator('[class*="diffPane"]')).toBeVisible()
      await screenshotMatrix(page, changesTabs.locator('xpath=../..'), 'git-diff', info)
      metrics.gitTab = await controlStyle(gitTab)
      const branchFilter = gitRoot.getByRole('button', { name: 'Branch filter', exact: true })
      await expect(branchFilter).toBeVisible()
      metrics.gitSelect = await controlStyle(branchFilter)
      metrics.gitMenu = await menuStyle(page, branchFilter)
      await selectMenu(gitRoot, 'Branch filter', 'review')
      await expect(branchFilter).toContainText('review')
      await selectMenu(gitRoot, 'Branch filter', 'All branches')
      const commit = gitRoot.getByRole('button', { name: 'Commit', exact: true })
      await expect(commit).toBeDisabled()
      metrics.disabled = await controlStyle(commit)
      expect(Number.parseFloat((metrics.disabled as { opacity?: string }).opacity ?? await commit.evaluate(node => getComputedStyle(node).opacity))).toBeLessThan(1)

      // Hold a real user action at its response boundary, without calling a model.
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      await page.route('**/sidebar/api/git.suggest-message', async route => {
        await gate
        await route.fulfill({ status: 500, json: { ok: false, error: { code: 'request-failed', message: 'Acceptance fixture: model unavailable' } } })
      })
      const generate = gitRoot.getByRole('button', { name: /^Generate commit message/ })
      await generate.click()
      await expect(generate).toHaveAttribute('aria-busy', 'true')
      await expect(generate).toBeDisabled()
      await expect(gitRoot.locator('[data-message-box] textarea')).toHaveAttribute('aria-busy', 'true')
      await expect(gitRoot.getByRole('status').filter({ hasText: 'Generating commit message…' })).toBeVisible()
      await gitRoot.screenshot({ path: info.outputPath('git-busy.png') })
      release()
      await expect(gitRoot.getByRole('alert')).toContainText('Acceptance fixture: model unavailable')
      await gitRoot.screenshot({ path: info.outputPath('git-error.png') })
      await expect(generate).toBeEnabled()
      await page.unroute('**/sidebar/api/git.suggest-message')

      // A completed readonly DTO drives the actual Tasks graph/tree without
      // starting subagents or asking a model. The normal keyless session is empty.
      let workflowReads = 0
      await page.route('**/sidebar/api/workflows.list', async route => {
        const { rootSessionId } = route.request().postDataJSON() as { rootSessionId: string }
        const run: WorkflowRunView = { runId: 'uiux-review', name: 'Local UI review',
          originSessionId: rootSessionId, status: 'completed', stopReason: 'completed',
          startedSeq: 1, startedAt: 1_793_894_400_000, finishedAt: 1_793_894_410_000,
          phases: [{ title: 'Review', members: [
            { seq: 1, label: 'Inspect controls', childId: 'uiux-controls', outcome: 'completed' },
            { seq: 2, label: 'Check keyboard access', childId: 'uiux-keyboard', outcome: 'failed' },
          ] }] }
        workflowReads += 1
        await route.fulfill({ json: { ok: true, value: { runs: [run] } } })
      })
      await openGuide(page, 'subagent')
      const tasks = panel.locator('[data-sidebar-surface="tasks"]:visible')
      await expect(tasks).toBeVisible()
      const graphSwitch = tasks.getByRole('button', { name: 'Switch to the workflow graph', exact: true })
      if (await graphSwitch.isVisible()) await graphSwitch.click()
      await expect(tasks.getByRole('group', { name: 'Workflow graph', exact: true })).toBeVisible()
      await screenshotMatrix(page, tasks, 'tasks-graph', info)
      await tasks.getByRole('button', { name: 'Switch to the tree', exact: true }).click()
      await expect(tasks.locator('[data-tasks-row]').first()).toBeVisible()
      await screenshotMatrix(page, tasks, 'tasks-tree', info)
      expect(workflowReads).toBeGreaterThan(0)
      metrics.workflowFixtureReads = workflowReads

      await openGuide(page, 'sidechat')
      const sidechat = panel.locator('[data-sidebar-surface="sidechat"]:visible')
      const draft = sidechat.getByRole('textbox', { name: 'Ask the first question — context inherited…', exact: true })
      await expect(draft).toBeVisible({ timeout: 30_000 })
      const send = sidechat.getByRole('button', { name: 'Send', exact: true })
      await expect(send).toBeDisabled()
      await draft.fill('Unsent acceptance draft — keep this text local.')
      await expect(send).toBeEnabled()
      await screenshotMatrix(page, sidechat, 'sidechat', info)
      await expect(draft).toHaveValue('Unsent acceptance draft — keep this text local.')
      metrics.sidechatMenu = await menuStyle(page, sidechat.getByRole('button', { name: 'Model', exact: true }))

      await openGuide(page, 'clues')
      const clues = panel.locator('[data-clue-tab]:visible')
      // The explorer remembers its layout across visits; this surface always
      // starts from the resources pane.
      await clueView(clues, 'browse')
      const sourceNavigation = clues.locator('[data-clue-source-navigation]')
      await expect(sourceNavigation).toBeVisible({ timeout: 30_000 })
      const sourceWidth = await stableWidth(sourceNavigation)
      if (sourceWidth >= 520) {
        const sourceTabs = sourceNavigation.getByRole('tab')
        await expect(sourceTabs).toHaveCount(5)
        const source = sourceTabs.first()
        metrics.cluesTab = await controlStyle(source)
        await source.focus()
        await source.press('ArrowRight')
        await expect(sourceTabs.nth(1)).toBeFocused()
        await page.keyboard.press('Home')
        await expect(source).toBeFocused()
      } else {
        // The approved narrow form is one host select; it must be reachable
        // and dismissible from the keyboard like every other control.
        const sourceSelect = sourceNavigation.getByRole('button', { name: 'Source', exact: true })
        await expect(sourceSelect).toBeVisible()
        metrics.cluesTab = await controlStyle(sourceSelect)
        await sourceSelect.focus()
        await expect(sourceSelect).toBeFocused()
        await sourceSelect.press('Enter')
        await expect(page.getByRole('menu')).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('menu')).toHaveCount(0)
        await expect(sourceSelect).toBeFocused()
      }
      await expect(sourceNavigation).toHaveAttribute('data-clue-active-source', 'builtin.files')
      const resourceRow = clues.locator('[data-clue-browser-state="page"] li').filter({ has: page.getByRole('button', { name: 'acceptance.md', exact: true }) }).first()
      await expect(resourceRow).toBeVisible()
      // The actual context handler receives four viewport corners; placement may
      // flip but every menu item must remain visible and hit-testable.
      for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 })
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ reducedMotion })
        const viewport = page.viewportSize()!
        for (const [corner, x, y] of [['tl', 1, 1], ['tr', viewport.width - 1, 1], ['bl', 1, viewport.height - 1], ['br', viewport.width - 1, viewport.height - 1]] as const) {
          await resourceRow.evaluate(node => {
            node.addEventListener('contextmenu', event => {
              const pointer = event as MouseEvent
              ;(node as HTMLElement).dataset.e2eMenuPoint = JSON.stringify({ constructor: event.constructor.name, x: pointer.clientX, y: pointer.clientY })
            }, { once: true })
          })
          // contextmenu needs MouseEvent coordinates; Playwright's generic
          // dispatchEvent constructor does not provide clientX/clientY here.
          await resourceRow.evaluate((node, point) => {
            node.dispatchEvent(new MouseEvent('contextmenu', { button: 2, clientX: point.x, clientY: point.y, bubbles: true, cancelable: true }))
          }, { x, y })
          const menu = page.getByRole('menu')
          await expect(menu).toBeVisible()
          const bounds = (await menu.boundingBox())!
          metrics[width + '-' + reducedMotion + '-' + corner] = { requested: { x, y },
            event: JSON.parse((await resourceRow.getAttribute('data-e2e-menu-point'))!), bounds,
            placement: await menu.evaluate(node => {
              const chain = []
              for (let current: Element | null = node; current !== null && chain.length < 4; current = current.parentElement) {
                const style = getComputedStyle(current)
                chain.push({ className: current.className, position: style.position, left: style.left, top: style.top, transform: style.transform })
              }
              return chain
            }), style: await controlStyle(menu) }
          expect(bounds.x).toBeGreaterThanOrEqual(0)
          expect(bounds.y).toBeGreaterThanOrEqual(0)
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
          await expect.poll(async () => {
            const placed = (await menu.boundingBox())!
            const horizontalGap = corner.endsWith('r') ? viewport.width - placed.x - placed.width : placed.x
            const verticalGap = corner.startsWith('b') ? viewport.height - placed.y - placed.height : placed.y
            return Math.max(horizontalGap, verticalGap)
          }, { message: 'the menu must remain anchored near the requested ' + corner + ' corner' }).toBeLessThanOrEqual(24)
          for (const item of await menu.getByRole('menuitem').all()) {
            expect(await item.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })).toBe(true)
          }
          await page.screenshot({ path: info.outputPath('menu-' + width + '-' + reducedMotion + '-' + corner + '.png') })
          await page.keyboard.press('Escape')
          await expect(menu).toHaveCount(0)
        }
      }
      }
      await page.setViewportSize({ width: 1440, height: 900 })
      await resourceRow.getByRole('button', { name: 'acceptance.md', exact: true }).click()
      const detail = await floatClueWindow(page, page.locator('[data-window-document-preview]'))
      await expect(detail.locator('[data-window-document-preview]')).toContainText('Browser acceptance')
      await screenshotMatrix(page, detail, 'resource-window', info)
      metrics.windowTab = await controlStyle(detail.locator('[data-window-mode-tab="preview"]'))
      await detail.getByRole('button', { name: 'Close', exact: true }).click()
      await clueView(clues, 'browse')
      await clues.getByRole('button', { name: 'Open clue source settings', exact: true }).click()
      const sourceSettings = await floatClueWindow(page, page.locator('[data-sidebar-settings]'))
      await expect(sourceSettings).toBeVisible()
      await expect(sourceSettings).toContainText('Sidebar settings')
      const sourceSettingsTabs = sourceSettings.getByRole('tablist', { name: 'Settings groups', exact: true })
      const sourceSettingsRail = sourceSettingsTabs.getByRole('tab')
      if (await sourceSettingsRail.count() > 0) {
        await expect(sourceSettingsRail).toHaveCount(6)
        await expect(sourceSettingsTabs.getByRole('tab', { name: 'Clue sources', exact: true })).toHaveAttribute('aria-selected', 'true')
      } else {
        // A narrow settings window replaces the rail with one group select.
        const groupSelect = sourceSettings.getByRole('button', { name: 'Settings groups', exact: true })
        await expect(groupSelect).toBeVisible()
        await expect(groupSelect).toContainText('Clue sources')
      }
      await expect(sourceSettings.locator('[data-clue-source]')).toHaveCount(5)
      await expect(sourceSettings.locator('[data-clue-source-status="unchecked"]')).toHaveCount(0, { timeout: 30_000 })
      await sourceSettings.locator('[data-clue-advanced] > summary').click()
      await screenshotMatrix(page, sourceSettings, 'clue-settings-window', info)
      await sourceSettings.getByRole('button', { name: 'Close', exact: true }).click()

      await page.getByRole('button', { name: 'Account menu', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'Side card', exact: true }).click()
      const settings = page.locator('[data-sidebar-settings]:visible')
      const settingsTabs = settings.getByRole('tablist', { name: 'Settings groups', exact: true })
      const settingsRail = settingsTabs.getByRole('tab')
      if (await settingsRail.count() > 0) {
        await expect(settingsRail).toHaveCount(5)
        const firstSettingsTab = settingsTabs.getByRole('tab', { name: 'General', exact: true })
        metrics.settingsTab = await controlStyle(firstSettingsTab)
        for (const group of ['General', 'Tabs', 'File viewers', 'Clue sources', 'Appearance']) {
          const groupTab = settingsTabs.getByRole('tab', { name: group, exact: true })
          await groupTab.click()
          await expect(groupTab).toHaveAttribute('aria-selected', 'true')
          await expect(settings.locator('select')).toHaveCount(0)
          if (group === 'Clue sources') await settings.locator('[data-clue-advanced] > summary').click()
          await screenshotMatrix(page, settings, 'settings-' + group.toLowerCase().replaceAll(' ', '-'), info)
        }
      } else {
        // Narrow form: one select at the top of the same continuous rows.
        const groupSelect = settings.getByRole('button', { name: 'Settings groups', exact: true })
        await expect(groupSelect).toBeVisible()
        metrics.settingsTab = await controlStyle(groupSelect)
        for (const group of ['General', 'Tabs', 'File viewers', 'Clue sources', 'Appearance']) {
          await groupSelect.click()
          await page.getByRole('menuitem', { name: group, exact: true }).click()
          await expect(groupSelect).toContainText(group)
          await expect(settings.locator('select')).toHaveCount(0)
          if (group === 'Clue sources') await settings.locator('[data-clue-advanced] > summary').click()
          await screenshotMatrix(page, settings, 'settings-' + group.toLowerCase().replaceAll(' ', '-'), info)
        }
      }
      expect(metrics.gitSelect).toMatchObject({ minHeight: touch ? '44px' : '32px', borderWidth: '1px', borderStyle: 'solid', boxShadow: 'none', backgroundImage: 'none' })
      const tabStyles = [metrics.editorTab, metrics.gitTab, metrics.windowTab]
      for (const style of tabStyles) {
        expect(style).toEqual(tabStyles[0])
        expect(style).toMatchObject({ minHeight: touch ? '44px' : '26px', boxShadow: 'none', backgroundImage: 'none' })
      }
      for (const style of [metrics.cluesTab, metrics.settingsTab]) {
        expect(Number.parseFloat((style as { minHeight: string }).minHeight)).toBeGreaterThanOrEqual(touch ? 44 : 26)
        expect(style).toMatchObject({ boxShadow: 'none', backgroundImage: 'none' })
      }
      expect({ head: git('rev-parse', 'HEAD'), refs: git('show-ref'), status: git('status', '--porcelain') }).toEqual(before)
      expect(errors).toEqual([])
    } finally {
      const measurements = info.outputPath('computed-controls.json')
      writeFileSync(measurements, JSON.stringify(metrics, null, 2))
      await info.attach('computed-controls.json', { path: measurements, contentType: 'application/json' })
      await api.dispose()
      await context.close()
    }
  })
}
