/**
 * Per-session sidebar state: the bottom workbench's split-pane tree, open
 * tabs, and the explorer expansion set. One state instance per conversation
 * id, persisted to localStorage under `dsh-sidebar:v1:<id>` so a reload
 * restores the exact layout of the session it belongs to — switching
 * conversations swaps the whole state (memory + isolation).
 *
 * The split tree is a recursive structure: a leaf holds a tab group, a split
 * divides the space row- or column-wise with fractional sizes. All tree
 * operations are pure functions over the node, unit-tested in tests/state.spec.ts.
 */
import { SIDEBAR_PREFS_DEFAULTS, type SidebarPrefs } from '../prefs-shared.ts'

/**
 * Tab type identifier. Builtins register their ids (editor / git / terminal
 * / subagent / browser / diff) through the sidebar service; external
 * plugins register their own (e.g. `'my-plugin:db'`). Kept as `string` so
 * the registry stays open.
 */
export type TabType = string

/** What a diff tab shows: a worktree/index change of one path, or one commit's full patch. */
export type SidebarDiffRef =
  | { kind: 'worktree'; path: string; staged: boolean; untracked?: boolean; worktree?: string; repoRoot?: string }
  | { kind: 'commit'; hash: string; hashFull: string; subject: string; worktree?: string; repoRoot?: string }

/** One open tab. `path` carries the file (editor) or is absent (git/terminal);
 *  `diff` carries the change a diff tab shows; `meta` (v0.12.0+) carries
 *  plugin-owned JSON-serializable state, preserved across reloads. */
export interface SidebarTab {
  id: string
  type: TabType
  title: string
  path?: string
  diff?: SidebarDiffRef
  /** Plugin-owned state (v0.12.0+): MUST be JSON-serializable — it is
   *  persisted with the layout and restored verbatim on reload. */
  meta?: unknown
}

/** A tab group. */
export interface SidebarLeaf {
  kind: 'leaf'
  id: string
  tabs: SidebarTab[]
  active: string | null
}

/** A recursive split between child panes (fractional sizes summing to 1). */
export interface SidebarSplit {
  kind: 'split'
  id: string
  dir: 'row' | 'col'
  sizes: number[]
  children: SplitNode[]
}

export type SplitNode = SidebarLeaf | SidebarSplit

/** The full per-session state. */
export interface SidebarState {
  /** The pane receiving newly opened tabs (the last pane the user touched). */
  activePane: string | null
  /** Monotonic browser tab counter (ids survive reloads). */
  nextBrowser: number
  /** Explorer expansion set (absolute directory paths). */
  expanded: string[]
  /**
   * Explorer rows highlighted by a "Show in folder" reveal (absolute paths).
   * Transient by design: sanitizeState never restores it, so a reload starts
   * unhighlighted.
   */
  revealed: string[]
  /** Whether the bottom panel (the plugin's one workbench) is open. */
  bottomOpen: boolean
  /** The bottom panel's height (clamped to the contract range). */
  bottomHeight: number
  /** The bottom workbench's split tree. */
  bottomSplits: SplitNode
}

export const TAB_MAX_WIDTH = 160
/** Bottom panel geometry contract (the upper bound is the viewport, enforced
 *  by {@link setBottomHeight}). */
export const BOTTOM_MIN = 120
export const BOTTOM_DEFAULT = 220
/** The conversation column keeps at least this much height when the bottom
 *  workbench claims space (see {@link setBottomHeight}). */
export const CONVERSATION_MIN = 280

let nextIdCounter = 0
/** Unique pane/tab id within one state instance. */
function uid(prefix: string): string {
  nextIdCounter += 1
  return `${prefix}:${nextIdCounter}`
}

/** Mint a fresh uid-based tab id. The `'editor:' + path` convention only
 *  covers openSidebarFile opens (per-path dedupe); opens that must not
 *  dedupe (the tree's "open to the side") mint through here. */
export function mintTabId(): string {
  return uid('tab')
}

/**
 * The largest numeric suffix across a raw persisted state's counter ids
 * (`pane:N` / `tab:N` / `split:N`). The uid counter is module-global and
 * resets on every reload, so a split minted AFTER a reload would collide
 * with the persisted ids (a fresh "pane:1" beside the persisted "pane:1");
 * mapLeaf would then visit BOTH leaves and every open would land in both
 * panes of the split. Seeding the counter past the persisted ids keeps
 * fresh ids disjoint.
 */
function maxCounterId(parsed: unknown): number {
  let max = 0
  const consider = (id: unknown): void => {
    if (typeof id !== 'string') return
    const match = /^(?:pane|tab|split):(\d+)$/.exec(id)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    consider(record.id)
    if (Array.isArray(record.tabs)) {
      for (const tab of record.tabs) {
        if (tab !== null && typeof tab === 'object') consider((tab as Record<string, unknown>).id)
      }
    }
    if (Array.isArray(record.children)) {
      for (const child of record.children) walk(child)
    }
  }
  walk((parsed as Record<string, unknown> | null)?.bottomSplits)
  return max
}

/**
 * A fresh default state: one empty pane in the bottom workbench, closed.
 * (The right column belongs to DSH's native Sidebar, so this plugin's own
 * layout has nothing to seed — its welcome cards offer the openable types on
 * first expansion.)
 */
export function makeDefaultState(): SidebarState {
  const bottomLeaf: SidebarLeaf = { kind: 'leaf', id: uid('pane'), tabs: [], active: null }
  return {
    activePane: bottomLeaf.id,
    nextBrowser: 1,
    expanded: [],
    revealed: [],
    bottomOpen: false,
    bottomHeight: BOTTOM_DEFAULT,
    bottomSplits: bottomLeaf,
  }
}

/** Walk the tree and apply `visit` to the leaf with the given id. */
export function mapLeaf(node: SplitNode, paneId: string, visit: (leaf: SidebarLeaf) => void): SplitNode {
  if (node.kind === 'leaf') {
    if (node.id === paneId) {
      const copy: SidebarLeaf = { ...node, tabs: [...node.tabs] }
      visit(copy)
      return copy
    }
    return node
  }
  const split = node
  return {
    ...split,
    sizes: [...split.sizes],
    children: split.children.map(child => mapLeaf(child, paneId, visit)),
  }
}

/** The first leaf of the tree (fallback pane when activePane is gone). */
export function firstLeaf(node: SplitNode): SidebarLeaf {
  if (node.kind === 'leaf') return node
  return firstLeaf(node.children[0]!)
}

/** Find the leaf containing a tab id, if any. */
export function leafWithTab(node: SplitNode, tabId: string): SidebarLeaf | undefined {
  if (node.kind === 'leaf') {
    return node.tabs.some(tab => tab.id === tabId) ? node : undefined
  }
  for (const child of node.children) {
    const found = leafWithTab(child, tabId)
    if (found !== undefined) return found
  }
  return undefined
}

/** All leaves of the tree, depth-first. */
export function allLeaves(node: SplitNode): SidebarLeaf[] {
  if (node.kind === 'leaf') return [node]
  return node.children.flatMap(allLeaves)
}

/** Whether a tab is open anywhere in the session's workbench. */
export function tabOpenIn(state: SidebarState, tabId: string): boolean {
  return allLeaves(state.bottomSplits).some(leaf => leaf.tabs.some(tab => tab.id === tabId))
}

/** Replace a leaf with a split of it plus a fresh empty leaf. */
export function splitLeafAt(node: SplitNode, paneId: string, dir: 'row' | 'col'): SplitNode {
  const fresh: SidebarLeaf = { kind: 'leaf', id: uid('pane'), tabs: [], active: null }
  return mapLeaf(node, paneId, (leaf) => {
    const target: SidebarLeaf = { ...leaf }
    const split: SidebarSplit = {
      kind: 'split',
      id: uid('split'),
      dir,
      sizes: [0.5, 0.5],
      children: [target, fresh],
    }
    Object.assign(leaf, split)
  })
}

/**
 * Split a leaf by inserting a fresh leaf holding `tab` beside it — the
 * VSCode drag-to-edge gesture. `dir` is the split direction ('row' for
 * left/right, 'col' for up/down); `front` places the new leaf first (left/
 * up) or second (right/down).
 * @returns the new tree plus the fresh leaf's id (the drop's active pane).
 */
export function insertLeafAt(
  node: SplitNode,
  paneId: string,
  dir: 'row' | 'col',
  tab: SidebarTab,
  front: boolean,
): { node: SplitNode; leafId: string } {
  const fresh: SidebarLeaf = { kind: 'leaf', id: uid('pane'), tabs: [tab], active: tab.id }
  const leafId = fresh.id
  const next = mapLeaf(node, paneId, (leaf) => {
    const target: SidebarLeaf = { ...leaf }
    const split: SidebarSplit = {
      kind: 'split',
      id: uid('split'),
      dir,
      sizes: [0.5, 0.5],
      children: front ? [fresh, target] : [target, fresh],
    }
    Object.assign(leaf, split)
  })
  return { node: next, leafId }
}

/** Where a tab drop lands on a pane: an edge creates a split, center merges. */
export type DropZone = 'left' | 'right' | 'up' | 'down' | 'center'

/**
 * The VSCode drag gesture: move a tab out of its pane and either merge it
 * into the target pane (center) or split the target pane with the tab in a
 * fresh leaf (edge). The source pane collapses when it empties.
 */
export function moveTabToEdge(
  state: SidebarState,
  fromPane: string,
  tabId: string,
  toPane: string,
  zone: DropZone,
): SidebarState {
  if (fromPane === toPane && zone === 'center') {
    // Dropped back onto its own pane's center: reorder to the end.
    return moveTab(state, fromPane, tabId, toPane, -1)
  }
  const node = state.bottomSplits
  const source = leafWithTab(node, tabId)
  if (source === undefined) return state
  const tab = source.tabs.find(candidate => candidate.id === tabId)!
  if (zone === 'center') {
    let emptied = false
    let splits = mapLeaf(node, source.id, (leaf) => {
      leaf.tabs = leaf.tabs.filter(candidate => candidate.id !== tabId)
      if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null
      if (leaf.tabs.length === 0) emptied = true
    })
    if (emptied) splits = removeLeafAt(splits, source.id)
    splits = mapLeaf(splits, toPane, (leaf) => {
      leaf.tabs = [...leaf.tabs, tab]
      leaf.active = tab.id
    })
    return { ...state, bottomSplits: splits, activePane: toPane }
  }
  // Edge zones split the target pane first, then lift the tab out of its
  // source pane. Doing it the other way around breaks a self-drop: removing
  // the tab empties the source leaf and removeLeafAt deletes it from the
  // tree, so insertLeafAt targets an id that no longer exists and the
  // dragged tab is silently discarded.
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'col'
  const inserted = insertLeafAt(node, toPane, dir, tab, zone === 'left' || zone === 'up')
  let emptied = false
  let splits = mapLeaf(inserted.node, source.id, (leaf) => {
    leaf.tabs = leaf.tabs.filter(candidate => candidate.id !== tabId)
    if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null
    if (leaf.tabs.length === 0) emptied = true
  })
  if (emptied) splits = removeLeafAt(splits, source.id)
  return { ...state, bottomSplits: splits, activePane: inserted.leafId }
}

/**
 * Remove a leaf from the tree. A split left with one child promotes that
 * child; removing the last leaf yields an empty leaf.
 */
export function removeLeafAt(node: SplitNode, paneId: string): SplitNode {
  if (node.kind === 'leaf') return node.id === paneId ? { ...node, tabs: [], active: null } : node
  const children = node.children.filter(child => !(child.kind === 'leaf' && child.id === paneId))
  if (children.length === node.children.length) {
    return {
      ...node,
      sizes: [...node.sizes],
      children: node.children.map(child => removeLeafAt(child, paneId)),
    }
  }
  if (children.length === 1) return children[0]!
  return { ...node, sizes: [...node.sizes], children }
}

/** Close a tab; an emptied leaf is removed (unless it is the only pane). */
export function closeTab(state: SidebarState, paneId: string, tabId: string): SidebarState {
  const key = 'bottomSplits'
  let emptied = false
  const splits = mapLeaf(state[key], paneId, (leaf) => {
    leaf.tabs = leaf.tabs.filter(tab => tab.id !== tabId)
    if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null
    if (leaf.tabs.length === 0) emptied = true
  })
  return { ...state, [key]: emptied ? removeLeafAt(splits, paneId) : splits }
}

/** Activate a tab in its pane (the pane's own tree). */
export function activateTab(state: SidebarState, paneId: string, tabId: string): SidebarState {
  const key = 'bottomSplits'
  return {
    ...state,
    activePane: paneId,
    [key]: mapLeaf(state[key], paneId, (leaf) => {
      if (leaf.tabs.some(tab => tab.id === tabId)) leaf.active = tabId
    }),
  }
}

/** Update the display fields of one open tab (title / path / meta) without
 *  re-opening it. The browser tab persists its current URL and hostname
 *  title through this reducer so a reload restores the visited page. A
 *  missing tab id is a no-op. The tab may live in either tree or a free
 *  window. */
export function patchTab(
  state: SidebarState,
  tabId: string,
  patch: { title?: string; path?: string; meta?: unknown },
): SidebarState {
  let changed = false
  const apply = (tab: SidebarTab): SidebarTab => {
    changed = true
    return {
      ...tab,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.path !== undefined ? { path: patch.path } : {}),
      ...(patch.meta !== undefined ? { meta: patch.meta } : {}),
    }
  }
  const walk = (node: SplitNode): SplitNode => {
    if (node.kind === 'leaf') {
      const tabs = node.tabs.map(tab => (tab.id === tabId ? apply(tab) : tab))
      return tabs === node.tabs ? node : { ...node, tabs }
    }
    const children = node.children.map(walk)
    return children === node.children ? node : { ...node, children }
  }
  const bottomSplits = walk(state.bottomSplits)
  return changed ? { ...state, bottomSplits } : state
}

/**
 * Land a tab in the workbench's first pane — the plugin's own opens (its
 * bottom-panel + menu, and every open when no native surface is installed):
 * the plugin owns no right column any more (DSH's native sidebar is the
 * right one), so the bottom workbench is the only tree.
 * @param state - the session state.
 * @param tab - the tab to land.
 * @returns the next state, with the bottom panel open.
 */
export function openTabInBottomPane(state: SidebarState, tab: SidebarTab): SidebarState {
  const targetId = firstLeaf(state.bottomSplits).id
  // Id-based safety net: if a tab with the same id exists, focus it.
  for (const leaf of allLeaves(state.bottomSplits)) {
    const existing = leaf.tabs.find(candidate => candidate.id === tab.id)
    if (existing !== undefined) return activateTab(state, leaf.id, existing.id)
  }
  return {
    ...state,
    bottomOpen: true,
    activePane: targetId,
    bottomSplits: mapLeaf(state.bottomSplits, targetId, (leaf) => {
      leaf.tabs = [...leaf.tabs, tab]
      leaf.active = tab.id
    }),
  }
}

/** Move a tab from one pane to another (insert at index; -1 appends).
 *  The panes may live in DIFFERENT trees — dragging a tab between the two
 *  panels removes it from its own tree and lands it in the other one. */
export function moveTab(state: SidebarState, fromPane: string, tabId: string, toPane: string, index = -1): SidebarState {
  const fromKey = 'bottomSplits'
  const toKey = 'bottomSplits'
  if (fromKey !== toKey) {
    let moved: SidebarTab | undefined
    let emptied = false
    const source = mapLeaf(state[fromKey], fromPane, (leaf) => {
      const found = leaf.tabs.find(tab => tab.id === tabId)
      if (found === undefined) return
      moved = found
      leaf.tabs = leaf.tabs.filter(tab => tab.id !== tabId)
      if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null
      if (leaf.tabs.length === 0) emptied = true
    })
    if (moved === undefined) return state
    const target = mapLeaf(state[toKey], toPane, (leaf) => {
      const insertAt = index >= 0 && index <= leaf.tabs.length ? index : leaf.tabs.length
      leaf.tabs = [...leaf.tabs.slice(0, insertAt), moved!, ...leaf.tabs.slice(insertAt)]
      leaf.active = moved!.id
    })
    return {
      ...state,
      [fromKey]: emptied ? removeLeafAt(source, fromPane) : source,
      [toKey]: target,
      activePane: toPane,
    }
  }
  let moved: SidebarTab | undefined
  let emptied = false
  let splits = mapLeaf(state[fromKey], fromPane, (leaf) => {
    const found = leaf.tabs.find(tab => tab.id === tabId)
    if (found === undefined) return
    moved = found
    leaf.tabs = leaf.tabs.filter(tab => tab.id !== tabId)
    if (leaf.active === tabId) leaf.active = leaf.tabs[leaf.tabs.length - 1]?.id ?? null
    if (leaf.tabs.length === 0) emptied = true
  })
  if (moved === undefined) return state
  if (emptied) splits = removeLeafAt(splits, fromPane)
  splits = mapLeaf(splits, toPane, (leaf) => {
    const insertAt = index >= 0 && index <= leaf.tabs.length ? index : leaf.tabs.length
    leaf.tabs = [...leaf.tabs.slice(0, insertAt), moved!, ...leaf.tabs.slice(insertAt)]
    leaf.active = moved!.id
  })
  return { ...state, [fromKey]: splits, activePane: toPane }
}

/** Split the active pane (or the pane containing the active tab). */
export function splitPane(state: SidebarState, dir: 'row' | 'col'): SidebarState {
  const paneId = state.activePane ?? firstLeaf(state.bottomSplits).id
  const key = 'bottomSplits'
  return { ...state, [key]: splitLeafAt(state[key], paneId, dir) }
}

/**
 * Open a diff tab the VSCode way: an existing instance of the same change is
 * focused wherever it lives; otherwise the tab joins the first pane that
 * already holds diff tabs (diff panes are sticky — repeated clicks stack
 * there); on the FIRST diff of a layout the source pane splits vertically so
 * the diff lands in a fresh pane below it ("默认在下半栏新增一个").
 *
 * This is split-tree placement surgery, not registry dispatch: the diff tab
 * descriptor's `dedupeKey` is `(tab) => tab.id`, and the existing-instance
 * check below is exactly that rule — the two agree by construction (asserted
 * in tests). Diff tabs minted by the Git view carry change-derived ids, so
 * the id check is the per-change dedupe.
 * @returns the new state, with the diff pane active.
 */
export function openDiffTab(state: SidebarState, sourcePaneId: string, tab: SidebarTab): SidebarState {
  const existingLeaf = leafWithTab(state.bottomSplits, tab.id)
  if (existingLeaf !== undefined) return activateTab(state, existingLeaf.id, tab.id)
  const diffLeaf = allLeaves(state.bottomSplits).find(leaf => leaf.tabs.some(candidate => candidate.type === 'diff'))
  if (diffLeaf !== undefined) {
    return {
      ...state,
      activePane: diffLeaf.id,
      bottomSplits: mapLeaf(state.bottomSplits, diffLeaf.id, (leaf) => {
        leaf.tabs = [...leaf.tabs, tab]
        leaf.active = tab.id
      }),
    }
  }
  // First diff: split the source pane, the diff tab in the new LOWER leaf.
  // (A stale sourcePaneId — its pane closed meanwhile — degrades to the
  // regular open path instead of dropping the tab into an orphaned leaf.)
  if (!allLeaves(state.bottomSplits).some(leaf => leaf.id === sourcePaneId)) {
    return openTabInBottomPane(state, tab)
  }
  const result = insertLeafAt(state.bottomSplits, sourcePaneId, 'col', tab, false)
  return { ...state, bottomSplits: result.node, activePane: result.leafId }
}

/** Expand/collapse the bottom workbench. */
export function toggleBottomPanel(state: SidebarState): SidebarState {
  return { ...state, bottomOpen: !state.bottomOpen }
}

/** Set the bottom workbench height (clamped to the contract range). The
 * upper bound leaves the conversation column at least {@link CONVERSATION_MIN}
 * tall — without the cap the workbench could swallow the whole viewport and
 * squeeze the conversation to zero height. */
export function setBottomHeight(state: SidebarState, height: number): SidebarState {
  const viewport = typeof window !== 'undefined' ? window.innerHeight : Infinity
  const max = Math.max(BOTTOM_MIN, viewport - CONVERSATION_MIN)
  return { ...state, bottomHeight: Math.min(max, Math.max(BOTTOM_MIN, Math.round(height))) }
}

/** Toggle a directory in the explorer expansion set. */
export function toggleExpanded(state: SidebarState, path: string): SidebarState {
  const expanded = state.expanded.includes(path)
    ? state.expanded.filter(item => item !== path)
    : [...state.expanded, path]
  return { ...state, expanded }
}

/**
 * Reveal files in the explorer: expand every ancestor directory between the
 * explorer root and each file (so the lazy tree actually shows the row) and
 * record the paths for highlighting. The reveal set is transient —
 * sanitizeState never restores it, so a reload starts unhighlighted.
 * @param state - current sidebar state.
 * @param cwd - the explorer's root (session working directory).
 * @param files - absolute paths to highlight (parent dirs are expanded).
 * @returns the next state, or the same reference when nothing is revealed.
 */
export function revealPaths(state: SidebarState, cwd: string | undefined, files: readonly string[]): SidebarState {
  const expanded = new Set(state.expanded)
  const revealed: string[] = []
  const rootParts = (cwd ?? '').split(/[\\/]+/).filter(part => part !== '')
  for (const file of files) {
    if (typeof file !== 'string' || file === '') continue
    revealed.push(file)
    const parts = file.split(/[\\/]+/).filter(part => part !== '' && part !== '.')
    const separator = file.includes('\\') ? '\\' : '/'
    // Keep the original leading separator(s) when rebuilding ancestor dirs:
    // FileTree matches expansion against ABSOLUTE paths, so dropping the
    // root (POSIX `/w/src` �W `w/src`) or a UNC prefix (`\\server\share`)
    // would leave every ancestor collapsed and the row unreachable.
    const prefix = file.startsWith('/') ? '/' : file.startsWith('\\\\') ? '\\\\' : file.startsWith('\\') ? '\\' : ''
    for (let i = rootParts.length; i < parts.length - 1; i++) {
      expanded.add(prefix + parts.slice(0, i + 1).join(separator))
    }
  }
  if (revealed.length === 0) return state
  return { ...state, expanded: [...expanded], revealed }
}

/** Adjust one split divider: `i` is the left/top child index, delta in fractions. */
export function resizeSplit(node: SplitNode, splitId: string, index: number, delta: number): SplitNode {
  if (node.kind === 'leaf') return node
  if (node.id === splitId) {
    const sizes = [...node.sizes]
    const left = Math.min(0.92, Math.max(0.08, sizes[index]! + delta))
    const right = Math.min(0.92, Math.max(0.08, sizes[index + 1]! - delta))
    sizes[index] = left
    sizes[index + 1] = right
    return { ...node, sizes }
  }
  return {
    ...node,
    sizes: [...node.sizes],
    children: node.children.map(child => resizeSplit(child, splitId, index, delta)),
  }
}

/** State-level {@link resizeSplit} route: the divider may live in either
 *  tree (split ids are globally unique). */
export function resizeSplitIn(state: SidebarState, splitId: string, index: number, delta: number): SidebarState {
  const key = 'bottomSplits'
  return { ...state, [key]: resizeSplit(state[key], splitId, index, delta) }
}

// ── The per-session store ──────────────────────────────────────────────────

const STORAGE_PREFIX = 'dsh-sidebar:v1'

/**
 * Cross-session panel width: the last dragged width, shared by EVERY
 * conversation (the panel width is a layout preference, not per-session
 * content). Written on every persist, read at session load and on
 * cache-hit session switches, so a drag in one conversation carries to all
 * the others (last drag wins).
 */
/** Immutable snapshot handed to React (replaced only on real changes). */
export interface SidebarSnapshot {
  sessionId: string | undefined
  state: SidebarState | undefined
  /**
   * The current side card prefs. Carried IN the snapshot (not a separate
   * subscription) so prefs changes re-render the consumers that gate on
   * them — the + menu hides a tab type the moment its switch flips.
   */
  prefs: SidebarPrefs
}

/**
 * URL escape hatch (#369): loading the app with `?dsh-sidebar-reset` drops
 * the persisted layout for the session instead of restoring it. When a
 * restored tab hangs the page on mount (the #369 freeze loop), reloading
 * into the same state replays the hang forever; this param starts from the
 * default layout and clears the stored copy, breaking the loop. Persisting
 * resumes as soon as the param is gone from the URL.
 */
const RESET_PARAM = 'dsh-sidebar-reset'

/** Whether the current page load asked for a persisted-state reset. */
function resetRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).has(RESET_PARAM)
  } catch {
    return false
  }
}

function loadState(sessionId: string): SidebarState {
  const reset = resetRequested()
  if (reset) {
    try {
      localStorage.removeItem(`${STORAGE_PREFIX}:${sessionId}`)
    } catch {
      // Storage unavailable: the default layout below is still the escape.
    }
  }
  if (!reset) {
    try {
      const raw = localStorage.getItem(`${STORAGE_PREFIX}:${sessionId}`)
      if (raw !== null) {
        const parsed = JSON.parse(raw) as unknown
        // Seed the uid counter past the persisted ids (it resets on reload);
        // sanitize re-ids any duplicates the pre-seeding counter left behind.
        nextIdCounter = maxCounterId(parsed)
        const sanitized = sanitizeState(parsed)
        if (sanitized !== undefined) return sanitized
      }
    } catch {
      // Corrupt or unavailable storage: fall through to the default.
    }
  }
  return makeDefaultState()
}

/**
 * Structural validation of one persisted state. A malformed or stale shape
 * (older layouts, hand-edited storage) must fall back to the default instead
 * of crashing the panel on every reload; the restored width is also clamped
 * to the current viewport so a stale fullscreen width can never crush the
 * app shell (margin-right larger than the window) or cover the whole screen.
 * @returns a clean state, or undefined to fall back to the default.
 */
export function sanitizeState(parsed: unknown): SidebarState | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  // A missing or malformed counter defaults to 1 rather than rejecting the
  // whole layout: these counters only name NEW tabs, so restarting one at 1
  // can at worst reuse a free id, while refusing the state would drop every
  // open tab of a session that was persisted by an older build.
  const nextBrowser = typeof record.nextBrowser === 'number' && Number.isInteger(record.nextBrowser) && record.nextBrowser >= 1
    ? record.nextBrowser
    : 1
  if (typeof record.activePane !== 'string' && record.activePane !== null) return undefined
  if (!Array.isArray(record.expanded) || record.expanded.some(item => typeof item !== 'string')) return undefined
  // Pane/split ids must be globally unique (the runtime uid counter is
  // shared), so a duplicate id gets a fresh one.
  const seen = new Set<string>()
  const reid = new Map<string, string>()
  // Workbench fields arrived in a later build: a missing or malformed value
  // on an OLDER persisted state defaults (closed / default height / empty
  // pane) so existing layouts keep loading, like nextBrowser.
  const bottomOpen = record.bottomOpen === true
  // Cap the persisted height so the conversation column (the agent output
  // area) keeps a usable minimum (a stale full-height panel from an older
  // build must never squeeze the conversation to zero). The cap is
  // setBottomHeight's own contract, or a restored height would snap on the
  // first drag.
  const maxHeight = typeof window !== 'undefined' ? window.innerHeight : Infinity
  const bottomCap = Math.max(BOTTOM_MIN, maxHeight - CONVERSATION_MIN)
  const rawHeight = typeof record.bottomHeight === 'number' && Number.isFinite(record.bottomHeight)
    ? record.bottomHeight
    : BOTTOM_DEFAULT
  const bottomHeight = Math.min(bottomCap, Math.max(BOTTOM_MIN, Math.round(rawHeight)))
  const bottomSplits = pruneEmptyPanes(sanitizeNode(record.bottomSplits, seen, reid)
    ?? { kind: 'leaf' as const, id: uid('pane'), tabs: [], active: null })
  const requestedActivePane = typeof record.activePane === 'string'
    ? (reid.get(record.activePane) ?? record.activePane)
    : null
  const activePane = requestedActivePane === null
    ? null
    : allLeaves(bottomSplits).some(leaf => leaf.id === requestedActivePane)
      ? requestedActivePane
      : firstLeaf(bottomSplits).id
  return {
    // A stale duplicate pane id may have been re-ided; follow the rename so
    // new tabs still land in the pane the user was using.
    activePane,
    nextBrowser,
    expanded: record.expanded as string[],
    revealed: [],
    bottomOpen,
    bottomHeight,
    bottomSplits,
  }
}

/** Collapse persisted split panes left empty after ephemeral diff tabs are dropped. */
function pruneEmptyPanes(node: SplitNode): SplitNode {
  const leaves = allLeaves(node)
  if (!leaves.some(leaf => leaf.tabs.length > 0)) return node
  return leaves.reduce(
    (tree, leaf) => leaf.tabs.length === 0 ? removeLeafAt(tree, leaf.id) : tree,
    node,
  )
}

/**
 * One tree node id, deduplicated against the ids already seen in this
 * state. Duplicates are exactly the pre-seeding counter-reset corruption
 * (a "pane:1"/"split:1" minted after a reload beside the persisted ones):
 * keeping both would make mapLeaf visit two leaves at once and every open
 * would land in both panes, so the repeat gets a fresh id.
 * @returns the id to use (the original, or a fresh uid for repeats).
 */
function uniqueNodeId(id: string, seen: Set<string>, reid: Map<string, string>): string {
  if (!seen.has(id)) {
    seen.add(id)
    return id
  }
  const prefix = /^split:\d+$/.test(id) ? 'split' : 'pane'
  const fresh = uid(prefix)
  seen.add(fresh)
  reid.set(id, fresh)
  return fresh
}

/**
 * Validate one persisted tab record. @returns the clean tab, `'diff'` for an
 * ephemeral diff tab (dropped everywhere — diff tabs never survive a reload),
 * or undefined when the record is malformed (structural corruption when it
 * comes from a split-tree leaf; a malformed FLOAT tab only drops the window).
 */
function sanitizePersistedTab(tab: unknown): SidebarTab | 'diff' | undefined {
  if (tab === null || typeof tab !== 'object') return undefined
  const candidate = tab as Record<string, unknown>
  if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string') return undefined
  if (candidate.type === 'diff') return 'diff'
  // Tab types are an open set (external plugins register their own); accept
  // any string type here — an unregistered type renders an <OrphanedTab/> at
  // view time and recovers if its plugin loads later.
  if (typeof candidate.type !== 'string') return undefined
  // The standalone explorer tab type merged INTO the editor (the single
  // files window): a persisted explorer tab reopens as an editor home tab —
  // no path, tree panel open (an existing meta object survives).
  if (candidate.type === 'explorer') {
    const meta = candidate.meta !== null && typeof candidate.meta === 'object' && !Array.isArray(candidate.meta)
      ? candidate.meta as Record<string, unknown>
      : undefined
    return { id: candidate.id, type: 'editor', title: 'Files', meta: { treeOpen: true, ...meta } }
  }
  // `meta` is plugin-owned JSON-serializable state (v0.12.0+): the persisted
  // value already went through JSON.parse, so it is inherently serializable —
  // carry it through verbatim (absent on older states).
  const result: SidebarTab = {
    id: candidate.id,
    type: candidate.type,
    title: candidate.title,
    ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
    ...(candidate.meta !== undefined ? { meta: candidate.meta } : {}),
  }
  // A persisted `pin` (the removed pinned-terminal marker) is simply not
  // copied into the rebuilt tab: only known fields survive, so a stale
  // layout loads unpinned instead of failing validation.
  return result
}

/** Validate one split-tree node (leaf or split) and rebuild it cleanly. */
function sanitizeNode(node: unknown, seen: Set<string>, reid: Map<string, string>): SplitNode | undefined {
  if (node === null || typeof node !== 'object') return undefined
  const record = node as Record<string, unknown>
  if (record.kind === 'leaf') {
    if (typeof record.id !== 'string' || !Array.isArray(record.tabs)) return undefined
    const tabs: SidebarTab[] = []
    let droppedDiff = false
    for (const tab of record.tabs) {
      const clean = sanitizePersistedTab(tab)
      if (clean === undefined) return undefined
      if (clean === 'diff') {
        droppedDiff = true
        continue
      }
      tabs.push(clean)
    }
    const active = typeof record.active === 'string' ? record.active : null
    // An active pointer into a dropped diff tab is expected after the drop;
    // any other missing active is structural corruption → reset the state.
    if (active !== null && !tabs.some(tab => tab.id === active) && !droppedDiff) return undefined
    return { kind: 'leaf', id: uniqueNodeId(record.id, seen, reid), tabs, active: active !== null && tabs.some(tab => tab.id === active) ? active : null }
  }
  if (record.kind === 'split') {
    if (typeof record.id !== 'string' || (record.dir !== 'row' && record.dir !== 'col')) return undefined
    if (!Array.isArray(record.children) || !Array.isArray(record.sizes)) return undefined
    const children: SplitNode[] = []
    for (const child of record.children) {
      const clean = sanitizeNode(child, seen, reid)
      if (clean === undefined) return undefined
      children.push(clean)
    }
    if (children.length < 2) return undefined
    if (
      record.sizes.length !== children.length
      || record.sizes.some(size => typeof size !== 'number' || !Number.isFinite(size) || size <= 0)
    ) {
      return undefined
    }
    return { kind: 'split', id: uniqueNodeId(record.id, seen, reid), dir: record.dir, sizes: record.sizes as number[], children }
  }
  return undefined
}

/** The session-scoped store: one state per conversation, localStorage-backed. */
export class SidebarStore {
  private readonly bySession = new Map<string, SidebarState>()
  private snapshot: SidebarSnapshot = {
    sessionId: undefined,
    state: undefined,
    prefs: { ...SIDEBAR_PREFS_DEFAULTS },
  }
  private readonly listeners = new Set<() => void>()
  /** Per-session persist debounce timers (v0.12.0+: one per session, so a
   *  targeted open never cancels another session's pending write). */
  private readonly persistTimers = new Map<string, number>()
  /** User-facing side card prefs seeding brand-new session states (defaults until the settings RPC resolves). */
  private prefs: SidebarPrefs = { ...SIDEBAR_PREFS_DEFAULTS }
  /**
   * External disable (the dsh-web-ui family's aionui-panel provider choice):
   * while true the sidebar must not mount at all. Not part of the snapshot —
   * nothing renders on it; the mount gate and the intercept predicates read
   * it directly.
   */
  private suspended = false

  /**
   * Set the external-disable flag (from the settings route) and remember it
   * for the mount gate and the intercept predicates.
   */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended
  }

  /** Whether the sidebar is externally disabled (aionui-panel chosen). */
  getSuspended(): boolean {
    return this.suspended
  }

  /**
   * Replace the side card prefs (the settings RPC result / settings page
   * write). Notifies like any store change: the snapshot carries the prefs,
   * so consumers that gate on enable switches (the + menu, derived flows)
   * re-render with the new values immediately.
   */
  setPrefs(prefs: SidebarPrefs): void {
    this.prefs = { ...prefs }
    this.snapshot = { ...this.snapshot, prefs: this.prefs }
    this.notify()
  }

  /** The current side card prefs (seeds new sessions; persisted states win). */
  getPrefs(): SidebarPrefs {
    return { ...this.prefs }
  }

  /** Select a session (or none); loads its persisted state. */
  setSession(sessionId: string | undefined): void {
    if (this.snapshot.sessionId === sessionId) return
    if (sessionId === undefined) {
      this.snapshot = { sessionId: undefined, state: undefined, prefs: this.prefs }
    } else {
      let state = this.bySession.get(sessionId)
      if (state === undefined) {
        state = loadState(sessionId)
        this.bySession.set(sessionId, state)
      } else {
        // Cache hit: another session's load/ops may have left the uid
        // counter below THIS session's persisted ids — re-seed so fresh
        // pane/split ids can never collide with its tree.
        nextIdCounter = maxCounterId(state)
      }
      this.snapshot = { sessionId, state, prefs: this.prefs }
    }
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot(): SidebarSnapshot {
    return this.snapshot
  }

  /** Mutate the current session's state (no-op without a session). */
  update(mutator: (draft: SidebarState) => void): void {
    const sessionId = this.snapshot.sessionId
    const state = this.snapshot.state
    if (sessionId === undefined || state === undefined) return
    const draft = structuredClone(state)
    mutator(draft)
    this.bySession.set(sessionId, draft)
    this.snapshot = { sessionId, state: draft, prefs: this.prefs }
    this.schedulePersist(sessionId, draft)
    this.notify()
  }

  /**
   * Whether a tab still exists in its session's state. Views use this on
   * unmount to tell "the tab was closed" (release the terminal now) from
   * "the tree re-rendered / the conversation switched" (the tab is still
   * open — keep the terminal alive through the host's reconnect grace).
   * Checks the session's own map entry (the current snapshot may already
   * point at another session when a conversation switch unmounts the old
   * one's tabs).
   */
  tabOpen(sessionId: string, tabId: string): boolean {
    const state = this.bySession.get(sessionId)
      ?? (this.snapshot.sessionId === sessionId ? this.snapshot.state : undefined)
    return state !== undefined && tabOpenIn(state, tabId)
  }

  /**
   * Read-only view of EVERY cached session's state (v0.17.0+). The
   * PinnedRail uses this to collect pinned terminals across sessions
   * without each render reading private fields. The map is the live
   * `bySession` reference — callers MUST treat it as read-only (mutations
   * go through {@link reduce} / {@link reduceFor}). A session that has
   * never been visited in this run is absent (its pinned tabs are not
   * visible until first load — accepted as YAGNI by the design).
   */
  getSessionStates(): ReadonlyMap<string, SidebarState> {
    return new Map(this.bySession)
  }

  /** Apply a pure reducer (returns the next state). */
  reduce(reducer: (state: SidebarState) => SidebarState): void {
    const sessionId = this.snapshot.sessionId
    const state = this.snapshot.state
    if (sessionId === undefined || state === undefined) return
    const next = reducer(state)
    // A reducer returning the SAME reference means "no change": skip the
    // persist + notify entirely — strict no-op paths (unknown tab ids,
    // patchTab on a missing tab) must not churn the state or rewrite
    // localStorage.
    if (next === state) return
    this.bySession.set(sessionId, next)
    this.snapshot = { sessionId, state: next, prefs: this.prefs }
    this.schedulePersist(sessionId, next)
    this.notify()
  }

  /**
   * Apply a pure reducer to a TARGET session's state (not the active one),
   * loading it on demand and persisting the result — WITHOUT switching the
   * active snapshot or notifying (the UI must not follow along). Used by the
   * service's targeted `openTab(seed, scope)`: the open lands in the target
   * session's layout and is visible whenever the user switches to it.
   */
  reduceFor(sessionId: string, reducer: (state: SidebarState) => SidebarState): void {
    // The uid counter is SHARED across sessions, and the ACTIVE session's
    // safety requires it to never drop below the ids IT minted. Seeding it
    // from the target's max may LOWER it (a cached target older than the
    // active session): restoring the pre-call level afterwards keeps the
    // active session's next mint collision-free — ids minted for the target
    // only need to exceed the target's own max, which the seed guaranteed.
    const counterBefore = nextIdCounter
    let state = this.bySession.get(sessionId)
    if (state === undefined) {
      state = loadState(sessionId)
      this.bySession.set(sessionId, state)
    } else {
      // Re-seed the uid counter past THIS session's persisted ids, exactly
      // like setSession's cache-hit path.
      nextIdCounter = maxCounterId(state)
    }
    const next = reducer(state)
    // Same-reference result = no change: keep the counter restore (it may
    // have been seeded down) but skip the write.
    nextIdCounter = Math.max(nextIdCounter, counterBefore)
    if (next === state) return
    this.bySession.set(sessionId, next)
    this.schedulePersist(sessionId, next)
  }

  private schedulePersist(sessionId: string, state: SidebarState): void {
    // Per-session debounce timers: one session's pending write must never
    // cancel another's (targeted opens schedule writes for INACTIVE
    // sessions while the active session may already have one pending —
    // a shared timer would drop the earlier write and the reload would
    // lose that session's layout).
    const existing = this.persistTimers.get(sessionId)
    if (existing !== undefined) window.clearTimeout(existing)
    const timer = window.setTimeout(() => {
      this.persistTimers.delete(sessionId)
      try {
        localStorage.setItem(`${STORAGE_PREFIX}:${sessionId}`, JSON.stringify(state))
      } catch {
        // Storage full or unavailable: layout memory is best-effort.
      }
    }, 200)
    this.persistTimers.set(sessionId, timer)
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * Create one sidebar store instance. Production code calls this only from
 * the client plugin's `apply` (the instance is handed to components as a
 * prop); tests call it directly. No module-level singleton: the store's
 * lifetime belongs to the plugin activation, exactly like the official
 * `createXXXStore()` factory rule.
 */
export function createSidebarStore(): SidebarStore {
  return new SidebarStore()
}
