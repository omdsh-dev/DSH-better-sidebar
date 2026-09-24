/**
 * The plugin's view of DSH 0.1.7's host-computed session projections — the
 * subagent catalog the Tasks page's topology renders, plus the two facts the
 * projection row does not carry.
 *
 * 0.1.6 published a per-parent lazy catalog through the sessions snapshot
 * (`subagentsByParent`, entries carrying `activity` / `hasChildren`) and the
 * page had to OBSERVE every parent it drew, releasing them when it hid. 0.1.7
 * replaced that whole handshake: the client loads every session's projections
 * once per connection, `SessionListState.projectionsBySession` publishes the
 * finished values, and a row is exactly `{ id, createdAt, mode, label? }`
 * (see the subagent catalog projection's `viewSchema`). So this module is a
 * pure adapter — no request, no subscription, no per-parent bookkeeping.
 *
 * The two dropped facts are derived, not invented:
 *
 * - a row HAS CHILDREN unless the child's own catalog is known-empty
 *   ({@link isKnownLeaf} — upstream's own disclosure rule, which keeps a
 *   branch open while its catalog is still loading instead of flapping it
 *   into a leaf);
 * - `activity` comes from the live channel (`subagents.live`, which folds the
 *   host's RUNNING children): a child the live map does not mention is not
 *   running ({@link childActivity}).
 *
 * What the projection genuinely does not carry any more is the 0.1.6
 * `diagnostic` row (a child whose descriptor was corrupt / unsupported /
 * unavailable): the host's fold publishes healthy identities only, so an
 * unreadable child is not a row at all and the page has nothing to show for
 * it. See the module report — no local equivalent exists.
 */
import type {
  SidebarSessionList,
  SidebarSubagentCatalogEntry,
} from '../context-types.ts'
import type { LastActivity } from '../subagent-activity.ts'

/** One parent's direct-child catalog, as the topology consumes it. */
export interface SubagentCatalogView {
  entries: readonly SidebarSubagentCatalogEntry[]
  state: 'loading' | 'ready' | 'error'
  error: { code?: string; message?: string } | null
}

/**
 * Fold the snapshot's projection values into per-parent catalog views.
 *
 * An `idle` row has been published but not read yet (the manager seeds rows
 * from the persisted checkpoint before the connection's read lands): it is
 * `loading` when it carries no value at all and `ready` when a value is
 * already there — the same reading upstream's own catalog view uses.
 *
 * @param projections - `SessionListState.projectionsBySession` (optional: a
 *   host without the projection store leaves every catalog empty).
 * @returns one view per session the snapshot knows about.
 */
export function subagentCatalogs(
  projections: SidebarSessionList['projectionsBySession'],
): Readonly<Record<string, SubagentCatalogView>> {
  const views: Record<string, SubagentCatalogView> = {}
  for (const [sessionId, snapshot] of Object.entries(projections ?? {})) {
    const entries = snapshot.values.subagentCatalog
    views[sessionId] = {
      entries: entries ?? [],
      state: snapshot.state === 'idle'
        ? entries === undefined ? 'loading' : 'ready'
        : snapshot.state,
      error: snapshot.error ?? null,
    }
  }
  return views
}

/**
 * Whether a child is a KNOWN LEAF: its own catalog finished loading and holds
 * no children. Everything else (a catalog still loading, one that failed, or
 * one this snapshot does not carry yet) keeps its disclosure — the topology
 * then draws the child's own level, whose rows hydrate when the projection
 * lands.
 *
 * @param catalogs - the views of one snapshot ({@link subagentCatalogs}).
 * @param childSessionId - the child row whose own catalog decides.
 */
export function isKnownLeaf(
  catalogs: Readonly<Record<string, SubagentCatalogView | undefined>>,
  childSessionId: string,
): boolean {
  const catalog = catalogs[childSessionId]
  return catalog?.state === 'ready' && catalog.entries.length === 0
}

/**
 * The child's live state. The `subagents.live` route folds only RUNNING
 * children (a Side Chat thread and an idle child are absent), so absence is
 * the inactive answer rather than missing data.
 *
 * @param live - the batch live map (`child id → latest activity`).
 * @param childSessionId - the child row being drawn.
 */
export function childActivity(
  live: Readonly<Record<string, LastActivity | undefined>>,
  childSessionId: string,
): 'running' | 'inactive' {
  return live[childSessionId] === undefined ? 'inactive' : 'running'
}
