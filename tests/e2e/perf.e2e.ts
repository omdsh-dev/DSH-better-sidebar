/**
 * Perf lane: a MEASUREMENT harness, not a pass/fail gate (beyond the mount
 * sanity it shares with the other lanes).
 *
 * It exists to put NUMBERS on the sidebar's client-side cost in a real
 * mounted `dsh web` (the same scratch-profile boot as scripts/e2e-mount.sh):
 *
 *   1. mount latency  — navigationStart → `[data-dsh-better-sidebar]`
 *      attached, sampled by an init-script probe (rAF loop, so it catches
 *      the attach even before Playwright's first poll);
 *   2. longtasks      — every >50ms main-thread task from first paint
 *      through the full built-in tab sweep (the heaviest mount surface);
 *   3. bundle cost    — per-resource transferSize/decodedBodySize/duration
 *      for everything sidebar-shaped the page fetched;
 *   4. bottom-drag frames — rAF frame-interval p95/max while dragging the
 *      bottom strip (the layout-push hot path), plus the width-leak guard
 *      from the drag lane (a closed right panel must push 0).
 *
 * Results print as single-line `PERF_JSON` records (plus a `PERF_SUMMARY`
 * aggregate) so a shell run can `tee` the log and grep them out; the
 * before/after comparison lives in docs/plans/2026-08-31-perf-optimization.md.
 * Run it 3× and take the median of each metric — single-run numbers on a
 * developer machine are noise, not baselines.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { PAGE_URL, createHostApi, hostRpc } from './host'

/** This lane's own workspace (lanes run serially against one server — never
 *  share seed paths with mount/drag). */
const WORKSPACE_PATH = process.env.DSH_E2E_PERF_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-perf-workspace')

/** Built-in tab titles the sweep drives (en-US copy; follows DSH locale). */
const BUILTIN_TABS = ['Files', 'Changes', 'Tasks', 'Side Chat (beta)', 'Terminal', 'Browser']

let api: APIRequestContext

async function seedSession(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, 'seed.txt'), 'perf lane\n')
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH })
  await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
}

test.beforeAll(async () => {
  api = await createHostApi()
  await seedSession()
})

test.afterAll(async () => {
  await api?.dispose()
})

/** The longtask collector + mount-attach probe, injected before ANY page
 *  script runs (longtasks observed late are gone forever). */
const PERF_PROBE = `(() => {
  const perf = { mountAt: null, longtasks: [] }
  window.__perfProbe = perf
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) perf.longtasks.push({ start: entry.startTime, duration: entry.duration })
  }).observe({ entryTypes: ['longtask'] })
  const check = () => {
    if (document.querySelector('[data-dsh-better-sidebar]') !== null) { perf.mountAt = performance.now(); return }
    requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
})()`

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]!
}

interface ResourceStat {
  name: string
  transferSize: number
  decodedBodySize: number
  duration: number
}

/** Dismiss whatever onboarding takeover is present (same dance as the other
 *  lanes) so the pointer can reach the sidebar's controls. */
async function dismissOnboarding(page: Page): Promise<void> {
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    console.warn('[e2e-perf] no onboarding takeover appeared; proceeding')
  }
  for (let round = 0; round < 8; round++) {
    let dismissed = false
    for (const name of ['Continue', 'Configure later']) {
      const button = page.getByRole('button', { name, exact: true }).first()
      if ((await button.count()) === 0) continue
      try {
        await button.click({ timeout: 4_000 })
        dismissed = true
        await page.waitForTimeout(1_000)
      } catch {
        // Masked by a takeover stacked above; retry in the next round.
      }
    }
    if (!dismissed) break
  }
}

test('measure: mount latency, longtasks and bundle cost through a full tab sweep', async ({ page }) => {
  await page.addInitScript(PERF_PROBE)
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })

  const mountLatency = await page.evaluate(() =>
    (window as unknown as { __perfProbe: { mountAt: number | null } }).__perfProbe.mountAt)
  expect(mountLatency, 'the mount probe must have caught the attach').not.toBeNull()

  await dismissOnboarding(page)

  // Open the panel, then sweep every built-in tab through the "+" menu — the
  // same crash-sweep surface as mount.e2e.ts, reused here as the workload.
  const expandButton = sidebar.getByRole('button', { name: 'Expand sidebar' })
  await expect(expandButton).toHaveCount(1)
  await expandButton.click()
  await expect
    .poll(async () => {
      const value = await page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-sidebar-width'))
      return value !== '' && value !== '0px'
    }, { timeout: 90_000 })
    .toBe(true)

  const newTabButton = sidebar.getByRole('button', { name: 'New tab' }).first()
  for (const title of BUILTIN_TABS) {
    await newTabButton.click()
    const item = page.getByRole('menuitem', { name: title }).first()
    await expect(item, `built-in tab "${title}" must be offered by the + menu`).toHaveCount(1)
    await item.click()
    await page.waitForTimeout(1_500)
  }

  // Let the last tab settle (lazy chunks + first render) before reading.
  await page.waitForTimeout(2_000)
  const probe = await page.evaluate(() => (window as unknown as { __perfProbe: { mountAt: number | null; longtasks: Array<{ start: number; duration: number }> } }).__perfProbe)
  const resources = await page.evaluate(() =>
    performance.getEntriesByType('resource')
      .filter(entry => /sidebar/.test(entry.name))
      .map(entry => {
        const resource = entry as PerformanceResourceTiming
        return {
          name: entry.name.replace(/^https?:\/\/[^/]+/, ''),
          transferSize: resource.transferSize,
          decodedBodySize: resource.decodedBodySize,
          duration: entry.duration,
        }
      }) as ResourceStat[],
  )

  const longtasks = probe.longtasks ?? []
  const record = {
    metric: 'mount-sweep',
    mountLatencyMs: mountLatency,
    longtaskCount: longtasks.length,
    longtaskTotalMs: Math.round(longtasks.reduce((sum, task) => sum + task.duration, 0)),
    longtaskMaxMs: longtasks.reduce((max, task) => Math.max(max, task.duration), 0),
    resourceCount: resources.length,
    resourceTransferTotal: resources.reduce((sum, r) => sum + r.transferSize, 0),
    resourceDecodedTotal: resources.reduce((sum, r) => sum + r.decodedBodySize, 0),
    resources,
  }
  console.log(`PERF_JSON ${JSON.stringify(record)}`)
  console.log(
    `PERF_SUMMARY mount=${Math.round(mountLatency!)}ms longtasks=${record.longtaskCount}/${record.longtaskTotalMs}ms `
    + `resources=${record.resourceCount}/${(record.resourceTransferTotal / 1024).toFixed(0)}KiB`,
  )
})

test('measure: bottom-strip drag frame pacing', async ({ page }) => {
  await page.addInitScript(PERF_PROBE)
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)

  // The right panel stays CLOSED on purpose: the bottom drag must not push
  // the host layout in that pose (the width-leak regression the drag lane
  // locks; recorded here as a number-adjacent guard for the perf story).
  const bottomExpand = sidebar.getByRole('button', { name: 'Expand bottom panel' })
  await expect(bottomExpand).toHaveCount(1)
  await bottomExpand.click()
  await expect
    .poll(async () => {
      const value = await page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue('--dsh-sidebar-height')) || 0)
      return value
    }, { timeout: 90_000 })
    .toBeGreaterThan(0)

  // Frame-pacing sampler: rAF timestamps during the drag only.
  await page.evaluate(() => {
    const frames: number[] = []
    const pushWidths: number[] = []
    const loop = (): void => {
      frames.push(performance.now())
      const width = parseFloat(document.documentElement.style.getPropertyValue('--dsh-sidebar-width'))
      pushWidths.push(Number.isNaN(width) ? 0 : width)
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    ;(window as unknown as { __dragFrames: number[]; __dragPushWidths: number[] }).__dragFrames = frames
    ;(window as unknown as { __dragPushWidths: number[] }).__dragPushWidths = pushWidths
  })

  // The panel slides down into place on expand: read the strip only after it
  // settles at innerHeight - the pushed height (a mid-animation box makes the
  // pointerdown land off-strip and the drag never starts).
  await expect
    .poll(async () => {
      const probe = await page.evaluate(() => {
        const bottom = document.querySelector('[data-dsh-better-sidebar] [data-dsh-bottom-panel]')
        if (bottom === null) return null
        const strip = [...bottom.querySelectorAll<HTMLElement>('*')].find(el => getComputedStyle(el).cursor === 'row-resize')
        if (strip === undefined) return null
        const r = strip.getBoundingClientRect()
        const heightVar = parseFloat(document.documentElement.style.getPropertyValue('--dsh-sidebar-height')) || 0
        return Math.abs((r.y + r.height / 2) - (window.innerHeight - heightVar))
      })
      return probe === null ? Number.NaN : probe
    }, { timeout: 30_000 })
    .toBeLessThanOrEqual(8)
  const stripPoint = await page.evaluate(() => {
    const bottom = document.querySelector('[data-dsh-better-sidebar] [data-dsh-bottom-panel]')
    if (bottom === null) return null
    const strip = [...bottom.querySelectorAll<HTMLElement>('*')].find(el => getComputedStyle(el).cursor === 'row-resize')
    if (strip === undefined) return null
    const r = strip.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  expect(stripPoint, 'the bottom drag strip must be present').not.toBeNull()

  const t0 = await page.evaluate(() => performance.now())
  await page.mouse.move(stripPoint!.x, stripPoint!.y)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(stripPoint!.x, stripPoint!.y - i * 8, { steps: 2 })
    await page.waitForTimeout(40)
  }
  await page.mouse.up()
  const t1 = await page.evaluate(() => performance.now())
  await page.waitForTimeout(300)

  const { frames, widths } = await page.evaluate(() => ({
    frames: (window as unknown as { __dragFrames: number[] }).__dragFrames,
    widths: (window as unknown as { __dragPushWidths: number[] }).__dragPushWidths,
  }))
  const dragFrames = frames.filter(t => t >= t0 && t <= t1)
  const intervals: number[] = []
  for (let i = 1; i < dragFrames.length; i++) intervals.push(dragFrames[i]! - dragFrames[i - 1]!)
  const dragWidths = widths.slice(Math.max(0, frames.indexOf(dragFrames[0] ?? frames[0]!)))
  const record = {
    metric: 'bottom-drag',
    frames: dragFrames.length,
    intervalMedianMs: Math.round(percentile(intervals, 50)),
    intervalP95Ms: Math.round(percentile(intervals, 95)),
    intervalMaxMs: Math.round(Math.max(0, ...intervals)),
    pushWidthLeakMax: Math.max(0, ...dragWidths),
  }
  console.log(`PERF_JSON ${JSON.stringify(record)}`)
  console.log(
    `PERF_SUMMARY drag-frames=${record.frames} p50=${record.intervalMedianMs}ms p95=${record.intervalP95Ms}ms `
    + `max=${record.intervalMaxMs}ms widthLeak=${record.pushWidthLeakMax}px`,
  )
  expect(record.pushWidthLeakMax, 'the closed right panel must push 0 width during the bottom drag').toBe(0)
})
