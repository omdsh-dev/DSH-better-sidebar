/**
 * Drag-layout lane: the width drag must track the app shell 1:1 — the
 * regression test for issue #92 ("主会话框左右抖动").
 *
 * The layout push squeezes `#root` via `margin-right: var(--dsh-sidebar-width)`
 * (layout.css), and layout.css disables that margin's transition while a drag
 * is live via `body[data-dsh-sidebar-dragging]`. If the transition stays
 * active during the drag (or the conversation lags the panel edge), the
 * conversation visibly shakes at pointer cadence. This spec drives a real
 * pointer drag on the width strip while a requestAnimationFrame sampler
 * records, per frame:
 *
 *   - the strip's x (the panel edge),
 *   - the conversation column's right edge (`#root`'s margin push lands
 *     exactly there),
 *   - whether `body[data-dsh-sidebar-dragging]` is set,
 *   - `#root`'s computed transition property/duration.
 *
 * Then it asserts the drag contract:
 *   1. the dragging attribute is present during the drag;
 *   2. `#root`'s transition is disabled (none) during the drag;
 *   3. the conversation edge follows the panel edge monotonically (no
 *      oscillation) and 1:1 (total travel within a rounding epsilon).
 *
 * The server is booted by scripts/e2e-mount.sh; this spec only loads the
 * page (same contract as mount.e2e.ts, using its own workspace so the two
 * lanes never race on seeding).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, request, type APIRequestContext } from '@playwright/test'

const BASE_URL = process.env.DSH_E2E_URL
if (!BASE_URL) {
  throw new Error('DSH_E2E_URL is not set — boot a DSH web instance with the plugin mounted and point this lane at it (see scripts/e2e-mount.sh)')
}

/** This lane's own workspace (distinct from mount.e2e.ts's, lanes run serially
 *  but against the same server — never share seed paths). */
const WORKSPACE_PATH = process.env.DSH_E2E_DRAG_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-drag-workspace')

let api: APIRequestContext

/** Seed one workspace + one session through the host's unary RPC surface. */
async function seedSession(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, 'seed.txt'), 'drag lane\n')
  const workspace = await api.post(`${BASE_URL}/api/workspace.create`, {
    data: { type: 'client-request', rpcId: 'e2e-drag-workspace', method: 'workspace.create', payload: { path: WORKSPACE_PATH } },
  })
  expect(workspace.ok(), `workspace.create: ${workspace.status()} ${await workspace.text()}`).toBe(true)
  const workspaceBody = (await workspace.json()) as {
    result: { ok: true; value: { workspace: { workspaceId: string } } } | { ok: false; error: unknown }
  }
  expect(workspaceBody.result.ok).toBe(true)
  const workspaceId = (workspaceBody.result as { value: { workspace: { workspaceId: string } } }).value.workspace.workspaceId

  const session = await api.post(`${BASE_URL}/api/session.create`, {
    data: { type: 'client-request', rpcId: 'e2e-drag-session', method: 'session.create', payload: { workspaceId } },
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
  stripX: number
  convoRight: number
  dragging: boolean
  transitionProperty: string
  transitionDuration: string
}

test('width drag tracks the shell 1:1 with transitions disabled (issue #92)', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })

  // Dismiss whatever onboarding takeover is present (same dance as the mount
  // lane), so the pointer can reach the strip without a masking overlay.
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    console.warn('[e2e-drag] no onboarding takeover appeared; proceeding')
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

  // openByDefault defaults OFF: a fresh session's panel starts collapsed, and
  // the collapsed layout push still writes `--dsh-sidebar-width: 0px` — so the
  // geometry checks below are meaningless until the panel is expanded through
  // the toggle cluster.
  const expandButton = sidebar.getByRole('button', { name: 'Expand sidebar' })
  await expect(expandButton, 'the collapsed toggle cluster must offer the expand button').toHaveCount(1)
  await expandButton.click()

  // The layout push variable becomes live (non-zero) once the panel opens
  // (session activation lags the shell render).
  await expect
    .poll(async () => {
      const value = await page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-sidebar-width'))
      return value !== '' && value !== '0px'
    }, { timeout: 90_000 })
    .toBe(true)

  // The width drag strip is the panel's left-edge hit strip. There is no
  // dedicated hook (the skinning contract is token-driven), so locate it
  // semantically among the sidebar's `cursor: col-resize` elements — the files
  // window's tree-dock handle matches too, but the panel strip is always the
  // LEFTMOST one (the dock sits at the panel's right edge).
  const locateStrip = `(() => {
    const host = document.querySelector('[data-dsh-better-sidebar]')
    if (host === null) return null
    const boxes = [...host.querySelectorAll('*')]
      .filter(el => getComputedStyle(el).cursor === 'col-resize')
      .map(el => el.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0)
      .sort((a, b) => a.x - b.x)
    const r = boxes[0]
    if (r === undefined) return null
    const varWidth = parseFloat(document.documentElement.style.getPropertyValue('--dsh-sidebar-width'))
    return {
      x: r.x, y: r.y, width: r.width, height: r.height,
      varWidth: Number.isNaN(varWidth) ? 0 : varWidth,
      innerWidth: window.innerWidth,
    }
  })()`
  type StripBox = { x: number; y: number; width: number; height: number; varWidth: number; innerWidth: number }
  // The panel SLIDES IN from the right on expand: locating the strip before
  // the open transition settles captures a mid-animation box at the viewport
  // edge, and the drag lands off-panel. Wait until the strip sits at the
  // pushed layout edge (its right edge ≈ innerWidth - the push variable).
  await expect
    .poll(async () => {
      const box = await page.evaluate<StripBox | null>(locateStrip)
      if (box === null) return false
      return Math.abs((box.x + box.width) - (box.innerWidth - box.varWidth)) <= 8
    }, { timeout: 30_000 })
    .toBe(true)
  const stripBox = await page.evaluate<StripBox | null>(locateStrip)
  expect(stripBox, 'the width drag strip must be present (cursor: col-resize)').not.toBeNull()

  // Instrument a per-frame sampler BEFORE the drag begins.
  await page.evaluate(() => {
    type Sample = FrameSample
    const samples: Sample[] = []
    // Same rule as the strip locator above: the LEFTMOST col-resize element
    // inside the sidebar host (the tree-dock handle is further right).
    const host = document.querySelector('[data-dsh-better-sidebar]')
    const strip = host === null
      ? null
      : [...host.querySelectorAll<HTMLElement>('*')]
        .filter(el => getComputedStyle(el).cursor === 'col-resize')
        .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)[0]
    // The conversation column: the grid item the layout push squeezes (the
    // same nth-child(2) layout.css targets for the vertical push; its right
    // edge is where the width push lands).
    const center = document.querySelector('#root > div[data-slot="root"] > div > div:nth-child(2)')
    const root = document.querySelector('#root') as HTMLElement
    const loop = (): void => {
      const s = strip?.getBoundingClientRect() ?? { left: 0 }
      const c = center?.getBoundingClientRect() ?? { left: 0, right: 0 }
      const cs = getComputedStyle(root)
      samples.push({
        t: performance.now(),
        stripX: s.left,
        convoRight: c.right,
        dragging: document.body.hasAttribute('data-dsh-sidebar-dragging'),
        transitionProperty: cs.transitionProperty,
        transitionDuration: cs.transitionDuration,
      })
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    ;(window as unknown as { __dragSamples: Sample[] }).__dragSamples = samples
  })

  const startX = stripBox!.x + stripBox!.width / 2
  const startY = stripBox!.y + Math.min(120, stripBox!.height / 2 + 60)

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  // Drag LEFT in steps (widens the panel): the conversation edge must move
  // LEFT in lockstep with the panel edge, monotonically, no oscillation.
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(startX - i * 10, startY, { steps: 2 })
    await page.waitForTimeout(40)
  }
  await page.mouse.up()
  await page.waitForTimeout(400)

  const samples = await page.evaluate(
    () => (window as unknown as { __dragSamples: FrameSample[] }).__dragSamples,
  )
  expect(samples.length, 'the frame sampler must have collected frames').toBeGreaterThan(20)

  // The drag must actually have moved the panel (sanity: the store committed).
  const first = samples.find(s => s.dragging)
  const last = [...samples].reverse().find(s => s.dragging)
  expect(first, 'the dragging attribute must appear during the drag').toBeDefined()
  expect(last!.stripX, 'the panel edge must have moved during the drag').toBeLessThan(first!.stripX - 40)
  // The conversation-column selector must have matched (the push lands on it).
  expect(last!.convoRight, 'the conversation edge must have moved with the drag').toBeLessThan(first!.convoRight - 40)

  // Contract 1 + 2: while dragging, the body attribute is set and #root's
  // margin transition is disabled (computed `transition: none` reads as
  // transition-property "none" with 0s duration; the non-dragging rule would
  // compute to "margin-right" with the theme duration).
  const draggingSamples = samples.filter(s => s.dragging)
  expect(draggingSamples.length).toBeGreaterThan(5)
  for (const sample of draggingSamples) {
    expect(sample.transitionProperty, 'the margin transition must be off while dragging').toBe('none')
    expect(sample.transitionDuration, 'the margin transition must be off while dragging').toBe('0s')
  }

  // Contract 3: monotonic, 1:1 tracking. During a leftward drag both the
  // strip x and the conversation right edge decrease; allow one frame of
  // rAF-batching staleness (0 delta), never a reversal.
  const tracked = draggingSamples.filter(s => s.t > first!.t)
  for (let i = 1; i < tracked.length; i++) {
    const stripDelta = tracked[i]!.stripX - tracked[i - 1]!.stripX
    const convoDelta = tracked[i]!.convoRight - tracked[i - 1]!.convoRight
    expect(stripDelta, 'the strip must move left during the drag').toBeLessThanOrEqual(2)
    expect(
      convoDelta,
      `conversation edge reversed while dragging (jitter): strip ${stripDelta}px, conversation ${convoDelta}px`,
    ).toBeLessThanOrEqual(2)
  }
  // Total travel in lockstep (rounding + one-frame staleness tolerance).
  const stripTravel = first!.stripX - last!.stripX
  const convoTravel = first!.convoRight - last!.convoRight
  expect(Math.abs(convoTravel - stripTravel), 'conversation must track the panel edge 1:1').toBeLessThanOrEqual(8)
})
