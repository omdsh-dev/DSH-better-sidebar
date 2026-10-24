/**
 * The plugin's view of DSH 0.1.7's `agentTeam` Session projection — the Lead
 * Session's team board, read straight off the client snapshot.
 *
 * 0.1.6 exposed the board through the experimental service's Remote vocabulary
 * (`agentTeams.remoteView`, reached over the wire) and the page had to poll it
 * every 5s. 0.1.7 deleted that trio and publishes the same state as a Session
 * projection instead: `SessionListState.projectionsBySession[leadId].values
 * .agentTeam`, loaded once per connection like every other projection. This
 * module is therefore a pure adapter — no request, no poller, no observer —
 * exactly like ./subagent-catalog.ts for the catalog.
 *
 * Two facts the durable projection does not carry are DERIVED, not invented:
 *
 * - TURN ACTIVITY. A projection row is `{ id, name, role, phase, error? }`
 *   where `phase` is the durable lifecycle (`provisioning | active | failed`,
 *   the Lead row always `active`). Whether a member is running right now comes
 *   from the session's own status — upstream's own web UI "reads the shared
 *   Session projections and overlays activity from Session status" — and this
 *   plugin already has that overlay: `subagents.live` reports EVERY tree child
 *   with an explicit `running` flag (see ./subagent-catalog.ts's `childLive`),
 *   with the session list's own coarse `running` as the fallback for the Lead.
 * - `diagnostics`, the 0.1.6 view's array of provisioning notes, collapses to
 *   the projection's single durable `error` string.
 *
 * What is genuinely gone is the member's `model` (and `description` /
 * `provider` / `context`): the wire view never carried them, so the node
 * detail no longer has a model row to show. See the design note
 * docs/plans/2026-09-27-agent-teams-dsh-0.1.7-adaptation.md.
 */
import type {
  SidebarChildLiveView,
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarTeamMemberProjection,
  SidebarTeamProjection,
} from '../context-types.ts'

/**
 * One roster row as this page consumes it: the projection's durable half plus
 * the derived runtime status. A THIRD type next to the host service's
 * `SidebarTeamMemberView` on purpose — that one is the 0.1.6 `listMembers`
 * shape (status/description/provider/model) this plugin no longer reads, and
 * conflating the two is exactly how the field drift that broke the board went
 * unnoticed.
 */
export interface TeamMemberRow {
  /** The member's session id (the teammate's child session under the lead). */
  id: string
  name: string
  role: 'lead' | 'teammate'
  /** Durable lifecycle, as the projection publishes it. */
  phase: SidebarTeamMemberProjection['phase']
  /** Derived display status: durable phase wins, else the live activity flag. */
  status: 'running' | 'idle' | 'provisioning' | 'failed'
  /** The durable provisioning error as a one-item list (see the header). */
  diagnostics: string[]
}

/**
 * The team board led by `rootId`, or undefined when that session leads none.
 *
 * ABSENT MEANS NO TEAM, and there are three ways to get there: the deployment
 * never mounted the experimental layer (no projection key at all), the root is
 * a teammate rather than the Lead, or the session simply has no team. All
 * three collapse into "the page draws no Teams block" — the same silent
 * degradation the 0.1.6 route expressed as `{available:false}` (layer absent)
 * and `{team:null}` (root leads none), with one lookup instead of two states
 * the page had to distinguish and never did.
 *
 * @param projections - `SessionListState.projectionsBySession`.
 * @param rootId - the tree's root session (the only session that can be Lead).
 */
export function teamProjectionOf(
  projections: SidebarSessionList['projectionsBySession'],
  rootId: string | undefined,
): SidebarTeamProjection | undefined {
  if (rootId === undefined) return undefined
  return projections?.[rootId]?.values.agentTeam
}

/**
 * Overlay runtime activity onto the durable roster.
 *
 * Status precedence is deliberately narrow: the durable phase wins for the two
 * states it owns (`failed` never becomes "running" because a retry is in
 * flight, `provisioning` is not yet a turn), and only an `active` member asks
 * the live channel whether it is running right now. A member the channel does
 * not mention yet (the first poll of a freshly rooted tree) reads as `idle`,
 * which is the safe direction: it never claims work that is not happening.
 *
 * @param team - the Lead's projection ({@link teamProjectionOf}).
 * @param live - the `subagents.live` map (`session id → live view`).
 * @param byId - the session list by id (the Lead's own running flag lives here).
 */
export function teamMembersOf(
  team: SidebarTeamProjection | undefined,
  live: Readonly<Record<string, SidebarChildLiveView | undefined>>,
  byId: Readonly<Record<string, SidebarSessionSummary | undefined>>,
): TeamMemberRow[] {
  if (team === undefined) return []
  return team.members.map(member => ({
    id: member.id,
    name: member.name,
    role: member.role,
    phase: member.phase,
    status: memberStatus(member, live, byId),
    diagnostics: member.error === undefined ? [] : [member.error],
  }))
}

/** One member's runtime status (see {@link teamMembersOf} for the rule). */
function memberStatus(
  member: SidebarTeamMemberProjection,
  live: Readonly<Record<string, SidebarChildLiveView | undefined>>,
  byId: Readonly<Record<string, SidebarSessionSummary | undefined>>,
): TeamMemberRow['status'] {
  if (member.phase === 'failed') return 'failed'
  if (member.phase === 'provisioning') return 'provisioning'
  // The summary's `running` is the authoritative run bit; the live channel's
  // flag is the catalog's RESIDENCY, which reads `running` for a retained
  // session that no agent is driving (a crash-restart — issue #800). Same rule
  // as the task tree: authoritative wins, the live flag only stands in when the
  // host's summaries do not carry the field.
  const running = byId[member.id]?.running ?? live[member.id]?.running
  return running === true ? 'running' : 'idle'
}
