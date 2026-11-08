/** Real layout regression for #1102. Exercises the mount geometry check and
 * its actual CSS without a DSH server; full mount smoke remains a separate gate.
 * Source extraction keeps this probe on the production implementation rather
 * than copying a second implementation that could drift away from it.
 */
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, test } from '@playwright/test'

const source = readFileSync('src/client/index.tsx', 'utf8')
const start = source.indexOf('const scheduleHostCheck =')
const end = source.indexOf('const mount =', start)
if (start < 0 || end < 0) throw new Error('Mount geometry check not found')
const check = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })
const sheet = readFileSync('src/client/sidebar.module.css', 'utf8')
const rules = [
  ':global([data-dsh-panel-host]) {',
  ':global([data-dsh-panel-host][data-dsh-panel-host-degraded]) {',
].map(selector => {
  const start = sheet.indexOf(selector)
  if (start < 0) throw new Error(`Missing host rule: ${selector}`)
  return sheet.slice(start, sheet.indexOf('}', start) + 1)
    .replace(':global(', '').replace(') {', ' {')
}).join('\n')

const settle = async (page: import('@playwright/test').Page) => {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  }))
}
const mount = async (page: import('@playwright/test').Page, styles: string) => {
  await page.setViewportSize({ width: 1291, height: 811 })
  await page.setContent(`<!DOCTYPE html><style>
    html,body { margin:0; overflow:hidden } ${styles}
    ${rules}</style><div id="root"><div data-dsh-panel-host></div></div>
    <script>let host = document.querySelector('#root'); let hostCheckFrame = null;
    ${check}; scheduleHostCheck();</script>`)
  await settle(page)
}

for (const [name, styles] of [
  ['unzoomed control', ''],
  ['body zoom 115%', 'body { zoom:1.15 }'],
  ['body zoom 85%', 'body { zoom:0.85 }'],
  ['html zoom 115%', 'html { zoom:1.15 }'],
  ['nested zoom', 'body { zoom:1.15 } #root { zoom:1.2 }'],
] as const) {
  test(`${name}: CSS zoom stays fixed and cannot scroll the document (#1102)`, async ({ page }) => {
    await mount(page, styles)
    const result = await page.evaluate(() => {
      document.scrollingElement!.scrollTop = 90
      const layer = document.querySelector<HTMLElement>('[data-dsh-panel-host]')!
      return {
        degraded: layer.hasAttribute('data-dsh-panel-host-degraded'),
        position: getComputedStyle(layer).position,
        overflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        scrollTop: document.scrollingElement!.scrollTop,
      }
    })
    expect(result).toEqual({ degraded: false, position: 'fixed', overflow: 0, scrollTop: 0 })
  })
}

test('real ancestor translation is compensated until the transform is removed', async ({ page }) => {
  await mount(page, 'body { transform:translate(25px, 35px) }')
  const layer = page.locator('[data-dsh-panel-host]')
  await expect(layer).toHaveAttribute('data-dsh-panel-host-degraded', '')
  for (let i = 0; i < 3; i++) {
    await settle(page)
    const rect = await layer.evaluate(node => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y }))
    expect(Math.abs(rect.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(rect.y)).toBeLessThanOrEqual(1)
    await expect(layer).toHaveAttribute('data-dsh-panel-host-degraded', '')
  }
  await page.evaluate(() => { document.body.style.transform = 'none' })
  await settle(page)
  await expect(layer).not.toHaveAttribute('data-dsh-panel-host-degraded', '')
  await expect(layer).toHaveCSS('position', 'fixed')
})
