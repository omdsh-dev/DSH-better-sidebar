/**
 * PR #1051's geometry and targeting gate against the REAL host docking kit.
 * The parent mount lane supplies DSH_E2E_URL; this spec never starts a server.
 * Two retained conversations deliberately have duplicate session-local tab ids:
 * menu targets and freeze ownership must use the visible session's own strip.
 * No CSS-module selectors, fake host nodes or injected controller are used.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { createHostApi, dismissOnboarding, gotoPage, hostRpc, sendFirstMessage } from './host'

const PANEL = '[data-sidebar-right-panel][data-sidebar-right-open]:visible'
const STRIP = '[data-dockkit-strip]'
const CHIP = '[data-dockkit-tab]'
const FROZEN = '[data-dsh-tabs-frozen]'
const ACTION = 'data-dsh-better-sidebar-tab-menu-action'
const KINDS = ['files', 'git', 'subagent', 'terminal'] as const

/** The actual rendered chip geometry, not just the flex declarations. */
async function widths(strip: Locator): Promise<number[]> {
  return strip.locator(CHIP).evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width))
}

async function ids(strip: Locator): Promise<string[]> {
  return strip.locator(CHIP).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-dockkit-tab') ?? ''))
}

async function equalWidths(strip: Locator, count: number): Promise<number[]> {
  await expect(strip.locator(CHIP)).toHaveCount(count)
  await expect.poll(async () => {
    const values = await widths(strip)
    return values.length === count && Math.min(...values) > 0 && Math.max(...values) - Math.min(...values) < 1
  }, { message: `${count} actual host chips must share one width` }).toBe(true)
  return widths(strip)
}

async function sessionId(page: Page): Promise<string> {
  const value = await page.locator(PANEL).getAttribute('data-sidebar-right-session')
  if (value === null || value === '') throw new Error('the visible host panel must identify its conversation')
  return value
}

/** Open real guide kinds, replacing the guide each time (the host mints ids). */
async function populate(page: Page): Promise<Locator> {
  await sendFirstMessage(page)
  await page.locator('[data-sidebar-right-expand]:visible').first().click()
  const panel = page.locator(PANEL)
  await expect(panel).toHaveCount(1)
  for (const kind of KINDS) {
    if (await panel.locator('[data-sidebar-right-guide]:visible').count() === 0) {
      await panel.locator('[data-dockkit-add-tab]').first().click()
    }
    await panel.locator(`[data-sidebar-right-guide-entry="${kind}"]:visible`).click()
    await expect(panel.locator(`[data-sidebar-right-guide-entry="${kind}"]:visible`)).toHaveCount(0)
  }
  const strip = panel.locator(STRIP)
  await expect(strip).toHaveCount(1)
  await equalWidths(strip, KINDS.length)
  return strip
}

/** Real pointer close, followed by a geometry assertion without moving away. */
async function closeLastAndKeepPointer(strip: Locator, before: number): Promise<void> {
  const count = await strip.locator(CHIP).count()
  await strip.locator(CHIP).last().locator('[data-dockkit-tab-close]').click()
  await expect(strip.locator(CHIP)).toHaveCount(count - 1)
  await expect(strip).toHaveAttribute('data-dsh-tabs-frozen', '')
  await expect.poll(async () => (await widths(strip)).every(value => Math.abs(value - before) < 1), {
    message: 'surviving chip widths must stay pinned across the host strip DOM replacement',
  }).toBe(true)
}

async function menu(page: Page, strip: Locator, action: string): Promise<Locator> {
  await strip.locator(CHIP).last().click({ button: 'right' })
  const item = page.locator(`[${ACTION}="${action}"]:visible`)
  await expect(item).toHaveCount(1)
  return item
}

test('native equal-width chips freeze only until pointer leave; bulk close ignores retained duplicate ids', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const root = mkdtempSync(join(tmpdir(), 'sidebar-tab-strip-'))
  writeFileSync(join(root, 'tab-strip.txt'), 'PR1051 host regression\n')
  const api = await createHostApi()
  const pageErrors: string[] = []
  const registrationErrors: string[] = []
  page.on('pageerror', error => { pageErrors.push(String(error)) })
  page.on('console', message => {
    if (message.type() === 'error' && /native register|dsh-better-sidebar/.test(message.text())) {
      registrationErrors.push(message.text())
    }
  })
  try {
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: root })
    await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
    await gotoPage(page)
    await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
    await dismissOnboarding(page)

    const firstStrip = await populate(page)
    const firstSession = await sessionId(page)
    const firstIds = await ids(firstStrip)

    // Use the shell's New session so its selection and live websocket feeds
    // advance too; an API-only session.create does not select the new session.
    await page.getByRole('button', { name: /^(New session|新建会话)$/ }).first().click()
    // The keyless host reopens its Get started dialog for a new conversation,
    // even after onboarding was dismissed in A. Close that real overlay before
    // trying to focus B's composer (otherwise it intercepts every pointer).
    await dismissOnboarding(page)
    const strip = await populate(page)
    const secondSession = await sessionId(page)
    expect(secondSession).not.toBe(firstSession)
    const secondIds = await ids(strip)
    expect(secondIds.filter(id => firstIds.includes(id)).length,
      'the fixture must really contain duplicate session-local ids').toBeGreaterThan(1)
    const hiddenPanel = page.locator(`[data-sidebar-right-panel][data-sidebar-right-session="${firstSession}"]`)
    await expect(hiddenPanel).toBeHidden()
    await expect(hiddenPanel.locator(CHIP)).toHaveCount(firstIds.length)

    const before = (await equalWidths(strip, 4))[0]!
    await closeLastAndKeepPointer(strip, before)
    await closeLastAndKeepPointer(strip, before)
    await expect(hiddenPanel.locator(FROZEN)).toHaveCount(0)
    await expect(page.locator(`html${FROZEN}`)).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('native-tabs-frozen.png') })

    await page.mouse.move(5, 5)
    await expect(strip).not.toHaveAttribute('data-dsh-tabs-frozen')
    await equalWidths(strip, 2)
    await expect.poll(async () => (await widths(strip))[0] ?? 0, {
      message: 'leaving the strip releases the pin and the two survivors grow',
    }).toBeGreaterThan(before + 1)

    // B now has two chips, A still has four with the same first ids. Resolving
    // the first matching tab in the whole document would incorrectly offer
    // right-side targets from A when right-clicking B's LAST chip.
    const closeRight = await menu(page, strip, 'closeRight')
    await expect(closeRight).toBeDisabled()
    await expect(page.locator(`[${ACTION}="closeLeft"]:visible`)).toBeEnabled()
    await page.keyboard.press('Escape')
    const keep = (await ids(strip)).at(-1)!
    await (await menu(page, strip, 'closeOthers')).click()
    await expect.poll(() => ids(strip)).toEqual([keep])
    await expect(page.locator(`[${ACTION}]:visible`)).toHaveCount(0)
    await expect(hiddenPanel.locator(CHIP)).toHaveCount(firstIds.length)

    // Return through the real session rail: the hidden session must retain its
    // own untouched tab order, rather than merely retaining some hidden DOM.
    const firstRow = page.locator(`[role="treeitem"][data-row-key="session:${firstSession}"]`).first()
    await expect(firstRow).toBeVisible({ timeout: 30_000 })
    await firstRow.click()
    await expect(page.locator(PANEL)).toHaveAttribute('data-sidebar-right-session', firstSession)
    await expect.poll(() => ids(page.locator(PANEL).locator(STRIP))).toEqual(firstIds)

    // Exercise the real host split control. SDK dockLabels supplies "Split";
    // keep the original pane identity rather than relying on DOM position when
    // the host rebuilds its layout around the second pane.
    const panelA = page.locator(PANEL)
    const originalPane = await panelA.locator(STRIP).getAttribute('data-dockkit-strip')
    expect(originalPane).toBeTruthy()
    const splitButton = panelA.getByRole('button', { name: /^(Split|分栏)(?:\s|$)/ }).first()
    await expect(splitButton).toBeEnabled()
    await splitButton.click()
    await expect(panelA.locator(STRIP)).toHaveCount(2)
    const original = panelA.locator(`[data-dockkit-strip="${originalPane}"]`)
    const sibling = panelA.locator(`[data-dockkit-strip]:not([data-dockkit-strip="${originalPane}"])`)
    await expect(sibling).toHaveCount(1)
    // The new pane is seeded with a guide. Replace it with a real Files body;
    // one wide chip makes accidental copying of the other pane's narrow width
    // observable, rather than having two coincidentally equal strip geometries.
    await panelA.locator('[data-sidebar-right-guide-entry="files"]:visible').click()
    await equalWidths(sibling, 1)
    const siblingBefore = await widths(sibling)
    const siblingIds = await ids(sibling)
    const originalBefore = (await equalWidths(original, firstIds.length))[0]!
    expect(siblingBefore[0]!, 'split fixture must have distinct pane chip widths').toBeGreaterThan(originalBefore + 1)
    await closeLastAndKeepPointer(original, originalBefore)
    await expect(sibling).not.toHaveAttribute('data-dsh-tabs-frozen')
    await expect.poll(async () => {
      const after = await widths(sibling)
      return after.length === siblingBefore.length && after.every((value, index) => Math.abs(value - siblingBefore[index]!) < 1)
    }, { message: 'closing in one split must not freeze or resize its sibling chips' }).toBe(true)
    await expect.poll(() => ids(sibling)).toEqual(siblingIds)
    await page.screenshot({ path: testInfo.outputPath('native-tabs-split.png') })
    await page.mouse.move(5, 5)
    await expect(original).not.toHaveAttribute('data-dsh-tabs-frozen')
    expect(pageErrors).toEqual([])
    expect(registrationErrors).toEqual([])
  } finally {
    await api.dispose()
  }
})
