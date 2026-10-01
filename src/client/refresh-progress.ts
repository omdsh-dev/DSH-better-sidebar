/**
 * Tracy's progress on the Refresh button (Tracy, 29/09/2026; TCH `tasks/todo-comment-people.md`
 * rule 5, contract `tasks/evidence/comment-people/contract.md` H2; stories RefreshWorking ·
 * RefreshWorkingLong · RefreshNewVersionUpdated · RefreshNewVersionReady and their compact forms).
 *
 * Nothing about a turn is drawn on the page any more — not on a pin, not as a pill — so a comment's
 * bubble and Tracy's work never overlap. The button says it:
 *
 *   the sender   `tracy:tracy-working` → spins + chip "Tracy is working" for {@link CHIP_MS}, then
 *                only spins · `tracy:turn-end` after a `tracy:site-changed` → the page reloads itself
 *                when it can, then chip "New version updated" for exactly {@link CHIP_MS} · it cannot
 *                (a comment box open — popover, edit or reply —, on another page, the reload never came back) →
 *                terracotta + "New version ready" until clicked.
 *                `tracy:tracy-asking` (a question card waits on the person) → still, no chip, until
 *                the answer's `tracy:tracy-working` spins it again (stage 6 acceptance F3: it spun
 *                "Tracy is working" for seven minutes while Tracy was waiting on the person).
 *   everyone     the 15 s poll's `siteChangedAt` is newer than the page's load → "New version ready";
 *                never a spinner, never an automatic reload (the stage-5 soft reload is gone).
 *
 * Pure, so `tests/refresh-progress.spec.ts` holds the rules; `BrowserView` runs it with the timers.
 */

/** How long a chip stays: "Tracy is working" after a send, "New version updated" after a reload. */
export const CHIP_MS = 3_000

/** How long an automatic reload may take before the page counts as not reloaded ("New version ready"). */
export const RELOAD_WAIT_MS = 10_000

export type RefreshLook = 'idle' | 'working' | 'working-long' | 'updated' | 'ready'

/**
 * How long the site tabs' reload request of a change the tab already answered is taken as that same
 * change (ms). Their request follows the turn's end by one round trip, or by the `/api/sites` answer
 * when the tab sits at a served address the site key does not name (14–19 s measured 23/09 on the
 * local stand); a minute covers both. The cost of the window: a second change inside it whose own
 * turn this tab did not hear, arriving while the first change's request never came, is shown as
 * "New version ready" by the poll instead of being reloaded.
 */
export const ABSORB_MS = 60_000

/**
 * How long a turn that changed nothing still draws as working after its end (ms; round 6, acceptance
 * v4 S08). Queued turns follow each other by 50–60 ms (measured: turn 1 ends 14.16 s, turn 2 begins
 * 14.21 s), which flashed the button idle for one frame; a turn beginning inside this window goes on
 * spinning as the same work. 300 ms is below what reads as "Tracy stopped" and far above the gap.
 */
export const SETTLE_MS = 300

/**
 * How long the working state a send starts at its press waits for the turn's own start (ms; round 9,
 * acceptance v5 V5S-6: a thread card's send took 0.8–1.8 s to spin, the chat saying the turn only once
 * its message landed). A send the chat took starts its turn within seconds, or queues behind a turn
 * already spinning; a turn that never starts lets the button go after this.
 */
export const PENDING_MS = 30_000

export interface RefreshState {
  /** `asking`: the turn waits on the person's answer to a question card; drawn as idle. */
  phase: 'idle' | 'working' | 'asking' | 'reloading' | 'updated' | 'ready'
  /** When the chip of `working` / `updated` goes (ms). */
  chipUntil: number
  /** The turn in progress wrote to the site. */
  changed: boolean
  /**
   * Until when (ms) the site tabs' next reload request is the change this tab's own turn end already
   * answered (reloaded or held), so it adds nothing; 0: none expected.
   */
  absorbUntil: number
  /** The site tabs' request came while the turn was still at work: its turn end answers it. */
  asked: boolean
  /**
   * `ready` because the tab was hidden when its reload came (round 6, acceptance v4 R13): the reload
   * happens when the tab is shown (`shown`), not in the background.
   */
  whenShown: boolean
  /** `idle` after a turn that changed nothing: drawn as working until then (ms), {@link SETTLE_MS}. */
  settleUntil: number
  /**
   * `working` started by a send at its press, before the chat said its turn started (round 9): until
   * when (ms) it waits for that start, {@link PENDING_MS}; 0: the working state is the turn's own.
   */
  pendingUntil: number
  /** What the button said before that send (`ready` stays `ready` when the send fails). */
  pendingWas: 'idle' | 'ready'
}

export const REFRESH_START: RefreshState = { phase: 'idle', chipUntil: 0, changed: false, absorbUntil: 0, asked: false, whenShown: false, settleUntil: 0, pendingUntil: 0, pendingWas: 'idle' }

export type RefreshEvent =
  /** A turn began — or goes on after the person answered its question card. */
  | { type: 'working'; now: number }
  /** The turn asked the person a question card and waits for the answer. */
  | { type: 'asking'; now: number }
  | { type: 'site-changed'; now: number }
  /**
   * `canReload`: no comment box is open, and the page shown is the one the turn began on. `hidden`:
   * the tab is not on screen (a conversation behind the one shown, a collapsed column) — held for `shown`.
   */
  | { type: 'turn-end'; now: number; canReload: boolean; hidden?: boolean }
  /** A new document loaded in the frame (the automatic reload, or the person's own). */
  | { type: 'loaded'; now: number }
  | { type: 'reload-timeout'; now: number }
  /** The poll: someone's change landed after this page loaded. */
  | { type: 'others-changed'; now: number }
  /**
   * The person pressed Refresh. `turnRunning`: whether a turn runs in the tab's conversation, as the chat
   * answered (`tracy:turn-state`); undefined when nobody knows.
   */
  | { type: 'pressed'; now: number; turnRunning?: boolean }
  /**
   * The site tabs asked this tab to reload (`BetterSidebarService.reloadTab`, after a turn of the
   * conversation on screen changed the site). `canReload`: no comment box is open on the tab.
   */
  | { type: 'reload-request'; now: number; canReload: boolean; hidden?: boolean }
  /**
   * The tab came on screen (round 6). `canReload`: no comment box is open on it. `turnRunning`: as for
   * `pressed` — `false` while the button still says working means the turn's end never reached the tab.
   */
  | { type: 'shown'; now: number; canReload: boolean; turnRunning?: boolean }
  /** A send from this tab left at the press (round 9): the working state starts now, not when the chat says so. */
  | { type: 'sending'; now: number }
  /** That send failed: nothing reached the chat. */
  | { type: 'send-failed'; now: number }
  /** {@link PENDING_MS} after a send whose turn never said it started. */
  | { type: 'send-expired'; now: number }

/**
 * `reload`: load the page again, keeping the scroll (the view's `refresh('full')`).
 * `reload-asked`: refresh the way the request asked (its `reloadMode`, e.g. `style`).
 */
export type RefreshEffect = 'reload' | 'reload-asked'

/**
 * 🔒 ONE RELOAD PER CHANGE, WHOEVER HEARS IT FIRST (TCH `fix/comment-reload-once`, 30/09/2026). Two
 * pieces learn that a turn changed the site: this tab's own turn events (a turn sent from the page,
 * rule 5), and the site tabs' `reloadTab` a round trip later (every turn of the conversation on
 * screen, for every Browser tab on the site). Both land here, so this reducer is the one owner of the
 * decision: the turn end that reloaded or held the page leaves an absorb slot the request of that
 * same change fills without a second load, and a request the turn events never announced (another
 * tab of the site, a turn typed in the chat) reloads, or holds under an open comment box.
 */
export function refreshStep(state: RefreshState, event: RefreshEvent): { state: RefreshState; effects: RefreshEffect[] } {
  let step = stepOnce(state, event)
  // The chat's word on the turn ends a send's wait for it; so does leaving the working state.
  if (step.state.pendingUntil !== 0 && (TURN_WORD.has(event.type) || step.state.phase !== 'working')) step = { state: { ...step.state, pendingUntil: 0 }, effects: step.effects }
  // A reload held for `shown` belongs to the `ready` it made: any way out of it (a load, a press, a new turn) spends it.
  if (step.state.phase !== 'ready' && step.state.whenShown) return { state: { ...step.state, whenShown: false }, effects: step.effects }
  return step
}

/** Events the chat says about the turn itself (`tracy:*` from chat-input). */
const TURN_WORD = new Set<RefreshEvent['type']>(['working', 'asking', 'site-changed', 'turn-end'])

function stepOnce(state: RefreshState, event: RefreshEvent): { state: RefreshState; effects: RefreshEffect[] } {
  const same = { state, effects: [] as RefreshEffect[] }
  // What a phase change keeps: the absorb slot and a request already heard belong to the change, not the phase.
  const to = (phase: RefreshState['phase'], chipUntil: number, changed: boolean): RefreshState => ({ ...state, phase, chipUntil, changed, settleUntil: 0 })
  // 🔒 A HIDDEN TAB NEVER RELOADS (round 6, R13): it says "New version ready" and reloads when shown.
  const heldHidden = (): RefreshState => ({ ...to('ready', 0, false), whenShown: true })
  // A turn waiting on the person is still the turn at work: its end and its writes count the same.
  const atWork = state.phase === 'working' || state.phase === 'asking'
  switch (event.type) {
    case 'working':
      // The turn a send already spins for at its press: the same work, the same chip (round 9).
      if (state.phase === 'working' && state.pendingUntil !== 0) return { state: { ...state, asked: false }, effects: [] }
      // The answer to a question card: the same turn goes on, and what it already wrote still counts.
      if (state.phase === 'asking') return { state: to('working', event.now + CHIP_MS, state.changed), effects: [] }
      // The next queued turn right after one that changed nothing: the same work goes on, no second chip.
      if (state.phase === 'idle' && event.now < state.settleUntil) return { state: { ...to('working', 0, false), asked: false }, effects: [] }
      return { state: { ...to('working', event.now + CHIP_MS, false), asked: false }, effects: [] }
    case 'asking':
      return atWork ? { state: to('asking', 0, state.changed), effects: [] } : same
    case 'site-changed':
      // A write whose turn start this tab did not hear still counts as a turn at work.
      if (atWork) return { state: { ...state, phase: 'working', changed: true }, effects: [] }
      return { state: { ...to('working', event.now, true), asked: false }, effects: [] }
    case 'turn-end': {
      if (!atWork) return same
      if (!state.changed) return { state: { ...to('idle', 0, false), asked: false, settleUntil: event.now + SETTLE_MS }, effects: [] }
      // The site tabs' request of this change is still to come, unless it already came during the turn.
      const answered = { absorbUntil: state.asked ? 0 : event.now + ABSORB_MS, asked: false }
      if (event.hidden === true) return { state: { ...heldHidden(), ...answered }, effects: [] }
      if (!event.canReload) return { state: { ...to('ready', 0, false), ...answered }, effects: [] }
      return { state: { ...to('reloading', 0, false), ...answered }, effects: ['reload'] }
    }
    case 'loaded':
      if (state.phase === 'reloading') return { state: to('updated', event.now + CHIP_MS, false), effects: [] }
      if (state.phase === 'ready') return { state: to('idle', 0, false), effects: [] }
      return same
    case 'reload-timeout':
      return state.phase === 'reloading' ? { state: to('ready', 0, false), effects: [] } : same
    case 'others-changed':
      return state.phase === 'idle' || (state.phase === 'updated' && event.now >= state.chipUntil)
        ? { state: to('ready', 0, false), effects: [] }
        : same
    case 'pressed':
      // 🔒 NO TURN RUNS → THE SPINNER ENDS (round 9, V5S-3: the turn's end never reached a hidden tab,
      // and pressing Refresh reloaded the page and went on spinning).
      return { state: atWork && event.turnRunning !== false ? state : to('idle', 0, false), effects: ['reload'] }
    case 'reload-request':
      // The change this tab's own turn end already reloaded or held.
      if (state.absorbUntil > event.now) return { state: { ...state, absorbUntil: 0 }, effects: [] }
      // Tracy still at work: its own turn end decides, and now knows the site changed.
      if (atWork) return { state: { ...state, changed: true, asked: true }, effects: [] }
      if (event.hidden === true) return { state: heldHidden(), effects: [] }
      // 🔒 AN OPEN COMMENT BOX IS NEVER RELOADED UNDER (R3), whatever the mode: a `style` refresh
      // falls back to a full reload when the page's agent is absent or never answers.
      if (!event.canReload) return { state: to('ready', 0, false), effects: [] }
      return { state, effects: ['reload-asked'] }
    case 'shown':
      // Round 9 (V5S-3): still working, but the conversation runs no turn — its end was missed while the
      // tab was hidden. Taken as that end, on screen: a write reloads (or waits under a box), else idle.
      if (atWork && event.turnRunning === false) return stepOnce(state, { type: 'turn-end', now: event.now, canReload: event.canReload })
      if (state.phase !== 'ready' || !state.whenShown) return same
      // Under an open box it stays "New version ready" for the person to press (R3); shown again it is not retried.
      if (!event.canReload) return { state: { ...state, whenShown: false }, effects: [] }
      return { state: to('reloading', 0, false), effects: ['reload'] }
    case 'sending':
      // Already at work (a send queued behind a running turn): that turn's state and writes stay.
      if (atWork || state.phase === 'reloading') return same
      return { state: { ...to('working', event.now + CHIP_MS, false), asked: false, pendingUntil: event.now + PENDING_MS, pendingWas: state.phase === 'ready' ? 'ready' : 'idle' }, effects: [] }
    case 'send-failed':
      return state.phase === 'working' && state.pendingUntil !== 0 ? { state: to(state.pendingWas, 0, false), effects: [] } : same
    case 'send-expired':
      return state.phase === 'working' && state.pendingUntil !== 0 && event.now >= state.pendingUntil ? { state: to(state.pendingWas, 0, false), effects: [] } : same
  }
}

/** What the button draws at `now`. */
export function refreshLook(state: RefreshState, now: number): RefreshLook {
  switch (state.phase) {
    case 'idle': return now < state.settleUntil ? 'working-long' : 'idle'
    case 'asking': return 'idle'
    case 'working': return now < state.chipUntil ? 'working' : 'working-long'
    case 'reloading': return 'working-long'
    case 'updated': return now < state.chipUntil ? 'updated' : 'idle'
    case 'ready': return 'ready'
  }
}

/** When the look changes next without any event (a chip running out), or null. */
export function nextChange(state: RefreshState, now: number): number | null {
  if ((state.phase === 'working' || state.phase === 'updated') && state.chipUntil > now) return state.chipUntil
  if (state.phase === 'working' && state.pendingUntil > now) return state.pendingUntil
  if (state.phase === 'idle' && state.settleUntil > now) return state.settleUntil
  return null
}
