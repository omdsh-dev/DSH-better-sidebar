/**
 * Toggle-layout lane (issue #315): while the right panel slides open/closed
 * with its 300ms layout push, the BOTTOM panel must keep tracking the center
 * column's horizontal edges frame by frame.
 *
 * The shell changed the bottom panel's geometry source from React state
 * (setCenterRect per ResizeObserver frame → full Sidebar re-render at
 * animation cadence) to a ref + direct inline writes, so the panel still
 * follows the animated center column with zero React work. This lane samples
 * the transition and asserts the bottom panel's edges stay glued to the
 * center column (left/right within a rounding + one-frame tolerance) — the
 * visual-equivalence proof for that change.
 *
 * The server is booted by scripts/e2e-mount.sh; this spec only loads the
 * page (own workspace, like drag-layout.e2e.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, request, type APIRequestContext } from '@playwright/test'

const BASE_URL = process.env.DSH_E2E_URL
if (!BASE_URL) {
  throw new Error('DSH_E2E_URL is not set — boot a DSH web instance with the plugin mounted and point this lane at it (see scripts/e2e-mount.sh)')
}

const WORKSPACE_PATH = process.env.DSH_E2E_TOGGLE_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-toggle-workspace')

let api: APIRequestContext

async function seedSession(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, 'seed.txt'), 'toggle lane\n')
  const workspace = await api.post(`${BASE_URL}/api/workspace.create`, {
    data: { type: 'client-request', rpcId: 'e2e-toggle-workspace', method: 'workspace.create', payload: { path: WORKSPACE_PATH } },
  })
  expect(workspace.ok(), `workspace.create: ${workspace.status()} ${await workspace.text()}`).toBe(true)
  const workspaceBody = (await workspace.json()) as {
    result: { ok: true; value: { workspace: { workspaceId: string } } } | { ok: false; error: unknown }
  }
  expect(workspaceBody.result.ok).toBe(true)
  const workspaceId = (workspaceBody.result as { value: { workspace: { workspaceId: string } } }).value.workspace.workspaceId
  const session = await api.post(`${BASE_URL}/api/session.create`, {
    data: { type: 'client-request', rpcId: 'e2e-toggle-session', method: 'session.create', payload: { workspaceId } },
  })
  expect(session.ok(), `session.create: ${session.status()} ${await session.text()}`).toBe(true)
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: BASE_URL })
  await seedSession()
})

test.afterAll(async () => {
  await api?.dispose()
})

interface FrameSample {
  t: number
  centerLeft: number
  centerRight: number
  bottomLeft: number
  bottomRight: number
}

test('bottom panel tracks the center column during the right-panel toggle transition (issue #315)', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })

  // Dismiss onboarding (same dance as the drag lane).
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    console.warn('[e2e-toggle] no onboarding takeover appeared; proceeding')
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
        // Masked by a takeover stacked above; retry in the next round.
      }
    }
    if (!dismissed) break
  }

  // Open the right panel (fresh sessions start collapsed).
  const expandButton = sidebar.getByRole('button', { name: 'Expand sidebar' })
  await expect(expandButton).toHaveCount(1)
  await expandButton.click()
  await expect
    .poll(async () => {
      const value = await page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-sidebar-width'))
      return value !== '' && value !== '0px'
    }, { timeout: 90_000 })
    .toBe(true)

  // Open the bottom panel too: the twin panels make the toggle exercise the
  // full geometry chain (bottom panel edges follow the animated push).
  const expandBottom = sidebar.getByRole('button', { name: 'Expand bottom panel' })
  await expect(expandBottom).toHaveCount(1)
  await expandBottom.click()
  // Wait until the bottom panel is REALLY tracking the center column (not
  // the hidden {0,0} fallback): the panel's box exists even while hidden, so
  // wait for the computed visibility + a matched right edge before sampling.
  await expect
    .poll(async () => page.evaluate(() => {
      const col = document.querySelector('#root [data-slot="conversation"]')?.parentElement
      const bottom = document.querySelector('[data-dsh-bottom-panel]')
      if (col === null || col === undefined || bottom === null) return false
      const cr = col.getBoundingClientRect()
      const br = bottom.getBoundingClientRect()
      const visible = getComputedStyle(bottom).visibility !== 'hidden'
      return cr.width > 100 && visible && Math.abs(br.right - cr.right) <= 3
    }), { timeout: 30_000 })
    .toBe(true)
  await page.waitForTimeout(500) // let both open transitions settle

  // Per-frame sampler: center column (same anchor as layout.css) vs the
  // bottom panel's visible edges. The loop re-resolves
  // window.__toggleSamples every frame, so clearing it (sampleToggle) drops
  // old frames without detaching the loop.
  await page.evaluate(() => {
    const center = document.querySelector('#root [data-slot="conversation"]')?.parentElement
    const bottom = document.querySelector('[data-dsh-bottom-panel]')
    ;(window as unknown as { __toggleSamples: FrameSample[] }).__toggleSamples = []
    const loop = (): void => {
      const c = center?.getBoundingClientRect() ?? { left: 0, right: 0 }
      const b = bottom?.getBoundingClientRect() ?? { left: 0, right: 0 }
      ;(window as unknown as { __toggleSamples: FrameSample[] }).__toggleSamples.push({
        t: performance.now(), centerLeft: c.left, centerRight: c.right, bottomLeft: b.left, bottomRight: b.right,
      })
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })

  const collapseButton = sidebar.getByRole('button', { name: 'Collapse sidebar' })
  const expandButton2 = sidebar.getByRole('button', { name: 'Expand sidebar' })

  async function sampleToggle(click: () => Promise<void>): Promise<FrameSample[]> {
    // Clear accumulated frames so the sample window starts at the click.
    await page.evaluate(() => {
      ;(window as unknown as { __toggleSamples: FrameSample[] }).__toggleSamples = []
    })
    await click()
    await page.waitForTimeout(800)
    const samples = await page.evaluate(() => {
      const data = (window as unknown as { __toggleSamples: FrameSample[] }).__toggleSamples
      ;(window as unknown as { __toggleSamples: FrameSample[] }).__toggleSamples = []
      return data
    })
    return samples
  }

  function trackMiss(samples: FrameSample[], label: string): void {
    // The bottom panel's geometry rides the center column's ResizeObserver:
    // RO callbacks run AFTER layout, so a write there lands in the NEXT
    // frame's paint — the panel is exactly ONE animation frame behind the
    // column mid-transition (measured: bottom(t) === center(t-1)).
    // Anything more is a real desync; the settled frames must agree exactly.
    const valid = samples.filter(s => s.centerRight - s.centerLeft > 100)
    expect(valid.length, `${label}: sampler must have captured the transition`).toBeGreaterThan(3)

    let maxOneFrame = 0
    for (let i = 1; i < valid.length; i++) {
      maxOneFrame = Math.max(
        maxOneFrame,
        Math.abs(valid[i]!.bottomLeft - valid[i - 1]!.centerLeft),
        Math.abs(valid[i]!.bottomRight - valid[i - 1]!.centerRight),
      )
    }
    const settled = valid.slice(-5)
    const settleMiss = Math.max(
      ...settled.map(s => Math.max(
        Math.abs(s.bottomLeft - s.centerLeft),
        Math.abs(s.bottomRight - s.centerRight),
      )),
    )
    console.log(`[e2e-toggle] ${label}: ${valid.length} frames, max one-frame miss=${maxOneFrame.toFixed(1)}px, settle miss=${settleMiss.toFixed(1)}px`)
    expect(maxOneFrame, `${label}: bottom panel must track the center column one frame behind (RO cadence)`).toBeLessThanOrEqual(4)
    expect(settleMiss, `${label}: bottom panel must settle exactly on the center column`).toBeLessThanOrEqual(3)
  }

  const collapseSamples = await sampleToggle(() => collapseButton.click())
  trackMiss(collapseSamples, 'collapse')

  const expandSamples = await sampleToggle(() => expandButton2.click())
  trackMiss(expandSamples, 'expand')
})
