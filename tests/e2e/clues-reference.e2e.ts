/** Real composer and local HTTP regression gate for the approved reference flow.
 * Public UI and HTTP only: no editor private state, fabricated draft revision or
 * browser login cookie passed to the agent read endpoint. All data is local.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, expect, request } from '@playwright/test'
import { createHostApi, dismissOnboarding, gotoPage, hostRpc, ORIGIN, sendFirstMessage, sidebarApi } from './host'

test('clues keep consecutive native chips and resolve an unstored @ pick with local curl semantics', async ({ page }, testInfo) => {
  const api = await createHostApi()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const root = join(process.env.DSH_E2E_WORKSPACE ?? tmpdir(), `reference-flow-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  const names = ['alpha-reference.md', 'beta-reference.md', 'unseen-reference.md', 'native-reference.ts']
  for (const name of names) writeFileSync(join(root, name), `Local fixture body: ${name}\n`)
  try {
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: root })
    const workspaceId = workspace.value.workspace.workspaceId
    const session = await hostRpc<{ sessionId: string }>(api, 'session.create', { workspaceId })
    const sessionId = session.value.sessionId
    const listing = await api.post(sidebarApi('clues.list'), { data: { workspaceId, sourceId: 'builtin.files' } })
    expect(listing.ok()).toBe(true)
    const listed = await listing.json() as { value: { items: { title: string; sourceId: string; typeId: string; locator: unknown }[] } }
    const candidates = listed.value.items
    const ids: string[] = []
    for (const name of names.slice(0, 2)) {
      const candidate = candidates.find(item => item.title === name)!
      expect(candidate).toBeDefined()
      const response = await api.post(sidebarApi('clues.ensure'), { data: { workspaceId, ...candidate } })
      expect(response.ok()).toBe(true)
      ids.push((await response.json() as { value: { clue: { id: string } } }).value.clue.id)
    }
    // This case tests insertion; the first-visit modal is tested separately.
    await page.addInitScript(() => {
      if (window === window.top) localStorage.setItem('dsh-better-sidebar:clues-help-seen-v2', '1')
    })
    await gotoPage(page)
    await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
    await dismissOnboarding(page)
    await sendFirstMessage(page)
    await page.locator('[data-sidebar-right-expand]:visible').first().click()
    await page.locator('[data-sidebar-right-guide-entry="files"]').click()
    const pane = page.locator('[data-sidebar-right-panel]:visible')
    const fileRow = pane.locator('[role="button"][title$="native-reference.ts"]:visible')
    await expect(fileRow).toHaveCount(1, { timeout: 30_000 })
    await fileRow.hover()
    await fileRow.getByRole('button', { name: /@file|@文件/ }).click()
    const composer = page.getByRole('textbox', { name: /^(Describe what you want to build|Message or run a task|描述你想要构建)/ })
    await expect(composer.locator('[data-composer-chip="reference"]')).toHaveCount(1)
    await expect(composer).toBeFocused()
    await page.locator('[data-dockkit-add-tab]').first().click()
    await page.locator('[data-sidebar-right-guide-entry="clues"]').click()
    const tab = page.locator('[data-clue-tab]:visible')
    await expect(tab).toBeVisible()
    for (const name of names.slice(0, 2)) {
      await tab.getByRole('button', { name: `Insert ${name}`, exact: true }).click()
      await expect(composer).toBeFocused()
    }
    const chips = composer.locator('[data-composer-chip]')
    await expect(chips).toHaveCount(3)
    await expect(chips.nth(0)).toContainText('native-reference.ts')
    await expect(chips.nth(1)).toContainText('alpha-reference.md')
    await expect(chips.nth(2)).toContainText('beta-reference.md')
    // The raw candidate has never been ensured. Opening/searching @ must not
    // persist it; the pick alone turns it into a stable reference.
    await expect(composer).toBeFocused()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type(' @unseen-reference')
    const option = page.locator('[role="option"][id^="dsh-slash-option-better-sidebar:clues-"]').filter({ hasText: 'unseen-reference.md' })
    await expect(page.getByRole('option', { name: 'unseen-reference.md', exact: true }).first()).toBeVisible()
    await testInfo.attach('native-menu-observation.json', { body: JSON.stringify(await page.getByRole('option').evaluateAll(nodes => nodes.map(node => ({ id: node.id, text: node.textContent, html: node.outerHTML.slice(0, 1500) }))), null, 2), contentType: 'application/json' })
    await expect(option).toHaveCount(1)
    expect((await option.innerText()).trim()).toBe('unseen-reference.md')
    const beforePick = await api.post(sidebarApi('clues.clues'), { data: { workspaceId } })
    const libraryBefore = await beforePick.json() as { value: { clues: { id: string; title: string }[] } }
    expect(libraryBefore.value.clues.some(item => item.title === 'unseen-reference.md')).toBe(false)
    await option.click()
    await expect(chips).toHaveCount(4)
    await expect(chips.filter({ hasText: 'unseen-reference.md' })).toHaveCount(1)
    await expect(chips.filter({ hasText: 'native-reference.ts' })).toHaveCount(1)
    await expect(chips.filter({ hasText: 'alpha-reference.md' })).toHaveCount(1)
    await expect(chips.filter({ hasText: 'beta-reference.md' })).toHaveCount(1)
    await expect(composer).toBeFocused()
    const afterPick = await api.post(sidebarApi('clues.clues'), { data: { workspaceId } })
    const libraryAfter = await afterPick.json() as { value: { clues: { id: string; title: string }[] } }
    expect(libraryAfter.value.clues).toHaveLength(libraryBefore.value.clues.length + 1)
    const picked = libraryAfter.value.clues.find(item => item.title === 'unseen-reference.md')!
    const payload = { workspaceId, reference: `[[dsh-clue:${picked.id}]]`, sessionId }
    const local = await request.newContext()
    try {
      const read = await local.post(`${ORIGIN}/sidebar/agent/clues/read`, { data: payload })
      expect(read.status()).toBe(200)
      expect(await read.json()).toMatchObject({ ok: true, value: { status: 'ok', kind: 'clue', freshness: 'live', text: 'Local fixture body: unseen-reference.md\n' } })
      const crossSite = await local.post(`${ORIGIN}/sidebar/agent/clues/read`, { headers: { origin: 'https://foreign.example' }, data: payload })
      expect(crossSite.status()).toBe(403)
      const writing = await local.post(`${ORIGIN}/sidebar/agent/clues/read`, { data: { ...payload, method: 'saveEdit' } })
      expect(writing.status()).toBe(400)
      const normalApi = await local.post(sidebarApi('settings.get'), { data: {} })
      expect(normalApi.status()).toBe(403)
      await testInfo.attach('reference-flow.json', { body: JSON.stringify({ chipCount: await chips.count(), ids, pickedId: picked.id, localReadStatus: read.status(), crossSiteStatus: crossSite.status(), writeAttemptStatus: writing.status(), existingApiUnauthenticatedStatus: normalApi.status() }, null, 2), contentType: 'application/json' })
    } finally {
      await local.dispose()
    }
    await page.screenshot({ path: testInfo.outputPath('consecutive-references.png') })
    expect(errors).toEqual([])
  } finally {
    await api.dispose()
  }
})
