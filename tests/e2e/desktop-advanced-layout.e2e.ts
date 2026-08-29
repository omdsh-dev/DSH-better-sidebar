/**
 * Regression lane for #459: DSH Desktop 2.0.4 advanced mode installs its
 * desktop-owned stylesheet at runtime and includes `#root { width: 100% }`.
 * If that later rule wins over better-sidebar's layout push, #root keeps the
 * full viewport width while retaining margin-right, so the fixed sidebar
 * overlays the conversation instead of making the shell give up space.
 *
 * This test deliberately appends the Desktop rule AFTER the plugin has
 * mounted, matching the failure-producing cascade order without requiring an
 * Electron/Windows runner. The advanced-mode body marker is part of the
 * Desktop shell contract and lets the compatibility override stay scoped.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { PAGE_URL, createHostApi, hostRpc } from './host'

const WORKSPACE_PATH = process.env.DSH_E2E_DESKTOP_ADVANCED_WORKSPACE
  ?? join(tmpdir(), 'dsh-e2e-desktop-advanced-workspace')

let api: APIRequestContext

async function seedSession(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, 'seed.txt'), 'desktop advanced layout lane\n')
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(
    api,
    'workspace.create',
    { path: WORKSPACE_PATH },
  )
  await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
}

test.beforeAll(async () => {
  api = await createHostApi()
  await seedSession()
})

test.afterAll(async () => {
  await api?.dispose()
})

test('Desktop advanced late root width cannot defeat the sidebar layout push (#459)', async ({ page }) => {
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })

  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })

  // Keyless DSH boots may stack onboarding takeovers above the shell. Dismiss
  // them using the same bounded loop as the other mount lanes before clicking
  // the sidebar toggle.
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    console.warn('[e2e-desktop-advanced] no onboarding takeover appeared; proceeding')
  }
  for (let round = 0; round < 8; round++) {
    let dismissed = false
    for (const name of ['Continue', 'Configure later']) {
      const button = page.getByRole('button', { name, exact: true }).first()
      if ((await button.count()) === 0) continue
      try {
        await button.click({ timeout: 4_000 })
        dismissed = true
        await page.waitForTimeout(800)
      } catch {
        // A higher takeover may mask this button; retry in the next round.
      }
    }
    if (!dismissed) break
  }

  // Reproduce dsh-desktop v2.0.4 advanced-shell ordering: the shell marker is
  // present and Desktop appends its owned stylesheet after plugin CSS. Keep
  // the relevant margin rule too so the containing block matches the real
  // Desktop stylesheet rather than relying on the web shell's body defaults.
  await page.evaluate(() => {
    document.body.dataset.dshDesktopMode = 'advanced'
    const style = document.createElement('style')
    style.dataset.testDesktopOwnedStyles = 'issue-459'
    style.textContent = `
      html, body, #root { width: 100%; height: 100%; }
      body[data-dsh-desktop-mode="advanced"] { margin: 0; background: transparent !important; }
    `
    document.head.appendChild(style)
  })

  const expandButton = sidebar.getByRole('button', { name: 'Expand sidebar' })
  await expect(expandButton).toHaveCount(1)
  await expandButton.click()

  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-sidebar-width')))
    .not.toBe('')

  // The push animates, so poll the geometric invariant instead of sleeping for
  // an assumed transition duration. Under the broken cascade rootWidth stays
  // equal to viewportWidth while marginRight becomes non-zero, making this
  // invariant remain false after the transition has settled.
  await expect
    .poll(() => page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('#root')
      if (root === null) return false
      const rect = root.getBoundingClientRect()
      const marginRight = Number.parseFloat(getComputedStyle(root).marginRight)
      if (!Number.isFinite(marginRight) || marginRight <= 0) return false
      return Math.abs(rect.width - (window.innerWidth - marginRight)) <= 2
    }), { timeout: 30_000 })
    .toBe(true)

  const geometry = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('#root')
    if (root === null) throw new Error('#root missing')
    const rect = root.getBoundingClientRect()
    const marginRight = Number.parseFloat(getComputedStyle(root).marginRight)
    return {
      viewportWidth: window.innerWidth,
      rootWidth: rect.width,
      marginRight,
      miss: Math.abs(rect.width - (window.innerWidth - marginRight)),
    }
  })

  expect(geometry.marginRight, 'expanded sidebar must apply a non-zero layout push').toBeGreaterThan(0)
  expect(geometry.rootWidth, 'Desktop advanced root must actually surrender horizontal space').toBeLessThan(geometry.viewportWidth)
  expect(
    geometry.miss,
    `root must shrink by the sidebar width: viewport=${geometry.viewportWidth}, root=${geometry.rootWidth}, margin=${geometry.marginRight}`,
  ).toBeLessThanOrEqual(2)
})
