/**
 * Real-browser verification of the image viewer's zoom/pan surface.
 *
 * The lane this runs in is booted by `scripts/e2e-mount.sh` against the
 * npm-packed plugin (the same install path a user takes), so this spec proves
 * the gestures on the artifact that ships — not on the source tree. It opens a
 * seeded PNG through the plugin's own explorer and drives the three gestures
 * the viewer promises: the wheel zooms around the cursor, a pointer drag pans,
 * and a double click returns to fit.
 *
 * The zoom is read off the picture's LIVE transform matrix rather than the
 * readout chip, because the matrix is what the browser actually paints: a
 * scale that never reached the DOM would still update a React state.
 *
 * This is the only lane where `offsetWidth`/`getBoundingClientRect` are real,
 * which is why the pan bound (`content box × zoom` against the content box) is
 * asserted here rather than in the jsdom spec.
 */
import { expect, test, type APIRequestContext } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { createHostApi, gotoPage, hostRpc, sendFirstMessage } from './host'

const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(process.env.TMPDIR ?? '/tmp', 'dsh-e2e-workspace')
const SEEDED_PNG = 'zz-zoom-check.png'

/** A 96x64 PNG (the pane is much larger, so FIT is a real scale-up). */
function checkerPng(): Buffer {
  const width = 96
  const height = 64
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let at = 0
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0
    at += 1
    for (let x = 0; x < width; x += 1) {
      const on = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0
      raw[at] = on ? 240 : 30
      raw[at + 1] = on ? 90 : 40
      raw[at + 2] = on ? 60 : 70
      at += 3
    }
  }
  const chunk = (tag: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(tag, 4, 'ascii')
    const body = Buffer.concat([head.subarray(4), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** CRC-32 (the PNG chunk checksum) without pulling in a dependency. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

const CHROME = '[data-sidebar-right-panel]'
const STAGE = '[data-image-stage]'
const IMG = '[data-image]'
const READOUT = '[data-image-zoom-readout]'

/** The RPC request context (carries the launch token's auth cookie). */
let api: APIRequestContext

test.beforeAll(async () => {
  api = await createHostApi()
  // Seed a real workspace + session through the same calls the UI makes: the
  // native right Sidebar only renders its guide (and with it the plugin's
  // files entry) for a live session, and the picture must be visible to the
  // explorer this test drives.
  writeFileSync(join(WORKSPACE_PATH, SEEDED_PNG), checkerPng())
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH })
  await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
})

test.afterAll(async () => {
  await api?.dispose()
})

test('the image viewer zooms around the cursor, pans by drag and resets to fit', async ({ page }) => {
  await gotoPage(page)
  await expect(page.locator('#root > *'), 'the shell must render').not.toHaveCount(0, { timeout: 90_000 })
  await expect(page.locator('[data-dsh-better-sidebar]'), 'the plugin must mount').toBeAttached({ timeout: 90_000 })

  // A keyless boot stacks onboarding takeovers over the shell (welcome
  // notice, then the provider dialog), and they mask the composer — dismiss
  // them BEFORE typing, the same order the mount smoke uses.
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch {
    console.warn('[e2e] no onboarding takeover appeared; proceeding without dismissal')
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
        // Masked by the takeover stacked above it; the next round tries the
        // other button first.
      }
    }
    if (!dismissed) break
  }

  // A live conversation is what the native sidebar renders into.
  await sendFirstMessage(page)

  await page.locator('[data-sidebar-right-expand]').first().click()

  const pane = page.locator(CHROME)
  await expect(pane.locator('[data-sidebar-right-guide]'), 'the native sidebar must show its guide').toBeVisible({ timeout: 30_000 })
  await expect(
    page.locator('[data-sidebar-right-guide-entry="files"]'),
    'the plugin must be offered as a native tab type before it can be opened',
  ).toHaveCount(1, { timeout: 30_000 })
  await page.locator('[data-sidebar-right-guide-entry="files"]').first().click()
  const row = pane.locator(`[role="button"][title$="${SEEDED_PNG}"]:visible`)
  await expect(row, `the seeded "${SEEDED_PNG}" must appear in the plugin's explorer`).toHaveCount(1, { timeout: 30_000 })
  await row.click({ position: { x: 8, y: 8 } })

  const stage = pane.locator(STAGE).first()
  await expect(stage, 'the image viewer must render its zoom stage').toBeVisible({ timeout: 30_000 })
  const img = stage.locator(IMG)
  await expect(img, 'the picture must be present inside the stage').toBeVisible()

  /** The live scale/translation the browser is painting. */
  const matrix = async (): Promise<{ scale: number; x: number; y: number }> =>
    img.evaluate((node: HTMLElement | SVGElement) => {
      const computed = getComputedStyle(node).transform
      const parts = computed.startsWith('matrix(')
        ? computed.slice('matrix('.length, -1).split(',').map(Number)
        : [1, 0, 0, 1, 0, 0]
      return { scale: parts[0] ?? 1, x: parts[4] ?? 0, y: parts[5] ?? 0 }
    })

  const atFit = await matrix()
  expect(atFit.scale, 'the viewer opens at fit, unscaled').toBeCloseTo(1, 3)
  expect(
    await img.evaluate((node: HTMLElement | SVGElement) => node instanceof HTMLImageElement && node.offsetWidth > 0 && node.offsetHeight > 0),
    'the picture has a real box',
  ).toBe(true)

  // Wheel zoom, anchored on a point off the stage's centre so the anchored
  // maths is actually exercised: the picture must grow AND move.
  const box = await stage.boundingBox()
  expect(box, 'the stage must have a box').not.toBeNull()
  const anchor = { x: box!.width * 0.25, y: box!.height * 0.25 }
  await page.mouse.move(box!.x + anchor.x, box!.y + anchor.y)
  await page.mouse.wheel(0, -240)
  await expect
    .poll(async () => (await matrix()).scale, { message: 'the wheel must zoom the picture in', timeout: 10_000 })
    .toBeGreaterThan(1.05)
  const zoomed = await matrix()
  expect(zoomed.x, 'an off-centre anchor must also translate the picture').not.toBeCloseTo(0, 2)

  // The pane must NOT scroll while the wheel zooms: the stage swallows it.
  const scrolled = await stage.evaluate((node) => node.scrollTop + node.scrollLeft)
  expect(scrolled, 'the wheel is consumed by the viewer, not by a scroller').toBe(0)

  // Drag panning: a pointer drag moves the picture further, bounded by the
  // fit box, and the cursor feedback marks the gesture.
  const before = await matrix()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await expect(stage, 'a drag in flight is marked for the grabbing cursor').toHaveAttribute('data-image-dragging', '')
  await page.mouse.move(box!.x + box!.width / 2 - 60, box!.y + box!.height / 2 - 40, { steps: 6 })
  await page.mouse.up()
  await expect(stage, 'the drag marker clears on release').not.toHaveAttribute('data-image-dragging', '')
  const dragged = await matrix()
  expect(
    Math.hypot(dragged.x - before.x, dragged.y - before.y),
    'the drag must move the picture',
  ).toBeGreaterThan(5)
  // Bounded: the picture's scaled box never leaves more slack than it has.
  const bounded = await img.evaluate((node: HTMLElement | SVGElement) => {
    if (!(node instanceof HTMLImageElement)) throw new Error('the viewer must render an <img>')
    const parts = getComputedStyle(node).transform.slice('matrix('.length, -1).split(',').map(Number)
    const scale = parts[0] ?? 1
    const stageBox = node.parentElement as HTMLElement
    const style = getComputedStyle(stageBox)
    const px = (value: string): number => Number.parseFloat(value) || 0
    const contentWidth = stageBox.offsetWidth - px(style.paddingLeft) - px(style.paddingRight)
    const contentHeight = stageBox.offsetHeight - px(style.paddingTop) - px(style.paddingBottom)
    return {
      x: parts[4] ?? 0,
      y: parts[5] ?? 0,
      limitX: Math.max(0, (contentWidth * scale - contentWidth) / 2) + 1,
      limitY: Math.max(0, (contentHeight * scale - contentHeight) / 2) + 1,
    }
  })
  expect(Math.abs(bounded.x), 'panning stays inside the picture’s own overflow (x)').toBeLessThanOrEqual(bounded.limitX)
  expect(Math.abs(bounded.y), 'panning stays inside the picture’s own overflow (y)').toBeLessThanOrEqual(bounded.limitY)

  // Double click toggles fit ↔ 2×.
  await stage.dblclick({ position: { x: box!.width / 2, y: box!.height / 2 } })
  await expect
    .poll(async () => (await matrix()).scale, { message: 'a double click on a zoomed picture returns to fit' })
    .toBeCloseTo(1, 2)
  // The readout chip lives in the viewer's toolbar, next to (not inside) the stage.
  expect(await pane.locator(READOUT).textContent()).toBe('100%')
})
