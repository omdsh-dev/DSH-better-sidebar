/**
 * In-page CLIENT ENTRY REPLACEMENT ("plugin reload") — the deployment-level
 * guard for the `dsh-better-sidebar:files` orphaned-tab-type bug.
 *
 * Field symptom (issues #770/#771, reproduced on the official desktop shell):
 * a client-side replacement of the plugin entry — a plugin-market update, a
 * disable→enable in the Plugins page, an HMR rebundle — left the host's tab
 * type id `dsh-better-sidebar:files` registered with nobody holding its
 * disposer, so the plugin could never register it again: every later `sync()`
 * reported `native register files error: … already registered` and the Files
 * takeover rendered the host's "nothing here can view this kind of content"
 * face until a page refresh.
 *
 * Root cause (fixed in v0.22.1): `sync()`'s drop loop treated the plugin's own
 * `files` takeover like a service descriptor, so every notification tore it
 * down and re-created it in the same pass. During the reload the re-creation
 * ran on the dying plugin context: `tabs.register` (host context, still alive)
 * took the id and `ctx.slots.inject` (plugin context) then threw
 * `cannot create effect on inactive context`, losing the disposer.
 *
 * The trigger here is the same one the host's own HMR uses: the installed
 * client bundle is stat-polled, and a changed revision (`mtime`/`ctime`/`size`)
 * makes the host tear the entry's fiber down and re-import it IN PAGE — no
 * full page navigation, which is what made the old failure permanent.
 */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { PAGE_URL, createHostApi, hostRpc, sendFirstMessage } from './host'

/** Workspace the sidebar renders against (created by this lane's seeding). */
const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-workspace')

/** A file seeded into the workspace, opened through the Files takeover. */
const SEEDED_FILE = 'hello.txt'

/**
 * The installed client bundle the host's HMR stat-poll watches. Derived from
 * the profile the server was booted with (`DSH_HOME`), overridable for a
 * hand-run lane.
 */
const CLIENT_JS = process.env.DSH_E2E_PLUGIN_CLIENT_JS
  ?? (process.env.DSH_HOME === undefined
    ? undefined
    : join(process.env.DSH_HOME, 'profiles/web/node_modules/dsh-better-sidebar/lib/client.js'))

/** The strip `fail()` pins to <body>; the plugin's registration failures land here. */
const REGISTRATION_ERROR = /native register .* error/

let api: APIRequestContext

test.beforeAll(async () => {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  writeFileSync(join(WORKSPACE_PATH, SEEDED_FILE), 'hello from the reload lane\n')
  api = await createHostApi()
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(
    api, 'workspace.create', { path: WORKSPACE_PATH },
  )
  await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
})

test.afterAll(async () => {
  await api?.dispose()
})

test('the native tab types survive an in-page client entry replacement', async ({ page }) => {
  // A hard failure, not a skip: this gate's whole value is that it cannot
  // pass quietly when the harness stops telling us where the bundle lives.
  if (CLIENT_JS === undefined) {
    throw new Error('DSH_HOME (or DSH_E2E_PLUGIN_CLIENT_JS) must point at the profile running this server')
  }
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  const sidebar = page.locator('[data-dsh-better-sidebar]')
  await expect(sidebar).toBeAttached({ timeout: 90_000 })

  // A keyless boot stacks onboarding takeovers over the shell (versioned
  // welcome notice, then the provider-config dialog). Same bounded dismissal
  // loop as the mount lane: a masked click is retried, an absent takeover is
  // fine.
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
        // Masked by the takeover stacked above it; the next round tries again.
      }
    }
    if (!dismissed) break
  }

  // The session header (and with it the native right sidebar's controls) only
  // exists once the session has a turn — the mount lane does the same.
  await sendFirstMessage(page)
  await page.locator('[data-sidebar-right-expand]').first().click()
  const pane = page.locator('[data-sidebar-right-panel]')
  await expect(page.locator('[data-sidebar-right-guide]')).toBeVisible({ timeout: 30_000 })
  // The takeover is ALIVE before the reload: its guide row opens the plugin's
  // explorer and the seeded file is listed.
  await page.locator('[data-sidebar-right-guide-entry="files"]').click()
  await expect(pane.locator(`[role="button"][title$="${SEEDED_FILE}"]:visible`)).toHaveCount(1, { timeout: 30_000 })

  // ── Trigger: bump the installed bundle's revision ─────────────────────
  // Tag the CURRENT host element so the replacement is observable: a disposal
  // removes it (`host.remove()`), and the new activation appends a fresh one.
  await page.evaluate(() => {
    document.querySelector('[data-dsh-better-sidebar]')?.setAttribute('data-e2e-generation', 'before-reload')
  })
  const now = new Date()
  utimesSync(CLIENT_JS!, now, new Date(now.getTime() + 2_000))
  await expect(
    page.locator('[data-dsh-better-sidebar][data-e2e-generation="before-reload"]'),
    'the host must replace the plugin entry in page (new activation)',
  ).toHaveCount(0, { timeout: 60_000 })
  // Let the fresh activation finish its registrations.
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 60_000 })
  await page.waitForTimeout(2_000)

  // ── Assertions: no registration failure, takeover usable ──────────────
  const registrationErrors = consoleErrors.filter(message => REGISTRATION_ERROR.test(message))
  expect(registrationErrors, registrationErrors.join('\n')).toEqual([])
  await expect(
    page.locator('body > div', { hasText: 'native register files error' }),
    'the failure strip must not be pinned',
  ).toHaveCount(0)
  // The Files takeover works again after the replacement: the guide row is
  // offered and the explorer still lists the seeded file.
  if (await page.locator('[data-sidebar-right-guide]').count() === 0) {
    await page.locator('[data-dockkit-add-tab]').first().click()
  }
  const filesEntry = page.locator('[data-sidebar-right-guide-entry="files"]')
  await expect(filesEntry, 'the Files guide row must be offered again').toHaveCount(1, { timeout: 30_000 })
  await filesEntry.click()
  // The explorer must really render again — assert the CONTENT first (a bare
  // "no unavailable marker" check passes on an empty pane), then the host's
  // "a kind with no registrant" fallback must be absent.
  await expect(pane.locator(`[role="button"][title$="${SEEDED_FILE}"]:visible`)).toHaveCount(1, { timeout: 30_000 })
  await expect(
    pane.locator('[data-sidebar-right-unavailable]'),
    'the host must not fall back to its "nothing can view this kind" face',
  ).toHaveCount(0)
})
