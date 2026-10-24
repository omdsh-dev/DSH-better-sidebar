import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { createHostApi, dismissOnboarding, gotoPage, hostRpc, sendFirstMessage } from './host'

/**
 * A SELECTED change row must stay an in-flow 28px band inside its own
 * `[data-group]` (the "staging area misaligned" report).
 *
 * The regression: a dangling selector list in `changes.module.css` (the
 * selected-row / `::before` selectors left without a declaration block, a
 * comment sitting between the trailing comma and `.guide`) joined the three
 * selected selectors onto the indent-guide rule. Every `[data-selected]` row
 * therefore inherited `position: absolute; top: 0; bottom: 0; width: 0;
 * border-left: 1px solid var(--dsw-alias-border-l1)` — it left its group,
 * stretched over the panel (28px → the panel's full height), collapsed to zero
 * width and painted the guide's pale hairline.
 *
 * jsdom cannot observe any of that (no layout engine — `tests/changes-tab.spec.tsx`
 * pins the sheet's dock/scroll rules as text instead), so this lane asserts the
 * RENDERED geometry of the selected row: computed `position`, width, the 28px
 * band height, its box inside its `[data-group]` and inside the changes
 * section, no borrowed `border-left`, and no overlap with the docked footer or
 * the preview pane. Waits are locator/poll based — no fixed sleeps.
 */

/** The fixture's porcelain states: a conflicted path, a path staged AND then
 *  edited (one row in each band), and an untracked file. */
function buildFixture(): { root: string; status: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'sidebar-git-layout-'))
  const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Layout fixture')
  git('config', 'user.email', 'layout@example.invalid')
  mkdirSync(join(root, 'src/app'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'src/app/main.ts'), 'export const main = 1\n')
  writeFileSync(join(root, 'src/app/util.ts'), 'export const util = 1\n')
  writeFileSync(join(root, 'docs/readme.md'), '# readme\n')
  git('add', '.')
  git('commit', '-m', 'base')
  // The conflict that produces the Merge band.
  git('checkout', '-b', 'side')
  writeFileSync(join(root, 'src/app/main.ts'), 'export const main = 99\n')
  git('add', '.')
  git('commit', '-m', 'side change')
  git('checkout', 'main')
  writeFileSync(join(root, 'src/app/main.ts'), 'export const main = 100\n')
  git('add', '.')
  git('commit', '-m', 'main change')
  try { git('merge', '--no-ff', 'side', '-m', 'merge') } catch { /* the conflict is the point */ }
  // util.ts is STAGED and then edited again: 'MM' ⇒ one row in the Staged band
  // and one in the Changes band, which is what makes the band distinction
  // observable at all.
  writeFileSync(join(root, 'src/app/util.ts'), 'export const util = 2\nexport const more = 3\n')
  git('add', 'src/app/util.ts')
  writeFileSync(join(root, 'src/app/util.ts'), 'export const util = 5\n')
  writeFileSync(join(root, 'docs/notes.md'), 'notes\n')
  return { root, status: git('status', '--porcelain').split('\n') }
}

/** The one selection the probe expects, or null before anything is clicked. */
interface SelectedRow { group: string; path: string }

/**
 * Geometry verdict for EVERY change row, plus the selected row's own computed
 * style. Returns human reasons (empty = pass), so a failing `expect.poll` names
 * the row and the measurement instead of a bare timeout.
 */
function rowGeometryProblems(page: Page, expected: SelectedRow | null): Promise<string[]> {
  return page.evaluate((target) => {
    const problems: string[] = []
    const view = document.defaultView
    if (view === null) return ['no browsing context']
    const changes = document.querySelector('[data-scm-section="changes"]')
    if (changes === null) return ['no [data-scm-section="changes"]']
    const changesBox = changes.getBoundingClientRect()
    const footer = document.querySelector('[data-git-footer]')?.getBoundingClientRect() ?? null
    const pane = document.querySelector('[class*="diffPane"]')?.getBoundingClientRect() ?? null
    const rows = [...document.querySelectorAll<HTMLElement>('[data-scm-section="changes"] [data-row]')]
    if (rows.length === 0) problems.push('no change rows rendered')
    for (const row of rows) {
      const group = row.closest('[data-group]')
      const name = row.getAttribute('data-row') ?? '?'
      const band = group?.getAttribute('data-group') ?? null
      const label = `${band ?? 'no-group'}/${name}`
      if (group === null) { problems.push(`${label}: not inside a [data-group]`); continue }
      const box = row.getBoundingClientRect()
      const style = view.getComputedStyle(row)
      // The regression's signature: the row borrowed the `.guide` box rule.
      if (style.position !== 'relative') problems.push(`${label}: computed position is ${style.position}, expected relative`)
      if (style.width === '0px' || Math.round(box.width) < 100) problems.push(`${label}: width ${style.width} (${String(Math.round(box.width))}px)`)
      if (style.borderLeftWidth !== '0px') problems.push(`${label}: borrowed border-left ${style.borderLeftWidth} ${style.borderLeftStyle} ${style.borderLeftColor}`)
      if (Math.abs(box.height - 28) > 1) problems.push(`${label}: height ${String(Math.round(box.height))}, expected the 28px band`)
      const groupBox = group.getBoundingClientRect()
      if (box.top < groupBox.top - 1 || box.bottom > groupBox.bottom + 1) {
        problems.push(`${label}: box ${String(Math.round(box.top))}..${String(Math.round(box.bottom))} escapes its group ${String(Math.round(groupBox.top))}..${String(Math.round(groupBox.bottom))}`)
      }
      if (box.top < changesBox.top - 1 || box.bottom > changesBox.bottom + 1) problems.push(`${label}: box escapes the changes section`)
      if (footer !== null && box.bottom > footer.top + 1) problems.push(`${label}: box overlaps the docked footer`)
      if (pane !== null && box.bottom > pane.top + 1) problems.push(`${label}: box overlaps the preview pane`)
    }
    const selected = [...document.querySelectorAll<HTMLElement>('[data-scm-section="changes"] [data-row][data-selected="true"]')]
    if (target === null) {
      if (selected.length > 0) problems.push(`${String(selected.length)} row(s) selected before any click`)
    } else {
      if (selected.length !== 1) problems.push(`${String(selected.length)} selected rows, expected exactly 1`)
      const wanted = selected.filter(row => row.getAttribute('data-row') === target.path
        && row.closest('[data-group]')?.getAttribute('data-group') === target.group)
      if (wanted.length !== 1) problems.push(`${target.group}/${target.path}: ${String(wanted.length)} selected rows, expected exactly 1`)
    }
    if (footer !== null && pane !== null && footer.bottom > pane.top + 2) problems.push('the docked footer overlaps the preview pane')
    return problems
  }, expected)
}

/** Open the Git guide entry and wait for the SCM body (never the control twice:
 *  the expand control is gone once the sidebar is open). */
async function openGitPage(page: Page): Promise<void> {
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)
  await sendFirstMessage(page)
  await page.locator('[data-sidebar-right-expand]').first().click()
  await page.locator('[data-sidebar-right-guide-entry="git"]').click()
  await expect(page.locator('[data-scm-section="changes"]')).toBeVisible({ timeout: 30_000 })
}

/** Select one band's file row and return the reasons the rendered result is wrong. */
async function selectRow(page: Page, target: SelectedRow): Promise<{ widthBefore: number; widthAfter: number }> {
  const row = page.locator(`[data-group="${target.group}"] [data-row="${target.path}"]`)
  await expect(row).toHaveCount(1)
  const before = await row.boundingBox()
  expect(before, `${target.group}/${target.path} has no box before selection`).not.toBeNull()
  await row.locator(`[data-path="${target.path}"]`).click()
  await expect(row).toHaveAttribute('data-selected', 'true')
  const pane = page.locator('[class*="diffPane"]')
  await expect(pane).toBeVisible({ timeout: 30_000 })
  await expect(pane.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  await expect.poll(() => rowGeometryProblems(page, target), { timeout: 10_000 }).toEqual([])
  const after = await row.boundingBox()
  expect(after, `${target.group}/${target.path} has no box after selection`).not.toBeNull()
  return { widthBefore: before?.width ?? 0, widthAfter: after?.width ?? 0 }
}

test('a selected change row stays an in-flow band inside its group', async ({ page }, testInfo) => {
  const { root, status } = buildFixture()
  // The fixture is only a valid probe if every band really has its row.
  expect(status).toContain('UU src/app/main.ts')
  expect(status).toContain('MM src/app/util.ts')
  expect(status).toContain('?? docs/notes.md')

  const api = await createHostApi()
  const pageErrors: string[] = []
  page.on('pageerror', error => { pageErrors.push(String(error)) })
  try {
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: root })
    const session = await hostRpc<{ sessionId: string }>(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
    expect(session.value.sessionId).toBeTruthy()
    await gotoPage(page)
    await openGitPage(page)

    // Nothing selected yet: every row is already an in-flow band in its group.
    await expect(page.locator('[data-group="merge"] [data-row="src/app/main.ts"]')).toBeVisible()
    await expect(page.locator('[data-group="staged"] [data-row="src/app/util.ts"]')).toBeVisible()
    await expect(page.locator('[data-graph-commit]')).toHaveCount(3)
    await expect.poll(() => rowGeometryProblems(page, null), { timeout: 10_000 }).toEqual([])

    // Both bands carry the SAME path: each selection must keep its own row put.
    for (const target of [
      { group: 'unstaged', path: 'src/app/util.ts', shot: 'selected-unstaged.png' },
      { group: 'staged', path: 'src/app/util.ts', shot: 'selected-staged.png' },
      { group: 'merge', path: 'src/app/main.ts', shot: 'selected-conflict.png' },
    ]) {
      const widths = await selectRow(page, target)
      expect(Math.abs(widths.widthAfter - widths.widthBefore), `${target.group}/${target.path} jumped width on selection`).toBeLessThanOrEqual(1)
      await page.screenshot({ path: testInfo.outputPath(target.shot) })
    }

    // A narrower desktop shell (still above the 768px mobile gate) must hold the
    // same invariants: the band is panel-width, not viewport-width.
    await page.setViewportSize({ width: 1024, height: 800 })
    await expect(page.locator('[data-scm-section="changes"]')).toBeVisible()
    await selectRow(page, { group: 'unstaged', path: 'src/app/util.ts' })
    await page.screenshot({ path: testInfo.outputPath('selected-narrow.png') })

    expect(pageErrors).toEqual([])
  } finally {
    await api.dispose()
  }
})
