/**
 * Plan page data layer: folding a session event log into the plan revisions
 * the model presented through the host's `exit_plan_mode` tool.
 */
import { describe, expect, it } from 'vitest'
import { extractPlans } from '../src/client/plans/ops.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'

/** One synthetic session event. */
function ev(type: string, seq: number, time: number, data: Record<string, unknown>): SidebarSessionEvent {
  return { type, seq, time, data }
}

/** An exit_plan_mode tool/call carrying `plan` (or a raw arguments blob). */
function call(seq: number, callId: string, args: unknown, time = seq): SidebarSessionEvent {
  return ev('tool/call', seq, time, { name: 'exit_plan_mode', callId, arguments: JSON.stringify(args) })
}

/** A tool/result event carrying one tool-result block with inner text. */
function result(seq: number, callId: string, text: string, isError = false, time = seq): SidebarSessionEvent {
  return ev('tool/result', seq, time, {
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', isError, content: [{ type: 'text', text }] }],
    },
  })
}

describe('extractPlans', () => {
  it('reads a plan from the call and leaves it pending until its result lands', () => {
    const plans = extractPlans([call(1, 'p1', { plan: '# 重构方案\n\n第一步。' })])
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      callId: 'p1',
      seq: 1,
      title: '重构方案',
      body: '# 重构方案\n\n第一步。',
      status: 'pending',
    })
    expect(plans[0]!.settledTime).toBeUndefined()
  })

  it('settles on approval when the result is not an error', () => {
    const plans = extractPlans([
      call(1, 'p1', { plan: '# 方案' }),
      result(2, 'p1', 'Plan approved — plan mode exited; carry out the plan starting with your next step.', false, 42),
    ])
    expect(plans[0]!.status).toBe('approved')
    expect(plans[0]!.settledTime).toBe(42)
  })

  it('settles as unadopted when the result is an error (keep planning, or a dismissed review)', () => {
    const plans = extractPlans([
      call(1, 'p1', { plan: '# 方案' }),
      result(2, 'p1', 'The user chose to keep planning; revise the plan and present it again.', true),
    ])
    expect(plans[0]!.status).toBe('unadopted')
  })

  it('keeps every revision in submission order, oldest first', () => {
    const plans = extractPlans([
      call(1, 'v1', { plan: '# 第一版' }),
      result(2, 'v1', 'keep planning', true),
      call(3, 'v2', { plan: '# 第二版' }),
      result(4, 'v2', 'keep planning', true),
      call(5, 'v3', { plan: '# 第三版' }),
      result(6, 'v3', 'approved'),
    ])
    expect(plans.map(plan => plan.title)).toEqual(['第一版', '第二版', '第三版'])
    expect(plans.map(plan => plan.status)).toEqual(['unadopted', 'unadopted', 'approved'])
  })

  it('reports a fresh revision after a settled one as pending again', () => {
    const plans = extractPlans([call(1, 'v1', { plan: '# 一' }), result(2, 'v1', 'ok'), call(3, 'v2', { plan: '# 二' })])
    expect(plans.map(plan => plan.status)).toEqual(['approved', 'pending'])
  })

  it('takes the first heading of any level, like the host review card does', () => {
    const plans = extractPlans([call(1, 'p1', { plan: '#\n# 真正的标题\n正文' })])
    expect(plans[0]!.title).toBe('真正的标题')
  })

  it('skips a body the host itself would refuse (no leading `# ` heading)', () => {
    // The host validates `/^#\s+\S/` INSIDE execute — its tool/call row is
    // already logged by then, so these calls are rows the user never saw a
    // review card for. Surfacing them would invent a phantom plan.
    const plans = extractPlans([
      call(1, 'bad1', { plan: '## 二级标题开头' }),
      call(2, 'bad2', { plan: '没有标题的正文' }),
      call(3, 'bad3', { plan: '   ' }),
      call(4, 'bad4', { plan: '' }),
      call(5, 'good', { plan: '# 合法计划' }),
    ])
    expect(plans.map(plan => plan.callId)).toEqual(['good'])
  })

  it('skips malformed or unreadable arguments without dropping the plans around them', () => {
    const broken: SidebarSessionEvent = ev('tool/call', 1, 1, {
      name: 'exit_plan_mode',
      callId: 'broken',
      arguments: '{not json',
    })
    const notAString: SidebarSessionEvent = ev('tool/call', 2, 2, {
      name: 'exit_plan_mode',
      callId: 'not-string',
      arguments: JSON.stringify({ plan: 42 }),
    })
    const plans = extractPlans([broken, notAString, call(3, 'good', { plan: '# 照常显示' })])
    expect(plans.map(plan => plan.callId)).toEqual(['good'])
  })

  it('ignores other tools and results that pair with no plan call', () => {
    const plans = extractPlans([
      call(1, 'p1', { plan: '# 计划' }),
      ev('tool/call', 2, 2, { name: 'bash', callId: 'b1', arguments: '{"command":"ls"}' }),
      result(3, 'b1', 'ok'),
      result(4, 'unknown', 'stray result'),
      ev('assistant/message', 5, 5, { text: 'hi' }),
    ])
    expect(plans.map(plan => plan.callId)).toEqual(['p1'])
  })

  it('ignores a stray result that carries no call id at all', () => {
    const stray: SidebarSessionEvent = ev('tool/result', 2, 2, { message: { content: [] } })
    const plans = extractPlans([call(1, 'p1', { plan: '# 计划' }), stray])
    expect(plans[0]!.status).toBe('pending')
  })

  it('drops a call whose result marks it aborted before dispatch (the harness error.info shape)', () => {
    // The harness mounts the error's `info` — not the error itself — on the
    // result, so the code rides `data.error.code` and reads
    // 'ABORTED_BEFORE_DISPATCH' (the dsh-tools constant's VALUE, not its name).
    const aborted: SidebarSessionEvent = ev('tool/result', 2, 2, {
      error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' },
      message: { source: { kind: 'tool', callId: 'p1' }, content: [{ type: 'tool-result', isError: true, content: [] }] },
    })
    const plans = extractPlans([
      call(1, 'p1', { plan: '# 未送达的计划' }),
      aborted,
      call(3, 'p2', { plan: '# 正常计划' }),
      result(4, 'p2', 'approved'),
    ])
    expect(plans.map(plan => plan.callId)).toEqual(['p2'])
  })

  it('trims the surrounding blank lines of a body but keeps its interior intact', () => {
    const plans = extractPlans([call(1, 'p1', { plan: '\n\n# 标题\n\n第一段\n\n第二段\n\n' })])
    expect(plans[0]!.body).toBe('# 标题\n\n第一段\n\n第二段')
  })

  it('returns nothing for an empty log', () => {
    expect(extractPlans([])).toEqual([])
  })
})
