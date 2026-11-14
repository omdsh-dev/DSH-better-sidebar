/**
 * UI19 browser gates on the REAL RC mount lane's shell/window/native sidebar.
 * Run only in scripts/e2e-mount.sh's isolated profile/workspace. These cases
 * create blank fixture sessions; they never call sendFirstMessage or prompt.
 * Every clues.* response is a local route fixture. actions.start is recorded
 * and fulfilled with accepted, never forwarded to the host/model. Source
 * writes and unexpected clue methods are blocked and fail the case.
 *
 * Markers/roles come from detail/comments/selection-actions/WindowHost and
 * FloatingWindow. Native Selection + DOM handles prove the visible menu and
 * retained node identity; no React private state or pixel snapshots are used.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'
import { floatClueWindow, selectClueSource } from './ui-helpers'
import { composerEditable, composerLocator, createHostApi, dismissOnboarding, gotoPage, hostRpc } from './host'

const TITLE = 'UI19 local discussion fixture'
const SOURCE = 'builtin.github.issues'
const TYPE = 'builtin.github.issue'
const NOW = '2026-10-24T12:00:00.000Z'
const BODY_SELECTION = 'UI19 body selection.'
const COMMENT_SELECTION = 'UI19 comment selection.'
const BODY_HEADINGS = ['UI19 body start', 'Body plan', 'Body finish']
const BODY = `# ${BODY_HEADINGS[0]}\n\n${BODY_SELECTION}\n\n## ${BODY_HEADINGS[1]}\n\n${Array.from({ length: 36 }, (_, i) => `Local paragraph ${i + 1}. This fixture is not fetched from GitHub.`).join('\n\n')}\n\n## ${BODY_HEADINGS[2]}\n\nEnd of local body.`
const candidate = { sourceId: SOURCE, typeId: TYPE, title: TITLE, locator: { kind: 'issue', owner: 'ui19-local', repo: 'fixture', number: 1 } }

interface ActionRequest {
  workspaceId: string
  sessionId: string
  action: string
  target: 'main' | 'side'
  requestId: string
  selection: string
  comment?: boolean
  resource: unknown
}

interface FixtureState {
  workspaceId?: string
  actions: ActionRequest[]
  reads: number
  comments: number
  blocked: string[]
  pageErrors: string[]
}

async function ok(route: Route, value: unknown): Promise<void> {
  await route.fulfill({ json: { ok: true, value } })
}

/** A closed local response catalogue: no source operation can escape to a CLI. */
async function interceptFixture(page: Page): Promise<FixtureState> {
  const state: FixtureState = { actions: [], reads: 0, comments: 0, blocked: [], pageErrors: [] }
  page.on('pageerror', error => state.pageErrors.push(error.message))
  await page.route('**/sidebar/api/clues.*', async route => {
    const method = new URL(route.request().url()).pathname.split('/').at(-1)!
    const input = route.request().postDataJSON() as { workspaceId?: string }
    switch (method) {
      case 'clues.sources':
        await ok(route, {
          sources: [{ sourceId: SOURCE, name: 'UI19 local source', pluginId: 'e2e-local', order: 0, types: [TYPE], transport: 'http',
            capabilities: { resolve: true, list: true, search: true, read: true, edit: false, portable: false, comments: { read: true, create: true, reply: 'native' } } }],
          types: [{ sourceId: SOURCE, typeId: TYPE, formats: ['text/markdown'], capabilities: { read: true, edit: false, concurrency: 'none' } }],
        }); return
      case 'clues.defaultScope': await ok(route, { scope: { repo: 'ui19-local/fixture', state: 'open' } }); return
      case 'clues.list':
      case 'clues.search': await ok(route, { items: [candidate] }); return
      case 'clues.resolve': await ok(route, { candidates: [candidate] }); return
      case 'clues.read':
        state.workspaceId = input.workspaceId
        state.reads += 1
        await ok(route, { format: 'text/markdown', data: { title: TITLE, body: BODY, text: BODY }, text: BODY, fetchedAt: NOW, freshness: 'live' }); return
      case 'clues.comments.list':
        state.comments += 1
        await ok(route, { status: 'ok', coverage: 'document', fetchedAt: NOW, complete: true, items: [
          { id: 'ui19-comment', kind: 'comment', format: 'text/markdown', body: `## Comment-only heading\n\n${COMMENT_SELECTION}`, author: { name: 'Fixture reviewer' }, createdAt: NOW },
          { id: 'ui19-review', kind: 'review', format: 'text/plain', body: 'Local review summary.', reviewState: 'APPROVED', author: { name: 'Fixture approver' } },
        ] }); return
      case 'clues.clues': await ok(route, { clues: [], revision: 0 }); return
      case 'clues.pins.list': await ok(route, { pins: [], revision: 0 }); return
      case 'clues.packs.list': await ok(route, { packs: [], revision: 0 }); return
      case 'clues.bindings.list': await ok(route, { bindings: [], revision: 0 }); return
      case 'clues.snapshots.list': await ok(route, { snapshots: [] }); return
      case 'clues.actions.start':
        state.actions.push(route.request().postDataJSON() as ActionRequest)
        // No deliveryId: the client must not reopen/start a sidechat either.
        await ok(route, { accepted: true }); return
      default:
        state.blocked.push(method)
        await route.fulfill({ status: 403, json: { ok: false, error: { code: 'forbidden', message: 'UI19 fixture blocks source writes and unexpected clue methods' } } })
    }
  })
  for (const path of ['**/sidebar/api/sidechat.start', '**/api/session/prompt', '**/sidebar/agent/clues/commit']) {
    await page.route(path, async route => {
      state.blocked.push(new URL(route.request().url()).pathname)
      await route.fulfill({ status: 403, json: { ok: false, error: { code: 'forbidden', message: 'UI19 fixture never sends model/session messages or commits' } } })
    })
  }
  return state
}

/** Only an on-screen control counts: retained sessions keep off-screen copies. */
async function onScreen(page: Page, selector: string): Promise<Locator> {
  let found: Locator | undefined
  await expect.poll(async () => {
    const viewport = page.viewportSize()!
    for (const node of await page.locator(selector + ':visible').all()) {
      if (!await node.isVisible()) continue
      const rect = await node.boundingBox()
      if (rect !== null && rect.x + rect.width > 0 && rect.y + rect.height > 0 && rect.x < viewport.width && rect.y < viewport.height) {
        found = node
        return true
      }
    }
    return false
  }, { message: `an on-screen ${selector} must appear`, timeout: 30_000 }).toBe(true)
  return found!
}

async function openFixture(page: Page): Promise<{ state: FixtureState; surface: Locator; sessionId: string }> {
  expect(process.env.DSH_E2E_WORKSPACE, 'run through the isolated RC mount lane').toBeTruthy()
  const root = join(process.env.DSH_E2E_WORKSPACE!, `ui19-${Date.now()}-${test.info().testId.replace(/[^a-zA-Z0-9-]/g, '_')}`)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'ui19-local.md'), '# UI19 local workspace\n')
  const api = await createHostApi()
  let seededSessionId: string
  try {
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: root })
    const session = await hostRpc<{ sessionId: string }>(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
    seededSessionId = session.value.sessionId
  } finally { await api.dispose() }
  const state = await interceptFixture(page)
  await gotoPage(page)
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)
  // The API seeded a blank session; select that exact public workspace row.
  // Creating another UI draft here races the retained sidebar during first mount.
  await page.locator('[data-row-key="session:' + seededSessionId! + '"]').click()
  await expect(page.locator('[data-sidebar-right-expand]:visible').first()).toBeVisible({ timeout: 30_000 })
  await (await onScreen(page, '[data-sidebar-right-expand]')).click()
  const panel = page.locator('[data-sidebar-right-panel][data-sidebar-right-session="' + seededSessionId! + '"]:visible')
  await expect(panel).toBeVisible()
  const sessionId = seededSessionId!
  if (await panel!.locator('[data-sidebar-right-guide]').count() === 0) await panel!.locator('[data-dockkit-add-tab]').first().click()
  await panel!.locator('[data-sidebar-right-guide-entry="clues"]').click()
  const tab = panel!.locator('[data-clue-tab]')
  await expect(tab).toBeVisible()
  await tab.locator('[data-clue-browse-region]').getByRole('button', { name: TITLE, exact: true }).click()
  // A clue window opens DOCKED in the right sidebar; this fixture floats it to
  // measure content, selection and draft retention on the floating surface.
  const surface = await floatClueWindow(page, page.locator('[data-window-document-body]'))
  await expect(surface.locator('[data-window-document-body]')).toContainText(BODY_SELECTION)
  await expect(surface.locator('[data-clue-comment="ui19-comment"]')).toContainText(COMMENT_SELECTION)
  return { state, surface, sessionId }
}

/** Set a real DOM Selection, then let the rendered surface handle mouseup. */
async function selectText(page: Page, scope: Locator, text: string): Promise<Locator> {
  const paragraph = scope.getByText(text, { exact: true })
  await paragraph.scrollIntoViewIfNeeded()
  await paragraph.evaluate((node, selected) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let textNode: Node | null
    while ((textNode = walker.nextNode()) !== null) {
      const at = (textNode.textContent ?? '').indexOf(selected)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(textNode, at)
      range.setEnd(textNode, at + selected.length)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return
    }
    throw new Error('the fixture selection must exist in one rendered text node')
  }, text)
  const menu = page.locator('[data-clue-selection-menu]')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('role', 'menu')
  return menu
}

function expectQuiet(state: FixtureState): void {
  expect(state.blocked, 'no source writes, model/session sends or unmocked clue calls').toEqual([])
  expect(state.pageErrors, 'no uncaught errors from the actual mounted client').toEqual([])
}

test('UI19 keeps discussion below the body and comment headings out of its outline', async ({ page }) => {
  const { state, surface } = await openFixture(page)
  const body = surface.locator('[data-window-document-body]')
  const discussion = surface.locator('[data-clue-discussion]')
  await expect(body.getByRole('heading')).toHaveText(BODY_HEADINGS)
  await expect(discussion.getByRole('heading', { name: 'Comment-only heading', exact: true })).toBeAttached()
  expect(await body.evaluate(node => {
    const discussion = node.closest('[data-window-document-preview]')!.querySelector('[data-clue-discussion]')!
    return Boolean(node.compareDocumentPosition(discussion) & Node.DOCUMENT_POSITION_FOLLOWING)
      && node.getBoundingClientRect().bottom <= discussion.getBoundingClientRect().top
  })).toBe(true)
  await expect(body.locator('[data-clue-discussion]')).toHaveCount(0)
  const outline = surface.locator('[data-dsh-md-toc]')
  await outline.click()
  const items = surface.locator('[data-dsh-md-toc-panel]').getByRole('button')
  await expect(items).toHaveCount(3)
  expect(await items.evaluateAll(nodes => nodes.map(node => node.getAttribute('title')))).toEqual(BODY_HEADINGS)
  await expect(surface.locator('[data-dsh-md-toc-panel]')).not.toContainText('Comment-only heading')
  await outline.click()
  expect(state.actions).toEqual([])
  expectQuiet(state)
})

test('UI19 selects body and comment actions with readable main/side targets without sending', async ({ page }) => {
  const { state, surface, sessionId } = await openFixture(page)
  const body = surface.locator('[data-window-document-body]')
  let menu = await selectText(page, body, BODY_SELECTION)
  expect(await menu.locator('[data-clue-selection-action]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-clue-selection-action'))))
    .toEqual(['insert', 'explain', 'rewrite', 'expand', 'continue', 'shorten', 'translate'])
  await expect(menu.getByRole('menuitemradio', { name: 'Main conversation', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(menu.getByRole('menuitemradio', { name: 'Side conversation', exact: true })).toBeVisible()
  await menu.locator('[data-clue-selection-action="explain"]').click()
  await expect(menu).toHaveCount(0)
  await expect.poll(() => state.actions.length).toBe(1)
  expect(state.actions[0]).toMatchObject({ workspaceId: state.workspaceId, sessionId, action: 'explain', target: 'main', selection: BODY_SELECTION, resource: { sourceId: SOURCE, typeId: TYPE, locator: candidate.locator } })
  expect(state.actions[0]!.requestId).toBeTruthy()
  expect(state.actions[0]!.comment).toBeUndefined()

  menu = await selectText(page, surface.locator('[data-clue-comment="ui19-comment"] [data-clue-selection-surface]'), COMMENT_SELECTION)
  await expect(menu.getByRole('menuitem')).toHaveCount(2)
  expect(await menu.locator('[data-clue-selection-action]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-clue-selection-action')))).toEqual(['insert', 'explain'])
  const side = menu.getByRole('menuitemradio', { name: 'Side conversation', exact: true })
  await side.click()
  await expect(side).toHaveAttribute('aria-checked', 'true')
  await menu.locator('[data-clue-selection-action="explain"]').click()
  await expect.poll(() => state.actions.length).toBe(2)
  expect(state.actions[1]).toMatchObject({ workspaceId: state.workspaceId, sessionId, action: 'explain', target: 'side', selection: COMMENT_SELECTION, comment: true, resource: { sourceId: SOURCE, typeId: TYPE, locator: candidate.locator } })
  menu = await selectText(page, surface.locator('[data-clue-comment="ui19-comment"] [data-clue-selection-surface]'), COMMENT_SELECTION)
  await menu.locator('[data-clue-selection-action="insert"]').click()
  const composer = page.getByRole('textbox', { name: /^(Describe what you want to build|Message or run a task|描述你想要构建)/ })
  await expect(composer).toContainText(COMMENT_SELECTION)
  expect(state.actions).toHaveLength(2)
  expectQuiet(state)
})

test('UI19 moves the same draft and scroll DOM between floating and native sidebar at narrow width', async ({ page }) => {
  const { state, surface } = await openFixture(page)
  // Set the viewport before recording scroll; resizing itself may reflow text.
  await page.setViewportSize({ width: 390, height: 844 })
  const input = surface.locator('[data-clue-comment-input]')
  const draft = 'Unsent local comment draft — never post this.'
  await input.fill(draft)
  const inputNode = await input.elementHandle()
  const bodyNode = await surface.locator('[data-window-document-body]').elementHandle()
  const scrollHandle = await surface.locator('[data-window-document-preview]').evaluateHandle(preview => {
    const scroll = [preview, ...preview.querySelectorAll<HTMLElement>('*')].find(node =>
      node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(node).overflowY))
    if (!(scroll instanceof HTMLElement)) throw new Error('fixture must overflow its real preview scroll container')
    scroll.scrollTop = 140
    return scroll
  })
  const offset = await scrollHandle.evaluate(node => node.scrollTop)
  expect(offset).toBeGreaterThan(0)
  const reads = state.reads
  const comments = state.comments

  // A real narrow viewport, with an icon AND text button; no forced frame width.
  const dock = surface.locator('[data-window-dock]')
  await expect(dock).toBeVisible()
  await expect(dock).toHaveText('Return to sidebar')
  await expect(dock.locator('svg')).toBeVisible()
  await dock.click()
  await expect(surface).toHaveAttribute('data-window-docked', 'true')
  await expect(surface).not.toHaveAttribute('data-floating-window', '')
  await expect(surface.locator('[data-window-float]')).toHaveText('Float window')
  await expect(input).toHaveValue(draft)
  expect(await input.evaluate((node, previous) => node === previous, inputNode)).toBe(true)
  expect(await surface.locator('[data-window-document-body]').evaluate((node, previous) => node === previous, bodyNode)).toBe(true)

  await surface.locator('[data-window-float]').click()
  await expect(surface).toHaveAttribute('data-floating-window', '')
  await expect(surface).not.toHaveAttribute('data-window-docked', 'true')
  await expect(dock).toHaveText('Return to sidebar')
  await expect(dock).toHaveAccessibleName('Return to sidebar')
  await expect(dock.getByText('Return to sidebar', { exact: true })).toBeVisible()
  await expect(dock.locator('svg')).toBeVisible()
  await expect(input).toHaveValue(draft)
  expect(await input.evaluate((node, previous) => node === previous, inputNode)).toBe(true)
  await expect.poll(() => scrollHandle.evaluate(node => node.scrollTop)).toBe(offset)
  expect(state.reads).toBe(reads)
  expect(state.comments).toBe(comments)
  expect(state.actions).toEqual([])
  expectQuiet(state)
  await scrollHandle.dispose()
  await inputNode?.dispose()
  await bodyNode?.dispose()
})

test('UI19 reveals a real scratch file through the clues menu into the expanded native tree', async ({ page }) => {
  const rootEnv = process.env.DSH_E2E_WORKSPACE
  expect(rootEnv, 'only create reveal fixtures under the mount lane scratch root').toBeTruthy()
  // The host canonicalizes workspace roots (macOS /tmp is /private/tmp).
  const root = realpathSync(rootEnv!)
  const folder = `ui19-reveal-${Date.now()}`
  const parent = join(root!, folder)
  const nested = join(parent, 'level')
  const target = join(nested, 'target-ui19.md')
  mkdirSync(nested, { recursive: true })
  writeFileSync(target, '# UI19 real local reveal\n')
  // Keep both ancestor rows explicit instead of compacting a one-child chain.
  writeFileSync(join(parent, 'sibling.txt'), 'local sibling\n')
  writeFileSync(join(nested, 'sibling.txt'), 'local sibling\n')
  const api = await createHostApi()
  try {
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: root })
    await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
  } finally { await api.dispose() }
  const blocked: string[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  // Unlike the first three cases, no files/clues read API is mocked here.
  for (const method of ['clues.actions.start', 'clues.comments.create', 'clues.saveEdit', 'sidechat.start']) {
    await page.route(`**/sidebar/api/${method}`, async route => {
      blocked.push(method)
      await route.fulfill({ status: 403, json: { ok: false, error: { code: 'forbidden', message: 'file reveal must not write content or send messages' } } })
    })
  }
  await gotoPage(page)
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)
  await page.getByRole('button', { name: /^(New session|新建会话)$/i }).first().click()
  await (await onScreen(page, '[data-sidebar-right-expand]')).click()
  const panel = await onScreen(page, '[data-sidebar-right-panel]')
  if (await panel.locator('[data-sidebar-right-guide]').count() === 0) await panel.locator('[data-dockkit-add-tab]').first().click()
  await panel.locator('[data-sidebar-right-guide-entry="clues"]').click()
  const browse = panel.locator('[data-clue-browse-region]')
  await selectClueSource(browse, 'builtin.files')
  const query = browse.getByRole('textbox', { name: 'Keyword, resource link or file path', exact: true })
  // Explicit ./ paths use the real files resolve API, not a search fixture.
  await query.fill(`./${folder}/level/target-ui19.md`)
  await query.press('Enter')
  // The accessible name also contains its path subtitle; title names the file.
  await browse.getByTitle('target-ui19.md', { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reveal in file tree', exact: true }).click()
  const row = panel.getByTitle(target, { exact: true })
  await expect(row).toHaveAttribute('role', 'button')
  await expect(row).toHaveAttribute('data-dsh-revealed', 'true')
  await expect(panel.getByTitle(parent, { exact: true })).toBeVisible()
  await expect(panel.getByTitle(nested, { exact: true })).toBeVisible()
  // FileTree's real reveal effect scrolls its own explorerBody smoothly.
  // No synthetic "selected"/"scrolled" marker is written by this test.
  await expect.poll(() => row.evaluate(node => {
    const body = node.closest('[class*="explorerBody"]')
    if (body === null) return false
    const bounds = body.getBoundingClientRect()
    const target = node.getBoundingClientRect()
    return target.width > 0 && target.height > 0 && target.top >= bounds.top - 1 && target.bottom <= bounds.bottom + 1
  })).toBe(true)
  expect(blocked).toEqual([])
  expect(errors).toEqual([])
})

test('UI19 keeps the CodeMirror long-selection menu focused until a compact chip is inserted', async ({ page }) => {
  const rootEnv = process.env.DSH_E2E_WORKSPACE
  expect(rootEnv, 'only create selection fixtures under the mount lane scratch root').toBeTruthy()
  const root = realpathSync(rootEnv!)
  const name = `ui19-code-selection-${Date.now()}.ts`
  const target = join(root, name)
  const selected = Array.from({ length: 8 }, (_, i) =>
    `// UI19-CM-${String(i).padStart(2, '0')}-ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstuvwxyz-0123456789`).join('\n')
  expect(selected.length, 'the native selection must exceed the old 500-character fence').toBeGreaterThan(500)
  writeFileSync(target, selected)
  const api = await createHostApi()
  try {
    const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: root })
    await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
  } finally { await api.dispose() }
  const blocked: string[] = [], errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  for (const route of ['**/sidebar/api/clues.actions.start', '**/sidebar/api/clues.comments.create', '**/sidebar/api/clues.saveEdit', '**/sidebar/api/fs.write', '**/sidebar/api/sidechat.start', '**/sidebar/agent/clues/commit', '**/api/session/prompt', '**/api/session/*/prompt']) {
    await page.route(route, async request => {
      blocked.push(new URL(request.request().url()).pathname)
      await request.fulfill({ status: 403, json: { ok: false, error: { code: 'forbidden', message: 'selection insertion must not write files or send messages' } } })
    })
  }
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await gotoPage(page)
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)
  await page.getByRole('button', { name: /^(New session|新建会话)$/i }).first().click()
  await expect(composerLocator(page)).toBeVisible()
  await (await onScreen(page, '[data-sidebar-right-expand]')).click()
  const panel = await onScreen(page, '[data-sidebar-right-panel]')
  if (await panel.locator('[data-sidebar-right-guide]').count() === 0) await panel.locator('[data-dockkit-add-tab]').first().click()
  await panel.locator('[data-sidebar-right-guide-entry="clues"]').click()
  const browse = panel.locator('[data-clue-browse-region]')
  await selectClueSource(browse, 'builtin.files')
  const query = browse.getByRole('textbox', { name: 'Keyword, resource link or file path', exact: true })
  await query.fill(`./${name}`)
  await query.press('Enter')
  await browse.getByTitle(name, { exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reveal in file tree', exact: true }).click()
  const row = panel.getByTitle(target, { exact: true })
  await expect(row).toHaveAttribute('data-dsh-revealed', 'true')
  // Click the file itself, away from the hover-only @ action at its right edge.
  await row.click({ position: { x: 8, y: 8 } })
  const code = panel.locator('.cm-content:visible').first()
  await expect(code).toBeVisible({ timeout: 30_000 })
  await expect(code.locator('.cm-line')).toHaveText(selected.split('\n'))
  await code.click({ position: { x: 8, y: 8 } })
  // A real Mod-A goes through CodeMirror's public keyboard handling. Do not
  // reach into its view/state; mouseup reaches the actual editor DOM too.
  await page.keyboard.press('ControlOrMeta+a')
  await code.dispatchEvent('mouseup', { button: 0, bubbles: true })
  const menu = page.locator('[data-clue-selection-menu]')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitemradio', { name: 'Main conversation', exact: true })).toBeFocused()
  // In the regression, that deliberate focus handoff raised CM focusChanged
  // and hid the popup before this real click could complete.
  await expect(menu).toBeVisible()
  await menu.locator('[data-clue-selection-action="insert"]').click()
  await expect(menu).toHaveCount(0)
  const composer = composerEditable(page)
  const chip = composer.locator('[data-composer-chip="reference"]')
  await expect(chip).toHaveCount(1)
  await expect(chip).toBeVisible()
  await expect(chip).toContainText(`${name}:1-8`)
  await expect(chip).not.toHaveClass(/openable/u)
  await expect(composer).not.toContainText('```')
  await expect(composer).not.toContainText('UI19-CM-00-')
  // Standard copy reads the host's clipboard projection, not a private
  // Lexical node. The full model payload must stay out of this projection.
  await composer.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+c')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`${name}:1-8`)
  const clipboard = await page.evaluate(() => navigator.clipboard.readText())
  expect(clipboard).not.toContain('```')
  expect(clipboard).not.toContain('UI19-CM-00-')
  expect(blocked).toEqual([])
  expect(errors).toEqual([])
})
