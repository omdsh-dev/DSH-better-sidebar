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
import { test, expect, request, type APIRequestContext, type Locator, type Page } from '@playwright/test'

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

test('a very fast width drag still commits the dragged position (no rollback on quick release)', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })

  // Dismiss whatever onboarding takeover is present (same dance as the
  // main lane) so the pointer can reach the strip.
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    console.warn('[e2e-drag-fast] no onboarding takeover appeared; proceeding')
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

  const expandButton = sidebar.getByRole('button', { name: 'Expand sidebar' })
  await expect(expandButton, 'the collapsed toggle cluster must offer the expand button').toHaveCount(1)
  await expandButton.click()
  await expect
    .poll(async () => {
      const value = await page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-sidebar-width'))
      return value !== '' && value !== '0px'
    }, { timeout: 90_000 })
    .toBe(true)

  const readWidth = (): Promise<number> => page.evaluate(() => {
    const value = parseFloat(document.documentElement.style.getPropertyValue('--dsh-sidebar-width'))
    return Number.isNaN(value) ? 0 : value
  })
  const widthBefore = await readWidth()

  // The panel slides in from the right on expand: read the strip box only
  // AFTER it settles at the pushed layout edge (a mid-animation read sits
  // off-viewport and the drag never reaches the strip).
  await expect
    .poll(async () => {
      const box = await page.evaluate(() => {
        const host = document.querySelector('[data-dsh-better-sidebar]')
        const el = [...host!.querySelectorAll('*')]
          .filter(e => getComputedStyle(e).cursor === 'col-resize')
          .map(e => e.getBoundingClientRect())
          .filter(r => r.width > 0 && r.height > 0)
          .sort((a, b) => a.x - b.x)[0]
        return el === undefined ? null : { x: el.x + el.width, innerWidth: window.innerWidth }
      })
      if (box === null) return false
      const varWidth = await page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue('--dsh-sidebar-width')) || 0)
      return Math.abs(box.x - (box.innerWidth - varWidth)) <= 8
    }, { timeout: 30_000 })
    .toBe(true)
  const stripBox = await page.evaluate(() => {
    const host = document.querySelector('[data-dsh-better-sidebar]')
    if (host === null) return null
    const boxes = [...host.querySelectorAll('*')]
      .filter(el => getComputedStyle(el).cursor === 'col-resize')
      .map(el => el.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0)
      .sort((a, b) => a.x - b.x)
    const r = boxes[0]
    if (r === undefined) return null
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  expect(stripBox, 'the width drag strip must be present').not.toBeNull()

  const startX = stripBox!.x + stripBox!.width / 2
  const startY = stripBox!.y + Math.min(120, stripBox!.height / 2 + 60)

  // FAST release: a single move and an immediate up — no per-frame waits,
  // so the last pointermove may never reach a requestAnimationFrame before
  // the release (the exact quick-flick that used to roll back to the
  // pre-drag width).
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX - 140, startY, { steps: 1 })
  await page.mouse.up()

  // The committed width must reflect the drag — and stay there (no rollback
  // once React settles).
  await expect
    .poll(async () => await readWidth(), { timeout: 10_000 })
    .toBeGreaterThan(widthBefore + 100)
  await page.waitForTimeout(600)
  expect(await readWidth(), 'the fast drag must not roll back after settling').toBeGreaterThan(widthBefore + 100)
})

/* ── issue #247: interrupted fast drags must not roll back ───────────── */

/** Dismiss whatever onboarding takeover is present (same dance as above). */
async function dismissOnboarding(page: Page): Promise<void> {
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
}

/** Open the sidebar panel and wait for the layout push to go live. */
async function expandSidebar(page: Page, sidebar: Locator): Promise<void> {
  const expandButton = sidebar.getByRole('button', { name: 'Expand sidebar' })
  await expect(expandButton, 'the collapsed toggle cluster must offer the expand button').toHaveCount(1)
  await expandButton.click()
  await expect
    .poll(async () => {
      const value = await page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-sidebar-width'))
      return value !== '' && value !== '0px'
    }, { timeout: 90_000 })
    .toBe(true)
}

/** Locate the width drag strip (the leftmost col-resize element inside the
 *  sidebar host), wait for it to settle at the pushed layout edge (the
 *  panel slides in from the right on expand — a strip read during the
 *  animation sits off-viewport and no pointer event ever reaches it), then
 *  read its FINAL box and return a drag start point on it. */
async function settleWidthStrip(page: Page): Promise<{ startX: number; startY: number }> {
  await expect
    .poll(async () => {
      const box = await page.evaluate(() => {
        const host = document.querySelector('[data-dsh-better-sidebar]')
        const el = [...host!.querySelectorAll('*')]
          .filter(e => getComputedStyle(e).cursor === 'col-resize')
          .map(e => e.getBoundingClientRect())
          .filter(r => r.width > 0 && r.height > 0)
          .sort((a, b) => a.x - b.x)[0]
        return el === undefined ? null : { x: el.x + el.width, innerWidth: window.innerWidth }
      })
      if (box === null) return false
      const varWidth = await page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue('--dsh-sidebar-width')) || 0)
      return Math.abs(box.x - (box.innerWidth - varWidth)) <= 8
    }, { timeout: 30_000 })
    .toBe(true)
  const stripBox = await page.evaluate(() => {
    const host = document.querySelector('[data-dsh-better-sidebar]')
    if (host === null) return null
    const boxes = [...host.querySelectorAll('*')]
      .filter(el => getComputedStyle(el).cursor === 'col-resize')
      .map(el => el.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0)
      .sort((a, b) => a.x - b.x)
    const r = boxes[0]
    if (r === undefined) return null
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  expect(stripBox, 'the width drag strip must be present').not.toBeNull()
  return {
    startX: stripBox!.x + stripBox!.width / 2,
    startY: stripBox!.y + Math.min(120, stripBox!.height / 2 + 60),
  }
}

/** Dispatch a synthetic pointer event (pointercancel / lostpointercapture)
 *  onto the width strip. Synthetic events bypass the real pointer-capture
 *  pipeline, which is exactly the point: the handlers must survive streams
 *  that end without a component-visible pointerup. */
async function dispatchPointerOnStrip(
  page: Page,
  type: 'pointercancel' | 'lostpointercapture',
  init: { clientX?: number; clientY?: number },
): Promise<void> {
  await page.evaluate(({ type, init }) => {
    const host = document.querySelector('[data-dsh-better-sidebar]')
    if (host === null) throw new Error('sidebar host missing')
    const el = [...host.querySelectorAll<HTMLElement>('*')]
      .filter(el => getComputedStyle(el).cursor === 'col-resize')
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .sort((a, b) => a.r.x - b.r.x)[0]?.el
    if (el === undefined) throw new Error('width drag strip not found')
    el.dispatchEvent(new PointerEvent(type, {
      pointerId: 1,
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      isPrimary: true,
      ...init,
    }))
  }, { type, init })
}

test('an interrupted fast drag (pointercancel → lostpointercapture) keeps the dragged width (issue #247)', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)
  await expandSidebar(page, sidebar)
  const readWidth = (): Promise<number> => page.evaluate(() => {
    const value = parseFloat(document.documentElement.style.getPropertyValue('--dsh-sidebar-width'))
    return Number.isNaN(value) ? 0 : value
  })
  const widthBefore = await readWidth()
  const { startX, startY } = await settleWidthStrip(page)

  // Ultra-fast flick whose stream the browser then CANCELS (touchpad /
  // gesture interception): pointercancel carries the final position and
  // lostpointercapture follows it. The double fire must commit ONCE — the
  // second interrupt event used to roll the drag back to the pre-drag
  // width (the abort path never marked the drag committed).
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX - 140, startY, { steps: 1 })
  await dispatchPointerOnStrip(page, 'pointercancel', { clientX: startX - 140, clientY: startY })
  await dispatchPointerOnStrip(page, 'lostpointercapture', {})

  await expect
    .poll(async () => await readWidth(), { timeout: 10_000 })
    .toBeGreaterThan(widthBefore + 100)
  await page.waitForTimeout(600)
  expect(await readWidth(), 'the interrupted fast drag must not roll back after settling').toBeGreaterThan(widthBefore + 100)

  // Release the real pointer stream the synthetic events bypassed.
  await page.mouse.up()
})

test('a capture-lost drag with no usable coordinates keeps the last applied width (issue #247)', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)
  await expandSidebar(page, sidebar)
  const readWidth = (): Promise<number> => page.evaluate(() => {
    const value = parseFloat(document.documentElement.style.getPropertyValue('--dsh-sidebar-width'))
    return Number.isNaN(value) ? 0 : value
  })
  const widthBefore = await readWidth()
  const { startX, startY } = await settleWidthStrip(page)

  // A flick whose move DID reach the DOM (the rAF flushed it), followed by
  // capture loss with NO coordinates (lostpointercapture does not carry a
  // position). The abort must adopt the last applied size — the old code
  // explicitly reverted the DOM to the pre-drag width here.
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX - 120, startY, { steps: 1 })
  await page.waitForTimeout(100) // let the rAF consume the pending write
  await dispatchPointerOnStrip(page, 'lostpointercapture', {})

  await expect
    .poll(async () => await readWidth(), { timeout: 10_000 })
    .toBeGreaterThan(widthBefore + 80)
  await page.waitForTimeout(600)
  expect(await readWidth(), 'the no-coordinate capture loss must not roll back after settling').toBeGreaterThan(widthBefore + 80)
  await page.mouse.up()
})

/* ── issue #248: HMR center-column replacement must be re-located ────── */

test('bottom panel re-locates a center column replaced deep inside #root (issue #248)', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)
  await expandSidebar(page, sidebar)

  // Open the bottom panel; it must become visible with the center column
  // measured (its right edge tracking the column's right edge).
  const bottomExpand = sidebar.getByRole('button', { name: 'Expand bottom panel' })
  await expect(bottomExpand, 'the toggle cluster must offer the bottom-panel expand button').toHaveCount(1)
  await bottomExpand.click()
  await expect
    .poll(async () => {
      const value = await page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-sidebar-height'))
      return value !== '' && value !== '0px'
    }, { timeout: 90_000 })
    .toBe(true)

  const probe = (): Promise<{ visible: boolean; drift: number } | null> => page.evaluate(() => {
    const el = document.querySelector('[data-dsh-better-sidebar] [data-dsh-bottom-panel]')
    const col = document.querySelector('#root [data-slot="conversation"]')?.parentElement
    if (el === null || col == null) return null
    const panel = el.getBoundingClientRect()
    const center = col.getBoundingClientRect()
    return {
      visible: getComputedStyle(el).visibility !== 'hidden',
      drift: Math.abs(panel.right - center.right),
    }
  })
  await expect
    .poll(async () => {
      const p = await probe()
      return p !== null && p.visible && p.drift <= 8
    }, { timeout: 30_000 })
    .toBe(true)

  // Simulate the HMR re-render: the shell swaps the center column node
  // DEEP inside #root (a mutation the old childList-only watcher never
  // saw — #root's own children don't change), first with a zero-size stub
  // (mid-teardown), then with a re-created column of different geometry.
  await page.evaluate(() => {
    const col = document.querySelector('#root [data-slot="conversation"]')?.parentElement
    if (col == null || col.parentElement === null) throw new Error('center column not found')
    const stub = document.createElement('div')
    const slot = document.createElement('div')
    slot.setAttribute('data-slot', 'conversation')
    stub.appendChild(slot)
    col.parentElement.replaceChild(stub, col)
  })
  await page.evaluate(() => {
    const col = document.querySelector('#root [data-slot="conversation"]')?.parentElement
    if (col == null || col.parentElement === null) throw new Error('center column stub not found')
    const fresh = document.createElement('div')
    fresh.style.width = '300px'
    fresh.style.height = '200px'
    const slot = document.createElement('div')
    slot.setAttribute('data-slot', 'conversation')
    fresh.appendChild(slot)
    col.parentElement.replaceChild(fresh, col)
  })

  // The locate chain (subtree watcher / html-style watcher / 1.5s retry)
  // must converge on the new column within a couple of seconds; the old
  // code kept observing the detached column and never recovered.
  await expect
    .poll(async () => {
      const p = await probe()
      return p !== null && p.visible && p.drift <= 8
    }, { timeout: 15_000 })
    .toBe(true)
})

/* ── issue #258: the bottom panel must not flash full-width after a width
      drag release ─────────────────────────────────────────────────────── */

test('bottom panel never flashes full-width after a width drag release (issue #258)', async ({ page }) => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)
  await expandSidebar(page, sidebar)

  // The bottom panel must be OPEN too — its right edge is what tracks the
  // center column (and what flashes full-width on release).
  const bottomExpand = sidebar.getByRole('button', { name: 'Expand bottom panel' })
  await expect(bottomExpand, 'the toggle cluster must offer the bottom-panel expand button').toHaveCount(1)
  await bottomExpand.click()
  await expect
    .poll(async () => {
      const value = await page.evaluate(() => document.documentElement.style.getPropertyValue('--dsh-sidebar-height'))
      return value !== '' && value !== '0px'
    }, { timeout: 90_000 })
    .toBe(true)

  const { startX, startY } = await settleWidthStrip(page)

  // Per-frame sampler: the bottom panel's right edge vs the center column's
  // right edge (where the layout push lands). The release path used to
  // TRANSIENTLY REMOVE the push variables between the layout effect's
  // cleanup and setup phases — React can yield a render frame in that gap,
  // so the browser painted the push-less layout (center column full width),
  // the drag-end measure cached that full-width rect, and the bottom panel
  // rendered full-width while #root's margin transition animated back to
  // the new width. Every post-release frame must keep the two edges glued
  // at the committed width: no full-width frame, no drift, no margin
  // animation.
  await page.evaluate(() => {
    const samples: Array<{ t: number; bottomRight: number; colRight: number; varW: string; dragging: boolean; iw: number }> = []
    const loop = (): void => {
      const bottom = document.querySelector('[data-dsh-better-sidebar] [data-dsh-bottom-panel]')
      const col = document.querySelector('#root [data-slot="conversation"]')?.parentElement
      samples.push({
        t: performance.now(),
        bottomRight: bottom?.getBoundingClientRect().right ?? -1,
        colRight: col?.getBoundingClientRect().right ?? -1,
        varW: document.documentElement.style.getPropertyValue('--dsh-sidebar-width'),
        dragging: document.body.hasAttribute('data-dsh-sidebar-dragging'),
        iw: window.innerWidth,
      })
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    ;(window as unknown as { __flashSamples: typeof samples }).__flashSamples = samples
  })

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(startX - i * 12, startY, { steps: 2 })
    await page.waitForTimeout(30)
  }
  await page.mouse.up()
  await page.waitForTimeout(500)

  const samples = await page.evaluate(
    () => (window as unknown as { __flashSamples: Array<{ t: number; bottomRight: number; colRight: number; varW: string; dragging: boolean; iw: number }> }).__flashSamples,
  )
  expect(samples.length, 'the frame sampler must have collected frames').toBeGreaterThan(20)
  const lastDrag = [...samples].reverse().find(s => s.dragging)
  expect(lastDrag, 'the dragging attribute must appear during the drag').toBeDefined()
  const releaseIdx = samples.indexOf(lastDrag!) + 1
  const release = samples[releaseIdx]!
  expect(release.colRight, 'the center column must be measurable after release').toBeGreaterThan(0)
  expect(release.bottomRight, 'the bottom panel must be measurable after release').toBeGreaterThan(0)
  const settled = samples[samples.length - 1]!
  for (const s of samples.slice(releaseIdx)) {
    expect(
      Math.abs(s.bottomRight - s.colRight),
      `bottom panel drifted from the center column at t=${Math.round(s.t)} (bottom ${s.bottomRight} vs column ${s.colRight})`,
    ).toBeLessThanOrEqual(8)
    const fullWidth = s.bottomRight >= s.iw - 1
    expect(
      fullWidth && s.varW !== '' && s.varW !== '0px',
      `bottom panel flashed full-width at t=${Math.round(s.t)} (right ${s.bottomRight}, push ${s.varW})`,
    ).toBe(false)
    expect(
      Math.abs(s.colRight - settled.colRight),
      `center column edge animated after release at t=${Math.round(s.t)} (${s.colRight} vs settled ${settled.colRight})`,
    ).toBeLessThanOrEqual(8)
  }
})

test('the bottom-push anchor resolves through the composite selectors (at least one; same element when both)', async ({ page }) => {
  // layout.css pushes the bottom panel via the center column. The selector
  // is COMPOSITE on purpose: `[data-pane="conversation"]` (0.1.x naming)
  // and `:has(> [data-slot="conversation"])` (rc.8-era naming) — HOST
  // VERSIONS MAY RENAME THE ATTRIBUTE (issue #208 comment / PR #226), so
  // the contract is "at least one resolves", and when both resolve they
  // must hit the SAME element (otherwise the push would land twice).
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  const anchors = await page.evaluate(() => {
    const a = document.querySelector('#root [data-dsh-frame] > [data-pane="conversation"]')
    const b = document.querySelector('#root :has(> [data-slot="conversation"])')
    const frame = document.querySelector('#root [data-dsh-frame]')
    return {
      a: a !== null,
      b: b !== null,
      same: a !== null && b !== null && a === b,
      frameChildren: frame !== null
        ? [...frame.children].map(el => `${el.tagName}[${[...el.attributes].map(attr => attr.name).filter(name => name.startsWith('data-')).join(',')}]`)
        : [],
    }
  })
  expect(
    anchors.a || anchors.b,
    `at least one bottom-push anchor must resolve on this host (frame children: ${anchors.frameChildren.join(' / ') || 'no [data-dsh-frame]'})`,
  ).toBe(true)
  if (anchors.a && anchors.b) {
    expect(anchors.same, 'both selectors must hit the SAME center-column element').toBe(true)
  }
})
