import { expect, type Locator, type Page } from '@playwright/test'

const sourceNames: Record<string, string> = {
  'builtin.files': 'Local files',
  'builtin.github.issues': 'GitHub Issues',
  'builtin.github.pulls': 'GitHub Pull requests',
  'builtin.feishu.docs': 'Feishu docs',
  'builtin.feishu.tasks': 'Feishu tasks',
}

/**
 * One retained window frame, whether it is docked in the right sidebar or
 * floating. Both surfaces render the same content markers; only the shell and
 * the dock/float control switch.
 */
export function clueWindowFrame(page: Page, marker: Locator): Locator {
  return page.locator('[data-floating-window], [data-window-docked="true"]').filter({ has: marker })
}

/**
 * HEAVY clue windows (detail, pack, share, config, settings) follow the
 * window-surface preference and open DOCKED by default; light flows
 * (collect, scope) are always floating. Present the floating surface the
 * cases measure and pin the transfer contract where it exists: a docked
 * frame becomes a floating dialog with the reverse dock control, while an
 * already-floating frame just needs its dock action visible.
 */
export async function floatClueWindow(page: Page, marker: Locator): Promise<Locator> {
  const frame = clueWindowFrame(page, marker)
  await expect(frame).toHaveCount(1)
  if (await frame.getAttribute('data-window-docked') === 'true') {
    await frame.locator('[data-window-float]').click()
    await expect(frame).toHaveAttribute('data-floating-window', '')
    await expect(frame.locator('[data-window-dock]')).toBeVisible()
  } else {
    await expect(frame).toHaveAttribute('data-floating-window', '')
  }
  // Floating keeps the native sidebar tab selected (it now only shows the
  // "open in a floating window" hint), which would hide the workbench the
  // caller needs next. Return to the clue guide tab, the surface the window
  // was opened from.
  const workbenchTab = page.locator('[data-sidebar-right-panel]:visible [role="tab"]')
    .filter({ hasText: /^\s*Clues\b/ }).first()
  await expect(workbenchTab).toHaveCount(1)
  await workbenchTab.click()
  await expect(workbenchTab).toHaveAttribute('aria-selected', 'true')
  return frame
}

/** Exercise the real portaled SelectMenu, including its close and focus contract. */
export async function selectMenu(scope: Locator, label: string, option: string): Promise<void> {
  const trigger = scope.getByRole('button', { name: label, exact: true })
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await scope.page().getByRole('menuitem', { name: option, exact: true }).click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
}

export async function selectClueSource(scope: Locator, sourceId: string): Promise<void> {
  const navigation = scope.locator('[data-clue-source-navigation]')
  const name = sourceNames[sourceId]!
  const select = navigation.getByRole('button', { name: 'Source', exact: true })
  const tab = navigation.getByRole('tab', { name, exact: true })
  await expect(tab.or(select)).toBeVisible()
  if (await tab.isVisible()) await tab.click()
  else {
    await select.click()
    await scope.page().getByRole('menuitem', { name, exact: true }).click()
  }
  await expect(navigation).toHaveAttribute('data-clue-active-source', sourceId)
}

/**
 * Open one explorer section and close the other (the behavioural tests still
 * exercise an exclusive switch; the page itself allows both open).
 */
export async function clueView(tab: Locator, view: 'browse' | 'packs'): Promise<void> {
  const title = view === 'browse' ? 'Resources' : 'Collections'
  const other = view === 'browse' ? 'Collections' : 'Resources'
  const toggle = tab.getByRole('button', { name: title, exact: true })
  const otherToggle = tab.getByRole('button', { name: other, exact: true })
  if (await otherToggle.count() > 0 && await otherToggle.getAttribute('aria-expanded') === 'true') {
    await otherToggle.click()
    await expect(otherToggle).toHaveAttribute('aria-expanded', 'false')
  }
  if (await toggle.getAttribute('aria-expanded') !== 'true') {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  }
  await expect(tab.locator(view === 'browse' ? '[data-clue-browse-region]' : '[data-clue-pack-region]')).toBeVisible()
  await expect(tab.locator(view === 'browse' ? '[data-clue-pack-region]' : '[data-clue-browse-region]')).toBeHidden()
}

/** Wait until a container's width stops changing (host panels resize on rAF). */
export async function stableWidth(scope: Locator): Promise<number> {
  let previous = -1
  await expect.poll(async () => {
    const width = await scope.evaluate(node => (node as HTMLElement).clientWidth)
    const stable = width === previous
    previous = width
    return stable
  }, { timeout: 10_000, intervals: [50, 100, 150, 200] }).toBe(true)
  return scope.evaluate(node => (node as HTMLElement).clientWidth)
}

export async function selectionMode(browser: Locator): Promise<void> {
  const toggle = browser.locator('[data-clue-selection-mode]')
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
}

export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate(dark => {
    document.body.toggleAttribute('data-ds-dark-theme', dark)
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  }, theme === 'dark')
}

/** Check the actual plugin viewport; scrollable content must stay inside it. */
export async function expectNoOverflow(surface: Locator): Promise<void> {
  await expect(surface).toBeVisible()
  expect(await surface.evaluate(node => node.clientWidth)).toBeGreaterThan(0)
  const overflow = await surface.evaluate(node => node.scrollWidth - node.clientWidth)
  const evidence = overflow <= 1 ? undefined : await surface.evaluate(node => {
    const box = node.getBoundingClientRect()
    return { clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, left: box.left, right: box.right,
      children: [...node.querySelectorAll<HTMLElement>('*')].filter(child => {
        const rect = child.getBoundingClientRect()
        return rect.width > 0 && rect.right > box.right + 1
      }).slice(0, 8).map(child => ({ tag: child.tagName, label: child.getAttribute('aria-label') ?? child.textContent?.trim().slice(0, 100),
        width: child.getBoundingClientRect().width, right: child.getBoundingClientRect().right, clientWidth: child.clientWidth, scrollWidth: child.scrollWidth,
        className: child.className, minWidth: getComputedStyle(child).minWidth, whiteSpace: getComputedStyle(child).whiteSpace })) }
  })
  expect(overflow, evidence === undefined ? undefined : JSON.stringify(evidence)).toBeLessThanOrEqual(1)
}
