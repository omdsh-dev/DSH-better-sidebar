/**
 * Real-host clue workbench visual/interaction gate. Uses only local fixture
 * files and the public clue API in the mount lane's isolated HOME: no remote
 * account, dependency installation, authorization or source writes.
 *
 * Checks the component's actual column width (not the desktop viewport), both
 * host themes, on-demand modal help and its marker, full-height view sizing,
 * the lazy document Preview/Edit modes, native row/shelf/pins/pack menus
 * (mouse + keyboard), debounced search and the activation-scoped client read
 * cache (no read TTL), and fixed share actions while long content scrolls.
 * Loading is observed as the shared animated indicator.
 * Screenshots are test artifacts, not mockups and not evidence about the user's
 * current GUI installation.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { clueView, expectNoOverflow, selectClueSource, selectionMode, setTheme, stableWidth } from './ui-helpers'
import { createHostApi, dismissOnboarding, gotoPage, hostRpc, sendFirstMessage, sidebarApi } from './host'

/** One measured workbench layout, written to the test artifact for tuning. */
interface ClueLayoutMetric {
  readonly theme: 'light' | 'dark'
  readonly width: number
  readonly view: 'browse' | 'packs'
  readonly height: number
  readonly firstRowHeight: number
  readonly scrollHeight: number
}

/** The versioned marker the guide dialog writes when the reader closes it. */
const CLUE_HELP_SEEN_KEY = 'dsh-better-sidebar:clues-help-seen-v2'

/**
 * Start a case as a returning reader. The first-visit guide is its own normal
 * test; every other case marks it seen through this helper rather than poking
 * window.localStorage from the test body.
 */
async function markHelpSeen(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    // Init scripts run in every frame; a sandboxed preview frame has no
    // same-origin storage, so only the top document writes the flag.
    if (window === window.top) window.localStorage.setItem(key, '1')
  }, CLUE_HELP_SEEN_KEY)
}

test('clues workbench stays usable across column widths and host themes', async ({ page }, testInfo) => {
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let clueListRequests = 0
  let clueStatusRequests = 0
  let clueReadRequests = 0
  let clueLoadEditRequests = 0
  const requestMetrics: Record<string, unknown> = {}
  page.on('request', request => {
    if (request.url().endsWith('/sidebar/api/clues.list')) clueListRequests += 1
    if (request.url().endsWith('/sidebar/api/clues.read')) clueReadRequests += 1
    if (request.url().endsWith('/sidebar/api/clues.loadEdit')) clueLoadEditRequests += 1
    if (/\/sidebar\/api\/clues\.(dependencies\.inspect|connections\.status)$/.test(request.url())) clueStatusRequests += 1
  })
  const api = await createHostApi()
  try {
    const path = join(process.env.DSH_E2E_WORKSPACE ?? tmpdir(), `clues-uiux-${Date.now()}`)
    mkdirSync(path, { recursive: true })
    const documents = ['api-contract.md', 'architecture-decisions.md', 'design-system.md', 'implementation-notes.md', 'launch-checklist.md', 'product-brief.md', 'research-summary.md', 'team-onboarding.md']
    for (let index = 0; index < 30; index += 1) {
      writeFileSync(join(path, documents[index] ?? `reference-${String(index).padStart(2, '0')}-long-resource-name.md`), `# Reference ${index}\n\nLocal fixture content.\n`)
    }
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path })
    const workspaceId = workspace.value.workspace.workspaceId
    await hostRpc(api, 'session.create', { workspaceId })
    const listing = await api.post(sidebarApi('clues.list'), { data: { workspaceId, sourceId: 'builtin.files' } })
    const listed = await listing.json() as { value: { items: { sourceId: string; typeId: string; title: string; locator: unknown }[] } }
    const memberIds: string[] = []
    const memberIdByTitle = new Map<string, string>()
    for (const item of listed.value.items.slice(0, 6)) {
      const ensured = await api.post(sidebarApi('clues.ensure'), { data: { workspaceId, ...item } })
      expect(ensured.ok()).toBe(true)
      const body = await ensured.json() as { value: { clue: { id: string } } }
      memberIds.push(body.value.clue.id)
      memberIdByTitle.set(item.title, body.value.clue.id)
    }
    // Product decisions is created FIRST so it is the OLDEST pack and therefore
    // the last row in the newest-first progressive list.
    const names = ['Product decisions', 'Architecture notes', 'Integration checklist', 'Release context and implementation references']
    for (let index = 0; index < 12; index += 1) {
      const result = await api.post(sidebarApi('clues.packs.create'), {
        data: { workspaceId, name: names[index] ?? `Reference pack ${index}`, members: index === 3 ? memberIds.slice(2, 6) : memberIds.slice(0, index % 4 === 0 ? 0 : index % 4 + 1) },
      })
      expect(result.ok()).toBe(true)
      expect((await result.json() as { ok: boolean }).ok).toBe(true)
    }

    await gotoPage(page, {}, { firstCluesVisit: true })
    await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
    await dismissOnboarding(page)
    await sendFirstMessage(page)
    await page.locator('[data-sidebar-right-expand]:visible').first().click()
    await page.locator('[data-sidebar-right-guide-entry="clues"]').click()
    const tab = page.locator('[data-clue-tab]:visible')
    await expect(tab).toBeVisible()
    /** One host Menu instance is opened at a time (browser/pins/shelf/pack). */
    const popupMenu = page.getByRole('menu')
    // First visit opens the host guide dialog; the question control can reopen it later.
    const help = page.locator('[data-clue-help]')
    const helpDialog = page.getByRole('dialog', { name: 'Use resources in three steps', exact: true })
    await expect(help).toBeVisible()
    await expect(helpDialog).toHaveAttribute('aria-modal', 'true')
    await expect(helpDialog.getByRole('button', { name: 'Close help', exact: true })).toBeVisible()
    await expect.poll(() => helpDialog.evaluate(node => node.contains(document.activeElement))).toBe(true)
    await expect(help.locator('[data-clue-help-step]')).toHaveCount(3)
    await expect(help.locator('[data-clue-help-flow], [data-clue-help-pin], [data-clue-help-binding], [data-clue-help-share]')).toHaveCount(0)
    await expect.poll(() => page.evaluate(key => window.localStorage.getItem(key), CLUE_HELP_SEEN_KEY)).toBeNull()
    await help.screenshot({ path: testInfo.outputPath('clues-help.png') })
    const helpTrigger = tab.getByRole('button', { name: 'Show clues help', exact: true })
    await page.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
    await expect.poll(() => page.evaluate(key => window.localStorage.getItem(key), CLUE_HELP_SEEN_KEY)).toBe('1')
    await expect(helpTrigger).toBeFocused()
    // The header question control reopens the same guide on demand.
    await helpTrigger.click()
    await expect(help).toBeVisible()
    await helpDialog.getByRole('button', { name: 'Close help', exact: true }).click()
    await expect(help).toHaveCount(0)
    await expect(helpTrigger).toBeFocused()

    const tabHeader = tab.locator('[data-sidebar-toolbar]')
    const packs = tab.locator('[data-clue-pack-region]')
    const browser = tab.locator('[data-clue-browse-region]')
    const query = browser.getByRole('textbox', { name: 'Keyword, resource link or file path', exact: true, includeHidden: true })
    const packFilter = packs.getByRole('searchbox', { name: 'Search clue packs', exact: true })
    const results = browser.getByRole('region', { name: 'Browse sources', exact: true })
    const packScroll = packs.locator('[data-clue-pack-scroll]')
    const toggleBrowser = async (): Promise<void> => clueView(tab, await browser.isVisible() ? 'packs' : 'browse')
    /** Resolve one DSH theme alias to the browser's computed color. */
    const resolveToken = async (token: string): Promise<string> => page.evaluate(name => {
      const probe = document.createElement('span')
      probe.style.background = `var(${name})`
      document.querySelector('[data-clue-tab]')!.append(probe)
      const color = getComputedStyle(probe).backgroundColor
      probe.remove()
      return color
    }, token)
    const resolveWithin = async (scope: Locator, token: string): Promise<string> => scope.evaluate((node, name) => {
      const probe = document.createElement('span')
      probe.style.background = `var(${name})`
      node.append(probe)
      const color = getComputedStyle(probe).backgroundColor
      probe.remove()
      return color
    }, token)
    /** Walk to the first painted ancestor: transparent panes still show the surface below. */
    const effectiveBackground = async (target: Locator): Promise<string> => target.evaluate(node => {
      let element: Element | null = node
      while (element !== null) {
        const color = getComputedStyle(element).backgroundColor
        if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color
        element = element.parentElement
      }
      return ''
    })
    const layoutMetrics: ClueLayoutMetric[] = []
    const colorMetrics: Record<string, unknown>[] = []
    await expect(tab.getByRole('button', { name: 'Resources', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await expect(packs).toBeHidden()
    await expect(browser.getByRole('region', { name: 'Resources', exact: true })).toBeVisible()
    await clueView(tab, 'packs')
    await expect(packs.getByRole('region', { name: 'Collections', exact: true })).toBeVisible()
    await clueView(tab, 'browse')
    const composer = page.getByRole('textbox', { name: /^(Describe what you want to build|Message or run a task|描述你想要构建)/ })
    const sourceNavigation = browser.locator('[data-clue-source-navigation]')
    const sourceWidth = await stableWidth(sourceNavigation)
    if (sourceWidth >= 520) {
      const sourceTabs = sourceNavigation.getByRole('tab')
      await expect(sourceTabs).toHaveCount(5)
      await expect(sourceNavigation.getByRole('tab', { name: /Local files/ })).toBeVisible()
      await expect(sourceNavigation.getByRole('tab', { name: /Local files/ }).locator('[aria-hidden=true] svg')).toHaveCount(1)
    } else {
      // The approved narrow form: one select, never a clipped five-button row.
      const sourceSelect = sourceNavigation.getByRole('button', { name: 'Source', exact: true })
      await expect(sourceSelect).toBeVisible()
      await expect(sourceSelect).toContainText('Local files')
    }
    await expect(browser.getByRole('combobox', { name: 'Source', exact: true })).toHaveCount(0)
    await expect(browser.getByRole('search')).toHaveCSS('height', '32px')
    await expect(query).toHaveCSS('font-size', '13px')
    await expect(query).toHaveCSS('line-height', '20px')
    const searchGutter = await browser.getByRole('search').evaluate(node => {
      const tab = node.closest('[data-clue-tab]')!
      return node.getBoundingClientRect().left - tab.getBoundingClientRect().left
    })
    expect(searchGutter).toBe(16)

    // Background refresh contract: the current page and the search box stay
    // exactly where they are; the fixed refresh control is the only status,
    // and the old rows remain readable until the new answer lands.
    const firstResult = results.locator('li').first()
    await expect(firstResult).toBeVisible()
    const oldResultText = (await firstResult.innerText()).trim()
    const queryBeforeRefresh = (await query.boundingBox())!
    const requestsBeforeRefresh = clueListRequests
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const refreshRoute = '**/sidebar/api/clues.list'
    await page.route(refreshRoute, async (route) => {
      await refreshGate
      await route.continue()
    })
    const refreshedResponse = page.waitForResponse(response =>
      response.url().endsWith('/clues.list') && response.status() === 200)
    await browser.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(browser.locator('[data-clue-refresh-status="refreshing"]')).toBeVisible()
    expect(Math.round((await query.boundingBox())!.y)).toBe(Math.round(queryBeforeRefresh.y))
    expect((await firstResult.innerText()).trim()).toBe(oldResultText)
    expect(clueListRequests).toBe(requestsBeforeRefresh + 1)
    releaseRefresh()
    await refreshedResponse
    await page.unroute(refreshRoute)
    await expect(browser.locator('[data-clue-refresh-status="refreshing"]')).toHaveCount(0)
    await expect(firstResult).toBeVisible()

    // Vary the component's own column independently from the wide desktop.
    const rightPanel = page.locator('[data-sidebar-right-panel]').first()
    const panelClientWidth = async (): Promise<number> => rightPanel.evaluate(node => node.clientWidth)
    const initialPanelWidth = await panelClientWidth()
    const resizePanel = async (width: number): Promise<void> => {
      const handle = page.locator('[data-side="rightbar"][class*="handle"]').first()
      // The native layout store follows ResizeObserver -> rAF. A new DOM
      // viewport alone does not mean the handle has moved to the panel edge.
      await expect.poll(async () => {
        const panel = (await rightPanel.boundingBox())!
        const grip = (await handle.boundingBox())!
        const x = grip.x + grip.width / 2
        const y = grip.y + grip.height / 2
        const hit = await page.evaluate(({ x, y }) =>
          document.elementFromPoint(x, y)?.closest('[data-side="rightbar"]') !== null, { x, y })
        return hit ? Math.abs(x - panel.x) : 9999
      }).toBeLessThanOrEqual(1)
      const panelWidth = await panelClientWidth()
      const handleBounds = (await handle.boundingBox())!
      const x = handleBounds.x + handleBounds.width / 2
      const y = handleBounds.y + handleBounds.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await expect(handle).toHaveAttribute('data-dragging', 'true')
      await page.mouse.move(x + panelWidth - width, y, { steps: 6 })
      await page.mouse.up()
      await expect.poll(async () => Math.abs((await panelClientWidth()) - width)).toBeLessThanOrEqual(2)
    }
    // Each view fills the same column; only the active view consumes height.
    await page.setViewportSize({ width: 2200, height: 1000 })
    await resizePanel(1100)
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme)
      for (const view of ['browse', 'packs'] as const) {
        await clueView(tab, view)
        const active = view === 'browse' ? browser : packs
        const tabBox = (await tab.boundingBox())!
        const box = (await active.boundingBox())!
        expect(Math.abs(box.width - tabBox.width)).toBeLessThanOrEqual(1)
        expect(box.height).toBeGreaterThan(tabBox.height * 0.7)
        await expectNoOverflow(active)
        await tab.screenshot({ path: testInfo.outputPath('clues-wide-1100-' + theme + '-' + view + '.png') })
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await resizePanel(700)
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme)
      for (const width of [320, 390, 640]) {
        await tab.evaluate((node, value) => { (node as HTMLElement).style.width = value + 'px' }, width)
        for (const view of ['browse', 'packs'] as const) {
          await clueView(tab, view)
          const active = view === 'browse' ? browser : packs
          const scroll = view === 'browse' ? results : packScroll
          await scroll.evaluate(node => { node.scrollTop = 0 })
          await expectNoOverflow(tab)
          await expectNoOverflow(active)
          await expectNoOverflow(scroll)
          const tabBox = (await tab.boundingBox())!
          const first = view === 'browse' ? results.locator('li').first() : packs.getByRole('button', { name: /^Manage pack:/ }).first()
          await expect(first).toBeVisible()
          const firstBox = (await first.boundingBox())!
          expect(firstBox.y + firstBox.height).toBeLessThan(tabBox.y + tabBox.height * 0.58)
          expect((await scroll.boundingBox())!.height).toBeGreaterThanOrEqual(tabBox.height * 0.48)
          if (view === 'browse') {
            // Browsing exposes one quiet menu per row; checkboxes need an explicit action.
            await expect(first.getByRole('checkbox')).toHaveCount(0)
            const insert = first.getByRole('button', { name: /^Insert / }).first()
            await expect(insert.locator('svg')).toHaveCount(1)
            expect((await insert.innerText()).trim()).toBe('')
            if (width >= 520) {
              await expect(sourceNavigation.getByRole('tab')).toHaveCount(5)
            } else {
              await expect(sourceNavigation.getByRole('button', { name: 'Source', exact: true })).toBeVisible()
              await expect(sourceNavigation.getByRole('tab')).toHaveCount(0)
            }
            await expect(browser.locator('[data-clue-result-pagination]')).toHaveCount(0)
          } else {
            await expect(packs.getByRole('button', { name: /^Manage pack:/ })).toHaveCount(12)
            await expect(packs.locator('[data-clue-pack-pagination]')).toHaveCount(0)
            const title = packs.getByRole('button', { name: 'Manage pack: Release context and implementation references', exact: true })
            await title.scrollIntoViewIfNeeded()
            // 30px rows: one line with an ellipsis (the full name stays in the title/tooltip).
            const packNameStyle = await title.locator('[data-clue-pack-name]').evaluate(node => {
              const s = getComputedStyle(node)
              return { clamp: s.webkitLineClamp, overflow: s.textOverflow, whiteSpace: s.whiteSpace }
            })
            expect(packNameStyle).toEqual({ clamp: 'none', overflow: 'ellipsis', whiteSpace: 'nowrap' })
          }
          const before = (await tabHeader.boundingBox())!.y
          const overflows = await scroll.evaluate(node => node.scrollHeight > node.clientHeight)
          await scroll.evaluate(node => { node.scrollTop = node.scrollHeight })
          if (overflows) expect(await scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
          else expect(await scroll.evaluate(node => node.scrollTop)).toBe(0)
          expect((await tabHeader.boundingBox())!.y).toBe(before)
          layoutMetrics.push({ theme, width, view, height: tabBox.height, firstRowHeight: firstBox.height, scrollHeight: (await scroll.boundingBox())!.height })
          await tab.screenshot({ path: testInfo.outputPath('clues-' + view + '-' + theme + '-' + width + '.png') })
        }
      }
    }
    writeFileSync(testInfo.outputPath('clues-layout-metrics.json'), JSON.stringify(layoutMetrics, null, 2))
    await setTheme(page, 'light')
    await clueView(tab, 'browse')
    // The two explorer sections are independent disclosures: each bar is a
    // native button with its own expanded state, and a collapse keeps the body
    // mounted (a keyboard toggle must not lose the page).
    const browseHeader = tab.getByRole('button', { name: 'Resources', exact: true })
    const packsHeader = tab.getByRole('button', { name: 'Collections', exact: true })
    await browseHeader.focus()
    await expect(browseHeader).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(browseHeader).toHaveAttribute('aria-expanded', 'false')
    await expect(browser).toBeHidden()
    await page.keyboard.press('Enter')
    await expect(browseHeader).toHaveAttribute('aria-expanded', 'true')
    await expect(browser).toBeVisible()
    await packsHeader.focus()
    await page.keyboard.press('Enter')
    await expect(packsHeader).toHaveAttribute('aria-expanded', 'true')
    await expect(packs).toBeVisible()
    await clueView(tab, 'browse')

    // Source range is explicit: the window never opens by choosing a source.
    await query.fill('architecture')
    await query.press('Enter')
    await expect(browser.locator('[data-clue-browser-state="page"] li').first()).toContainText('architecture')
    await selectClueSource(browser, 'builtin.github.issues')
    await expect(sourceNavigation).toHaveAttribute('data-clue-active-source', 'builtin.github.issues')
    const scopeWindow = (): Locator => page.locator('[data-floating-window]')
      .filter({ has: page.locator('[data-clue-scope-window]') })
    await expect(scopeWindow()).toHaveCount(0)
    await browser.getByRole('button', { name: /^Choose range/ }).first().click()
    await expect(scopeWindow()).toBeVisible()
    const githubScope = scopeWindow()
    await githubScope.getByRole('textbox', { name: 'GitHub repository', exact: true }).fill('acme/widgets')
    await githubScope.getByRole('radio', { name: 'Closed', exact: true }).check()
    await page.mouse.move(0, 0)
    await githubScope.screenshot({ path: testInfo.outputPath('clues-scope-github.png') })
    await githubScope.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(scopeWindow()).toHaveCount(0)
    // The unsaved draft survives a source round trip; saving is explicit.
    await selectClueSource(browser, 'builtin.feishu.docs')
    await selectClueSource(browser, 'builtin.github.issues')
    await browser.getByRole('button', { name: /^Choose range/ }).first().click()
    await expect(scopeWindow()).toBeVisible()
    await expect(scopeWindow().getByRole('textbox', { name: 'GitHub repository', exact: true })).toHaveValue('acme/widgets')
    await expect(scopeWindow().getByRole('radio', { name: 'Closed', exact: true })).toBeChecked()
    await scopeWindow().getByRole('button', { name: 'Save range', exact: true }).click()
    await expect(scopeWindow()).toHaveCount(0)

    await selectClueSource(browser, 'builtin.feishu.docs')
    await expect(scopeWindow()).toHaveCount(0)
    await browser.getByRole('button', { name: /^Choose range/ }).first().click()
    await expect(scopeWindow()).toBeVisible()
    const feishuScope = scopeWindow()
    await feishuScope.getByRole('radio', { name: 'A wiki space', exact: true }).check()
    await feishuScope.getByRole('textbox', { name: 'A wiki space', exact: true }).fill('space-42')
    await page.mouse.move(0, 0)
    await feishuScope.screenshot({ path: testInfo.outputPath('clues-scope-feishu.png') })
    await feishuScope.getByRole('button', { name: 'Close', exact: true }).click()
    await selectClueSource(browser, 'builtin.files')
    await selectClueSource(browser, 'builtin.feishu.docs')
    await browser.getByRole('button', { name: /^Choose range/ }).first().click()
    await expect(scopeWindow().getByRole('textbox', { name: 'A wiki space', exact: true })).toHaveValue('space-42')
    await scopeWindow().getByRole('button', { name: 'Save range', exact: true }).click()
    await expect(scopeWindow()).toHaveCount(0)

    await selectClueSource(browser, 'builtin.files')
    await expect(query).toHaveValue('architecture')
    await expect(browser.locator('[data-clue-browser-state="page"] li').first()).toContainText('architecture')
    await selectClueSource(browser, 'builtin.github.issues')
    await browser.getByRole('button', { name: /^Choose range/ }).first().click()
    await expect(scopeWindow().getByRole('radio', { name: 'Closed', exact: true })).toBeChecked()
    await scopeWindow().getByRole('button', { name: 'Close', exact: true }).click()
    await selectClueSource(browser, 'builtin.files')
    await expect(query).toHaveValue('architecture')

    await clueView(tab, 'packs')
    // Pack filtering and the SVG insert action replace the old literal '@'.
    // Collection search is always visible in its own view.
    await packFilter.fill('Architecture')
    await expect(packFilter.locator('..')).toHaveCSS('height', '32px')
    await expect(packFilter).toHaveCSS('font-size', '13px')
    await expect(packs.getByRole('button', { name: 'Manage pack: Architecture notes', exact: true })).toBeVisible()
    await expect(query).toHaveValue('architecture')
    await packFilter.fill('')
    await expect(packs.getByRole('button', { name: /^Manage pack:/ })).toHaveCount(12)
    await expect(packs.locator('[data-clue-pack-pagination]')).toHaveCount(0)
    const manage = packs.getByRole('button', { name: 'Manage pack: Release context and implementation references', exact: true })
    await manage.scrollIntoViewIfNeeded()
    const insert = packs.getByRole('button', { name: 'Insert pack: Release context and implementation references', exact: true })
    await expect(insert.locator('svg')).toHaveCount(1)
    expect((await insert.innerText()).trim()).toBe('')
    await manage.focus()
    await page.keyboard.press('Tab')
    await expect(insert).toBeFocused()
    await insert.press('Enter')
    await expect(page.locator('[data-floating-window]:visible')).toHaveCount(0)
    await expect(query).toHaveValue('architecture')

    // A short workbench still contains the last pack row inside the 158px
    // pack viewport: geometry, not just visibility/scrollHeight.
    await tab.evaluate(node => { (node as HTMLElement).style.height = '400px' })
    await expect.poll(() => tab.evaluate(node => Math.round(node.getBoundingClientRect().height))).toBe(400)
    await expect(packs).toBeVisible()
    await packFilter.fill('')
    await packScroll.evaluate(node => { node.scrollTop = node.scrollHeight })
    const lastPack = packs.getByRole('button', { name: 'Manage pack: Product decisions', exact: true })
    await expect(lastPack).toBeVisible()
    // The short-height pass above changes the box between frames; align the
    // last row before measuring its bounds rather than trusting one scrollTop.
    await lastPack.scrollIntoViewIfNeeded()
    const lastPackBounds = (await lastPack.boundingBox())!
    const packScrollBounds = (await packScroll.boundingBox())!
    const tabBounds = (await tab.boundingBox())!
    expect(lastPackBounds.x).toBeGreaterThanOrEqual(packScrollBounds.x - 1)
    expect(lastPackBounds.x + lastPackBounds.width).toBeLessThanOrEqual(packScrollBounds.x + packScrollBounds.width + 1)
    // The shelf's inner scroll may keep the row one line under its own box
    // while the section paints it; the user-visible contract is the tab box.
    expect(lastPackBounds.y).toBeGreaterThanOrEqual(tabBounds.y - 1)
    expect(lastPackBounds.y + lastPackBounds.height).toBeLessThanOrEqual(tabBounds.y + tabBounds.height + 1)
    await expect(packs.getByRole('region', { name: 'Collections', exact: true })).toBeVisible()
    await expect(packFilter).toBeVisible()
    await page.mouse.move(0, 0)
    await tab.screenshot({ path: testInfo.outputPath('clues-short-height-search.png') })
    await tab.evaluate(node => { (node as HTMLElement).style.height = '' })
    await expect(packFilter).toBeVisible()

    await clueView(tab, 'browse')
    // No pager: scrolling the result viewport appends 25 -> 30 exactly once.
    await browser.getByRole('button', { name: 'Clear search', exact: true }).click()
    // Earlier theme/width sweeps may already have cached page two. Test a cold
    // append here; the separate source-flip check covers warm-cache reuse.
    await browser.getByRole('button', { name: 'Refresh', exact: true }).click()
    const resultRows = browser.locator('[data-clue-browser-state="page"] li')
    await expect(resultRows).toHaveCount(25)
    await expect.poll(() => results.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
    await results.evaluate(node => { node.scrollTop = 0 })
    await packScroll.evaluate(node => { node.scrollTop = 0 })
    await resultRows.first().evaluate(node => { (node as HTMLElement).dataset.e2eFirst = 'true' })
    const firstPageLabels = await resultRows.evaluateAll(nodes => nodes.slice(0, 25).map(node => node.textContent))
    await expect(browser.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0)
    await expect(browser.getByRole('button', { name: 'Previous', exact: true })).toHaveCount(0)
    const requestsBeforeAppend = clueListRequests
    // The page really has another cursor and no append is in flight.
    await expect(results).toHaveAttribute('data-clue-has-next', 'true')
    await expect(results).toHaveAttribute('data-clue-more-loading', 'false')
    await expect(results).toHaveAttribute('data-clue-request-busy', 'false')
    await results.evaluate(node => { node.scrollTop = node.scrollHeight })
    const appendProbe = await results.evaluate(node => {
      const sentinel = node.querySelector('[data-clue-result-sentinel]')
      const box = node.getBoundingClientRect()
      return {
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
        sentinelTop: sentinel === null ? null : sentinel.getBoundingClientRect().top,
        boxBottom: box.bottom,
      }
    })
    expect(appendProbe.scrollTop).toBeGreaterThan(0)
    expect(appendProbe.sentinelTop).not.toBeNull()
    expect(appendProbe.sentinelTop!).toBeLessThanOrEqual(appendProbe.boxBottom + 100)
    const scrollBeforeAppend = await results.evaluate(node => node.scrollTop)
    // A loaded host can batch the first scroll event; nudge the bottom again
    // while the owner's in-flight guard keeps the append exactly-once.
    await expect.poll(async () => {
      if (await resultRows.count() < 30) await results.evaluate(node => { node.scrollTop = node.scrollHeight })
      return resultRows.count()
    }, { timeout: 20_000 }).toBe(30)
    await expect(resultRows.first()).toHaveAttribute('data-e2e-first', 'true')
    expect(await resultRows.evaluateAll(nodes => nodes.slice(0, 25).map(node => node.textContent))).toEqual(firstPageLabels)
    await expect(query).toHaveValue('')
    expect(await results.evaluate(node => node.scrollTop)).toBeGreaterThanOrEqual(scrollBeforeAppend - 2)
    expect(clueListRequests).toBe(requestsBeforeAppend + 1)
    const lateListRequest = await page.waitForRequest(request => request.url().endsWith('/sidebar/api/clues.list'), { timeout: 750 })
      .then(() => true).catch(() => false)
    expect(lateListRequest).toBe(false)
    expect(clueListRequests).toBe(requestsBeforeAppend + 1)
    await expect(browser.locator('[data-clue-result-pagination]')).toHaveCount(0)
    await results.evaluate(node => { node.scrollTop = 0 })

    // Runtime query flow: keyword search is trailing-edge debounced (300ms),
    // explicit Refresh invalidates exactly the page family, and a hidden or
    // revisited warm list is served without another network round trip.
    const searchRequests: string[] = []
    const resolveRequests: string[] = []
    page.on('request', request => {
      if (request.url().endsWith('/sidebar/api/clues.search')) searchRequests.push(request.url())
      if (request.url().endsWith('/sidebar/api/clues.resolve')) resolveRequests.push(request.url())
    })
    // Links/paths stay explicit: Enter resolves immediately, never through the
    // debounced keyword search.
    await query.fill('https://github.com/acme/widgets/issues/7')
    await query.press('Enter')
    await expect.poll(() => resolveRequests.length).toBe(1)
    expect(searchRequests).toHaveLength(0)
    await browser.getByRole('button', { name: 'Clear search', exact: true }).click()
    await expect(browser.locator('[data-clue-browser-state="page"]')).toBeVisible()

    await query.fill('refe')
    await query.fill('reference')
    await expect(results.locator('li').first()).toBeVisible()
    await expect.poll(() => searchRequests.length).toBe(1)
    expect(searchRequests).toHaveLength(1)
    await browser.getByRole('button', { name: 'Clear search', exact: true }).click()
    await expect(browser.locator('[data-clue-browser-state="page"]')).toBeVisible()

    // Loading: a delayed list request must expose the real spinner, with CSS
    // rotation in normal motion and none under reduced motion.
    let delayNextList = true
    const listRoute = '**/sidebar/api/clues.list'
    await page.route(listRoute, async route => {
      if (delayNextList) {
        delayNextList = false
        await new Promise(resolve => setTimeout(resolve, 5_200))
      }
      await route.continue()
    })
    const beforeLoading = clueListRequests
    await browser.getByRole('button', { name: 'Refresh', exact: true }).click()
    const loading = browser.locator('[data-clue-refresh-status="refreshing"] [data-loading-indicator]')
    await expect(loading).toBeVisible()
    expect(await loading.evaluate(node => getComputedStyle(node.querySelector('[aria-hidden="true"]') ?? node).animationName)).not.toBe('none')
    await expect.poll(() => clueListRequests).toBe(beforeLoading + 1)
    // Leave while the actual HTTP is pending, then return inside the shared
    // five-second protection window. A second wire request would be a regression.
    await toggleBrowser()
    await expect(browser).toBeHidden()
    const leftAt = Date.now()
    await page.waitForTimeout(4_500)
    await toggleBrowser()
    await expect(browser).toBeVisible()
    requestMetrics.pendingViewTimeAwayMs = Date.now() - leftAt
    await expect(loading).toHaveCount(0)
    await expect(browser.locator('[data-clue-browser-state="page"]')).toBeVisible()
    expect(clueListRequests).toBe(beforeLoading + 1)
    requestMetrics.pendingViewReturnListRequests = clueListRequests - beforeLoading
    await page.unroute(listRoute)

    // A settled page is a cache paint: switching views and returning adds no
    // read, and the same rows stay on screen.
    const settledViewRequests = clueListRequests
    await toggleBrowser()
    await expect(browser).toBeHidden()
    await toggleBrowser()
    await expect(browser).toBeVisible()
    await expect(browser.locator('[data-clue-browser-state="page"]')).toBeVisible()
    expect(clueListRequests).toBe(settledViewRequests)
    requestMetrics.settledViewReturnListRequests = clueListRequests - settledViewRequests

    delayNextList = true
    await page.route(listRoute, async route => {
      if (delayNextList) {
        delayNextList = false
        await new Promise(resolve => setTimeout(resolve, 900))
      }
      await route.continue()
    })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const beforeReduced = clueListRequests
    await browser.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(loading).toBeVisible()
    expect(await loading.evaluate(node => getComputedStyle(node.querySelector('[aria-hidden="true"]') ?? node).animationName)).toBe('none')
    await expect.poll(() => clueListRequests).toBe(beforeReduced + 1)
    await expect(loading).toHaveCount(0)
    await expect(browser.locator('[data-clue-browser-state="page"]')).toBeVisible()
    await page.unroute(listRoute)
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    // The activation-scoped cache (no read TTL) serves a warm Files flip
    // without another list request. Feishu may still be cold here and can stay
    // in its own page/error/needs-scope terminal state; that read is not what
    // this assertion pins.
    const beforeFeishuRequests = clueListRequests
    await selectClueSource(browser, 'builtin.feishu.docs')
    await expect(browser.locator('[data-clue-browser-state="page"], [data-clue-browser-state="error"], [data-clue-browser-state="needs-scope"]').first()).toBeVisible()
    const afterFeishuRequests = clueListRequests
    requestMetrics.feishuSourceFlipListRequests = afterFeishuRequests - beforeFeishuRequests
    await selectClueSource(browser, 'builtin.files')
    await expect(browser.locator('[data-clue-browser-state="page"]')).toBeVisible()
    await expect.poll(() => clueListRequests).toBe(afterFeishuRequests)
    requestMetrics.cachedFilesReturnListRequests = clueListRequests - afterFeishuRequests

    // Pinned strip uses the same WorkbenchSection bar and keeps results usable.
    await tab.evaluate(node => { (node as HTMLElement).style.width = '390px' })
    await expect.poll(() => tab.evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(390)
    const pinnedTitles = ['api-contract.md', 'architecture-decisions.md', 'design-system.md']
    for (const title of pinnedTitles) {
      await results.getByRole('button', { name: `More actions: ${title}`, exact: true }).click()
      await popupMenu.getByRole('menuitem', { name: 'Pin', exact: true }).click()
      await expect(tab.locator('[data-clue-pins-region]').getByTitle(title, { exact: true })).toBeVisible()
    }
    const pinsRegion = tab.locator('[data-clue-pins-region]')
    await expect(pinsRegion).toBeVisible()
    const pinRow = pinsRegion.locator('li').first()
    await pinRow.click({ button: 'right' })
    await expect(popupMenu).toBeVisible()
    await expect(popupMenu.getByRole('menuitem', { name: 'Preview', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(popupMenu).toHaveCount(0)
    await pinRow.getByRole('button').first().focus()
    await page.keyboard.press('ContextMenu')
    await expect(popupMenu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(popupMenu).toHaveCount(0)
    const pinnedResultsBounds = await results.boundingBox()
    await results.evaluate(node => { node.scrollTop = 0 })
    await page.mouse.move(0, 0)
    await tab.screenshot({ path: testInfo.outputPath('clues-pinned-390.png') })
    expect(pinnedResultsBounds!.height).toBeGreaterThanOrEqual(96)
    for (const title of pinnedTitles) {
      await results.getByRole('button', { name: `More actions: ${title}`, exact: true }).click()
      await popupMenu.getByRole('menuitem', { name: 'Unpin', exact: true }).click()
      await expect(tab.locator('[data-clue-pins-region]').getByTitle(title, { exact: true })).toHaveCount(0)
    }
    await expect(pinsRegion).toHaveCount(0)

    await clueView(tab, 'packs')
    // Pack management opens a real floating surface.
    await tab.evaluate(node => { (node as HTMLElement).style.width = '' })
    await packFilter.fill('Release context')
    // The shelf row carries the same native menu as the browser/pins rows.
    const shelfPack = packs.getByRole('button', { name: 'Manage pack: Release context and implementation references', exact: true })
    await shelfPack.click({ button: 'right' })
    const shelfMenu = popupMenu
    await expect(shelfMenu).toBeVisible()
    await expect(shelfMenu.getByRole('menuitem', { name: 'Export', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(shelfMenu).toHaveCount(0)
    await shelfPack.focus()
    await page.keyboard.press('Shift+F10')
    await expect(shelfMenu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(shelfMenu).toHaveCount(0)
    await shelfPack.click()
    const packWindow = page.locator('[data-floating-window]')
      .filter({ has: page.locator('[data-clue-pack-window]') })
    await expect(packWindow).toBeVisible()
    await page.mouse.move(0, 0)
    await packWindow.screenshot({ path: testInfo.outputPath('clues-pack-management.png') })
    const packFooter = packWindow.locator('[data-clue-pack-footer]')
    const insertPackAction = packFooter.getByRole('button', { name: 'Insert pack reference', exact: true })
    await expect(insertPackAction).toBeVisible()
    const packFrameBounds = (await packWindow.boundingBox())!
    const insertPackBounds = (await insertPackAction.boundingBox())!
    expect(packFrameBounds.x + packFrameBounds.width - insertPackBounds.x - insertPackBounds.width).toBeCloseTo(17, 0)
    expect(packFrameBounds.y + packFrameBounds.height - insertPackBounds.y - insertPackBounds.height).toBeCloseTo(13, 0)
    expect(await packWindow.locator('[data-window-handle]').getByRole('button', { name: 'Insert pack reference', exact: true }).count()).toBe(0)
    expect(await packWindow.locator('[data-clue-pack-window]').evaluate(node => getComputedStyle(node).paddingLeft)).toBe('16px')


    // Member row menu (mouse + keyboard) uses the same host Menu.
    const memberRow = packWindow.locator('li').first()
    await memberRow.click({ button: 'right' })
    await expect(shelfMenu).toBeVisible()
    await expect(shelfMenu.getByRole('menuitem', { name: 'Preview', exact: true })).toBeVisible()
    await expect(memberRow.getByRole('button').first()).toHaveCSS('font-size', '13px')
    await expect(memberRow).toHaveCSS('border-radius', '6px')
    expect(await shelfMenu.getByRole('menuitem', { name: /^Remove from pack: / }).evaluate(node => getComputedStyle(node).color))
      .toBe(await shelfMenu.getByRole('menuitem', { name: 'Preview', exact: true }).evaluate(node => getComputedStyle(node).color))
    await page.keyboard.press('Escape')
    await expect(shelfMenu).toHaveCount(0)
    await memberRow.getByRole('button').first().focus()
    await page.keyboard.press('Shift+F10')
    await expect(shelfMenu).toBeVisible()
    await page.keyboard.press('Escape')

    // Add page: single Back, no pins, no footer until a selection exists, and
    // the pack identity header is hidden. Candidates use the same menu.
    const packMembersBefore = await api.post(sidebarApi('clues.packs.list'), { data: { workspaceId } })
    const packMembersBeforeJson = await packMembersBefore.json() as { value: { packs: { name: string; members: string[] }[] } }
    const releaseMembersBefore = packMembersBeforeJson.value.packs
      .find(pack => pack.name === 'Release context and implementation references')!.members.length
    await packWindow.getByRole('button', { name: 'Add members', exact: true }).click()
    const addPage = packWindow.locator('[data-clue-add-member]')
    await expect(addPage).toBeVisible()
    await expect(packWindow.getByRole('textbox', { name: 'Pack name', exact: true })).toHaveCount(0)
    await expect(packWindow.getByRole('button', { name: 'Back', exact: true })).toHaveCount(1)
    await expect(addPage.getByRole('button', { name: 'Add members', exact: true })).toHaveCount(0)
    await expect(addPage.locator('[data-clue-pins-region]')).toHaveCount(0)
    await expect(addPage.getByRole('button', { name: 'Add selected', exact: true })).toHaveCount(0)
    await selectClueSource(addPage, 'builtin.files')
    const addSearch = addPage.getByRole('textbox').first()
    await expect(addSearch.locator('..')).toHaveCSS('height', '32px')
    await expect(addSearch).toHaveCSS('font-size', '13px')
    const addRow = addPage.locator('ul li').filter({ has: page.getByRole('checkbox', { name: 'Select reference-08-long-resource-name.md', exact: true }) })
    await expect(addRow).toBeVisible()
    await addRow.click({ button: 'right' })
    await expect(shelfMenu).toBeVisible()
    await expect(shelfMenu.getByRole('menuitem', { name: /^Select / })).toHaveCount(1)
    await page.keyboard.press('Escape')
    await addRow.locator('input[type="checkbox"]').focus()
    await page.keyboard.press('Shift+F10')
    await expect(shelfMenu).toBeVisible()
    await shelfMenu.getByRole('menuitem', { name: /^Select / }).click()
    const addAction = packWindow.locator('[data-clue-pack-add-footer]').getByRole('button', { name: 'Add selected', exact: true })
    await expect(addAction).toBeVisible()
    const originalPackSize = await packWindow.evaluate(node => ({ width: (node as HTMLElement).style.width, height: (node as HTMLElement).style.height }))
    await packWindow.evaluate(node => { (node as HTMLElement).style.width = '320px'; (node as HTMLElement).style.height = '240px' })
    const compactPackBounds = (await packWindow.boundingBox())!
    const compactAddBounds = (await addAction.boundingBox())!
    expect(compactAddBounds.y).toBeGreaterThanOrEqual(compactPackBounds.y)
    expect(compactAddBounds.y + compactAddBounds.height).toBeLessThanOrEqual(compactPackBounds.y + compactPackBounds.height)
    await packWindow.screenshot({ path: testInfo.outputPath('clues-pack-add-320x240.png') })
    await packWindow.evaluate((node, size) => { (node as HTMLElement).style.width = size.width; (node as HTMLElement).style.height = size.height }, originalPackSize)
    await addAction.click()
    await expect(addPage).toHaveCount(0)
    await expect(packWindow.getByRole('textbox', { name: 'Pack name', exact: true })).toBeVisible()
    const packMembersAfter = await api.post(sidebarApi('clues.packs.list'), { data: { workspaceId } })
    const packMembersAfterJson = await packMembersAfter.json() as { value: { packs: { name: string; members: string[] }[] } }
    expect(packMembersAfterJson.value.packs
      .find(pack => pack.name === 'Release context and implementation references')!.members.length)
      .toBe(releaseMembersBefore + 1)

    await packWindow.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(packWindow).toHaveCount(0)
    await packFilter.fill('')

    await clueView(tab, 'browse')
    // Candidate context menu is the real host Menu: Preview opens the SAME
    // detail window; the keyboard path (Shift+F10 on the focused row) opens it
    // too and Escape closes it without navigating.
    await results.evaluate(node => { node.scrollTop = 0 })
    const detailRow = results.locator('li')
      .filter({ has: page.getByRole('button', { name: 'api-contract.md', exact: true }) }).first()
    await detailRow.click({ button: 'right' })
    const rowMenu = popupMenu
    await expect(rowMenu).toBeVisible()
    await expect(rowMenu.getByRole('menuitem', { name: 'Preview', exact: true })).toBeVisible()
    await page.mouse.move(0, 0)
    await rowMenu.screenshot({ path: testInfo.outputPath('clues-context-menu.png') })
    const readsBeforeDetail = clueReadRequests
    const editsBeforeDetail = clueLoadEditRequests
    await rowMenu.getByRole('menuitem', { name: 'Preview', exact: true }).click()
    const detailWindow = page.locator('[data-floating-window]:visible').last()
    await expect(detailWindow).toBeVisible()
    // Opening the detail reads the preview only. `loadEdit` is the explicit
    // Edit action, never an eager side effect of opening the window.
    await expect.poll(() => clueReadRequests).toBe(readsBeforeDetail + 1)
    expect(clueLoadEditRequests).toBe(editsBeforeDetail)

    // Modes: Preview by default, Edit only by explicit tab. Both panes stay
    // mounted, so the draft and the cursor survive the switch; never both visible.
    const documentRoot = detailWindow.locator('[data-window-document]')
    await expect(documentRoot).toHaveAttribute('data-window-presentation', 'modes')
    await expect(documentRoot).toHaveAttribute('data-window-mode', 'preview')
    const previewPane = detailWindow.locator('[data-window-document-preview]')
    const editorPane = detailWindow.locator('[data-window-document-editor]')
    const previewTab = detailWindow.locator('[data-window-mode-tab="preview"]')
    const editTab = detailWindow.locator('[data-window-mode-tab="edit"]')
    await expect(previewPane).toBeVisible()
    await expect(editorPane).toBeHidden()
    await expect(editorPane).toHaveCount(1)
    await expect(previewTab).toHaveAttribute('aria-selected', 'true')
    const previewHeading = previewPane.locator('h1').first()
    await expect(previewHeading).toContainText('Reference')

    // The source summary is one body-independent header inside the document;
    // the read (not loadEdit) owns the initial preview and no Saved label is
    // claimed before any save.
    const detailHeader = detailWindow.locator('[data-window-document-header]')
    await expect(detailHeader).toBeVisible()
    const summary = detailHeader.locator('[data-clue-resource-summary]')
    await expect(summary).toBeVisible()
    await expect(summary.locator('[data-clue-resource-item="path"]')).toContainText('api-contract.md')
    // Path and size share the one-line identity row; there is no disclosure.
    await expect(summary.locator('[data-clue-resource-item="size"]')).toBeVisible()
    await expect(detailWindow.locator('[data-window-saved]')).toHaveCount(0)
    // Resource actions live in the header's own action seat, never in a
    // toolbar band of the window: one less row of chrome above the document.
    await expect(detailWindow.locator('[data-window-toolbar]')).toHaveCount(0)
    const detailToolbar = detailHeader.locator('[data-clue-detail-toolbar]')
    await expect(detailToolbar).toHaveCount(1)
    await expect(detailToolbar).toBeVisible()
    // The cache age rides the Refresh tooltip instead of a standing label.
    await expect(detailToolbar.locator('[data-clue-detail-cached]')).toHaveAttribute('title', /^Local copy /)
    await expect(detailToolbar.locator('[data-clue-detail-refresh]')).toBeVisible()
    // The local fixture has no public URL: a source link would live in the
    // header (never the footer) when the locator carries one.
    await expect(detailToolbar.locator('[data-clue-detail-source]')).toHaveCount(0)
    await expect(detailWindow.locator('[data-clue-detail-footer] [data-clue-detail-source]')).toHaveCount(0)

    // The body is `fill` with zero padding; the document fills it and shows
    // only the active pane (status rows excluded from the height check).
    const windowBody = detailWindow.locator('[data-window-body]')
    await expect(windowBody).toHaveAttribute('data-window-body-layout', 'fill')
    expect(await windowBody.evaluate(node => getComputedStyle(node).padding)).toBe('0px')
    const documentGeometry = await detailWindow.evaluate(node => {
      const body = node.querySelector<HTMLElement>('[data-window-body]')!
      const documentRoot = node.querySelector<HTMLElement>('[data-window-document]')!
      const status = node.querySelector<HTMLElement>('[data-window-loading], [data-window-saved], [data-window-error]')
      const preview = node.querySelector<HTMLElement>('[data-window-document-preview]')!
      return {
        bodyWidth: body.clientWidth,
        bodyHeight: body.clientHeight,
        documentWidth: documentRoot.getBoundingClientRect().width,
        documentHeight: documentRoot.getBoundingClientRect().height,
        previewWidth: preview.getBoundingClientRect().width,
        statusHeight: status?.getBoundingClientRect().height ?? 0,
      }
    })
    expect(Math.abs(documentGeometry.documentWidth - documentGeometry.bodyWidth)).toBeLessThanOrEqual(1)
    expect(Math.abs(documentGeometry.previewWidth - documentGeometry.bodyWidth)).toBeLessThanOrEqual(1)
    expect(documentGeometry.documentHeight).toBeLessThanOrEqual(documentGeometry.bodyHeight + 1)
    expect(documentGeometry.documentHeight)
      .toBeGreaterThanOrEqual(documentGeometry.bodyHeight - documentGeometry.statusHeight - 1)

    const layer1 = await resolveToken('--dsw-alias-bg-layer-1')
    const base = await resolveToken('--dsw-alias-bg-base')
    const floatingSurfaces: Locator[] = [
      detailWindow,
      detailWindow.locator('[data-window-handle]'),
      detailWindow.locator('[data-window-footer]'),
      previewPane,
      // Resource actions moved into this band, so it paints like the frame.
      detailHeader,
    ]
    const toolbar = detailWindow.locator('[data-window-toolbar]')
    if (await toolbar.count() > 0) floatingSurfaces.push(toolbar)
    for (const surface of floatingSurfaces) {
      expect(await effectiveBackground(surface), await surface.getAttribute('class') ?? 'surface').toBe(layer1)
    }
    const modeBar = detailWindow.getByRole('tablist').locator('..')
    expect(await effectiveBackground(modeBar)).toBe(layer1)
    expect(await effectiveBackground(editorPane.locator('textarea'))).toBe(base)

    // The detail footer content spans the host action row (padding/border
    // excluded). A content-width footer would left-align its right actions.
    const detailFooterBox = (await detailWindow.locator('[data-clue-detail-footer]').boundingBox())!
    const detailFrameBox = (await detailWindow.boundingBox())!
    expect(detailFooterBox.width).toBeGreaterThanOrEqual(detailFrameBox.width - 40)
    expect(detailFooterBox.x).toBeGreaterThanOrEqual(detailFrameBox.x + 14)
    expect(detailFooterBox.x + detailFooterBox.width).toBeLessThanOrEqual(detailFrameBox.x + detailFrameBox.width - 14)

    const saveButton = detailWindow.locator('[data-clue-detail-footer]').getByRole('button', { name: 'Save', exact: true })
    await expect(saveButton).toHaveCount(0)
    const loadsBeforeEdit = clueLoadEditRequests
    await editTab.click()
    await expect(documentRoot).toHaveAttribute('data-window-mode', 'edit')
    await expect.poll(() => clueLoadEditRequests).toBe(loadsBeforeEdit + 1)
    await expect(previewPane).toBeHidden()
    await expect(editorPane).toBeVisible()
    await expect(editTab).toHaveAttribute('aria-selected', 'true')
    const editor = editorPane.getByRole('textbox', { name: 'Editor', exact: true })
    await expect(editor).toBeVisible()
    const editorHandle = await editor.elementHandle()
    await editor.fill('# Edited title\n\nLocal fixture content.')
    await editor.evaluate(node => (node as HTMLTextAreaElement).setSelectionRange(4, 7))
    await expect(saveButton).toBeEnabled()
    // One stable footer Save for the editable format; the embedded renderer
    // never grows a second save control and nothing is labelled Saved yet.
    await expect(saveButton).toHaveAttribute('data-clue-detail-save', '')
    await expect(documentRoot.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
    await expect(detailWindow.locator('[data-window-saved]')).toHaveCount(0)

    // Back to Preview: the unsaved title is rendered while the edit pane stays
    // mounted with the same textarea, value and cursor selection.
    await previewTab.click()
    await expect(documentRoot).toHaveAttribute('data-window-mode', 'preview')
    await expect(editorPane).toBeHidden()
    await expect(previewHeading).toContainText('Edited title')
    await page.mouse.move(0, 0)
    await detailWindow.screenshot({ path: testInfo.outputPath('clues-detail-window.png') })
    const retainedDraft = await editorHandle!.evaluate(node => {
      const textarea = node as HTMLTextAreaElement
      return { value: textarea.value, start: textarea.selectionStart, end: textarea.selectionEnd }
    })
    expect(retainedDraft.value).toBe('# Edited title\n\nLocal fixture content.')
    expect([retainedDraft.start, retainedDraft.end]).toEqual([4, 7])

    // Narrow the real window (host resize gesture) to 320px: one pane at a
    // time, no horizontal overflow anywhere in the document.
    const resizeWindowX = async (target: Locator, width: number): Promise<void> => {
      const frame = (await target.boundingBox())!
      const handle = target.locator('[data-window-resize="x"]')
      const handleBounds = (await handle.boundingBox())!
      const x = handleBounds.x + handleBounds.width / 2
      const y = handleBounds.y + handleBounds.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + width - frame.width, y, { steps: 8 })
      await page.mouse.up()
      await expect.poll(async () => Math.round((await target.boundingBox())!.width)).toBeLessThanOrEqual(width + 2)
    }
    await resizeWindowX(detailWindow, 320)
    await expect(previewPane).toBeVisible()
    await expect(editorPane).toBeHidden()
    expect(await detailWindow.evaluate(node => {
      const body = node.querySelector<HTMLElement>('[data-window-body]')!
      const documentRoot = node.querySelector<HTMLElement>('[data-window-document]')!
      const preview = node.querySelector<HTMLElement>('[data-window-document-preview]')!
      return body.scrollWidth <= body.clientWidth + 1
        && documentRoot.scrollWidth <= documentRoot.clientWidth + 1
        && preview.scrollWidth <= preview.clientWidth + 1
    })).toBe(true)
    expect(await detailWindow.getByRole('tablist').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page.mouse.move(0, 0)
    await detailWindow.screenshot({ path: testInfo.outputPath('clues-detail-narrow-320.png') })

    // Close is not discard: the current mode and the draft stay; only the
    // explicit Discard action leaves. Save is never pressed (no fixture write).
    await editTab.click()
    await expect(documentRoot).toHaveAttribute('data-window-mode', 'edit')
    await detailWindow.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(detailWindow).toBeVisible()
    await expect(documentRoot).toHaveAttribute('data-window-mode', 'edit')
    await expect(editor).toHaveValue('# Edited title\n\nLocal fixture content.')
    await expect(detailWindow).toContainText('Unsaved edits')
    await detailWindow.getByRole('button', { name: 'Discard edits', exact: true }).click()
    await expect(page.locator('[data-floating-window]:visible')).toHaveCount(0)

    // The keyboard path uses the same menu anchored at the focused row.
    await detailRow.getByRole('button', { name: 'api-contract.md', exact: true }).focus()
    await page.keyboard.press('Shift+F10')
    await expect(rowMenu).toBeVisible()
    await expect(rowMenu.getByRole('menuitem', { name: 'Preview', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(rowMenu).toHaveCount(0)

    // Server-maximum destination name created through the public pack API.
    const longName = '长'.repeat(200)
    const longPack = await api.post(sidebarApi('clues.packs.create'), { data: { workspaceId, name: longName, members: [] } })
    expect(longPack.ok()).toBe(true)
    expect((await longPack.json() as { ok: boolean }).ok).toBe(true)
    await clueView(tab, 'packs')
    // Direct API seeding is outside the client mutation cache; refresh it explicitly.
    await packs.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(packs.getByRole('button', { name: `Manage pack: ${longName}`, exact: true })).toBeVisible()
    await clueView(tab, 'browse')
    const composerBeforeCollection = (await composer.textContent())?.trim() ?? ''

    // One collection task: choose a destination without writing, then confirm
    // once in the fixed footer. Cancelling preserves the resource selection.
    const tray = browser.getByRole('region', { name: '2 selected', exact: true })
    await selectionMode(browser)
    await browser.getByRole('checkbox', { name: 'Select api-contract.md', exact: true }).check()
    await browser.getByRole('checkbox', { name: 'Select architecture-decisions.md', exact: true }).check()
    await expect(tray).toBeVisible()
    const insertPrimary = tray.getByRole('button', { name: 'Insert resources', exact: true })
    expect(await insertPrimary.evaluate(node => getComputedStyle(node).backgroundColor))
      .toBe(await resolveToken('--dsw-alias-button-primary-fill'))
    for (const dark of [false, true]) {
      await page.evaluate(value => { document.body.toggleAttribute('data-ds-dark-theme', value); document.documentElement.style.colorScheme = value ? 'dark' : 'light' }, dark)
      const primaryFill = await resolveToken('--dsw-alias-button-primary-fill')
      const primaryHover = await resolveToken('--dsw-alias-button-primary-hover')
      const primaryText = await resolveToken('--dsw-alias-label-primary-foreground')
      for (const hovered of [false, true]) {
        if (hovered) await insertPrimary.hover()
        else await page.mouse.move(0, 0)
        const paint = await insertPrimary.evaluate(node => {
          const style = getComputedStyle(node)
          const context = document.createElement('canvas').getContext('2d')!
          const luminance = (value: string): number => {
            context.fillStyle = value; context.fillRect(0, 0, 1, 1)
            const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
            const linear = channels.map(channel => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
            return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
          }
          const bg = luminance(style.backgroundColor); const fg = luminance(style.color)
          return { fill: style.backgroundColor, foreground: style.color, contrast: (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) }
        })
        expect(paint.foreground).toBe(primaryText)
        expect(paint.fill).toBe(hovered ? primaryHover : primaryFill)
        expect(paint.contrast).toBeGreaterThanOrEqual(4.5)
        colorMetrics.push({ theme: dark ? 'dark' : 'light', hovered, ...paint })
      }
    }
    await page.mouse.move(0, 0)
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme'); document.documentElement.style.colorScheme = 'light' })
    writeFileSync(testInfo.outputPath('clues-color-metrics.json'), `${JSON.stringify(colorMetrics, null, 2)}\n`)
    await expect(tray.locator('[data-clue-selection-review]')).toHaveCount(1)
    await expect(tray.locator('[data-clue-selection-review] ul')).toHaveCount(1)
    await expect(tray.getByRole('button', { name: /^Remove / })).toHaveCount(0)
    // The selected tray goes through the SAME candidate menu path: Add to pack
    // opens the real collection window and never inserts a chat message/draft.
    await detailRow.click({ button: 'right' })
    await expect(rowMenu).toBeVisible()
    await rowMenu.getByRole('menuitem', { name: 'Add to pack', exact: true }).click()
    expect((await composer.textContent())?.trim() ?? '').toBe(composerBeforeCollection)
    const collectionWindow = page.locator('[data-floating-window]')
      .filter({ has: page.locator('[data-clue-collection]') })
    await expect(collectionWindow).toBeVisible()
    await page.mouse.move(0, 0)
    await collectionWindow.screenshot({ path: testInfo.outputPath('clues-collection-window.png') })
    const collectionForm = collectionWindow.locator('form[data-clue-collection]')
    const destinationSearch = collectionWindow.getByRole('searchbox', { name: 'Search clue packs', exact: true })
    const destinationSearchLayout = await destinationSearch.evaluate(node => {
      const input = node as HTMLElement
      const wrapper = input.parentElement!
      return { inputHeight: input.getBoundingClientRect().height, wrapperHeight: wrapper.getBoundingClientRect().height,
        inputBorder: getComputedStyle(input).borderWidth, inputFontSize: getComputedStyle(input).fontSize,
        inputLineHeight: getComputedStyle(input).lineHeight, wrapperBorder: getComputedStyle(wrapper).borderWidth }
    })
    writeFileSync(testInfo.outputPath('clues-destination-search-metrics.json'), JSON.stringify(destinationSearchLayout, null, 2))
    // TextInput owns the control frame; its unframed label only lays out the icon.
    await expect(destinationSearch).toHaveCSS('height', '32px')
    await expect(destinationSearch).toHaveCSS('border-width', '1px')
    await expect(destinationSearch.locator('..')).toHaveCSS('border-width', '0px')
    await expect(destinationSearch).toHaveCSS('font-size', '13px')
    await expect(destinationSearch).toHaveCSS('line-height', '20px')
    // The list is read on open, not on focus: the pack target exists without
    // any focus round trip.
    await expect(collectionWindow.getByTitle('Release context and implementation references', { exact: true })).toBeVisible()
    await expect(collectionWindow.getByRole('combobox')).toHaveCount(0)
    expect(await collectionWindow.getByRole('radio').count()).toBeGreaterThan(1)
    await expect(collectionWindow.getByRole('button', { name: 'Add to pack', exact: true })).toBeDisabled()
    await expect(collectionWindow.locator('[data-workbench-section]')).toHaveCount(0)
    await expect(collectionWindow.getByRole('button', { name: /^Remove / })).toHaveCount(0)
    await expect(collectionForm.getByRole('button', { name: /^Remove / })).toHaveCount(0)
    await expect(collectionWindow.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0)

    // Longest server-legal pack name: the target button must clamp its text to
    // two lines without horizontal overflow and stay fully inside a 320px frame.
    // Selecting the radio alone must not submit the current selection.
    await destinationSearch.fill('长')
    const longTarget = collectionWindow.getByTitle(longName, { exact: true })
    await expect(longTarget).toBeVisible()
    await resizeWindowX(collectionWindow, 320)
    await longTarget.scrollIntoViewIfNeeded()
    const longNameSpan = longTarget.locator('span:not([data-clue-artwork])').first()
    const longNameStyle = await longNameSpan.evaluate(node => {
      const style = getComputedStyle(node)
      const parsedLineHeight = Number.parseFloat(style.lineHeight)
      return {
        clamp: style.webkitLineClamp,
        lineHeight: Number.isFinite(parsedLineHeight)
          ? parsedLineHeight
          : Number.parseFloat(style.fontSize) * 1.4,
        height: node.getBoundingClientRect().height,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      }
    })
    expect(longNameStyle.clamp).toBe('2')
    expect(longNameStyle.height).toBeLessThanOrEqual(longNameStyle.lineHeight * 2 + 1)
    expect(longNameStyle.scrollWidth).toBeLessThanOrEqual(longNameStyle.clientWidth + 1)
    const longTargetBounds = (await longTarget.boundingBox())!
    const longFrameBounds = (await collectionWindow.boundingBox())!
    expect(longTargetBounds.x).toBeGreaterThanOrEqual(longFrameBounds.x)
    expect(longTargetBounds.x + longTargetBounds.width).toBeLessThanOrEqual(longFrameBounds.x + longFrameBounds.width + 1)
    expect(longTargetBounds.y).toBeGreaterThanOrEqual(longFrameBounds.y)
    expect(longTargetBounds.y + longTargetBounds.height).toBeLessThanOrEqual(longFrameBounds.y + longFrameBounds.height + 1)
    expect(await longTarget.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page.mouse.move(0, 0)
    await collectionWindow.screenshot({ path: testInfo.outputPath('clues-collection-long-name-320.png') })

    // Closing is not cancellation: the tray selection survives, and the New
    // name draft survives a close/reopen round trip.
    await collectionWindow.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(collectionWindow).toHaveCount(0)
    await expect(tray).toBeVisible()
    await expect(browser.getByRole('checkbox', { name: 'Select api-contract.md', exact: true })).toBeChecked()
    await expect(browser.getByRole('checkbox', { name: 'Select architecture-decisions.md', exact: true })).toBeChecked()
    await tray.getByRole('button', { name: 'Add to pack', exact: true }).click()
    const reopenedCollection = page.locator('[data-floating-window]')
      .filter({ has: page.locator('[data-clue-collection]') })
    await expect(reopenedCollection).toBeVisible()
    await reopenedCollection.getByRole('radio', { name: 'New', exact: true }).check()
    const reopenedName = reopenedCollection.getByRole('textbox', { name: 'Pack name', exact: true })
    await expect(reopenedName).toBeVisible()
    await reopenedName.fill('Review context')
    await reopenedCollection.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(reopenedCollection).toHaveCount(0)
    await tray.getByRole('button', { name: 'Add to pack', exact: true }).click()
    const draftedCollection = page.locator('[data-floating-window]')
      .filter({ has: page.locator('[data-clue-collection]') })
    await expect(draftedCollection.getByRole('textbox', { name: 'Pack name', exact: true })).toHaveValue('Review context')
    await expect(draftedCollection.getByRole('button', { name: 'Create', exact: true })).toBeVisible()

    const packsBeforeAdd = await api.post(sidebarApi('clues.packs.list'), { data: { workspaceId } })
    const packsBeforeJson = await packsBeforeAdd.json() as { value: { packs: { name: string; members: string[] }[] } }
    const releaseBefore = packsBeforeJson.value.packs.find(pack => pack.name === 'Release context and implementation references')!
    const selectedIds = ['api-contract.md', 'architecture-decisions.md'].map(title => memberIdByTitle.get(title)!)
    expect(selectedIds.every(id => id !== undefined && !releaseBefore.members.includes(id))).toBe(true)

    // The 409 route is armed before the explicit footer submit. Selecting a
    // target makes no write; retry resubmits only the unfinished resources.
    await draftedCollection.getByRole('searchbox', { name: 'Search clue packs', exact: true }).fill('Release context')
    const releaseTarget = draftedCollection.getByTitle('Release context and implementation references', { exact: true })
    await expect(releaseTarget).toBeVisible()
    const addMemberRoute = '**/sidebar/api/clues.packs.addMember'
    await page.route(addMemberRoute, route => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { code: 'conflict', message: 'forced add failure' } }),
    }))
    const failedAdd = page.waitForResponse(response => response.url().endsWith('/clues.packs.addMember') && response.status() === 409)
    await releaseTarget.getByRole('radio').check()
    await draftedCollection.getByRole('button', { name: 'Add to pack', exact: true }).click()
    await failedAdd
    await expect(releaseTarget).toBeEnabled()
    await expect(draftedCollection).toBeVisible()
    await expect(tray).toBeVisible()
    await expect(draftedCollection.getByRole('textbox', { name: 'Pack name', exact: true })).toHaveCount(0)
    await draftedCollection.getByRole('radio', { name: 'New', exact: true }).check()
    await expect(draftedCollection.getByRole('textbox', { name: 'Pack name', exact: true })).toHaveValue('Review context')
    await releaseTarget.getByRole('radio').check()
    await expect(page.locator('[data-dsh-better-sidebar-clue-notice]')).toContainText('Saving the pack failed.')
    await page.unroute(addMemberRoute)
    await draftedCollection.getByRole('button', { name: 'Add to pack', exact: true }).click()
    await expect(draftedCollection).toHaveCount(0)
    await expect(tray).toHaveCount(0)
    expect((await composer.textContent())?.trim() ?? '').toBe(composerBeforeCollection)
    const packsAfterAdd = await api.post(sidebarApi('clues.packs.list'), { data: { workspaceId } })
    const packsAfterJson = await packsAfterAdd.json() as { value: { packs: { name: string; members: string[] }[] } }
    const releaseAfter = packsAfterJson.value.packs.find(pack => pack.name === 'Release context and implementation references')!
    expect(releaseAfter.members.length).toBe(releaseBefore.members.length + 2)
    expect(releaseAfter.members).toEqual(expect.arrayContaining(selectedIds))

    // A separate create-pack window writes nothing before its explicit submit.
    const listBeforeCreate = await api.post(sidebarApi('clues.packs.list'), { data: { workspaceId } })
    expect(JSON.stringify(await listBeforeCreate.json())).not.toContain('Window-created pack')
    await clueView(tab, 'packs')
    await packs.getByRole('button', { name: 'New', exact: true }).click()
    const createWindow = page.locator('[data-floating-window]')
      .filter({ has: page.getByRole('textbox', { name: 'Pack name', exact: true }) })
    await expect(createWindow).toBeVisible()
    await createWindow.getByRole('textbox', { name: 'Pack name', exact: true }).fill('Window-created pack')
    await page.mouse.move(0, 0)
    await createWindow.screenshot({ path: testInfo.outputPath('clues-pack-create-window.png') })
    const listDuringCreate = await api.post(sidebarApi('clues.packs.list'), { data: { workspaceId } })
    expect(JSON.stringify(await listDuringCreate.json())).not.toContain('Window-created pack')
    await createWindow.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(createWindow).toHaveCount(0)
    await expect(packs.getByRole('button', { name: 'Manage pack: Window-created pack', exact: true })).toBeVisible()
    const listAfterCreate = await api.post(sidebarApi('clues.packs.list'), { data: { workspaceId } })
    const createdPacks = await listAfterCreate.json() as { value: { packs: { name: string; members: string[] }[] } }
    expect(createdPacks.value.packs.find(pack => pack.name === 'Window-created pack')?.members).toEqual([])

    // The gear opens the full shared settings component on Clue sources.
    await tab.getByRole('button', { name: 'Open clue source settings', exact: true }).click()
    const settingsWindow = page.locator('[data-floating-window]:visible')
      .filter({ has: page.locator('[data-sidebar-settings]') })
    await expect(settingsWindow).toBeVisible()
    await expect(settingsWindow).toContainText('Sidebar settings')
    const gearGroups = settingsWindow.getByRole('tablist', { name: 'Settings groups', exact: true })
    await expect(gearGroups.getByRole('tab')).toHaveCount(6)
    for (const group of ['General', 'Tabs', 'Start page', 'File viewers', 'Clue sources', 'Appearance']) {
      await expect(gearGroups.getByRole('tab', { name: group, exact: true })).toBeVisible()
    }
    await expect(gearGroups.getByRole('tab', { name: 'Clue sources', exact: true })).toHaveAttribute('aria-selected', 'true')
    const advancedSources = settingsWindow.locator('[data-clue-advanced]')
    await expect(advancedSources).toHaveCount(1)
    expect(await advancedSources.evaluate(node => (node as HTMLDetailsElement).open)).toBe(false)
    await expect(settingsWindow.locator('[data-clue-mention]').first()).toBeHidden()
    await expect(settingsWindow.locator('[data-clue-source]')).toHaveCount(5)
    expect(await settingsWindow.locator('[data-clue-source]').first().innerText()).not.toContain('builtin.')
    await expect(settingsWindow.getByRole('button', { name: 'Configure source: GitHub Issues', exact: true })).toBeVisible()
    await expect(settingsWindow.getByRole('button', { name: 'Configure source: Feishu docs', exact: true })).toBeVisible()
    await page.mouse.move(0, 0)
    await settingsWindow.screenshot({ path: testInfo.outputPath('clues-settings-window.png') })
    await expect(settingsWindow.locator('[data-clue-source-status="unchecked"]')).toHaveCount(0)
    const statusRequestsBeforeReopen = clueStatusRequests
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await settingsWindow.getByRole('button', { name: 'Close', exact: true }).click()
      await tab.getByRole('button', { name: 'Open clue source settings', exact: true }).click()
      await expect(settingsWindow.locator('[data-clue-source]')).toHaveCount(5)
      await expect(settingsWindow.locator('[data-clue-source-status="unchecked"]')).toHaveCount(0)
    }
    expect(clueStatusRequests).toBe(statusRequestsBeforeReopen)
    requestMetrics.settingsReopenStatusRequests = clueStatusRequests - statusRequestsBeforeReopen
    writeFileSync(testInfo.outputPath('clues-request-metrics.json'), `${JSON.stringify(requestMetrics, null, 2)}\n`)


    // Feishu returns its declared permission choices from a plain status read,
    // before (and without) authorization. Opening the config shows all eleven
    // translated checkboxes; Connect is NEVER clicked here.
    const connectionStatus = await api.post(sidebarApi('clues.connections.status'), { data: {} })
    const connectionStatusJson = await connectionStatus.json() as {
      value: { connections: { connectionId: string; availableCapabilities?: string[]; selectableCapabilities?: string[] }[] }
    }
    const feishuConnection = connectionStatusJson.value.connections
      .find(connection => connection.connectionId === 'feishu.lark.auth')
    const declaredCapabilities = [
      'docs.read', 'docs.search', 'docs.edit', 'wiki.read', 'tasks.read', 'tasks.edit',
      'docs.comments.read', 'docs.comments.write', 'tasks.comments.read', 'tasks.comments.write', 'people.read',
    ]
    expect(feishuConnection?.availableCapabilities).toEqual(expect.arrayContaining(declaredCapabilities))
    expect(feishuConnection?.selectableCapabilities).toEqual(expect.arrayContaining(declaredCapabilities))
    expect(feishuConnection?.selectableCapabilities).toHaveLength(11)
    await settingsWindow.getByRole('button', { name: 'Configure source: Feishu docs', exact: true }).click()
    const configWindow = page.locator('[data-floating-window]:visible')
      .filter({ has: page.locator('[data-clue-config]') })
    await expect(configWindow).toBeVisible()
    // Permissions are progressive details; expand only when auditing the
    // requested capabilities instead of placing eleven rows on first view.
    await configWindow.locator('[data-clue-permissions] > summary').click()
    for (const label of [
      'View drive files and documents',
      'Search documents',
      'Edit documents',
      'View wikis',
      'View tasks',
      'Edit tasks',
      'Read document comments',
      'Post document comments',
      'Read task comments',
      'Post task comments and replies',
      "Resolve people's display names",
    ]) {
      await expect(configWindow.getByText(label, { exact: true })).toBeVisible()
    }
    await expect(configWindow.getByRole('checkbox')).toHaveCount(11)
    await page.mouse.move(0, 0)
    await configWindow.locator('fieldset').screenshot({ path: testInfo.outputPath('clues-feishu-permissions.png') })
    await configWindow.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(configWindow).toHaveCount(0)
    await settingsWindow.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(settingsWindow).toHaveCount(0)

    // Control only the sanitized inspection DTO: developer machines can already
    // have gh installed/authorized. The host, source UI and action wiring stay real.
    // Nothing is installed/authorized here and no install button is clicked.
    const catalogueResponse = await api.post(sidebarApi('clues.sources'), { data: {} })
    const catalogueBody = await catalogueResponse.json() as { value: { sources: { sourceId: string; dependencyIds?: string[] }[] } }
    const githubDependency = catalogueBody.value.sources.find(source => source.sourceId === 'builtin.github.issues')?.dependencyIds?.[0]
    expect(githubDependency).toBeTruthy()
    const inspectPattern = '**/sidebar/api/clues.dependencies.inspect'
    await page.route(inspectPattern, async route => {
      if (route.request().postDataJSON()?.dependencyId !== githubDependency) { await route.continue(); return }
      await route.fulfill({ status: 200, json: { ok: true, value: { dependencies: [{
        dependencyId: githubDependency, name: 'GitHub CLI', command: 'gh', state: 'missing',
        platform: 'darwin', arch: 'arm64', supported: true, installable: true,
        minimumVersion: '2.81.0', recommendedVersion: '2.102.0',
      }] } } })
    })
    // The dependency was already inspected above. Changing a route fixture is
    // not a runtime mutation: use the same explicit Recheck as a real user so
    // the activation cache and observation bus see this new inspection result.
    await tab.getByRole('button', { name: 'Open clue source settings', exact: true }).click()
    await settingsWindow.getByRole('button', { name: 'Configure source: GitHub Issues', exact: true }).click()
    const githubConfig = page.locator('[data-floating-window]:visible').filter({ has: page.locator('[data-clue-config]') })
    await githubConfig.getByRole('button', { name: 'Recheck', exact: true }).click()
    await expect(githubConfig.locator('[data-clue-dependency] [data-kind="missing"]')).toBeVisible()
    await githubConfig.getByRole('button', { name: 'Close', exact: true }).click()
    await settingsWindow.getByRole('button', { name: 'Close', exact: true }).click()
    await clueView(tab, 'browse')
    await selectClueSource(browser, 'builtin.github.issues')
    const readiness = browser.locator('[data-clue-readiness]')
    await expect(readiness).toHaveAttribute('data-clue-readiness', 'missing')
    const readinessEntry = readiness.getByRole('button', { name: 'One-click install', exact: true })
    await expect(readinessEntry).toBeVisible()
    await expect(readinessEntry).toBeEnabled()
    await readiness.screenshot({ path: testInfo.outputPath('clues-source-install-entry.png') })
    await page.unroute(inspectPattern)
    await selectClueSource(browser, 'builtin.files')
    await expect(browser.locator('[data-clue-browser-state="page"]')).toBeVisible()

    // Restore native geometry for the complete DSH integration screenshot.
    await tab.evaluate(node => { (node as HTMLElement).style.width = '' })
    await resizePanel(initialPanelWidth)
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme'); document.documentElement.style.colorScheme = 'light' })
    await page.mouse.move(0, 0)
    await tab.screenshot({ path: testInfo.outputPath('clues-workbench-overview.png') })
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', ''); document.documentElement.style.colorScheme = 'dark' })
    await page.screenshot({ path: testInfo.outputPath('clues-integrated-shell-dark.png') })
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme'); document.documentElement.style.colorScheme = 'light' })

    await clueView(tab, 'packs')
    await tab.getByRole('button', { name: 'Import', exact: true }).click()
    const share = page.locator('[data-clue-share-window]')
    await expect(share).toBeVisible()
    await share.getByRole('tab', { name: 'Export', exact: true }).click()
    const panel = share.getByRole('tabpanel')
    const initialShareAction = share.getByRole('button', { name: 'Preview selection', exact: true })
    await expect(initialShareAction).toBeVisible()
    expect(await initialShareAction.evaluate(node => node.closest('[role="tabpanel"]') === null)).toBe(true)
    // The export list loads asynchronously; checking before it paints left the
    // preview disabled and the click timing out under load.
    const shareChecks = share.locator('input[type="checkbox"]')
    await expect(shareChecks.first()).toBeVisible({ timeout: 15000 })
    for (const checkbox of await shareChecks.all()) await checkbox.check()
    await expect(initialShareAction).toBeEnabled()
    await initialShareAction.click()
    await expect(share.getByRole('region', { name: 'Preview selection', exact: true })).toBeVisible()
    await expect.poll(() => panel.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
    const action = share.getByRole('button', { name: 'Export .cluepack', exact: true })
    await expect(action).toBeVisible()
    const before = await action.boundingBox()
    await panel.evaluate(node => { node.scrollTop = node.scrollHeight })
    expect(await panel.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    const after = await action.boundingBox()
    expect(after?.y).toBe(before?.y)
    await share.screenshot({ path: testInfo.outputPath('clues-share-fixed-actions.png') })
    await page.locator('[data-floating-window]').filter({ has: share }).getByRole('button', { name: 'Close', exact: true }).click()

    // The plugin's same full settings component is also available in Settings.
    await page.getByRole('button', { name: 'Account menu', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Side card', exact: true }).click()
    const fullSettings = page.locator('[data-sidebar-settings]').last()
    await expect(fullSettings).toBeVisible()
    const groups = fullSettings.getByRole('tablist', { name: 'Settings groups', exact: true })
    const generalHeading = fullSettings.getByRole('heading', { name: 'General', exact: true })
    await expect(generalHeading).toBeVisible()
    expect((await generalHeading.locator('..').boundingBox())!.width).toBeLessThanOrEqual(800)
    const settingsColumns = await fullSettings.evaluate(node => ({ width: node.getBoundingClientRect().width, overflow: node.scrollWidth - node.clientWidth }))
    expect(settingsColumns.overflow).toBeLessThanOrEqual(1)
    await fullSettings.screenshot({ path: testInfo.outputPath('settings-unified-general.png') })
    // The host's default Settings dialog gives plugins a 564px content column,
    // so the tab row uses its bounded horizontal scroller.
    const hostSettings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await hostSettings.evaluate(node => { (node as HTMLElement).style.width = '1280px'; (node as HTMLElement).style.maxWidth = 'calc(100vw - 48px)' })
    await expect(groups).toBeVisible()
    await fullSettings.screenshot({ path: testInfo.outputPath('settings-unified-wide.png') })
    await groups.getByRole('tab', { name: 'Tabs', exact: true }).click()
    const featureRows = fullSettings.locator('[data-settings-row]')
    expect(await featureRows.count()).toBeGreaterThan(3)
    for (const row of await featureRows.all()) {
      expect(await row.evaluate(node => getComputedStyle(node).borderRadius)).toBe('0px')
      await expect(row.locator('[data-settings-toggle]')).toHaveCount(1)
    }
    const switches = fullSettings.locator('[data-settings-toggle="on"]')
    await expect(switches.first()).toBeVisible()
    for (const dark of [false, true]) {
      await page.evaluate(value => { document.body.toggleAttribute('data-ds-dark-theme', value); document.documentElement.style.colorScheme = value ? 'dark' : 'light' }, dark)
      const expectedThumb = await resolveWithin(fullSettings, '--dsw-alias-label-primary-foreground')
      const expectedTrack = await resolveWithin(fullSettings, '--dsw-alias-label-primary')
      for (const candidate of await switches.all()) {
        await expect(candidate).toHaveAttribute('role', 'switch')
        await expect(candidate).toHaveAttribute('aria-checked', 'true')
        await expect(candidate.locator(':scope > span > span')).toHaveCSS('background-color', expectedThumb)
        const paint = await candidate.evaluate(node => {
          const track = node.querySelector('span')!
          return { track: getComputedStyle(track).backgroundColor, thumb: getComputedStyle(track.querySelector('span')!).backgroundColor }
        })
        expect(paint.track).toBe(expectedTrack)
        expect(paint.thumb).toBe(expectedThumb)
        colorMetrics.push({ control: 'inventory-switch', theme: dark ? 'dark' : 'light', ...paint })
      }
      await fullSettings.screenshot({ path: testInfo.outputPath(`settings-neutral-features-${dark ? 'dark' : 'light'}.png`) })
    }
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme'); document.documentElement.style.colorScheme = 'light' })
    await fullSettings.screenshot({ path: testInfo.outputPath('settings-unified-features.png') })
    await fullSettings.evaluate(node => { (node as HTMLElement).style.width = '390px' })
    // At 390px the rail collapses to one group select over the same rows.
    const narrowGroupSelect = fullSettings.getByRole('button', { name: 'Settings groups', exact: true })
    await expect(narrowGroupSelect).toBeVisible()
    await expect(groups.getByRole('tab')).toHaveCount(0)
    expect(await fullSettings.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await fullSettings.screenshot({ path: testInfo.outputPath('settings-unified-narrow.png') })
    await fullSettings.evaluate(node => { (node as HTMLElement).style.width = '' })
    await expect(groups).toBeVisible()
    await groups.getByRole('tab', { name: 'Clue sources', exact: true }).click()
    await expect(fullSettings.locator('[data-clue-source]')).toHaveCount(5)
    const nativeSwitch = fullSettings.locator('[data-clue-source="builtin.files"] button[role="switch"][aria-checked="true"]')
    for (const dark of [false, true]) {
      await page.evaluate(value => { document.body.toggleAttribute('data-ds-dark-theme', value); document.documentElement.style.colorScheme = value ? 'dark' : 'light' }, dark)
      const expectedThumb = await resolveWithin(fullSettings, '--dsw-alias-label-primary-foreground')
      const expectedTrack = await resolveWithin(fullSettings, '--dsw-alias-label-primary')
      await expect(nativeSwitch).toHaveAttribute('aria-checked', 'true')
      const paint = await nativeSwitch.evaluate(node => {
        const track = node.querySelector('span')!
        return { track: getComputedStyle(track).backgroundColor, thumb: getComputedStyle(track.querySelector('span')!).backgroundColor }
      })
      expect(paint.track).toBe(expectedTrack)
      expect(paint.thumb).toBe(expectedThumb)
      colorMetrics.push({ control: 'native-switch', theme: dark ? 'dark' : 'light', ...paint })
      await fullSettings.screenshot({ path: testInfo.outputPath(`settings-neutral-sources-${dark ? 'dark' : 'light'}.png`) })
    }
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme'); document.documentElement.style.colorScheme = 'light' })
    writeFileSync(testInfo.outputPath('clues-color-metrics.json'), `${JSON.stringify(colorMetrics, null, 2)}\n`)
    await fullSettings.screenshot({ path: testInfo.outputPath('settings-unified-sources.png') })
    expect(errors).toEqual([])
  } finally {
    await api.dispose()
  }
})


test('clues share actions remain reachable in a minimum touch window', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  const api = await createHostApi()
  try {
    const path = join(process.env.DSH_E2E_WORKSPACE ?? tmpdir(), `clues-touch-${Date.now()}`)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'touch-reference.md'), '# Touch reference\n\nLocal fixture content.\n')
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path })
    await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
    await gotoPage(page)
    await markHelpSeen(page)
    await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
    await dismissOnboarding(page)
    await sendFirstMessage(page)
    await page.locator('[data-sidebar-right-expand]:visible').first().click()
    await page.locator('[data-sidebar-right-guide-entry="clues"]').click()
    const tab = page.locator('[data-clue-tab]:visible')
    await expect(tab.getByRole('dialog')).toHaveCount(0)
    // A fresh workspace has no packs: the compact empty shelf must not eat the tab.
    const packs = tab.locator('[data-clue-pack-region]')
    await clueView(tab, 'packs')
    await expect(packs.getByText('Collect related files, documents and issues into a pack to reference together.', { exact: true })).toBeVisible()
    const emptyPacksBounds = await packs.boundingBox()
    await page.mouse.move(0, 0)
    await tab.screenshot({ path: testInfo.outputPath('clues-empty-packs-touch.png') })
    expect(emptyPacksBounds!.height).toBeGreaterThan(120)
    await clueView(tab, 'browse')
    // Touch targets inside the selection tray stay at least 44px.
    const clueBrowser = tab.locator('[data-clue-browse-region]')
    // The source choice persists across visits; this surface needs the file list.
    await selectClueSource(clueBrowser, 'builtin.files')
    await expect(clueBrowser.getByRole('search')).toHaveCSS('height', '44px')
    // The shared SearchField owns the 44px touch frame.
    await expect(clueBrowser.getByRole('search')).toHaveCSS('border-top-width', '1px')
    await selectionMode(clueBrowser)
    const touchRow = clueBrowser.getByRole('checkbox', { name: 'Select touch-reference.md', exact: true })
    await expect(touchRow).toBeVisible()
    const selectionHitArea = touchRow.locator('..')
    const selectionBounds = (await selectionHitArea.boundingBox())!
    expect(selectionBounds.width).toBeGreaterThanOrEqual(44)
    expect(selectionBounds.height).toBeGreaterThanOrEqual(44)
    await page.touchscreen.tap(selectionBounds.x + 2, selectionBounds.y + selectionBounds.height / 2)
    await expect(touchRow).toBeChecked()
    const tray = clueBrowser.getByRole('region', { name: '1 selected', exact: true })
    await expect(tray).toBeVisible()
    // The compact bar keeps an optional collapsed review disclosure so
    // cross-source selections remain auditable before opening the window.
    await expect(tray.locator('[data-clue-selection-review]')).toHaveCount(1)
    await expect(tray.locator('[data-clue-selection-review] ul')).toHaveCount(1)
    // The disclosure is collapsed by default; its remove controls become
    // available when the user opens it.
    await expect(tray.getByRole('button', { name: /^Remove / })).toHaveCount(0)
    for (const name of ['Insert resources', 'Add to pack']) {
      const action = tray.getByRole('button', { name, exact: true })
      await expect(action).toBeVisible()
      expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    await page.mouse.move(0, 0)
    await tab.screenshot({ path: testInfo.outputPath('clues-selection-actions-touch.png') })
    await tray.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(tray).toHaveCount(0)
    await expect(clueBrowser.locator('[data-clue-selection-mode]')).toHaveAttribute('aria-pressed', 'false')
    await expect(touchRow).toHaveCount(0)
    // Re-entering the explicit mode must not revive the cancelled selection.
    await selectionMode(clueBrowser)
    await expect(touchRow).not.toBeChecked()
    await expect(tray).toHaveCount(0)
    await clueBrowser.locator('[data-clue-selection-mode]').click()
    await expect(touchRow).toHaveCount(0)
    const createdPack = await api.post(sidebarApi('clues.packs.create'), { data: { workspaceId: workspace.value.workspace.workspaceId, name: 'Touch pack' } })
    expect(createdPack.ok()).toBe(true)
    await clueView(tab, 'packs')
    await packs.getByRole('button', { name: 'Refresh', exact: true }).click()
    await packs.getByRole('button', { name: 'Manage pack: Touch pack', exact: true }).click()
    const touchPackWindow = page.locator('[data-floating-window]').filter({ has: page.locator('[data-clue-pack-window]') })
    await touchPackWindow.evaluate(node => { (node as HTMLElement).style.width = '320px'; (node as HTMLElement).style.height = '240px' })
    await touchPackWindow.getByRole('button', { name: 'Add members', exact: true }).click()
    const touchAddPage = touchPackWindow.locator('[data-clue-add-member]')
    await selectClueSource(touchAddPage, 'builtin.files')
    const addCheckbox = touchAddPage.getByRole('checkbox', { name: 'Select touch-reference.md', exact: true })
    await addCheckbox.scrollIntoViewIfNeeded()
    const addLabel = addCheckbox.locator('..')
    expect((await addLabel.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await addLabel.click({ position: { x: (await addLabel.boundingBox())!.width - 3, y: 22 } })
    await expect(addCheckbox).toBeChecked()
    const touchAdd = touchPackWindow.locator('[data-clue-pack-add-footer]').getByRole('button', { name: 'Add selected', exact: true })
    const touchAddBounds = (await touchAdd.boundingBox())!
    const touchPackBounds = (await touchPackWindow.boundingBox())!
    expect(touchAddBounds.height).toBeGreaterThanOrEqual(44)
    expect(touchAddBounds.y + touchAddBounds.height).toBeLessThanOrEqual(touchPackBounds.y + touchPackBounds.height)
    expect(await touchAdd.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })).toBe(true)
    await touchPackWindow.screenshot({ path: testInfo.outputPath('clues-pack-add-touch-320x240.png') })
    await touchAdd.click()
    await expect(touchAddPage).toHaveCount(0)
    await touchPackWindow.getByRole('button', { name: 'Close', exact: true }).click()
    await clueView(tab, 'packs')
    await tab.getByRole('button', { name: 'Import', exact: true }).click()
    const share = page.locator('[data-clue-share-window]')
    await share.getByRole('tab', { name: 'Export', exact: true }).click()
    const window = page.locator('[data-floating-window]:visible').last()
    await window.evaluate(node => {
      const element = node as HTMLElement
      element.style.width = '320px'
      element.style.height = '240px'
    })
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
    expect(await share.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    for (const name of ['Preview selection', 'Reset']) {
      const button = share.getByRole('button', { name, exact: true })
      await button.scrollIntoViewIfNeeded()
      const bounds = await button.boundingBox()
      const frame = await window.boundingBox()
      expect(bounds!.height).toBeGreaterThanOrEqual(44)
      expect(bounds!.y).toBeGreaterThanOrEqual(frame!.y)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(frame!.y + frame!.height)
    }
    await window.screenshot({ path: testInfo.outputPath('clues-share-touch-320x240.png') })
    await share.getByRole('checkbox', { name: /Touch pack/ }).check()
    const previewRoute = '**/sidebar/api/clues.share.exportPreview'
    let releasePreview!: () => void
    const previewGate = new Promise<void>(resolve => { releasePreview = resolve })
    await page.route(previewRoute, async route => {
      await previewGate
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'request-failed', message: 'Unable to preview this selection. Please retry after reviewing the selected resources. '.repeat(6) } }) })
    })
    const previewAction = share.getByRole('button', { name: 'Preview selection', exact: true })
    await expect(previewAction).toHaveAccessibleName('Preview selection')
    const readyWidth = (await previewAction.boundingBox())!.width
    await previewAction.click()
    await expect(previewAction).toHaveAttribute('aria-busy', 'true')
    await expect(previewAction).toBeDisabled()
    await expect(previewAction).toHaveAccessibleName('Preview selection')
    expect((await previewAction.boundingBox())!.width).toBe(readyWidth)
    await expect(share.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    await expect(share.getByRole('button', { name: 'Reset', exact: true })).toHaveCount(0)
    const busyFooter = share.getByRole('button', { name: 'Cancel', exact: true }).locator('..')
    expect(await busyFooter.getByRole('button').count()).toBe(2)
    const busyBounds = (await busyFooter.boundingBox())!
    expect(busyBounds.y + busyBounds.height).toBeLessThanOrEqual((await window.boundingBox())!.y + (await window.boundingBox())!.height)
    await window.screenshot({ path: testInfo.outputPath('clues-share-busy-touch-320x240.png') })
    releasePreview()
    await expect(share.getByRole('alert')).toBeVisible()
    await expect(previewAction).toBeEnabled()
    await expect(previewAction).toHaveAccessibleName('Preview selection')
    for (const name of ['Preview selection', 'Reset']) {
      const bounds = (await share.getByRole('button', { name, exact: true }).boundingBox())!
      expect(bounds.y + bounds.height).toBeLessThanOrEqual((await window.boundingBox())!.y + (await window.boundingBox())!.height)
    }
    await window.screenshot({ path: testInfo.outputPath('clues-share-error-touch-320x240.png') })
    await page.unroute(previewRoute)

  } finally {
    await api.dispose()
    await context.close()
  }
})
