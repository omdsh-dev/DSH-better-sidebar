// @vitest-environment jsdom
/**
 * R1 — the side chat follows the SAME global "work details" preference the main
 * conversation does. Design basis: `/tmp/bsb-parity/forkpoint-recon.md`
 * §Q1/§Q2, the host's own reader of that setting
 * (`ui-chat/src/client/transcript-view.ts:56-66`), its policy table
 * (`ui-chat/src/client/presentation-policy.ts:23-52`), the settings vocabulary
 * (`ui-chat/src/chat-settings.ts:6-36`) and the collapse-timing consumer
 * (`ui-chat/src/client/chat/ChatView.tsx:145-153,278` + `ChatGroupSeat.tsx:239`).
 *
 * Why this spec exists: the side chat renders EVERY settled turn with all of its
 * reasoning and tool rows individually exposed, and it reads no preference at
 * all (`grep -rn "configForms|transcriptView|collapseTiming" src` → nothing).
 * A reader who set "work steps: compact" therefore gets a wall of process rows
 * in the side panel while the main pane folds them away; the two transcripts of
 * the same conversation disagree about how much detail to show.
 *
 * ============================ CONTRACT ============================
 * S. SOURCE AND NORMALIZATION. The mode comes from the host's public
 *    cross-plugin service — `ctx.get('configForms')` → `.get('ui-chat')` →
 *    `getSnapshot()`/`subscribe()` — and is normalized exactly like
 *    `transcript-view.ts:56-66`:
 *      S1. `transcriptView` in `{'normal', 'expanded'}` reads as `detailed`;
 *          any other absent/null value falls back to the client DEFAULT.
 *      S2. The default is the Web default: `detailed` (`'dshDesktop' in
 *          globalThis` is false in this environment). A missing `configForms`
 *          service, a form that is not `ready` yet (`value === undefined`) or an
 *          unusable value all keep that default — the transcript never locks
 *          into a data-less mode, and never crashes.
 *      S3. `collapseTiming` defaults to `completion`; `next-input` is honored.
 *      S4. The mounted transcript follows the form's notifications live: a
 *          `subscribe()` push is enough to re-render, no remount.
 * T. TURN FOLD. Every turn that produced process rows (reasoning / tool) gets
 *    ONE Turn-level disclosure, `data-sidechat-turn-fold` on a native
 *    `<details>` whose `<summary>` is the always-visible line:
 *      T0. THE LINE'S COPY is the host's own turn-process vocabulary — the host
 *          labels this same control from `message.turnProcess.*`, and the user
 *          asked for parity with the main pane, not for a plugin caption:
 *            settled WITH a measured duration →
 *              `t('sideChatTurnTook', { duration })` ("done, took …"), the
 *              duration formatted by the transcript's own `formatDurationMs`
 *              (the same formatter its turn-tail usage line prints, so the two
 *              lines can never disagree);
 *            settled WITHOUT a measurable duration → `t('sideChatTurnDone')`;
 *            still RUNNING → `t('sideChatTurnRunning')`, and that control stays
 *              open (T5).
 *          The old `sideChatWorkDetails` caption retires with this contract.
 *      T1. A COMPLETED turn (`turn/end` landed) is folded: the disclosure is
 *          CLOSED, so its process rows are hidden. Folding HIDES, never
 *          deletes: those rows stay in the DOM inside the closed disclosure.
 *      T2. The user question and the assistant's ANSWER are never inside the
 *          fold — only work details are.
 *      T3. `compact`, `standard` AND `detailed` all fold completed turns (host
 *          `foldCompletedTurns: true` for those three modes, and that is what
 *          the host's table says); the fold is closed.
 *      T4. `verbose` folds nothing: no `[data-sidechat-turn-fold]` at all.
 *      T5. A turn that has not ended yet is never HIDDEN: it has its control
 *          line in `compact`/`standard`/`detailed` but that disclosure is OPEN,
 *          so its process rows stay visible (there is no settled work to
 *          summarise). `verbose` has no control at all (T4).
 *      T6. `collapseTiming`: under `completion` (the default) the newest
 *          completed turn folds like the rest; under `next-input` it STAYS OPEN
 *          (host: `deferTurn = tailTurn`) so the reader can see what just
 *          happened until they send the next message.
 *      T7. `liveProcessDetail` (true for `standard` and `detailed`, false for
 *          `compact` and `verbose`) picks what the RUNNING turn's control line
 *          says: those two modes append live process detail — the running
 *          tool's name or command, or the first line of its reasoning — while
 *          `compact` keeps just the running label. This is the one difference a flat
 *          transcript still shares with the host's per-mode table, so it is
 *          also what the DEFAULT and legacy-value fallbacks are asserted by.
 *
 * Locale keys this contract needs (every shipped dictionary, not just zh/en):
 *   `sideChatTurnTook`    — settled with a measured duration (`{duration}`)
 *   `sideChatTurnDone`    — settled without one
 *   `sideChatTurnRunning` — still running
 *
 * The ladder above is the batch's agreed equivalence for a flat transcript: the
 * host differentiates `compact`/`standard`/`detailed` by in-turn step grouping,
 * which the side chat does not render; folding and the live-detail line are the
 * two signals it does share with the host.
 * ==================================================================
 *
 * The shared view harness owns no `configForms` face and this task may not
 * change it, so this spec mounts the real view with a spec-local `ctx`
 * (`harness.extraProps` is the harness's documented seam for exactly this).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { t } from '../src/client/locales.ts'
import { formatDurationMs } from '../src/client/sidechat-transcript.ts'

/** The three copies the Turn control line can show (host `message.turnProcess.*`). */
const TOOK_KEY = 'sideChatTurnTook'
const DONE_KEY = 'sideChatTurnDone'
const RUNNING_KEY = 'sideChatTurnRunning'

/** The duration the fixtures' completed turns measure (`turn/start` →
 *  `turn/end`: 4 s), formatted by the transcript's own formatter. */
const SETTLED_DURATION = formatDurationMs(4_000)

/** Translate a key this spec names but the build may not have yet. */
function copy(key: string, params?: Record<string, string | number>): string {
  return (t as unknown as (key: string, params?: Record<string, string | number>) => string)(key, params)
}

/** The marker texts the assertions locate rows by (unique per turn). */
const QUESTION_ONE = 'QUESTION-ONE'
const ANSWER_ONE = 'ANSWER-ONE'
const REASONING_ONE = 'REASONING-ONE'
const COMMAND_ONE = 'COMMAND-ONE'
const QUESTION_TWO = 'QUESTION-TWO'
const ANSWER_TWO = 'ANSWER-TWO'
const REASONING_TWO = 'REASONING-TWO'
const COMMAND_TWO = 'COMMAND-TWO'
/** The turn that is still running when the transcript is pulled. */
const QUESTION_RUNNING = 'QUESTION-RUNNING'
const REASONING_RUNNING = 'REASONING-RUNNING'
const COMMAND_RUNNING = 'COMMAND-RUNNING'

/** Anything a live-detail line may legitimately quote for the running turn. */
const LIVE_DETAIL_MARKERS = ['bash', COMMAND_RUNNING, REASONING_RUNNING]

/** The `ui-chat` settings namespace (host `chat-settings.ts:6`). */
const CHAT_NAMESPACE = 'ui-chat'

/** One `ConfigForm` snapshot, narrowed to what the view may read. */
interface FormState {
  status: 'loading' | 'ready' | 'unavailable'
  value?: { transcriptView?: string | null; collapseTiming?: string }
}

/** A live form stub: the view subscribes, the test publishes. */
interface FormStub {
  form: {
    getSnapshot: () => FormState
    subscribe: (listener: () => void) => () => void
    set: () => Promise<void>
  }
  publish: (next: FormState) => void
}

/**
 * Build one `ui-chat` config form.
 * @param initial - the snapshot it starts with.
 */
function installForm(initial: FormState): FormStub {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    form: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: () => Promise.resolve(),
    },
    publish: (next: FormState) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** A form whose host has accepted these values. */
function readyForm(value: FormState['value']): FormStub {
  return installForm({ status: 'ready', value })
}

/** The `configForms` service face: one namespace, one shared form. */
function configFormsOf(stub: FormStub | undefined): unknown {
  if (stub === undefined) return undefined
  return { get: (id: string) => (id === CHAT_NAMESPACE ? stub.form : undefined) }
}

/** The sessions-list fixture the shared harness installs (same rows). */
function listFixture(): unknown {
  return {
    byId: {
      root: { id: 'root', cwd: '/p', displayTitle: '主会话', running: false },
      t1: { id: 't1', cwd: '/p', displayTitle: 'Side: 线程一', origin: 'subagent', parentId: 'root', running: false },
    },
    projectionsBySession: {
      root: {
        values: { subagentCatalog: [{ id: 't1', createdAt: 1_000, mode: 'continuable', label: 'Side: 线程一' }] },
        state: 'ready',
        error: null,
      },
    },
  }
}

/** One completed turn: question, tool call + result, reasoning + answer, end. */
function completedTurn(
  turn: number,
  at: number,
  markers: { question: string; reasoning: string; command: string; answer: string },
): unknown[] {
  const callId = `call-${String(turn)}`
  return [
    { type: 'user/message', seq: at, time: at * 1_000, data: { id: `m-${String(turn)}`, role: 'user', content: [{ type: 'text', text: markers.question }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: at + 1, time: (at + 1) * 1_000, data: { turn } },
    { type: 'tool/call', seq: at + 2, time: (at + 2) * 1_000, data: { turn, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command: markers.command }) } },
    {
      type: 'tool/result',
      seq: at + 3,
      time: (at + 3) * 1_000,
      data: {
        turn,
        step: 1,
        message: {
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }],
        },
      },
    },
    {
      type: 'assistant/message',
      seq: at + 4,
      time: (at + 4) * 1_000,
      data: {
        turn,
        step: 1,
        message: { content: [{ type: 'reasoning', text: markers.reasoning }, { type: 'text', text: markers.answer }] },
      },
    },
    { type: 'turn/end', seq: at + 5, time: (at + 5) * 1_000, data: { turn, reason: { kind: 'completed' } } },
  ]
}

/** A turn that is still running: a tool call with no result yet, and a step
 *  message carrying that step's reasoning. No `turn/end`. */
function runningTurn(turn: number, at: number, markers: { reasoning: string; command: string }): unknown[] {
  const callId = `call-running-${String(turn)}`
  return [
    { type: 'user/message', seq: at, time: at * 1_000, data: { id: `m-${String(turn)}`, role: 'user', content: [{ type: 'text', text: QUESTION_RUNNING }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: at + 1, time: (at + 1) * 1_000, data: { turn } },
    { type: 'tool/call', seq: at + 2, time: (at + 2) * 1_000, data: { turn, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command: markers.command }) } },
    {
      type: 'assistant/message',
      seq: at + 3,
      time: (at + 3) * 1_000,
      data: { turn, step: 1, message: { content: [{ type: 'reasoning', text: markers.reasoning }] } },
    },
  ]
}

/** The thread's own log: two settled turns. */
function twoTurns(): unknown[] {
  return [
    { type: 'session/end-seed', seq: 0, time: 0, data: { inherited: true } },
    ...completedTurn(1, 1, { question: QUESTION_ONE, reasoning: REASONING_ONE, command: COMMAND_ONE, answer: ANSWER_ONE }),
    ...completedTurn(2, 7, { question: QUESTION_TWO, reasoning: REASONING_TWO, command: COMMAND_TWO, answer: ANSWER_TWO }),
  ]
}

/** The same two settled turns plus a third that is still running. */
function withRunningTurn(): unknown[] {
  return [...twoTurns(), ...runningTurn(3, 13, { reasoning: REASONING_RUNNING, command: COMMAND_RUNNING })]
}

/** The Turn-level disclosures, in document order. */
function folds(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-sidechat-turn-fold]')]
}

/** The closed Turn-level disclosures — the ones hiding their rows. */
function closedFolds(container: HTMLElement): HTMLElement[] {
  return folds(container).filter(fold => !isOpen(fold))
}

/** The innermost element carrying `needle` (document order puts descendants last). */
function innermost(container: HTMLElement, needle: string): HTMLElement | undefined {
  const matches = [...container.querySelectorAll<HTMLElement>('*')]
    .filter(element => (element.textContent ?? '').includes(needle))
  return matches.at(-1)
}

/** The Turn disclosure that owns `needle`, when one does. */
function foldOf(container: HTMLElement, needle: string): HTMLElement | undefined {
  return innermost(container, needle)?.closest<HTMLElement>('[data-sidechat-turn-fold]') ?? undefined
}

/** Whether a disclosure is open. */
function isOpen(fold: HTMLElement): boolean {
  return fold.hasAttribute('open')
}

/** The always-visible line of a disclosure. */
function summaryOf(fold: HTMLElement): HTMLElement | null {
  return fold.querySelector<HTMLElement>('summary')
}

/** What the reader sees on a disclosure's line (its copy plus any tooltip). */
function lineOf(fold: HTMLElement): string {
  const summary = summaryOf(fold)
  return `${summary?.textContent ?? ''} ${summary?.getAttribute('title') ?? ''}`
}

/** Whether `needle` sits behind a CLOSED Turn fold. */
function hiddenBehindClosedFold(container: HTMLElement, needle: string): boolean {
  const fold = foldOf(container, needle)
  return fold !== undefined && !isOpen(fold)
}

/**
 * Whether any mode-specific live detail (a running tool's name/command, or the
 * first line of its reasoning) reached the running turn's line.
 * @param fold - the running turn's disclosure.
 */
function carriesLiveDetail(fold: HTMLElement | undefined): boolean {
  if (fold === undefined) return false
  const line = lineOf(fold)
  return LIVE_DETAIL_MARKERS.some(marker => line.includes(marker))
}

/** The running turn's disclosure, or undefined when the view draws none. */
function runningFold(container: HTMLElement): HTMLElement | undefined {
  return foldOf(container, REASONING_RUNNING) ?? foldOf(container, COMMAND_RUNNING)
}

let harness: SidechatHarness

beforeEach(() => {
  harness = installSidechatHarness()
})

afterEach(() => {
  harness.cleanup()
})

/**
 * Mount the real transcript under a `ui-chat` settings form.
 * @param stub - the form, or undefined for a composition without `configForms`.
 * @param events - the thread's own log.
 */
async function mountWith(stub: FormStub | undefined, events: unknown[]) {
  harness.wire.events = events
  // One stable snapshot object: `useSyncExternalStore` loops forever when
  // `getSnapshot()` returns a fresh reference on every call.
  const list = listFixture()
  const forms = configFormsOf(stub)
  harness.extraProps.ctx = {
    sessions: { list: { getSnapshot: () => list, subscribe: () => () => {} } },
    get: (key: string) => {
      if (key === 'betterSidebar') return harness.host
      if (key === 'configForms') return forms
      return undefined
    },
  }
  const rendered = harness.mount()
  await harness.flush(6)
  return rendered
}

describe('Turn control copy (R1)', () => {
  it('defines the three turn-line copies in the dictionaries', () => {
    for (const key of [TOOK_KEY, DONE_KEY, RUNNING_KEY]) {
      expect(copy(key), `the ${key} key must exist in the locale dictionary`).not.toBe(key)
    }
    // The took copy interpolates the measured duration as `{duration}`.
    expect(copy(TOOK_KEY), 'the took copy carries a {duration} placeholder').toContain('{duration}')
    expect(copy(TOOK_KEY, { duration: SETTLED_DURATION })).toBe(
      copy(TOOK_KEY).replace('{duration}', SETTLED_DURATION),
    )
  })
})

describe('work details: every folding mode (R1)', () => {
  for (const mode of ['compact', 'standard', 'detailed'] as const) {
    it(`folds every settled turn behind one closed control (${mode})`, async () => {
      const rendered = await mountWith(readyForm({ transcriptView: mode }), twoTurns())
      try {
        const container = rendered.container
        const all = folds(container)
        expect(all, 'each settled turn gets exactly one control').toHaveLength(2)
        for (const fold of all) {
          expect(fold.tagName, 'the control is a native disclosure').toBe('DETAILS')
          expect(isOpen(fold), 'a settled turn starts folded').toBe(false)
          const line = summaryOf(fold)?.textContent ?? ''
          expect(line, 'a settled turn says what it did, with its duration')
            .toContain(copy(TOOK_KEY, { duration: SETTLED_DURATION }))
          expect(line, 'and never claims to still be running').not.toContain(copy(RUNNING_KEY))
        }
        // Folding HIDES, it does not delete: the work rows are still there.
        for (const marker of [REASONING_ONE, COMMAND_ONE, REASONING_TWO, COMMAND_TWO]) {
          expect(innermost(container, marker), `${marker} is still in the DOM`).toBeDefined()
          expect(hiddenBehindClosedFold(container, marker), `${marker} is hidden by a closed fold`).toBe(true)
        }
        // Only work details fold: the question and the answer stay readable.
        for (const marker of [QUESTION_ONE, ANSWER_ONE, QUESTION_TWO, ANSWER_TWO]) {
          expect(foldOf(container, marker), `${marker} is not inside a turn fold`).toBeUndefined()
        }
      } finally {
        rendered.unmount()
      }
    })
  }

  it('keeps the newest completed turn open under the next-input timing', async () => {
    const rendered = await mountWith(
      readyForm({ transcriptView: 'compact', collapseTiming: 'next-input' }),
      twoTurns(),
    )
    try {
      const container = rendered.container
      expect(folds(container), 'both settled turns still get their control').toHaveLength(2)
      expect(hiddenBehindClosedFold(container, REASONING_ONE), 'the older turn folds').toBe(true)
      expect(
        hiddenBehindClosedFold(container, REASONING_TWO),
        'the newest completed turn stays open until the next input',
      ).toBe(false)
    } finally {
      rendered.unmount()
    }
  })

  it('folds the newest completed turn too under the default completion timing', async () => {
    const rendered = await mountWith(readyForm({ transcriptView: 'compact' }), twoTurns())
    try {
      expect(
        hiddenBehindClosedFold(rendered.container, REASONING_TWO),
        'absence of collapseTiming means completion',
      ).toBe(true)
    } finally {
      rendered.unmount()
    }
  })

  it('never hides a turn that has not ended', async () => {
    const rendered = await mountWith(readyForm({ transcriptView: 'compact' }), withRunningTurn())
    try {
      const container = rendered.container
      expect(closedFolds(container), 'only the settled turns fold themselves shut').toHaveLength(2)
      expect(
        hiddenBehindClosedFold(container, REASONING_RUNNING),
        'the running turn has no settled work to summarise',
      ).toBe(false)
      expect(
        hiddenBehindClosedFold(container, COMMAND_RUNNING),
        'and its executing command stays visible too',
      ).toBe(false)
    } finally {
      rendered.unmount()
    }
  })

  it('folds nothing at all in verbose', async () => {
    const rendered = await mountWith(readyForm({ transcriptView: 'verbose' }), twoTurns())
    try {
      const container = rendered.container
      expect(folds(container), 'verbose has no turn controls').toHaveLength(0)
      for (const marker of [REASONING_ONE, COMMAND_ONE, ANSWER_ONE]) {
        expect(innermost(container, marker), `${marker} still renders`).toBeDefined()
      }
    } finally {
      rendered.unmount()
    }
  })
})

describe('work details: the running turn line (R1, liveProcessDetail)', () => {
  it('keeps the running line generic in compact', async () => {
    const rendered = await mountWith(readyForm({ transcriptView: 'compact' }), withRunningTurn())
    try {
      const fold = runningFold(rendered.container)
      expect(fold, 'the running turn has a control line too').toBeDefined()
      expect(lineOf(fold as HTMLElement), 'a running turn says it is in progress')
        .toContain(copy(RUNNING_KEY))
      expect(lineOf(fold as HTMLElement), 'and is not labelled as finished')
        .not.toContain(copy(DONE_KEY))
      expect(
        carriesLiveDetail(fold),
        'compact never quotes the running command or reasoning',
      ).toBe(false)
    } finally {
      rendered.unmount()
    }
  })

  for (const mode of ['standard', 'detailed'] as const) {
    it(`carries live process detail on the running line in ${mode}`, async () => {
      const rendered = await mountWith(readyForm({ transcriptView: mode }), withRunningTurn())
      try {
        const fold = runningFold(rendered.container)
        expect(fold, 'the running turn has a control line').toBeDefined()
        expect(
          carriesLiveDetail(fold),
          `liveProcessDetail quotes the running tool/command/reasoning in ${mode}`,
        ).toBe(true)
        expect(lineOf(fold as HTMLElement), 'the line still says the turn is running')
          .toContain(copy(RUNNING_KEY))
      } finally {
        rendered.unmount()
      }
    })
  }
})

describe('work details: the preference is live (R1)', () => {
  it('re-renders the mounted transcript when the setting changes', async () => {
    const stub = readyForm({ transcriptView: 'compact' })
    const rendered = await mountWith(stub, withRunningTurn())
    try {
      expect(folds(rendered.container), 'starts in compact (one control per turn)').toHaveLength(3)
      expect(
        carriesLiveDetail(runningFold(rendered.container)),
        'compact starts generic',
      ).toBe(false)

      stub.publish({ status: 'ready', value: { transcriptView: 'verbose' } })
      await harness.flush(4)
      expect(folds(rendered.container), 'the mounted view follows the store').toHaveLength(0)

      stub.publish({ status: 'ready', value: { transcriptView: 'compact' } })
      await harness.flush(4)
      expect(folds(rendered.container), 'and follows it back').toHaveLength(3)
    } finally {
      rendered.unmount()
    }
  })

  it('falls back to the Web default (detailed) without a configForms service', async () => {
    const rendered = await mountWith(undefined, withRunningTurn())
    try {
      const container = rendered.container
      expect(innermost(container, ANSWER_ONE), 'the transcript renders with no settings service').toBeDefined()
      expect(hiddenBehindClosedFold(container, REASONING_ONE), 'the default folds settled work').toBe(true)
      expect(
        carriesLiveDetail(runningFold(container)),
        'and the default is detailed, which shows live process detail',
      ).toBe(true)
    } finally {
      rendered.unmount()
    }
  })

  it('keeps the default while the form is not ready', async () => {
    const rendered = await mountWith(installForm({ status: 'loading' }), withRunningTurn())
    try {
      const container = rendered.container
      expect(innermost(container, ANSWER_ONE), 'the transcript renders while settings load').toBeDefined()
      expect(
        carriesLiveDetail(runningFold(container)),
        'a form without accepted values keeps the detailed default',
      ).toBe(true)
    } finally {
      rendered.unmount()
    }
  })

  it('treats the legacy saved values as detailed', async () => {
    for (const legacy of ['normal', 'expanded']) {
      const rendered = await mountWith(readyForm({ transcriptView: legacy }), withRunningTurn())
      try {
        expect.soft(
          carriesLiveDetail(runningFold(rendered.container)),
          `legacy "${legacy}" reads as detailed`,
        ).toBe(true)
      } finally {
        rendered.unmount()
      }
    }
  })
})

describe('work details: the settled line without a duration (R1)', () => {
  it('labels a settled turn with no measurable duration as done', async () => {
    // No `turn/start`: the mapping can compute no wall time for the turn.
    const events = [
      { type: 'session/end-seed', seq: 0, time: 0, data: { inherited: true } },
      ...completedTurn(1, 1, {
        question: QUESTION_ONE,
        reasoning: REASONING_ONE,
        command: COMMAND_ONE,
        answer: ANSWER_ONE,
      }).filter(event => (event as { type: string }).type !== 'turn/start'),
    ]
    const rendered = await mountWith(readyForm({ transcriptView: 'compact' }), events)
    try {
      const fold = foldOf(rendered.container, REASONING_ONE)
      expect(fold, 'the settled turn is folded').toBeDefined()
      const line = lineOf(fold as HTMLElement)
      expect(line, 'a turn with no measured duration just says done').toContain(copy(DONE_KEY))
      expect(line, 'and quotes no duration').not.toContain(copy(TOOK_KEY, { duration: SETTLED_DURATION }))
      expect(line, 'and is not running').not.toContain(copy(RUNNING_KEY))
    } finally {
      rendered.unmount()
    }
  })
})
