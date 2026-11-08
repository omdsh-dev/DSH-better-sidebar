/**
 * Shared fixtures of the Context-diagnostics lane
 * (`scripts/e2e-context.sh` → `./context-diagnostics.e2e.ts`).
 *
 * Two jobs, both deliberately thin:
 *
 * 1. The ONE source of truth for the ids the lane's host fixture
 *    (`./context-fixture-plugin.mjs`) attaches to. The spec creates the parent
 *    session itself through the public `session/create` RPC with
 *    {@link PARENT_SESSION_ID}; the fixture row (installed only in this lane's
 *    scratch profiles) then seeds the child session
 *    and the background job off that fixed id. No channel, no private API.
 *
 * 2. The DOM handles the lane asserts on, all of them the HOST's or the
 *    PLUGIN's own public markers — never an internal:
 *    - `[data-sidebar-right-session="<sid>"]` — the host's per-session right
 *      column owner (the host's own client bundle addresses panes this way),
 *    - `[role="tab"]` — a native tab button (dsh-context's own bundle finds its
 *      tab by `button[role="tab"]` + text),
 *    - `[data-row-key="session:<sid>"]` — a session row of the host's workspace
 *      tree (`role="treeitem"`, click = open),
 *    - `[data-graph-node="<sid>"]` — an agent card of the plugin's Tasks graph
 *      (click = the node's detail popover),
 *    - `[data-dsh-ctx-entry="session|agent|job"]` / `[data-dsh-ctx-alert]` —
 *      the plugin's own entry-point and alert testids
 *      (`src/client/context-diagnostics-ui.tsx`).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { hostRpc } from './host'
export { dismissOnboarding } from './host'

/** The parent session the SPEC creates through `session/create` (the fixture
 *  plugin attaches to exactly this id — see the module header). */
export const PARENT_SESSION_ID = 'session-e2e-context-parent'

/** The child (subagent-origin) session the fixture row creates. */
export const CHILD_SESSION_ID = 'session-e2e-context-child'

/** The child's descriptor label (deliberately not a `Side: ` side-thread). */
export const CHILD_LABEL = 'Context fixture child'

/** The fixture job's label (its row's accessible name starts with it). */
export const JOB_LABEL = 'e2e context fixture job'

/** A file in the lane's workspace, so the seeded workspace is not empty. */
export const SEED_FILE = 'context-lane.txt'

/** The dsh-context tab/bundle identity (its `TabDescriptor.id` and kind). */
export const CONTEXT_KIND = 'dsh-context'

/** The Context tab's localized title (en / zh dictionaries). */
export const CONTEXT_TAB_NAME = /^(Context|上下文)$/

/** A card title the real dsh-context dashboard renders (en / zh). */
export const DASHBOARD_CARD = /Token Stats|Token 统计/

/**
 * The panel-list label of dsh-context's placement-independent "Context
 * Insights" page (`ov.title` in its own dictionaries). It exists whenever the
 * plugin is mounted, whatever `defaultPlacement` says — which is what makes it
 * the guard for the `tab-only` variant: the entries must be hidden there
 * because the RIGHT COLUMN type is off, not because dsh-context failed to
 * mount.
 */
export const CONTEXT_INSIGHTS_LABEL = /^(Context Insights|上下文洞察)$/

/** Testid of one entry point (its `kind` is `session` / `agent` / `job`). */
export function entrySelector(kind: 'session' | 'agent' | 'job'): string {
  return `[data-dsh-ctx-entry="${kind}"]`
}

/** Testid of the frame-wide error alert (one at a time). */
export const ALERT_SELECTOR = '[data-dsh-ctx-alert]'

/** The host's per-session right-column owner element. */
export function sessionOwner(page: Page, sessionId: string): Locator {
  return page.locator(`[data-sidebar-right-session="${sessionId}"]`)
}

/** The host's workspace-tree row for one session (subagent rows are absent by
 *  the HOST's own rule — `origin === 'subagent'` rows are filtered out). */
export function sessionRow(page: Page, sessionId: string): Locator {
  return page.locator(`[data-row-key="session:${sessionId}"]`)
}

/**
 * Seed the lane's workspace and its parent session through the host's public
 * unary RPC (`workspace.create` + `session.create`), the same calls the UI
 * makes. The session id is PINNED so the fixture row can attach to it without
 * any extra channel.
 * @param api - authenticated host request context (`createHostApi`).
 * @param workspacePath - the lane's workspace directory (created if absent).
 */
export async function seedParentSession(api: APIRequestContext, workspacePath: string): Promise<void> {
  mkdirSync(workspacePath, { recursive: true })
  writeFileSync(join(workspacePath, SEED_FILE), 'context diagnostics lane\n')
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(
    api, 'workspace.create', { path: workspacePath },
  )
  await hostRpc(api, 'session.create', {
    workspaceId: workspace.value.workspace.workspaceId,
    sessionId: PARENT_SESSION_ID,
  })
}

/**
 * Count the elements matching `selector` that INTERSECT the viewport. The host
 * keeps a hidden copy of every retained session's chrome (translated out of
 * view, its rect still non-empty), so a plain count would see duplicates the
 * reader cannot see — the blank-session lane documents the same hazard.
 * @param page - the lane's page.
 * @param selector - a CSS selector.
 * @returns how many matches are really on screen.
 */
export async function onScreenCount(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    let seen = 0
    for (const element of document.querySelectorAll(sel)) {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0
        && rect.top < window.innerHeight && rect.left < window.innerWidth) seen += 1
    }
    return seen
  }, selector)
}

/**
 * Bring the native right column up and open one guide entry. Idempotent: the
 * expand control only exists while the column is collapsed, and the guide page
 * only shows while the pane holds no tabs (the same two-step the mount lane
 * performs inline).
 * @param page - the lane's page.
 * @param kind - the guide entry's kind (`files` / `subagent` / `dsh-context`).
 */
export async function openGuideEntry(page: Page, kind: string, sessionId = PARENT_SESSION_ID): Promise<Locator> {
  const owner = sessionOwner(page, sessionId)
  const viewport = page.viewportSize()
  for (const expand of await page.locator('[data-sidebar-right-expand]').all()) {
    const rect = await expand.boundingBox()
    if (rect !== null && viewport !== null && rect.x + rect.width > 0 && rect.y + rect.height > 0
      && rect.x < viewport.width && rect.y < viewport.height) {
      await expand.click()
      break
    }
  }
  if (await owner.locator('[data-sidebar-right-guide]').count() === 0) {
    await owner.locator('[data-dockkit-add-tab]').first().click()
  }
  await owner.locator(`[data-sidebar-right-guide-entry="${kind}"]`).click()
  return owner
}

/**
 * The texts of the ACTIVE tab buttons inside one container (0..n — a pane
 * without a selected tab answers `[]`).
 * @param scope - a page or an owner-element locator.
 */
export async function activeTabTexts(scope: Page | Locator): Promise<string[]> {
  return scope.locator('[role="tab"][aria-selected="true"]').allTextContents()
}

/**
 * Wait until one container's active tab is titled `name`.
 * @param scope - the owner element (or page) to read.
 * @param name - the expected tab title pattern.
 */
export async function expectActiveTab(scope: Page | Locator, name: RegExp): Promise<void> {
  await expect
    .poll(async () => (await activeTabTexts(scope)).filter(text => name.test(text.trim())).length, { timeout: 30_000 })
    .toBeGreaterThan(0)
}
