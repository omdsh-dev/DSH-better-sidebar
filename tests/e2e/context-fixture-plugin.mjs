/**
 * e2e-only HOST fixture for the Context-diagnostics lane
 * (`scripts/e2e-context.sh` → `tests/e2e/context-diagnostics.e2e.ts`).
 *
 * NOTHING here ships: the lane copies this file into a throwaway package under
 * its scratch directory and installs it with the official `dsh plugin add`
 * channel, exactly like `tests/fixtures/aggregate-better-sidebar` (see
 * `build_fixture_package` in the lane script).
 *
 * Why a fixture exists at all: the lane must not call a real model, and a
 * keyless `dsh web` can produce neither a durable child session nor a
 * background job through any public RPC — `job/*` exposes list/follow/kill
 * only, and `session/fork` needs a completed turn that only a model can make.
 * So this row seeds, through the host's PUBLIC services and nothing else:
 *
 *   - one subagent child session under the lane's parent session, using the
 *     same `ctx.agents.create` shape (standard `subagent/descriptor` seed +
 *     fork markers + `inbox.clear()`) that `src/sidechat-routes.ts` uses in
 *     production, plus the official parent's `subagent/catalog` event so both
 *     the host catalog and the plugin's Tasks topology discover the child;
 *   - one RUNNING background job owned by that parent, through
 *     `ctx.jobs.start` (the same registry `dsh-tool-subagent` uses for
 *     background delegations).
 *
 * This is SERVER-SIDE DATA CONSTRUCTION, not model execution: nothing here
 * runs an agent turn, calls an LLM, or touches a production route. The lane
 * reports it that way.
 *
 * The parent session itself is created by the SPEC through the public
 * `session/create` RPC with the fixed id below, which is how this row knows
 * what to attach to without inventing a channel.
 */

import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'

/** The parent session the lane creates through `session/create`. */
const PARENT_ID = 'session-e2e-context-parent'

/** The fixture child session (visible to the host's subagent catalog). */
const CHILD_ID = 'session-e2e-context-child'

/** The child's descriptor label — deliberately NOT the 'Side: ' prefix, which
 *  the plugin's topology filters out as a side-chat thread. */
const CHILD_LABEL = 'Context fixture child'

/** The background job's model-facing label. */
const JOB_LABEL = 'e2e context fixture job'

/** Poll cadence / budget for the parent session's arrival. */
const POLL_MS = 200
const POLL_LIMIT = 300

/** Failed seeding attempts (logged each) before the fixture stops retrying. */
const MAX_FAILURES = 5

/** How long the fixture job stays running before it settles itself. */
const JOB_TTL_MS = 600_000

/** Plugin name (the row this fixture's bundle patch inserts). */
export const name = 'fixture-context-seed'

/** One line in the host log, so the lane can prove the seeding happened. */
function log(message) {
  console.log(`[e2e-context-fixture] ${message}`)
}

/**
 * Seed the child session and the job once the parent exists.
 * @param ctx - host context (public services only).
 * @returns whether the seeding is complete (false = keep polling).
 */
async function seed(ctx) {
  const agents = ctx.get('agents')
  if (agents === undefined || typeof agents.get !== 'function') return false
  const parent = agents.get(PARENT_ID)
  if (parent === undefined) return false

  const cwd = process.env.DSH_E2E_CONTEXT_WORKSPACE ?? parent.session?.header?.cwd
  const descriptor = {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode: 'one-shot',
    provider: 'e2e-context-fixture',
    label: CHILD_LABEL,
  }
  const message = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const parentMarker = 'E2E_PARENT_CONTEXT_MARKER'
  const childMarker = 'E2E_CHILD_CONTEXT_MARKER'
  if (!parent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === 'fixture-parent-message')) {
    parent.session.append('user/message', message('fixture-parent-message', parentMarker), { surfaceOp: 'append' })
  }
  const seedEvents = [
    { type: 'subagent/descriptor', seq: 0, time: Date.now(), data: descriptor },
    { type: 'user/message', seq: 1, time: Date.now(), data: message('fixture-child-message', childMarker), surfaceOp: 'append' },
  ]

  if (agents.get(CHILD_ID) === undefined) {
    const handle = await agents.create({
      sessionId: CHILD_ID,
      meta: {
        ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
        parentSession: PARENT_ID,
        isSeeded: true,
        origin: 'subagent',
        delegationDepth: 1,
      },
      seed: seedEvents,
      inheritedEventCount: seedEvents.length,
      agentOptions: { ...parent.options },
    })
    // Same fencing the production sidechat seed performs: the runtime inbox
    // projection folds the FULL log (inherited prefix included), so a fresh
    // fixture child must not inherit anything the parent left unclaimed.
    handle.agent.inbox.clear()
    const header = handle.agent.session.header
    parent.session.append('subagent/catalog', {
      version: 0,
      childId: header.id,
      childCreatedAt: header.createdAt,
      mode: 'one-shot',
      label: CHILD_LABEL,
    })
    log(`seeded child session ${CHILD_ID} under ${PARENT_ID}`)
  }

  const jobs = ctx.get('jobs')
  if (jobs !== undefined && typeof jobs.start === 'function') {
    const running = jobs.list(PARENT_ID).filter(view => view.label === JOB_LABEL)
    if (running.length === 0) {
      const id = jobs.start({
        kind: 'bash',
        label: JOB_LABEL,
        owner: PARENT_ID,
        run: (job) => {
          job.append('e2e context fixture job started\n', { channel: 'stdout' })
          job.append('e2e context fixture output line 1\n', { channel: 'stdout' })
          job.updateProgress('fixture 1/1')
          let settle
          const done = new Promise((resolve) => { settle = resolve })
          let settled = false
          let timer
          const finish = (status, detail) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            settle(detail === undefined ? { status } : { status, detail })
          }
          timer = setTimeout(() => {
            job.append('e2e context fixture job done\n', { channel: 'stdout' })
            finish('completed', 'exit code: 0')
          }, JOB_TTL_MS)
          return {
            cancel: (reason) => { finish('killed', typeof reason === 'string' ? reason : 'canceled by fixture') },
            done,
          }
        },
      })
      log(`started job ${id} owned by ${PARENT_ID}`)
    }
  }

  log(`seeding complete for ${PARENT_ID}`)
  return true
}

/**
 * Mount the fixture: poll (bounded) for the lane's parent session, then seed
 * once. No timers survive the seeding, and none survive disposal.
 * @param ctx - host context.
 */
export function apply(ctx) {
  let timer
  let polls = 0
  let failures = 0
  let running = false

  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  const tick = async () => {
    if (running) return
    running = true
    try {
      polls += 1
      if (await seed(ctx)) {
        stop()
        return
      }
      if (polls >= POLL_LIMIT) {
        stop()
        log(`gave up waiting for ${PARENT_ID} after ${POLL_LIMIT} polls`)
      }
    } catch (error) {
      failures += 1
      log(`seeding attempt ${failures} failed: ${error instanceof Error ? error.message : String(error)}`)
      if (failures >= MAX_FAILURES) {
        stop()
        log(`gave up after ${MAX_FAILURES} failed seeding attempts`)
      }
    } finally {
      running = false
    }
  }

  log(`mounted (waiting for ${PARENT_ID})`)
  timer = setInterval(() => { void tick() }, POLL_MS)
  void tick()

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { stop() }, 'e2e-context-fixture.poll')
  }
}
