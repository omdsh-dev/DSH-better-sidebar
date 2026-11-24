/**
 * PTC (run_code) transcript mapping: the side-chat transcript must fold the
 * log-only PTC pair (tool/ptc-dispatch-start + tool/ptc-dispatch) into the
 * root run_code row's children, with the same tool-row fields a direct call
 * gets (args, result text, failed state, structured card, attachments).
 *
 * ============================ CONTRACT ============================
 * 1. A start attaches a RUNNING child (executing: true) under its parent;
 *    the paired dispatch settles the SAME child in place, keeping the start
 *    event's seq as its identity.
 * 2. A dispatch without a start still yields a settled child.
 * 3. A failed dispatch marks the child failed and drops its structured card.
 * 4. parentCallId pointing at another subCallId nests one level deeper.
 * 5. A PTC event whose parent row is outside the event window contributes
 *    nothing (no orphan top-level row).
 * 6. The row-reuse pass compares children: unchanged PTC trees keep their
 *    object identity, a settled dispatch rebuilds the root row.
 * ==================================================================
 */
import { describe, expect, it } from 'vitest'
import type { SidebarHistoryEntry, SidebarSessionEvent } from '../src/context-types.ts'
import { transcriptRows, type SidechatTranscriptRow } from '../src/client/sidechat-transcript.ts'

const ROOT = 'root'

function entry(event: SidebarSessionEvent): SidebarHistoryEntry {
  return { event }
}

/** One log event fixture; the surface-eligible message events carry the
 *  append marker exactly like the live pipeline appends them. */
function ev(type: string, seq: number, data: Record<string, unknown> = {}): SidebarSessionEvent {
  const event: SidebarSessionEvent = { type, seq, time: seq * 1_000, data }
  if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
    return { ...event, surfaceOp: 'append' } as SidebarSessionEvent
  }
  return event
}

/** The root program call: a run_code with code + description. */
function rootCall(seq = 3): SidebarSessionEvent {
  return ev('tool/call', seq, {
    turn: 1,
    step: 1,
    callId: ROOT,
    name: 'run_code',
    arguments: JSON.stringify({
      code: 'const r = await tools.bash({ command: "echo root-code-only" })',
      description: 'Inspect the repo',
    }),
  })
}

/** One PTC sub-call start. */
function start(seq: number, sub: string, name: string, args: Record<string, unknown>, parent = ROOT): SidebarSessionEvent {
  return ev('tool/ptc-dispatch-start', seq, {
    rootCallId: ROOT,
    parentCallId: parent,
    subCallId: sub,
    name,
    arguments: args,
  })
}

/** One PTC sub-call result. */
function dispatch(
  seq: number,
  sub: string,
  name: string,
  args: Record<string, unknown>,
  content: unknown[],
  extra: Record<string, unknown> = {},
): SidebarSessionEvent {
  return ev('tool/ptc-dispatch', seq, {
    rootCallId: ROOT,
    parentCallId: ROOT,
    subCallId: sub,
    name,
    arguments: args,
    isError: false,
    content,
    ...extra,
  })
}

function rootResult(seq: number, text = 'done'): SidebarSessionEvent {
  return ev('tool/result', seq, {
    turn: 1,
    step: 1,
    message: { source: { kind: 'tool', callId: ROOT }, content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] },
  })
}

type ToolRow = Extract<SidechatTranscriptRow, { kind: 'tool' }>

function toolRows(events: SidebarSessionEvent[]): ToolRow[] {
  return transcriptRows(events.map(entry)).filter((row): row is ToolRow => row.kind === 'tool')
}

const BASH_ARGS = { command: 'echo ptc-child-ok' }
const READ_ARGS = { file_path: 'src/a.ts' }

describe('PTC sub-call rows', () => {
  it('attaches paired bash/read sub-calls to the run_code row with their structured cards', () => {
    const root = rootCall()
    const bashStart = start(4, ROOT + ':ptc:1', 'bash', BASH_ARGS)
    const bashDispatch = dispatch(5, ROOT + ':ptc:1', 'bash', BASH_ARGS, [{ type: 'text', text: 'ptc-child-ok\n[exit code: 0]' }], { meta: { cwd: '/p' } })
    const readStart = start(6, ROOT + ':ptc:2', 'read', READ_ARGS)
    const readDispatch = dispatch(7, ROOT + ':ptc:2', 'read', READ_ARGS, [{ type: 'text', text: '<content>\n1: read-child-ok\n</content>' }], {
      meta: { path: 'src/a.ts', offset: 1, lines: [{ number: 1, text: 'read-child-ok' }], totalLines: 1, lang: 'ts' },
    })
    const result = rootResult(8)

    const rows = toolRows([ev('session/end-seed', 0), root, bashStart, bashDispatch, readStart, readDispatch, result])
    expect(rows).toHaveLength(1)
    const tool = rows[0]!
    expect(tool.name).toBe('run_code')
    expect(tool.executing).toBe(false)
    expect(tool.resultText).toBe('done')
    expect(tool.children).toHaveLength(2)

    const bash = tool.children![0]!
    expect(bash).toMatchObject({ name: 'bash', callId: ROOT + ':ptc:1', seq: 4, executing: false, failed: false, args: JSON.stringify(BASH_ARGS) })
    expect(bash.card).toMatchObject({ type: 'terminal', command: 'echo ptc-child-ok', output: 'ptc-child-ok', exitCode: 0 })
    expect(bash.resultText).toBe('ptc-child-ok\n[exit code: 0]')

    const read = tool.children![1]!
    expect(read).toMatchObject({ name: 'read', callId: ROOT + ':ptc:2', seq: 6, executing: false })
    expect(read.card).toMatchObject({
      type: 'read',
      label: 'src/a.ts',
      lines: [{ number: 1, text: 'read-child-ok' }],
      totalLines: 1,
      lang: 'ts',
    })
  })

  it('keeps a started-only sub-call running until its dispatch lands', () => {
    const rows = toolRows([
      ev('session/end-seed', 0),
      rootCall(),
      start(4, ROOT + ':ptc:1', 'bash', BASH_ARGS),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.executing).toBe(true)
    expect(rows[0]!.children).toHaveLength(1)
    expect(rows[0]!.children![0]).toMatchObject({ name: 'bash', executing: true, failed: false })
    expect(rows[0]!.children![0]!.resultText).toBeUndefined()
  })

  it('recovers a settled sub-call from a dispatch without its start', () => {
    const rows = toolRows([
      ev('session/end-seed', 0),
      rootCall(),
      dispatch(4, ROOT + ':ptc:1', 'bash', BASH_ARGS, [{ type: 'text', text: 'recovered\n[exit code: 1]' }], { isError: false }),
    ])
    expect(rows).toHaveLength(1)
    const child = rows[0]!.children![0]!
    expect(child).toMatchObject({ seq: 4, name: 'bash', executing: false, failed: false })
    expect(child.card).toMatchObject({ type: 'terminal', command: 'echo ptc-child-ok', output: 'recovered', exitCode: 1 })
  })

  it('marks a failed dispatch failed and drops the structured card', () => {
    const failed = dispatch(5, ROOT + ':ptc:1', 'write', { file_path: 'readonly.txt', content: 'new' }, [{ type: 'text', text: 'permission denied' }], { isError: true })
    const rows = toolRows([
      ev('session/end-seed', 0),
      rootCall(),
      start(4, ROOT + ':ptc:1', 'write', { file_path: 'readonly.txt', content: 'new' }),
      failed,
    ])
    const child = rows[0]!.children![0]!
    expect(child.failed).toBe(true)
    expect(child.executing).toBe(false)
    expect(child.resultText).toBe('permission denied')
    expect(child.card).toBeUndefined()
  })

  it('nests a sub-call under its sub-call parent', () => {
    const rows = toolRows([
      ev('session/end-seed', 0),
      rootCall(),
      start(4, ROOT + ':ptc:1', 'bash', BASH_ARGS),
      start(5, ROOT + ':ptc:1:ptc:1', 'read', READ_ARGS, ROOT + ':ptc:1'),
      dispatch(6, ROOT + ':ptc:1:ptc:1', 'read', READ_ARGS, [{ type: 'text', text: 'nested' }]),
    ])
    const outer = rows[0]!.children![0]!
    expect(outer.name).toBe('bash')
    expect(outer.children).toHaveLength(1)
    expect(outer.children![0]).toMatchObject({ name: 'read', callId: ROOT + ':ptc:1:ptc:1' })
  })

  it('ignores PTC events whose parent row is outside the window', () => {
    const rows = toolRows([
      ev('session/end-seed', 0),
      start(1, 'orphan:ptc:1', 'bash', BASH_ARGS, 'missing-root'),
      dispatch(2, 'orphan:ptc:1', 'bash', BASH_ARGS, [{ type: 'text', text: 'no parent' }]),
    ])
    expect(rows).toEqual([])
  })

  it('keeps unchanged PTC trees by identity and rebuilds on a settle', () => {
    const events = [
      ev('session/end-seed', 0),
      rootCall(),
      start(4, ROOT + ':ptc:1', 'bash', BASH_ARGS),
    ]
    const first = transcriptRows(events.map(entry))
    const second = transcriptRows(events.map(entry), first)
    expect(second[0]).toBe(first[0])

    const settled = [...events, dispatch(5, ROOT + ':ptc:1', 'bash', BASH_ARGS, [{ type: 'text', text: 'out\n[exit code: 0]' }])]
    const third = transcriptRows(settled.map(entry), second)
    expect(third[0]).not.toBe(second[0])
    expect((third[0] as ToolRow).children![0]).toMatchObject({ executing: false, resultText: 'out\n[exit code: 0]' })
  })

  it('keeps a PTC present as a child row while the delivery card stays top-level', () => {
    const presentArgs = { files: [{ path: 'out/report.pdf' }] }
    const rows = transcriptRows([
      ev('session/end-seed', 0),
      rootCall(),
      start(4, ROOT + ':ptc:1', 'present', presentArgs),
      dispatch(5, ROOT + ':ptc:1', 'present', presentArgs, [{ type: 'text', text: 'Presented out/report.pdf' }]),
      ev('deliverables/presented', 6, { turn: 1, callId: ROOT + ':ptc:1', files: [{ path: '/p/out/report.pdf' }] }),
    ].map(entry))
    const tool = rows.find((row): row is ToolRow => row.kind === 'tool')
    expect(tool?.children).toHaveLength(1)
    expect(tool?.children?.[0]).toMatchObject({ name: 'present', callId: ROOT + ':ptc:1', executing: false })
    const delivery = rows.find(row => row.kind === 'deliverables')
    expect(delivery).toMatchObject({ kind: 'deliverables', callId: ROOT + ':ptc:1', files: [{ path: '/p/out/report.pdf' }] })
  })

  it('never throws on a malformed PTC payload', () => {
    const rows = toolRows([
      ev('session/end-seed', 0),
      rootCall(),
      ev('tool/ptc-dispatch-start', 4, { parentCallId: ROOT, name: 'bash' }),
      ev('tool/ptc-dispatch', 5, { parentCallId: ROOT, name: 'bash', content: 'not-an-array' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.children).toBeUndefined()
  })
})
