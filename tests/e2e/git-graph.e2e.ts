import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { createHostApi, dismissOnboarding, gotoPage, hostRpc, sendFirstMessage, sidebarApi } from './host'

// A dedicated fixture: never initialize or write the caller's working repository.
test('read-only Git Graph renders merge history and filters without checkout', async ({ page }, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'sidebar-graph-e2e-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Graph fixture')
  git('config', 'user.email', 'graph@example.invalid')
  writeFileSync(join(root, 'base.txt'), 'base\n')
  git('add', '.')
  git('commit', '-m', 'Graph base')
  // The final history exceeds one 50-row page; its viewport must still stay bounded.
  for (let index = 0; index < 48; index++) git('commit', '--allow-empty', '-m', `History ${String(index)}`)
  git('checkout', '-b', 'feature')
  writeFileSync(join(root, 'feature.txt'), 'feature\n')
  git('add', '.')
  git('commit', '-m', 'Graph feature')
  git('checkout', 'main')
  writeFileSync(join(root, 'main.txt'), 'main\n')
  git('add', '.')
  git('commit', '-m', 'Graph main')
  git('merge', '--no-ff', 'feature', '-m', 'Graph merge')
  const before = { head: git('rev-parse', 'HEAD'), refs: git('show-ref'), status: git('status', '--porcelain') }
  const api = await createHostApi()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  try {
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: root })
    const session = await hostRpc<{ sessionId: string }>(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
    const response = await api.post(sidebarApi('git.graph'), { data: { sessionId: session.value.sessionId, cwd: root } })
    expect(response.ok()).toBe(true)
    await gotoPage(page)
    await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
    await dismissOnboarding(page)
    await sendFirstMessage(page)
    await page.locator('[data-sidebar-right-expand]').first().click()
    await page.locator('[data-sidebar-right-guide-entry="git"]').click()
    // The Graph area is a SECTION of the Git lens (#969's engine rendered in
    // #944's Source Control structure), unfolded by default: unfold it when a
    // previous run left it folded rather than toggling it shut.
    const graphHeader = page.getByRole('button', { name: 'Graph', exact: true }).first()
    if (await graphHeader.getAttribute('aria-expanded') !== 'true') await graphHeader.click()
    const graph = page.locator('[data-git-graph]:visible')
    await expect(graph.getByText('Graph merge', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
    await expect(graph.getByText('Graph feature', { exact: true }).first()).toBeVisible()
    const expectGraphFillsHeight = async () => {
      await expect.poll(() => page.evaluate(() => {
        const graphBox = document.querySelector('[data-git-graph]')!.getBoundingClientRect()
        const footer = document.querySelector('[data-git-footer]')!.getBoundingClientRect()
        return Math.abs(footer.top - graphBox.bottom)
      }), { message: 'the graph must use the available height above the footer' }).toBeLessThanOrEqual(1)
    }
    await page.setViewportSize({ width: 1440, height: 1400 })
    await expectGraphFillsHeight()
    const graphScroll = graph.locator(':scope > [aria-busy]')
    expect(await graphScroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('git-graph-tall.png'), fullPage: true })
    await graph.getByText('Graph merge', { exact: true }).first().click()
    await expectGraphFillsHeight()
    // The selection opens the DETAILS card in the shared bottom pane: the full
    // hash chip, both merge parents (7-char chips), and no first-parent note.
    // Scope to the card — short hashes also appear in the (hidden) Git lens.
    const panel = page.locator('[data-sidebar-right-panel]:visible')
    const card = panel.locator('section[aria-label]')
    await expect(card.getByText(before.head, { exact: true })).toBeVisible()
    const parents = git('rev-parse', 'HEAD^1', 'HEAD^2').split('\n')
    await expect(card.getByText(parents[0]!.slice(0, 7), { exact: true }).first()).toBeVisible()
    await expect(card.getByText(parents[1]!.slice(0, 7), { exact: true }).first()).toBeVisible()
    await expect(panel.getByText(/first parent/i)).toHaveCount(0)
    // The current branch's pill (HEAD folds into it) sits on the merge row.
    // Scoped to the row: the bare name also lives in the branch select.
    const mergeRow = graph.locator('[data-graph-commit]', { hasText: 'Graph merge' }).first()
    await expect(mergeRow.getByText('main', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('git-graph.png'), fullPage: true })
    const branchFilter = page.locator('[data-git-graph] select').filter({ has: page.locator('option[value="refs/heads/feature"]') })
    await branchFilter.selectOption('refs/heads/feature')
    await expect(graph.getByText('Graph merge', { exact: true })).toHaveCount(0)
    await expect(graph.getByText('Graph feature', { exact: true }).first()).toBeVisible()
    expect({ head: git('rev-parse', 'HEAD'), refs: git('show-ref'), status: git('status', '--porcelain') }).toEqual(before)
    await page.setViewportSize({ width: 1024, height: 800 })
    await graph.getByText('Graph feature', { exact: true }).first().click()
    await expect(page.locator('[class*="diffPane"]')).toBeVisible()
    await expectGraphFillsHeight()
    await page.screenshot({ path: testInfo.outputPath('git-graph-narrow-preview.png'), fullPage: true })
    await graphHeader.click()
    await expect(graph).toHaveCount(0)
    expect(await page.locator('[data-scm-section="graph"]').evaluate(el => Math.round(el.getBoundingClientRect().height))).toBe(28)
    await graphHeader.click()
    await expect(graph).toBeVisible()
    await expect(graph.locator('[data-graph-commit]')).toHaveCount(50)
    await expectGraphFillsHeight()

    // Stress the outer scroller only after verifying graph interactions are read-only.
    for (let index = 0; index < 40; index++) writeFileSync(join(root, `change-${String(index)}.txt`), 'pending\n')
    const changes = page.locator('[data-scm-section="changes"]')
    await changes.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(changes.locator('[data-row="change-39.txt"]')).toHaveCount(1)
    await expect(graphScroll).toHaveAttribute('aria-busy', 'false')
    await expect(graph.locator('[data-graph-commit]')).toHaveCount(50)
    const outer = page.locator('[data-git-scroll]')
    expect(await outer.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    expect(await graph.evaluate(el => Math.round(el.getBoundingClientRect().height))).toBe(220)
    await outer.evaluate(el => { el.scrollTop = el.scrollHeight })
    await expectGraphFillsHeight()
    await page.screenshot({ path: testInfo.outputPath('git-graph-long-changes.png'), fullPage: true })
    await changes.locator(':scope > div > button[aria-expanded]').click()
    await expectGraphFillsHeight()
    expect(errors).toEqual([])
  } finally {
    await api.dispose()
    // Fixture retained with test artifacts for inspecting failures; no shared-path cleanup.
  }
})
