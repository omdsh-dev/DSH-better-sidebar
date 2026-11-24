// @vitest-environment jsdom
/**
 * The transcript's mention vocabulary covers files this thread PRODUCED — and
 * only those. Regression guard for the source set, not for the renderer (see
 * `tests/sidechat-file-mentions.spec.tsx` for the mention control itself).
 *
 * Why this spec exists: the first cut of the vocabulary read `file_path` / `path`
 * out of EVERY `tool/call`, so a `read` target and a `grep`/`glob` root entered
 * it too. The host's own produced-path set is narrower — it counts the mutation
 * tools only (`ui-deliverables/turn-deliverables.ts`'s `mutationPath`: write /
 * edit / str_replace_editor) plus deliveries — and the difference is visible: a
 * directory spelled `` `src` `` or a file the thread merely READ became an
 * openable mention, so clicking it landed the editor on a folder or on a file
 * the thread never wrote.
 *
 * ============================ CONTRACT ============================
 * 1. `producedFilePaths` returns the targets of successful `write` / `edit` /
 *    MUTATING `str_replace_editor` calls and the `deliverables` paths — nothing
 *    else.
 * 2. A `read` target and a `grep` `path` (a directory) are NOT mentions in the
 *    rendered transcript: their inline code stays an inert `<code>`.
 * 3. `str_replace_editor` is judged by its `command`: `view` only reads, so its
 *    target is inert too; `create` (like `str_replace` / `insert`) is a
 *    mutation and stays clickable.
 * 4. A FAILED call produced nothing. The failure channel is the host's — the
 *    tool message's own `isError` (a tool that throws a bare error sets that and
 *    nothing else) — so a failed `write` target is inert.
 * 5. The mutation targets and the delivered file ARE mentions (the guard: the
 *    narrowing must not empty the vocabulary).
 * ==================================================================
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { producedFilePaths } from '../src/client/sidechat-mentions.ts'
import { transcriptRows } from '../src/client/sidechat-transcript.ts'
import type { SidebarHistoryEntry, SidebarSessionEvent } from '../src/context-types.ts'

/** One `tool/call` + its `tool/result` (failed results carry the host's own
 *  `isError` on the tool message, exactly like a tool that threw). */
function call(
  name: string,
  seq: number,
  args: Record<string, unknown>,
  failed = false,
): SidebarSessionEvent[] {
  const callId = `c-${name}-${String(seq)}`
  return [
    {
      type: 'tool/call',
      seq,
      time: seq * 1_000,
      data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
    } as SidebarSessionEvent,
    {
      type: 'tool/result',
      seq: seq + 1,
      time: (seq + 1) * 1_000,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId },
          ...(failed ? { isError: true } : {}),
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: failed ? 'boom' : 'ok' }] }],
        },
      },
    } as SidebarSessionEvent,
  ]
}

/** The paths this thread produced (or only touched), by tool. */
const READ_PATH = 'src/read-me.ts'
const SEARCH_ROOT = 'src'
const WRITTEN = 'src/written.ts'
const EDITED = 'src/edited.ts'
const EDITOR_PATH = 'src/editor-created.ts'
const VIEWED_PATH = 'src/editor-viewed.ts'
const FAILED_WRITE = 'src/never-written.ts'
const DELIVERED = 'src/delivered.ts'

/** The answer that spells every candidate token in inline code. */
const ANSWER = `I read \`${READ_PATH}\`, searched \`${SEARCH_ROOT}\`, wrote \`${WRITTEN}\`, `
  + `edited \`${EDITED}\`, created \`${EDITOR_PATH}\`, viewed \`${VIEWED_PATH}\`, `
  + `failed to write \`${FAILED_WRITE}\`, and delivered \`${DELIVERED}\`.`

/** A thread that reads, searches, mutates and delivers. */
function events(): SidebarSessionEvent[] {
  return [
    { type: 'session/end-seed', seq: 0, time: 0, data: { inherited: true } } as SidebarSessionEvent,
    {
      type: 'user/message',
      seq: 1,
      time: 1_000,
      data: { content: [{ type: 'text', text: 'which files?' }], source: { kind: 'user' } },
    } as SidebarSessionEvent,
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } } as SidebarSessionEvent,
    ...call('read', 3, { file_path: READ_PATH }),
    ...call('grep', 5, { pattern: 'needle', path: SEARCH_ROOT }),
    ...call('write', 7, { file_path: WRITTEN, content: 'x' }),
    ...call('edit', 9, { file_path: EDITED, old_string: 'a', new_string: 'b' }),
    ...call('str_replace_editor', 11, { command: 'create', path: EDITOR_PATH, file_text: 'x' }),
    // A read-only editor command: `view` mutates nothing.
    ...call('str_replace_editor', 13, { command: 'view', path: VIEWED_PATH }),
    // A failure the host reports only through the tool message's own isError
    // (a tool that throws a bare error writes no `data.error`).
    ...call('write', 15, { file_path: FAILED_WRITE, content: 'x' }, true),
    {
      type: 'deliverables/presented',
      seq: 17,
      time: 17_000,
      data: { turn: 1, files: [{ path: DELIVERED }] },
    } as SidebarSessionEvent,
    {
      type: 'assistant/message',
      seq: 18,
      time: 18_000,
      data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: ANSWER }] } },
    } as SidebarSessionEvent,
  ]
}

/** History rows from a plain event list (the wire's shape). */
function entries(list: readonly SidebarSessionEvent[]): SidebarHistoryEntry[] {
  return list.map(event => ({ event }))
}

/** The mention control inside the inline code whose own text is exactly `token`. */
function mentionOf(container: HTMLElement, token: string): HTMLButtonElement | undefined {
  const codes = [...container.querySelectorAll<HTMLElement>('code')]
  const code = codes.find(element => element.textContent?.trim() === token)
  expect(code, `the token "${token}" renders as inline code`).toBeDefined()
  return code?.querySelector<HTMLButtonElement>('button') ?? undefined
}

let harness: SidechatHarness

beforeEach(() => {
  harness = installSidechatHarness()
})

afterEach(() => {
  harness.cleanup()
})

describe('the mention vocabulary is scoped to producing tools (D12)', () => {
  it('collects mutation targets and deliveries only', () => {
    const produced = producedFilePaths(transcriptRows(entries(events())))
    expect(produced).toEqual([WRITTEN, EDITED, EDITOR_PATH, DELIVERED])
    // Each exclusion states the rule it guards: a read target, a search root, a
    // read-only editor command's target, and a FAILED write's target.
    expect(produced, 'a read target is not production').not.toContain(READ_PATH)
    expect(produced, 'a search root is not production').not.toContain(SEARCH_ROOT)
    expect(produced, 'str_replace_editor `view` mutates nothing').not.toContain(VIEWED_PATH)
    expect(produced, 'a FAILED write produced nothing').not.toContain(FAILED_WRITE)
  })

  it('leaves the non-producing calls inert while the mutations stay clickable', async () => {
    harness.wire.events = events()
    const rendered = harness.mount()
    await harness.flush(4)
    try {
      const { container } = rendered
      expect(mentionOf(container, READ_PATH), 'a file the thread only READ is not a mention').toBeUndefined()
      expect(mentionOf(container, SEARCH_ROOT), 'a search root (a directory) is not a mention').toBeUndefined()
      expect(mentionOf(container, VIEWED_PATH), 'a read-only editor command is not a mention').toBeUndefined()
      expect(mentionOf(container, FAILED_WRITE), 'a FAILED write is not a mention').toBeUndefined()

      expect(mentionOf(container, WRITTEN), 'a written file is a mention').toBeDefined()
      expect(mentionOf(container, EDITED), 'an edited file is a mention').toBeDefined()
      expect(mentionOf(container, EDITOR_PATH), 'an editor-created file is a mention').toBeDefined()
      expect(mentionOf(container, DELIVERED), 'a delivered file is a mention').toBeDefined()
    } finally {
      rendered.unmount()
    }
  })

  it('counts mutation targets dispatched inside run_code, and still excludes its reads', async () => {
    const PTC_WRITTEN = 'src/ptc-written.ts'
    const PTC_READ = 'src/ptc-read.ts'
    const root = 'ptc-root'
    const dispatch = (seq: number, sub: string, name: string, args: Record<string, unknown>, text: string): SidebarSessionEvent[] => [
      {
        type: 'tool/ptc-dispatch-start',
        seq,
        time: seq * 1_000,
        data: { rootCallId: root, parentCallId: root, subCallId: sub, name, arguments: args },
      } as SidebarSessionEvent,
      {
        type: 'tool/ptc-dispatch',
        seq: seq + 1,
        time: (seq + 1) * 1_000,
        data: { rootCallId: root, parentCallId: root, subCallId: sub, name, arguments: args, isError: false, content: [{ type: 'text', text }] },
      } as SidebarSessionEvent,
    ]
    const list: SidebarSessionEvent[] = [
      { type: 'session/end-seed', seq: 0, time: 0, data: { inherited: true } } as SidebarSessionEvent,
      {
        type: 'user/message',
        seq: 1,
        time: 1_000,
        data: { content: [{ type: 'text', text: 'do it in code' }], source: { kind: 'user' } },
      } as SidebarSessionEvent,
      { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } } as SidebarSessionEvent,
      {
        type: 'tool/call',
        seq: 3,
        time: 3_000,
        data: { turn: 1, step: 1, callId: root, name: 'run_code', arguments: JSON.stringify({ code: 'await tools.write({})', description: 'Write a file' }) },
      } as SidebarSessionEvent,
      ...dispatch(4, root + ':ptc:1', 'write', { file_path: PTC_WRITTEN, content: 'x' }, 'written'),
      ...dispatch(6, root + ':ptc:2', 'read', { file_path: PTC_READ }, 'read'),
      {
        type: 'tool/result',
        seq: 8,
        time: 8_000,
        data: {
          turn: 1,
          step: 1,
          message: { source: { kind: 'tool', callId: root }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'done' }] }] },
        },
      } as SidebarSessionEvent,
      {
        type: 'assistant/message',
        seq: 9,
        time: 9_000,
        data: {
          turn: 1,
          step: 2,
          message: { content: [{ type: 'text', text: 'I wrote `' + PTC_WRITTEN + '` and read `' + PTC_READ + '`.' }] },
        },
      } as SidebarSessionEvent,
    ]

    const produced = producedFilePaths(transcriptRows(entries(list)))
    expect(produced, 'a write inside run_code is production').toContain(PTC_WRITTEN)
    expect(produced, 'a read inside run_code is not production').not.toContain(PTC_READ)

    harness.wire.events = list
    const rendered = harness.mount()
    await harness.flush(4)
    try {
      const { container } = rendered
      expect(mentionOf(container, PTC_WRITTEN), 'the PTC write stays clickable').toBeDefined()
      expect(mentionOf(container, PTC_READ), 'the PTC read stays inert').toBeUndefined()
    } finally {
      rendered.unmount()
    }
  })
})
