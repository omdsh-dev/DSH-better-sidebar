/** Live host UX with sanitized source-response fixtures; no third-party writes.
 * Backend source shape/query contracts are tested separately against source fixtures.
 * This gate proves the REAL native tab, format host, filters and browser cache.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, expect } from '@playwright/test'
import { selectClueSource, setTheme } from './ui-helpers'
import { createHostApi, dismissOnboarding, gotoPage, hostRpc, sendFirstMessage } from './host'

const now = '2026-10-23T03:00:00.000Z'
const tasks = [
  { sourceId: 'builtin.feishu.tasks', typeId: 'builtin.feishu.task', title: 'Review launch checklist', locator: { kind: 'task', guid: 'fixture-task-1' }, info: { state: 'active', author: { name: 'Ada' }, assignees: [{ name: 'Lin' }], due: { at: '2026-10-24T09:00:00.000Z' }, createdAt: now, updatedAt: now } },
  { sourceId: 'builtin.feishu.tasks', typeId: 'builtin.feishu.task', title: 'Confirm design review', locator: { kind: 'task', guid: 'fixture-task-2' }, info: { state: 'completed', author: { name: 'Ada' }, assignees: [{ name: 'Grace' }], completedAt: now, updatedAt: now } },
]
const pull = { sourceId: 'builtin.github.pulls', typeId: 'builtin.github.pull', title: 'Improve the resource workbench', locator: { kind: 'pull', owner: 'acme', repo: 'demo', number: 42, url: 'https://github.com/acme/demo/pull/42' }, info: { state: 'open', repository: 'acme/demo', number: 42, author: { handle: 'grace', name: 'Grace' }, assignees: [{ name: 'Ada' }], branches: { head: 'feat/resource-ui', base: 'main' }, counts: { comments: 3, commits: 2, changedFiles: 4, additions: 88, deletions: 20 }, labels: ['ux', 'review'], checks: 'success', review: 'approved', mergeable: 'mergeable', createdAt: now, updatedAt: now } }
const issue = { ...pull, sourceId: 'builtin.github.issues', typeId: 'builtin.github.issue', title: 'Keep resource details readable', locator: { ...pull.locator, kind: 'issue', url: 'https://github.com/acme/demo/issues/42' }, info: { ...pull.info, branches: undefined, counts: { comments: 5 } } }
const doc = { sourceId: 'builtin.feishu.docs', typeId: 'builtin.feishu.docx', title: 'Launch notes', locator: { kind: 'docx', token: 'doc-fixture' }, info: { updatedAt: now } }

test('clues cache revisits and expose source status, author and branches in one compact detail', async ({ page }, testInfo) => {
  const api = await createHostApi()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const requests: string[] = []
  const root = join(process.env.DSH_E2E_WORKSPACE ?? tmpdir(), `resources-ux-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'context.md'), '# Local context\n')
  try {
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: root })
    await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
    await page.route('**/sidebar/api/clues.defaultScope', async route => {
      const body = route.request().postDataJSON() as { sourceId: string }
      await route.fulfill({ json: { ok: true, value: { scope: body.sourceId.startsWith('builtin.github') ? { repo: 'acme/demo', state: 'open' } : { kind: 'drive-root' } } } })
    })
    await page.route('**/sidebar/api/clues.list', async route => {
      const body = route.request().postDataJSON() as { sourceId: string; scope?: { completed?: boolean } }
      requests.push(`list:${body.sourceId}:${body.scope?.completed ?? 'all'}`)
      if (body.sourceId === 'builtin.files') { await route.continue(); return }
      const items = body.sourceId === 'builtin.feishu.tasks'
        ? tasks.filter(item => body.scope?.completed === undefined || (item.info.state === 'completed') === body.scope.completed)
        : body.sourceId === pull.sourceId ? [pull] : body.sourceId === issue.sourceId ? [issue] : [doc]
      await route.fulfill({ json: { ok: true, value: { items } } })
    })
    await page.route('**/sidebar/api/clues.read', async route => {
      const body = route.request().postDataJSON() as { sourceId: string; locator: { guid?: string } }
      requests.push(`read:${body.sourceId}:${body.locator?.guid ?? ''}`)
      if (body.sourceId === 'builtin.files') { await route.continue(); return }
      const task = tasks.find(item => item.locator.guid === body.locator?.guid) ?? tasks[0]!
      const value = body.sourceId === 'builtin.feishu.tasks'
        ? { format: 'feishu.task.document', data: { kind: 'task', guid: task.locator.guid, title: task.title, description: '## Checklist\n\n- Check release notes\n- Confirm ownership', completed: task.info.state === 'completed', start: null, due: null }, info: task.info }
        : body.sourceId === 'builtin.feishu.docs'
          ? { format: 'feishu.docs.xml', data: { kind: 'docx', docToken: 'doc-fixture', title: doc.title, projection: 'xml', content: '<title>Launch notes</title><h1>Release plan</h1><p>Readable document content.</p>' }, info: doc.info }
          : { format: 'text/markdown', data: { title: body.sourceId === pull.sourceId ? pull.title : issue.title, body: '## Context\n\nA readable change description.', text: '## Context\n\nA readable change description.' }, info: body.sourceId === pull.sourceId ? pull.info : issue.info }
      await route.fulfill({ json: { ok: true, value: { ...value, fetchedAt: now, freshness: 'live' } } })
    })
    await gotoPage(page, {}, { firstCluesVisit: true })
    await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
    await dismissOnboarding(page)
    await sendFirstMessage(page)
    await page.locator('[data-sidebar-right-expand]:visible').first().click()
    await page.locator('[data-sidebar-right-guide-entry="clues"]').click()
    const tab = page.locator('[data-clue-tab]:visible')
    const help = page.locator('[data-clue-help]')
    const helpDialog = page.getByRole('dialog', { name: 'Use resources in three steps', exact: true })
    await expect(help.locator('[data-clue-help-step]')).toHaveCount(3)
    await expect(helpDialog).toHaveAttribute('aria-modal', 'true')
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(1)
    await helpDialog.screenshot({ path: testInfo.outputPath('clues-help-dialog.png') })
    await helpDialog.getByRole('button', { name: 'Close help', exact: true }).click()
    await expect(help).toHaveCount(0)
    const browse = tab.locator('[data-clue-browse-region]')
    await selectClueSource(browse, 'builtin.feishu.tasks')
    const filter = browse.getByRole('button', { name: 'Status', exact: true })
    await expect(browse.getByRole('button', { name: /^Review launch checklist/ })).toBeVisible()
    // An unfinished task is the resting case of its list: it prints no state at all.
    await expect(browse.locator('[data-clue-resource-inline-state="active"]')).toHaveCount(0)
    await filter.click()
    await expect(filter).toHaveAttribute('aria-expanded', 'true')
    await page.getByRole('menuitem', { name: 'Completed', exact: true }).click()
    await expect(browse.getByRole('button', { name: /^Confirm design review/ })).toBeVisible()
    await expect(browse.getByRole('button', { name: /^Review launch checklist/ })).toHaveCount(0)
    await filter.click()
    await page.getByRole('menuitem', { name: 'All', exact: true }).click()
    const frame = page.locator('[data-floating-window]:visible').last()
    await browse.getByRole('button', { name: /^Review launch checklist/ }).click()
    const summary = frame.locator('[data-clue-resource-summary]')
    await expect(summary.locator('[data-clue-resource-state-chip]')).toHaveCount(0)
    await expect(summary).toContainText('Ada')
    // Assignees are deliberately not part of the quiet preview header.
    await expect(summary).not.toContainText('Lin')
    await expect(frame.locator('[data-window-document-preview]')).toContainText('Checklist')
    const reads = requests.filter(item => item.startsWith('read:')).length
    await frame.getByRole('button', { name: 'Close', exact: true }).click()
    await browse.getByRole('button', { name: /^Review launch checklist/ }).click()
    await expect(frame.locator('[data-clue-resource-summary]')).toContainText('Ada')
    expect(requests.filter(item => item.startsWith('read:'))).toHaveLength(reads)
    await frame.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect.poll(() => requests.filter(item => item.startsWith('read:')).length).toBe(reads + 1)
    await frame.getByRole('button', { name: 'Close', exact: true }).click()
    const beforeFlip = requests.filter(item => item.startsWith('list:builtin.feishu.tasks')).length
    await selectClueSource(browse, 'builtin.github.pulls')
    // A row shows CI as a dot: passing keeps the dot and drops the word (which
    // would repeat on every healthy row), so the column still distinguishes
    // "passing" from "no CI reported".
    const rowChecks = browse.locator('[data-clue-resource-inline-checks="success"]').first()
    await expect(rowChecks).toHaveAttribute('data-clue-resource-inline-checks', 'success')
    await expect(rowChecks.locator('[data-checks]')).toHaveAttribute('aria-label', 'CI: Passed')
    await expect(rowChecks).toHaveText('')
    await browse.getByRole('button', { name: /^Improve the resource workbench/ }).click()
    await expect(summary).toContainText('Grace')
    await expect(summary.locator('[data-clue-change-request-fact="checks"]')).toContainText('Passed')
    await expect(summary.locator('[data-clue-change-request-fact="checks"]').getByRole('img'))
      .toHaveAttribute('aria-label', 'CI: Passed')
    await expect(summary.locator('[data-clue-change-request-fact="review"]')).toContainText('Approved')
    // Mergeable is the resting case and stays silent; only a conflict is a fact.
    await expect(summary.locator('[data-clue-change-request-fact="merge"]')).toHaveCount(0)
    await expect(summary).toContainText('feat/resource-ui')
    await expect(summary).toContainText('main')
    await expect(summary).toContainText('88')
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme)
      await frame.screenshot({ animations: 'disabled', path: testInfo.outputPath(`pull-${theme}.png`) })
    }
    await frame.evaluate(node => { (node as HTMLElement).style.width = '320px'; (node as HTMLElement).style.height = '320px' })
    const bounds = (await frame.boundingBox())!
    const footer = (await frame.locator('[data-clue-detail-footer]').boundingBox())!
    expect(footer.x).toBeGreaterThanOrEqual(bounds.x)
    expect(footer.x + footer.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1)
    await frame.screenshot({ animations: 'disabled', path: testInfo.outputPath('pull-compact.png') })
    await frame.getByRole('button', { name: 'Close', exact: true }).click()
    await selectClueSource(browse, 'builtin.github.issues')
    await browse.getByRole('button', { name: /^Keep resource details readable/ }).click()
    await expect(summary).toContainText('Grace')
    await frame.getByRole('button', { name: 'Close', exact: true }).click()
    await selectClueSource(browse, 'builtin.feishu.docs')
    await browse.getByRole('button', { name: /^Launch notes/ }).click()
    await expect(frame.locator('[data-window-document-preview]')).toContainText('Readable document content.')
    await expect(frame.locator('[data-window-document-preview] details summary')).toHaveText('Details')
    await frame.screenshot({ animations: 'disabled', path: testInfo.outputPath('document-readable.png') })
    await frame.getByRole('button', { name: 'Close', exact: true }).click()
    await selectClueSource(browse, 'builtin.feishu.tasks')
    await expect(browse.getByRole('button', { name: /^Review launch checklist/ })).toBeVisible()
    expect(requests.filter(item => item.startsWith('list:builtin.feishu.tasks'))).toHaveLength(beforeFlip)
    await testInfo.attach('request-counts.json', { body: JSON.stringify(requests, null, 2), contentType: 'application/json' })
    expect(errors).toEqual([])
  } finally { await api.dispose() }
})
