/**
 * Host route tests for the background-job API ('jobs.output' / 'jobs.kill').
 * 'jobs.output' REPLAYS the output the model has read so far from the owner
 * session's event log (tool/call + tool/result pairs of job_output calls) —
 * the model's cursor is never touched, so nothing is stolen and unread jobs
 * report `read: false`. 'jobs.kill' uses the registry's stock kill, fenced
 * by the owning session, with a 503 when the registry is absent.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildJobsApi } from '../src/jobs-routes.ts'
import { SidebarError } from '../src/wire.ts'
import type { Context, SidebarSessionEvent } from '../src/context-types.ts'

/** A context whose `get` serves only the jobs/agents faces, with a session store. */
function ctxWith(sessions: unknown, jobs: unknown, agents: unknown): Context {
  return {
    sessions,
    get: (key: string) => (key === 'jobs' ? jobs : key === 'agents' ? agents : undefined),
  } as unknown as Context
}

/** A context that additionally captures the session/event listener (live mirror). */
function ctxWithFeed(sessions: unknown): {
  ctx: Context
  emit: (session: unknown, event: SidebarSessionEvent) => void
} {
  let listener: ((session: unknown, event: SidebarSessionEvent) => void) | undefined
  const base = ctxWith(sessions, undefined, undefined) as unknown as {
    on: (event: string, fn: (session: unknown, event: SidebarSessionEvent) => void) => () => void
    effect: (fn: () => void | (() => void)) => void
  }
  base.on = (_event: string, fn) => {
    listener = fn
    return () => { if (listener === fn) listener = undefined }
  }
  // The vendored cordis runs the registration effect immediately.
  base.effect = (fn) => { fn() }
  return {
    ctx: base as unknown as Context,
    emit: (session, event) => { listener?.(session, event) },
  }
}

/** A stub live agent (the fence compares `id` only). */
const agent = (id: string) => ({ id, session: { header: { cwd: '/p' } } })

/** One job_output tool/call event. */
function jobOutputCall(seq: number, callId: string, jobId: string): SidebarSessionEvent {
  return { type: 'tool/call', seq, time: seq, data: { name: 'job_output', callId, arguments: JSON.stringify({ job_id: jobId }) } }
}

/** One tool/result event carrying the finalized text the model received. */
function jobOutputResult(seq: number, callId: string, text: string, over: { isError?: boolean } = {}): SidebarSessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError: over.isError === true,
          content: [{ type: 'text', text }],
        }],
      },
    },
  }
}

/** The owner session with the given event log. */
function session(events: SidebarSessionEvent[]): unknown {
  return { header: { cwd: '/p' }, snapshotEvents: () => events }
}

describe('jobs.output route (event replay)', () => {
  it('concatenates the job_output results the model read for the job, oldest first', () => {
    const events = [
      jobOutputCall(0, 'c1', 'bash-1'),
      jobOutputResult(1, 'c1', 'line1\nline2\n[status: running]'),
      jobOutputCall(2, 'c2', 'bash-1'),
      jobOutputResult(3, 'c2', 'line3\n[status: completed, exit code: 0]'),
      // Another job's reads are ignored.
      jobOutputCall(4, 'c3', 'bash-2'),
      jobOutputResult(5, 'c3', 'other job output'),
    ]
    const api = buildJobsApi(ctxWith({ get: () => session(events) }, undefined, undefined), 512 * 1024)
    expect(api.output({ sessionId: 's1', id: 'bash-1' })).toEqual({
      text: 'line1\nline2\n[status: running]\nline3\n[status: completed, exit code: 0]',
      truncated: false,
      read: true,
    })
  })

  it('skips the controller\'s "(no new output)" deltas and error results', () => {
    const events = [
      jobOutputCall(0, 'c1', 'bash-1'),
      jobOutputResult(1, 'c1', 'real output\n[status: running]'),
      jobOutputCall(2, 'c2', 'bash-1'),
      jobOutputResult(3, 'c2', '(no new output)\n[status: running]'),
      jobOutputCall(4, 'c3', 'bash-1'),
      jobOutputResult(5, 'c3', 'boom', { isError: true }),
    ]
    const api = buildJobsApi(ctxWith({ get: () => session(events) }, undefined, undefined), 512 * 1024)
    expect(api.output({ sessionId: 's1', id: 'bash-1' })).toEqual({
      text: 'real output\n[status: running]',
      truncated: false,
      read: true,
    })
  })

  it('reports read:false until the model reads the job (no registry call at all)', () => {
    const events = [jobOutputCall(0, 'c1', 'bash-2')]
    const jobs = { kill: vi.fn() }
    const api = buildJobsApi(ctxWith({ get: () => session(events) }, jobs, undefined), 100)
    expect(api.output({ sessionId: 's1', id: 'bash-1' })).toEqual({ text: '', truncated: false, read: false })
    // The replay never touches the registry — the model's cursor is safe by construction.
    expect(jobs.kill).not.toHaveBeenCalled()
  })

  it('mirrors live job_output events the store log misses (restart divergence)', () => {
    // The store session is frozen at its rehydration boundary (no events);
    // the read exists only on the live session/event feed.
    const { ctx, emit } = ctxWithFeed({ get: () => session([]) })
    const api = buildJobsApi(ctx, 512 * 1024)
    expect(api.output({ sessionId: 's1', id: 'bash-1' })).toEqual({ text: '', truncated: false, read: false })

    // The live feed delivers the job_output call and its result.
    emit({ id: 's1' }, jobOutputCall(100, 'c-live', 'bash-1'))
    emit({ id: 's1' }, jobOutputResult(101, 'c-live', 'live line\n[status: completed, exit code: 0]'))
    expect(api.output({ sessionId: 's1', id: 'bash-1' })).toEqual({
      text: 'live line\n[status: completed, exit code: 0]',
      truncated: false,
      read: true,
    })

    // Unrelated results are never cached (no job_output call paired them),
    // and another session's feed does not leak into this one.
    emit({ id: 's1' }, jobOutputResult(102, 'c-other', 'unpaired line'))
    emit({ id: 's2' }, jobOutputCall(103, 'c-s2', 'bash-1'))
    emit({ id: 's2' }, jobOutputResult(104, 'c-s2', 'other session line'))
    expect(api.output({ sessionId: 's1', id: 'bash-1' })).toEqual({
      text: 'live line\n[status: completed, exit code: 0]',
      truncated: false,
      read: true,
    })
    expect(api.output({ sessionId: 's2', id: 'bash-1' })).toEqual({
      text: 'other session line',
      truncated: false,
      read: true,
    })
  })

  it('merges store-log traces with live mirror traces without double-counting', () => {
    // A seed read (seq 5) in the store log plus a live read (seq 106) that
    // ALSO reached the store log would double-count — the seq dedupe keeps
    // exactly one copy of each.
    const events = [jobOutputCall(5, 'c-seed', 'bash-1'), jobOutputResult(6, 'c-seed', 'seed line')]
    const { ctx, emit } = ctxWithFeed({ get: () => session(events) })
    const api = buildJobsApi(ctx, 512 * 1024)
    emit({ id: 's1' }, jobOutputCall(106, 'c-live', 'bash-1'))
    emit({ id: 's1' }, jobOutputResult(107, 'c-live', 'live line'))
    expect(api.output({ sessionId: 's1', id: 'bash-1' })).toEqual({
      text: 'seed line\nlive line',
      truncated: false,
      read: true,
    })
  })

  it('caps oversized replays with the truncated flag', () => {
    const events = [jobOutputCall(0, 'c1', 'bash-1'), jobOutputResult(1, 'c1', 'x'.repeat(10_000))]
    const api = buildJobsApi(ctxWith({ get: () => session(events) }, undefined, undefined), 100)
    const value = api.output({ sessionId: 's1', id: 'bash-1' })
    expect(value.text).toBe('x'.repeat(100))
    expect(value.truncated).toBe(true)
    expect(value.read).toBe(true)
  })

  it('rejects a missing sessionId or id as bad-request', () => {
    const api = buildJobsApi(ctxWith({ get: () => undefined }, undefined, undefined), 100)
    expect(() => api.output({ id: 'bash-1' })).toThrowError(expect.objectContaining<Partial<SidebarError>>({ code: 'bad-request' }))
    expect(() => api.output({ sessionId: 's1' })).toThrowError(expect.objectContaining<Partial<SidebarError>>({ code: 'bad-request' }))
  })
})

describe('jobs.kill route', () => {
  it('kills with the forwarded reason and the live caller', () => {
    const jobs = { kill: vi.fn(() => 'requested' as const) }
    const agents = { get: vi.fn((id: string) => agent(id)) }
    const api = buildJobsApi(ctxWith({ get: () => undefined }, jobs, agents), 100)
    expect(api.kill({ sessionId: 's1', id: 'bash-1', reason: 'user pressed stop' }))
      .toEqual({ ok: true, outcome: 'requested' })
    expect(jobs.kill).toHaveBeenCalledWith('bash-1', agent('s1'), 'user pressed stop')
  })

  it('defaults the reason when none is supplied', () => {
    const jobs = { kill: vi.fn(() => 'already-finished' as const) }
    const api = buildJobsApi(ctxWith({ get: () => undefined }, jobs, undefined), 100)
    expect(api.kill({ sessionId: 's1', id: 'bash-1' })).toEqual({ ok: true, outcome: 'already-finished' })
    expect(jobs.kill).toHaveBeenCalledWith('bash-1', undefined, 'user requested via sidebar')
  })

  it('maps registry refusals to a 404 job-error', () => {
    const jobs = { kill: vi.fn(() => { throw new Error('unknown job bash-9') }) }
    const api = buildJobsApi(ctxWith({ get: () => undefined }, jobs, undefined), 100)
    expect(() => api.kill({ sessionId: 's1', id: 'bash-9' })).toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'job-error', status: 404 }),
    )
  })

  it('degrades to a 503 when the jobs registry is absent (output keeps working)', () => {
    const api = buildJobsApi(ctxWith({ get: () => session([]) }, undefined, undefined), 100)
    expect(() => api.kill({ sessionId: 's1', id: 'bash-1' })).toThrowError(
      expect.objectContaining<Partial<SidebarError>>({ code: 'job-error', status: 503 }),
    )
    expect(api.output({ sessionId: 's1', id: 'bash-1' })).toEqual({ text: '', truncated: false, read: false })
  })
})
