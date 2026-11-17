// @vitest-environment jsdom
/**
 * PTC (run_code) display in the real SideChatView.
 *
 * Why this spec exists: a PTC program logs only `run_code` as a tool/call and
 * dispatches its inner tools as log-only `tool/ptc-dispatch*` pairs, so the
 * side transcript used to show one raw-JSON run_code row and none of the
 * work the program did. The main conversation renders that call tree (root
 * row + indented sub-calls + the same structured cards); the side chat must
 * agree.
 *
 * ============================ CONTRACT ============================
 * 1. The run_code row's collapsed line carries the model-written description,
 *    never the raw arguments JSON.
 * 2. Its disclosed body shows the PROGRAM, not the escaped argument blob; the
 *    final output stays in its own labelled Result section.
 * 3. PTC sub-calls render as indented rows under that root, in
 *    `[data-sidechat-subcalls]`, OUTSIDE the root <details> — so a collapsed
 *    root still shows them.
 * 4. A bash sub-call renders the terminal card (command + output), and a read
 *    sub-call renders its line window; neither falls back to raw JSON.
 * ==================================================================
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'

const ROOT = 'root'

function ev(type: string, seq: number, data: Record<string, unknown> = {}): unknown {
  return { type, seq, time: seq * 1_000, data }
}

const BASH_ARGS = { command: 'echo ptc-child-ok' }
const READ_ARGS = { file_path: 'src/a.ts' }

function events(): unknown[] {
  return [
    ev('session/end-seed', 0),
    ev('user/message', 1, { content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } }),
    ev('turn/start', 2, { turn: 1 }),
    ev('tool/call', 3, {
      turn: 1,
      step: 1,
      callId: ROOT,
      name: 'run_code',
      arguments: JSON.stringify({
        code: 'const r = await tools.bash({ command: "echo root-code-only" })',
        description: 'Inspect the repo',
      }),
    }),
    ev('tool/ptc-dispatch-start', 4, { rootCallId: ROOT, parentCallId: ROOT, subCallId: ROOT + ':ptc:1', name: 'bash', arguments: BASH_ARGS }),
    ev('tool/ptc-dispatch', 5, {
      rootCallId: ROOT,
      parentCallId: ROOT,
      subCallId: ROOT + ':ptc:1',
      name: 'bash',
      arguments: BASH_ARGS,
      isError: false,
      content: [{ type: 'text', text: 'ptc-child-ok\n[exit code: 0]' }],
      meta: { cwd: '/p' },
    }),
    ev('tool/ptc-dispatch-start', 6, { rootCallId: ROOT, parentCallId: ROOT, subCallId: ROOT + ':ptc:2', name: 'read', arguments: READ_ARGS }),
    ev('tool/ptc-dispatch', 7, {
      rootCallId: ROOT,
      parentCallId: ROOT,
      subCallId: ROOT + ':ptc:2',
      name: 'read',
      arguments: READ_ARGS,
      isError: false,
      content: [{ type: 'text', text: '<content>\n1: read-child-ok\n</content>' }],
      meta: { path: 'src/a.ts', offset: 1, lines: [{ number: 1, text: 'read-child-ok' }], totalLines: 1, lang: 'ts' },
    }),
    ev('tool/result', 8, {
      turn: 1,
      step: 1,
      message: { source: { kind: 'tool', callId: ROOT }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'program done' }] }] },
    }),
    ev('assistant/message', 9, { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'finished' }] } }),
    // No turn/end: the turn fold stays open, so the root row is in view.
  ]
}

let harness: SidechatHarness

beforeEach(() => {
  harness = installSidechatHarness({ events: events() })
})

afterEach(() => {
  harness.cleanup()
})

describe('PTC run_code display in SideChatView', () => {
  it('shows the description, the program body and indented bash/read sub-call cards', async () => {
    const rendered = harness.mount()
    await harness.flush(4)
    try {
      const { container } = rendered
      const allDetails = [...container.querySelectorAll<HTMLDetailsElement>('details')]
      const root = allDetails.find(element => element.querySelector('summary')?.textContent?.includes('run_code') === true)
      expect(root, 'the run_code row renders as a disclosure').toBeDefined()
      if (root === undefined) return
      const summary = root.querySelector('summary')
      expect(summary).not.toBeNull()
      expect(summary!.textContent, 'the collapsed line is the model description').toContain('Inspect the repo')
      expect(summary!.textContent, 'the collapsed line never dumps raw arguments').not.toContain('{"code"')
      expect(root.open, 'the run_code row starts closed').toBe(false)
      expect(root.textContent, 'the disclosed body shows the program').toContain('root-code-only')
      expect(root.textContent, 'the final result keeps its own section').toContain('program done')

      const subcalls = container.querySelector<HTMLElement>('[data-sidechat-subcalls]')
      expect(subcalls, 'PTC sub-calls render in their own column').not.toBeNull()
      expect(root.contains(subcalls), 'the column is outside the root disclosure').toBe(false)
      const children = [...subcalls!.querySelectorAll<HTMLElement>('[data-sidechat-subcall]')]
      expect(children, 'both dispatched sub-calls render').toHaveLength(2)

      const summaries = children.map(child => child.querySelector('summary')?.textContent ?? '')
      expect(summaries[0], 'bash carries its command summary').toContain('bash')
      expect(summaries[0]).toContain('echo ptc-child-ok')
      expect(summaries[0], 'the bash line is not raw JSON').not.toContain('{"command"')
      expect(summaries[1], 'read carries its path summary').toContain('src/a.ts')

      const text = container.textContent ?? ''
      expect(text, 'the bash terminal output is visible').toContain('ptc-child-ok')
      expect(text, 'the read line window is visible').toContain('read-child-ok')
    } finally {
      rendered.unmount()
    }
  })
})
