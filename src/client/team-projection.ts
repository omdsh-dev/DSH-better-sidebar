/**
 * The plugin's view of the host's `agentTeam` Session projection — the Lead
 * Session's shared task board — plus the roster the board draws beside it.
 *
 * DSH 0.2.2 reshaped that projection: the wire value is now
 * `{ enabled, tasks, failure? }` and no longer carries `members`
 * (upgrade-guide v0.2.1-rc.2 "agentTeam.members is removed"; the Team package
 * migration 122dc3af42 moved the roster out of the Team projection for good).
 * A team member IS a direct subagent of the Lead, so the roster this module
 * publishes is the Lead's `subagentCatalog` — the projection
 * ./subagent-catalog.ts already folds for the topology — with the Lead row
 * prepended.
 *
 * Two facts the projection used to carry are genuinely gone, and this module
 * does not fake them:
 *
 * - there is no durable `phase`: `provisioning` / `failed` were the old roster
 *   lifecycle, and a spawn that never produced a catalog entry has no row to
 *   draw at all;
 * - there is no per-member `error`: the only failure left is the board-wide
 *   `failure` string, which the board itself reports.
 *
 * Turn activity is derived, not invented: the session list's `running` bit is
 * authoritative, the live channel's flag is the catalog's RESIDENCY and only
 * stands in when the summaries do not carry the field (issue #800 — a retained
 * session reads `running` in the live map while no agent drives it).
 */
import type {
  SidebarChildLiveView,
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarSubagentCatalogEntry,
  SidebarTeamProjection,
} from '../context-types.ts'

/**
 * The root agent's fixed name (the host's `ROOT_AGENT_NAME`). Named here
 * rather than imported: a client bundle may not value-import the host's
 * subagent package, and the Lead is the only row whose name is not a catalog
 * entry.
 */
const ROOT_AGENT_NAME = 'lead'

/** One roster row as this page consumes it: identity plus the derived runtime status. */
export interface TeamMemberRow {
  /** The member's session id (the Lead itself, or a direct child under it). */
  id: string
  /** The member's agent name: `lead` at the root, the catalog name below it. */
  name: string
  role: 'lead' | 'teammate'
  /** Derived display status: the session's own run bit, live flag as the fallback. */
  status: 'running' | 'idle'
}

/**
 * The team board led by `rootId`, or undefined when that session leads none.
 *
 * ABSENT MEANS NO TEAM, and there are three ways to get there: the deployment
 * never mounted the Team layer (no projection key at all), the session leads no
 * team (`enabled: false` — the durable mode selection), or the root is a
 * teammate rather than the Lead. All three collapse into "the page draws no
 * Teams block", which is the same silent degradation the 0.1.6 route expressed
 * as `{available:false}` and `{team:null}`.
 *
 * A host that still publishes the pre-0.2.2 value carries no `enabled` flag;
 * that reads as enabled, which keeps the board visible exactly where it used
 * to be.
 *
 * @param projections - `SessionListState.projectionsBySession`.
 * @param rootId - the tree's root session (the only session that can be Lead).
 */
export function teamProjectionOf(
  projections: SidebarSessionList['projectionsBySession'],
  rootId: string | undefined,
): SidebarTeamProjection | undefined {
  if (rootId === undefined) return undefined
  const team = projections?.[rootId]?.values.agentTeam
  return team?.enabled === false ? undefined : team
}

/**
 * Build the roster: the Lead, then the Lead's direct children from its catalog.
 *
 * The catalog is the ONLY roster source now (see the module header), so a child
 * that the catalog does not list is not a member — there is no second list to
 * disagree with, which is what kept the old `members` drift invisible.
 *
 * @param team - the Lead's projection ({@link teamProjectionOf}).
 * @param rootId - the tree's root session id.
 * @param entries - the Lead's `subagentCatalog` rows, in catalog order.
 * @param live - the `subagents.live` map (`session id → live view`).
 * @param byId - the session list by id (the Lead's own running flag lives here).
 */
export function teamMembersOf(
  team: SidebarTeamProjection | undefined,
  rootId: string | undefined,
  entries: readonly SidebarSubagentCatalogEntry[],
  live: Readonly<Record<string, SidebarChildLiveView | undefined>>,
  byId: Readonly<Record<string, SidebarSessionSummary | undefined>>,
): TeamMemberRow[] {
  if (team === undefined || rootId === undefined) return []
  const statusOf = (id: string): TeamMemberRow['status'] =>
    (byId[id]?.running ?? live[id]?.running) === true ? 'running' : 'idle'
  return [
    { id: rootId, name: ROOT_AGENT_NAME, role: 'lead', status: statusOf(rootId) },
    ...entries.map(entry => ({
      id: entry.id,
      name: entry.name ?? entry.label ?? entry.id,
      role: 'teammate' as const,
      status: statusOf(entry.id),
    })),
  ]
}
