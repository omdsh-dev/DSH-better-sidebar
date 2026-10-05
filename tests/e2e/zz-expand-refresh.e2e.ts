/**
 * Expand-refresh lane: a folder toggle must not rebuild the tree.
 *
 * Reported symptom: "expanding a folder makes the whole tree refresh over and
 * over". Two independent defects produced it, and neither is visible in jsdom:
 *
 *  1. the plugin's native surface re-created the `files` takeover's slot
 *     registration on EVERY store write, and the store notifies on each
 *     expand/collapse. Replacing a slot registration replaces the host's slot
 *     entry, so the native tab BODY was unmounted and remounted: the explorer
 *     lost its level cache, its scroll position and its directory watcher, and
 *     re-listed the whole visible set every time a folder was toggled;
 *  2. a live-refresh notice dropped the cached level before re-listing it, so
 *     the rows of a directory that changed on disk were replaced by a loading
 *     placeholder and rebuilt.
 *
 * This lane is the real-browser counterpart of the two unit guards
 * (tests/native-surface.spec.ts, tests/file-tree-batch-load.spec.tsx): jsdom
 * cannot see the host's slot machinery, so only a mounted `dsh web` can prove
 * the body survives a toggle. It drives the plugin's own Files tab in DSH's
 * native right Sidebar over a workspace with a 40-child directory and records,
 * per phase, every `fs.trees`/`fs.tree` request with its payload paths, every
 * `/sidebar/ws/fs-watch` frame, the tree-body replacements and an rAF census of
 * the live rows.
 *
 * The gate:
 *   A1  the first request after a toggle names the TOGGLED level only
 *       (asking for [root, ...expanded] is the empty-cache signature of a
 *       fresh mount);
 *   A2  the tree body survives every toggle (no unmount/remount, no reopened
 *       watch socket);
 *   A3  rows that are on screen never drop to zero — not on a toggle and not
 *       when a directory changes behind the plugin.
 *
 * Phases wait for QUIESCENCE (no new request, frame or DOM batch for a quiet
 * window) rather than a fixed sleep, so a slow machine widens the window
 * instead of racing it.
 *
 * NOTE: this lane seeds its own workspace + session, and DSH renders the
 * session that is current — so it runs LAST (the `zz-` prefix) for the same
 * reason the mount lane runs first: a later lane's seeding must not change what
 * an earlier lane's tree shows.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { PAGE_URL, createHostApi, hostRpc, sendFirstMessage } from './host'

/** This lane's own workspace: a 40-child directory plus a small sibling. */
const WORKSPACE_PATH = process.env.DSH_E2E_EXPAND_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-expand-probe')
/** The big directory's name and its child count (the reader's scenario). */
const BIG = 'big'
const BIG_CHILDREN = 40
/** Quiescence: how long nothing may happen before a phase is read. */
const QUIET_MS = 500
/** Minimum reaction window: the watcher debounce (150ms) plus the round trip. */
const MIN_PHASE_MS = 800
const QUIET_MAX_MS = 4_000

let api: APIRequestContext

function seedWorkspace(): void {
  // The lane owns this directory and every run starts from the same tree: a
  // leftover file from an earlier run would already be listed, so the
  // behind-the-plugin write below would change nothing on screen.
  rmSync(WORKSPACE_PATH, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE_PATH, BIG), { recursive: true })
  mkdirSync(join(WORKSPACE_PATH, 'bravo'), { recursive: true })
  for (let i = 0; i < BIG_CHILDREN; i++) {
    writeFileSync(join(WORKSPACE_PATH, BIG, `file-${String(i).padStart(2, '0')}.txt`), `child ${i}\n`)
  }
  writeFileSync(join(WORKSPACE_PATH, 'bravo', 'z.txt'), 'z\n')
  writeFileSync(join(WORKSPACE_PATH, 'top.txt'), 'top\n')
}

test.beforeAll(async () => {
  api = await createHostApi()
  seedWorkspace()
  const workspace = await hostRpc<{ workspace: { workspaceId: string } }>(api, 'workspace.create', { path: WORKSPACE_PATH })
  await hostRpc(api, 'session.create', { workspaceId: workspace.value.workspace.workspaceId })
})

test.afterAll(async () => { await api?.dispose() })

async function dismissOnboarding(page: Page): Promise<void> {
  try {
    await expect
      .poll(() => page.getByRole('button', { name: /^(Continue|Configure later)$/ }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
  } catch { /* a build without onboarding proceeds straight to the tree */ }
  for (let round = 0; round < 8; round++) {
    let dismissed = false
    for (const name of ['Continue', 'Configure later']) {
      const button = page.getByRole('button', { name, exact: true }).first()
      if ((await button.count()) === 0) continue
      try { await button.click({ timeout: 4_000 }); dismissed = true; await page.waitForTimeout(1_000) } catch { /* masked */ }
    }
    if (!dismissed) break
  }
}

/**
 * Install the census: follow the pane's tree body (through a replacement, so a
 * remount is recorded without zeroing the measurement), count — every frame —
 * the live rows under the big directory, and log every document-level batch
 * that removed a native tab host or a whole run of rows.
 */
const INSTALL_CENSUS = `(() => {
  const bodies = () => [...document.querySelectorAll('[class*="explorerBody"]')]
  const findTree = () => bodies().find(el => el.getBoundingClientRect().height > 0
    && [...el.querySelectorAll('[class*="explorerName"]')].some(span => span.textContent === '${BIG}'))
  const first = findTree()
  if (first === undefined) return 'no tree body'
  first.setAttribute('data-expand-probe', 'target')
  const state = {
    changes: [], batches: [], added: 0, removed: 0,
    replacedBodies: 0, killedRows: 0, marks: [], minBig: Infinity, sawBig: 0, emptyFrames: 0,
  }
  let seq = 0
  const seen = new Map()
  const census = () => {
    const now = Math.round(performance.now())
    const live = bodies().filter(el => el.getBoundingClientRect().height > 0 || el.querySelector('[class*="explorerRow"]'))
    for (const el of live) if (!seen.has(el)) { seq += 1; seen.set(el, seq); state.marks.push({ t: now, ev: 'tree-body-mount', seq }) }
    for (const [el, id] of [...seen]) if (!el.isConnected) { seen.delete(el); state.marks.push({ t: now, ev: 'tree-body-unmount', seq: id }) }
    const current = first.isConnected ? first : findTree()
    const bigRows = current === undefined ? -1 : current.querySelectorAll('[title*="/${BIG}/"]').length
    const rows = current === undefined ? -1 : current.querySelectorAll('[class*="explorerRow"]').length
    state.changes.push({ t: now, alive: first.isConnected ? 1 : 0, bodies: live.length, rows, bigRows })
    // The blanking detector: the low only counts from the moment rows are up
    // (an empty level before its first listing is not a blank frame). Collapsing
    // the folder legitimately empties it, so only the phases that keep it open
    // assert on this.
    if (bigRows > 0) state.sawBig = 1
    if (state.sawBig === 1 && bigRows >= 0) state.minBig = Math.min(state.minBig, bigRows)
    if (state.sawBig === 1 && bigRows === 0) state.emptyFrames += 1
  }
  new MutationObserver(records => {
    let added = 0, removed = 0, killedRows = 0, killedBodies = 0
    for (const record of records) {
      added += record.addedNodes.length
      removed += record.removedNodes.length
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue
        const cls = typeof node.className === 'string' ? node.className : ''
        if (cls.includes('nativeTabHost')) killedBodies += 1
        killedRows += node.querySelectorAll('[class*="explorerRow"]').length
      }
    }
    state.added += added
    state.removed += removed
    state.killedRows += killedRows
    state.replacedBodies += killedBodies
    // A placeholder that is not itself a row marks the frame a level was blanked.
    if (killedRows > 0) state.emptyFrames += 1
    state.batches.push({ t: Math.round(performance.now()), added, removed, killedRows, killedBodies })
    census()
  }).observe(document.body, { childList: true, subtree: true })
  const loop = () => { census(); requestAnimationFrame(loop) }
  requestAnimationFrame(loop)
  census()
  window.__census = { state }
  return 'installed'
})()`

test('a folder toggle re-lists that folder and nothing else', async ({ page }) => {
  // ── Node-side recorders (armed before navigation: the socket opens on mount) ──
  interface Req { t: number; kind: string; paths: string[] }
  const requests: Req[] = []
  interface Sock { id: number; sent: string[]; recv: string[] }
  const sockets: Sock[] = []
  const t0 = Date.now()
  const rel = (): number => Date.now() - t0

  page.on('request', (request) => {
    const url = request.url()
    const kind = url.includes('/sidebar/api/fs.trees') ? 'fs.trees'
      : url.includes('/sidebar/api/fs.tree') ? 'fs.tree'
        : /\/sidebar\/api\/git\./.test(url) ? 'git' : null
    if (kind === null) return
    let paths: string[] = []
    const body = request.postData()
    if (body !== null) {
      try {
        const parsed = JSON.parse(body) as { paths?: string[]; path?: string }
        paths = parsed.paths ?? (parsed.path === undefined ? [] : [parsed.path])
      } catch { /* non-JSON payload: leave the paths empty */ }
    }
    requests.push({ t: rel(), kind, paths })
  })
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/sidebar/ws/fs-watch')) return
    const sock: Sock = { id: sockets.length + 1, sent: [], recv: [] }
    sockets.push(sock)
    ws.on('framesent', (frame) => sock.sent.push(String(frame.payload)))
    ws.on('framereceived', (frame) => sock.recv.push(String(frame.payload)))
  })

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#root > *')).not.toHaveCount(0, { timeout: 90_000 })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 90_000 })
  await dismissOnboarding(page)
  await sendFirstMessage(page)

  const pane = page.locator('[data-sidebar-right-panel]')
  await page.locator('[data-sidebar-right-expand]').first().click()
  await expect(pane).toBeVisible({ timeout: 90_000 })
  const addTab = page.locator('[data-dockkit-add-tab]').first()
  if (await page.locator('[data-sidebar-right-guide]').count() === 0) await addTab.click()
  await page.locator('[data-sidebar-right-guide-entry="files"]').click()
  const dirRow = (name: string) => pane.locator(`[class*="explorerDir"]:has([class*="explorerName"]:text-is("${name}"))`)
  await expect(dirRow(BIG), 'the seeded big directory must be listed').toHaveCount(1, { timeout: 60_000 })
  await expect(
    pane.locator('[role="button"][title$="top.txt"]:visible'),
    'the root level must be listed before the toggle',
  ).toHaveCount(1, { timeout: 60_000 })

  const installed = await page.evaluate(INSTALL_CENSUS)
  expect(installed, 'the tree body must exist for the census').toBe('installed')

  /** A phase's readings, all read at once at the end of the phase. */
  interface Phase {
    phase: string
    requests: string[]
    sockets: number
    wsFrames: number
    added: number
    removed: number
    killedRows: number
    treeBodyReplaced: number
    emptyFrames: number
    minBigRows: number
    transitions: unknown[]
  }
  const phases: Phase[] = []
  /** Counters the quiescence wait compares: requests, frames and DOM batches. */
  const activity = (): number =>
    requests.length + sockets.reduce((sum, s) => sum + s.sent.length + s.recv.length, 0) + domBatch
  let domBatch = 0

  const runPhase = async (phase: string, action: (() => Promise<void>) | null): Promise<Phase> => {
    const reqBase = requests.length
    const sockBase = sockets.length
    await page.evaluate(() => {
      const probe = (window as unknown as { __census?: { state: Record<string, unknown> } }).__census
      if (probe === undefined) return
      Object.assign(probe.state, {
        changes: [], batches: [], marks: [], added: 0, removed: 0, replacedBodies: 0, killedRows: 0,
        minBig: Infinity, sawBig: 0, emptyFrames: 0,
      })
    })
    if (action !== null) await action()
    // Wait for quiescence instead of a fixed sleep: the phase ends when nothing
    // (network, socket, DOM) has moved for QUIET_MS, capped so a watcher loop
    // cannot hang the lane — a loop is exactly what the gate must catch.
    const started = Date.now()
    let last = activity()
    let quietSince = Date.now()
    while (Date.now() - started < QUIET_MAX_MS) {
      await page.waitForTimeout(50)
      const seen = await page.evaluate(() => {
        const probe = (window as unknown as { __census?: { state: { batches: unknown[] } } }).__census
        return probe?.state.batches.length ?? 0
      })
      domBatch = seen
      const now = activity()
      if (now !== last) { last = now; quietSince = Date.now(); continue }
      if (Date.now() - started >= MIN_PHASE_MS && Date.now() - quietSince >= QUIET_MS) break
    }
    const sample = await page.evaluate(() => {
      const probe = (window as unknown as { __census?: { state: Record<string, unknown> } }).__census
      if (probe === undefined) return null
      const s = probe.state as unknown as {
        changes: Array<{ t: number; alive: number; bodies: number; rows: number; bigRows: number }>
        marks: Array<{ t: number; ev: string; seq: number }>
        added: number; removed: number; replacedBodies: number; killedRows: number
        minBig: number; emptyFrames: number
      }
      // Collapse the rAF census to its transitions (what changed on screen).
      const transitions: typeof s.changes = []
      let lastKey = ''
      for (const entry of s.changes) {
        const key = `${entry.alive}/${entry.bodies}/${entry.rows}/${entry.bigRows}`
        if (key === lastKey) continue
        lastKey = key
        transitions.push(entry)
      }
      return {
        added: s.added, removed: s.removed, killedRows: s.killedRows, emptyFrames: s.emptyFrames,
        minBig: s.minBig === Infinity ? -1 : s.minBig,
        remounts: s.marks.filter(mark => mark.ev === 'tree-body-unmount').length,
        replacedBodies: s.replacedBodies,
        transitions,
      }
    })
    const phaseRequests = requests.slice(reqBase).filter(entry => entry.kind !== 'git')
      .map(entry => `${entry.kind}[${entry.paths.map(path => path.split('/').pop()).join(',')}]`)
    const phaseFrames = sockets.slice(sockBase)
      .flatMap(sock => [...sock.sent.map(frame => `sent#${sock.id} ${frame}`), ...sock.recv.map(frame => `recv#${sock.id} ${frame}`)])
    const result: Phase = {
      phase,
      requests: phaseRequests,
      sockets: sockets.length - sockBase,
      wsFrames: phaseFrames.length,
      added: sample?.added ?? -1,
      removed: sample?.removed ?? -1,
      killedRows: sample?.killedRows ?? -1,
      treeBodyReplaced: (sample?.replacedBodies ?? 0) > 0 || (sample?.remounts ?? 0) > 0 ? 1 : 0,
      emptyFrames: sample?.emptyFrames ?? -1,
      minBigRows: sample?.minBig ?? -1,
      transitions: sample?.transitions ?? [],
    }
    phases.push(result)
    console.log(`EXPAND_PHASE ${JSON.stringify(result)}`)
    return result
  }

  // A: the reported gesture — expanding the 40-child directory.
  const expand = await runPhase(`A-expand-${BIG}`, async () => {
    await dirRow(BIG).click({ position: { x: 8, y: 8 } })
  })
  // B: idle with the directory open — a watcher feedback loop would show up
  // here as requests arriving with nobody touching anything.
  const idle = await runPhase('B-idle', null)
  // C: a directory written BEHIND the plugin (a build, a formatter, the
  // model's own bash): the host notices and the tree re-lists exactly that
  // level, in place.
  const landed = `landed-${Date.now()}.txt`
  const external = await runPhase('C-external-write', async () => {
    writeFileSync(join(WORKSPACE_PATH, BIG, landed), 'landed\n')
  })
  // D: expanding a second directory while the first stays open.
  const sibling = await runPhase('D-expand-bravo', async () => {
    await dirRow('bravo').click({ position: { x: 8, y: 8 } })
  })
  // E: collapsing the first one back.
  const collapse = await runPhase(`E-collapse-${BIG}`, async () => {
    await dirRow(BIG).click({ position: { x: 8, y: 8 } })
  })

  console.log(`EXPAND_SUMMARY ${JSON.stringify(phases.map(phase => ({
    phase: phase.phase,
    requests: phase.requests,
    newSockets: phase.sockets,
    wsFrames: phase.wsFrames,
    domAdded: phase.added,
    domRemoved: phase.removed,
    rowsKilledWithSubtrees: phase.killedRows,
    treeBodyReplaced: phase.treeBodyReplaced,
    minBigRows: phase.minBigRows,
    emptyFramesAfterRowsUp: phase.emptyFrames,
    rowTransitions: phase.transitions,
  })), null, 1)}`)

  // A1: the toggle's own request names the toggled level only.
  expect(
    expand.requests[0],
    'expanding a folder must ask for that folder, not the whole visible set',
  ).toBe(`fs.trees[${BIG}]`)
  // D is prefetch-AWARE, and zero requests here is a CACHE HIT, not a missing
  // expansion. The host's `probeCompactRows` marks a directory whose sole
  // child is a FILE as `compact` too — deliberately, so the client can preload
  // marked levels and stabilize the fold label before expansion — and `bravo`
  // holds exactly one file. The compact-preload effect in FileTree.tsx
  // (`loadLevels(compactLoadTargets(...))`) therefore lists `bravo` whenever
  // the LEVEL CACHE CHANGES (the root listing arriving is enough), while it is
  // still collapsed. The click then renders straight from that cache: no
  // request, but the child row does appear. Both readings are accepted, and
  // the guard this phase really owes is the second one — bounding the SCOPE:
  // whatever it asks for must be exactly the toggled level, never a payload
  // carrying the root or the whole visible set (that is the empty-cache
  // signature of a fresh mount, which is what used to re-list everything on
  // every toggle). Do NOT "fix" the zero back into an expected request: an
  // expansion is not supposed to re-list anything it already has.
  expect(
    sibling.requests.length,
    'expanding a prefetched compact level lists at most that one level',
  ).toBeLessThanOrEqual(1)
  for (const request of sibling.requests) {
    expect(request, 'expanding a sibling must ask for the sibling, never a wider set').toBe('fs.trees[bravo]')
  }
  expect(
    sibling.added,
    'the prefetched level must still render its child row (zero requests while rows appear)',
  ).toBeGreaterThanOrEqual(1)
  // A2: the tree body survives every toggle. A replaced body unmounts the
  // explorer — level cache, scroll position and directory watcher with it —
  // and a reopened socket re-announces its whole watch set.
  for (const phase of [expand, sibling, collapse]) {
    expect(phase.treeBodyReplaced, `${phase.phase}: the tab body must not be replaced`).toBe(0)
    expect(phase.sockets, `${phase.phase}: the watch socket must not be re-opened`).toBe(0)
  }
  // A3: rows on screen never drop to zero.
  expect(expand.emptyFrames, 'the expand must not blank the level').toBe(0)
  expect(external.emptyFrames, 'a live refresh must not blank the level').toBe(0)
  expect(external.minBigRows, 'the live refresh must keep the level on screen').toBe(BIG_CHILDREN)
  // …and neither the idle folder nor the collapse re-lists anything.
  expect(idle.requests, 'an idle open folder must not re-list').toEqual([])
  expect(collapse.requests, 'collapsing must not re-list anything').toEqual([])
  expect(collapse.killedRows, 'collapsing only removes the level it closes').toBe(0)
})
