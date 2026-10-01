/**
 * Progress on the Refresh button (TCH `tasks/todo-comment-people.md` rule 5, contract H2; stories
 * RefreshWorking · RefreshWorkingLong · RefreshNewVersionUpdated · RefreshNewVersionReady). The
 * reducer is fed the chat's turn events, the page's loads and the poll's `siteChangedAt`; what the
 * button draws is `refreshLook`.
 */
import { describe, expect, it } from 'vitest'
import { ABSORB_MS, CHIP_MS, PENDING_MS, REFRESH_START, SETTLE_MS, nextChange, refreshLook, refreshStep, type RefreshEvent, type RefreshState } from '../src/client/refresh-progress.ts'

function run(events: RefreshEvent[]): { state: RefreshState; effects: string[] } {
  let state = REFRESH_START
  const effects: string[] = []
  for (const event of events) {
    const step = refreshStep(state, event)
    state = step.state
    effects.push(...step.effects)
  }
  return { state, effects }
}

describe('the sender: progress of a turn sent from the page', () => {
  it('just sent: the icon spins with "Tracy is working" for 3 s, then only spins', () => {
    const { state } = run([{ type: 'working', now: 1_000 }])
    expect(refreshLook(state, 1_000)).toBe('working')
    expect(refreshLook(state, 1_000 + CHIP_MS - 1)).toBe('working')
    expect(refreshLook(state, 1_000 + CHIP_MS)).toBe('working-long')
  })

  it('done after a site change and the page could reload: it reloads, then "New version updated" for exactly 3 s', () => {
    const { state, effects } = run([
      { type: 'working', now: 0 },
      { type: 'site-changed', now: 5_000 },
      { type: 'turn-end', now: 9_000, canReload: true },
    ])
    expect(effects).toEqual(['reload'])
    expect(refreshLook(state, 9_000)).toBe('working-long')
    const loaded = refreshStep(state, { type: 'loaded', now: 9_500 }).state
    expect(refreshLook(loaded, 9_500)).toBe('updated')
    expect(refreshLook(loaded, 9_500 + CHIP_MS - 1)).toBe('updated')
    expect(refreshLook(loaded, 9_500 + CHIP_MS)).toBe('idle')
  })

  it('done after a site change but the page cannot reload (typing, another page): terracotta "New version ready" until clicked', () => {
    const { state, effects } = run([
      { type: 'working', now: 0 },
      { type: 'site-changed', now: 1 },
      { type: 'turn-end', now: 2, canReload: false },
    ])
    expect(effects).toEqual([])
    expect(refreshLook(state, 60_000)).toBe('ready')
    const pressed = refreshStep(state, { type: 'pressed', now: 70_000 })
    expect(pressed.effects).toEqual(['reload'])
    expect(refreshLook(pressed.state, 70_000)).toBe('idle')
  })

  it('the reload failed (no new document in time): "New version ready"', () => {
    const { state } = run([
      { type: 'working', now: 0 },
      { type: 'site-changed', now: 1 },
      { type: 'turn-end', now: 2, canReload: true },
      { type: 'reload-timeout', now: 12_000 },
    ])
    expect(refreshLook(state, 12_000)).toBe('ready')
  })

  it('a turn that changed nothing on the site ends quietly', () => {
    const { state, effects } = run([{ type: 'working', now: 0 }, { type: 'turn-end', now: 4_000, canReload: true }])
    expect(effects).toEqual([])
    // Round 6: idle once the settle window (a queued turn right behind) has passed.
    expect(refreshLook(state, 4_000 + SETTLE_MS)).toBe('idle')
  })
})

describe('everyone else with the page open', () => {
  it('a site change newer than the page load: "New version ready", no spinner, never an automatic reload', () => {
    const { state, effects } = run([{ type: 'others-changed', now: 0 }])
    expect(effects).toEqual([])
    expect(refreshLook(state, 0)).toBe('ready')
  })

  it('a new document (the person reloaded or navigated) takes "New version ready" away', () => {
    const { state } = run([{ type: 'others-changed', now: 0 }, { type: 'loaded', now: 5 }])
    expect(refreshLook(state, 5)).toBe('idle')
  })

  it('the poll does not override the sender\'s own progress', () => {
    const { state } = run([{ type: 'working', now: 0 }, { type: 'others-changed', now: 100 }])
    expect(refreshLook(state, 100)).toBe('working')
  })
})

describe('a reload asked from outside: the site tabs\' `reloadTab` after a changing turn (one owner per change)', () => {
  const ask = (now: number, canReload = true): RefreshEvent => ({ type: 'reload-request', now, canReload })
  const sent = (canReload: boolean): RefreshEvent[] => [
    { type: 'working', now: 0 },
    { type: 'site-changed', now: 1 },
    { type: 'turn-end', now: 2, canReload },
  ]

  it('the sender\'s own turn already reloaded the page: the request of that change reloads nothing more', () => {
    // Before the reload came back, and after it did ("New version updated" must not vanish under a second load).
    expect(run([...sent(true), ask(3)]).effects).toEqual(['reload'])
    const after = run([...sent(true), { type: 'loaded', now: 500 }, ask(4_000)])
    expect(after.effects).toEqual(['reload'])
    expect(refreshLook(after.state, 1_000)).toBe('updated')
  })

  it('the sender\'s own turn held the page ("New version ready"): the request keeps it held, no reload', () => {
    const { state, effects } = run([...sent(false), ask(3)])
    expect(effects).toEqual([])
    expect(refreshLook(state, 3)).toBe('ready')
    expect(refreshStep(state, { type: 'pressed', now: 4 }).effects).toEqual(['reload'])
  })

  it('a tab the turn\'s own events did not reach (another tab of the site, a turn typed in the chat) reloads as asked', () => {
    const { state, effects } = run([ask(0)])
    expect(effects).toEqual(['reload-asked'])
    expect(refreshLook(state, 0)).toBe('idle')
  })

  it('a comment box open on the tab: no reload, "New version ready" until clicked, then the click reloads', () => {
    const { state, effects } = run([ask(0, false)])
    expect(effects).toEqual([])
    expect(refreshLook(state, 10_000)).toBe('ready')
    const pressed = refreshStep(state, { type: 'pressed', now: 20_000 })
    expect(pressed.effects).toEqual(['reload'])
    expect(refreshLook(pressed.state, 20_000)).toBe('idle')
  })

  it('the sender\'s turn saw no write but the site tabs say it changed: their request reloads, once', () => {
    const { effects } = run([{ type: 'working', now: 0 }, { type: 'turn-end', now: 2, canReload: true }, ask(3)])
    expect(effects).toEqual(['reload-asked'])
  })

  it('one request is absorbed per change: the next change\'s request reloads again', () => {
    expect(run([...sent(true), { type: 'loaded', now: 500 }, ask(4_000), ask(9_000)]).effects).toEqual(['reload', 'reload-asked'])
  })

  it('an absorbed slot expires: a request long after the sender\'s reload is another change', () => {
    expect(run([...sent(true), { type: 'loaded', now: 500 }, ask(2 + ABSORB_MS)]).effects).toEqual(['reload', 'reload-asked'])
  })

  it('a request while Tracy is still at work waits for the turn end, which reloads once', () => {
    const { effects } = run([{ type: 'working', now: 0 }, ask(1), { type: 'turn-end', now: 2, canReload: true }, { type: 'loaded', now: 3 }, ask(5_000)])
    // That turn's request is spent, so a later one is another change.
    expect(effects).toEqual(['reload', 'reload-asked'])
  })

  it('the request of the turn before, arriving after the next one began, adds no reload', () => {
    const { effects } = run([...sent(true), { type: 'loaded', now: 500 }, { type: 'working', now: 600 }, ask(700), { type: 'turn-end', now: 800, canReload: true }])
    expect(effects).toEqual(['reload'])
  })
})

describe('Tracy waiting on a question card (F3)', () => {
  it('stops the spinner while it waits; the answer resumes it; the turn\'s write still reloads at its end', () => {
    let st = refreshStep(REFRESH_START, { type: 'working', now: 0 }).state
    st = refreshStep(st, { type: 'site-changed', now: 1 }).state
    st = refreshStep(st, { type: 'asking', now: 2 }).state
    expect(refreshLook(st, 3)).toBe('idle')
    expect(refreshStep(st, { type: 'pressed', now: 4 }).state).toBe(st)
    st = refreshStep(st, { type: 'working', now: 60_000 }).state
    expect(refreshLook(st, 60_001)).toBe('working')
    const end = refreshStep(st, { type: 'turn-end', now: 70_000, canReload: true })
    expect(end.effects).toEqual(['reload'])
  })

  it('a turn that ends while it still waits ends as a turn does', () => {
    let st = refreshStep(REFRESH_START, { type: 'working', now: 0 }).state
    st = refreshStep(st, { type: 'asking', now: 1 }).state
    expect(refreshStep(st, { type: 'turn-end', now: 2, canReload: true }).state).toEqual({ ...REFRESH_START, settleUntil: 2 + SETTLE_MS })
  })
})

describe('a turn typed in the chat (TCH fix/refresh-chat-turns, 30/09/2026)', () => {
  // Since TCH chat-input 30/09 every turn of the conversation on screen on this site brings the same
  // turn events as a Send to Tracy (contract H2). Measured before by Brian on the stand: the poll saw
  // Tracy's first write mid-turn and the idle tab showed "New version ready" while Tracy still worked.
  it('the poll\'s change during the working chat turn does not show "New version ready"; its end reloads once', () => {
    const { state, effects } = run([
      { type: 'working', now: 0 },
      { type: 'site-changed', now: 4_000 },
      { type: 'others-changed', now: 15_000 },
      { type: 'site-changed', now: 20_000 },
      { type: 'others-changed', now: 30_000 },
    ])
    expect(refreshLook(state, 30_000)).toBe('working-long')
    expect(effects).toEqual([])
    let st = refreshStep(state, { type: 'turn-end', now: 40_000, canReload: true })
    expect(st.effects).toEqual(['reload'])
    st = refreshStep(st.state, { type: 'loaded', now: 40_500 })
    expect(refreshLook(st.state, 40_500)).toBe('updated')
    // The site tabs' request of the same change a round trip later: absorbed, no second load.
    st = refreshStep(st.state, { type: 'reload-request', now: 42_000, canReload: true })
    expect(st.effects).toEqual([])
  })
})

describe('round 6: a hidden Browser tab never reloads (acceptance v4 R13)', () => {
  it('a reload request while hidden holds "New version ready" and reloads once shown', () => {
    const held = run([{ type: 'reload-request', now: 1_000, canReload: true, hidden: true }])
    expect(held.effects).toEqual([])
    expect(refreshLook(held.state, 1_000)).toBe('ready')
    const shown = refreshStep(held.state, { type: 'shown', now: 5_000, canReload: true })
    expect(shown.effects).toEqual(['reload'])
    expect(refreshLook(refreshStep(shown.state, { type: 'loaded', now: 5_100 }).state, 5_100)).toBe('updated')
  })

  it('its own conversation\'s changing turn ending while hidden: held, reloaded when shown', () => {
    const held = run([
      { type: 'working', now: 0 },
      { type: 'site-changed', now: 1_000 },
      { type: 'turn-end', now: 2_000, canReload: true, hidden: true },
    ])
    expect(held.effects).toEqual([])
    expect(refreshLook(held.state, 2_000)).toBe('ready')
    expect(refreshStep(held.state, { type: 'shown', now: 9_000, canReload: true }).effects).toEqual(['reload'])
  })

  it('shown with a comment box open: stays "New version ready" (R3), the person presses Refresh', () => {
    const held = run([{ type: 'reload-request', now: 1_000, canReload: true, hidden: true }])
    const shown = refreshStep(held.state, { type: 'shown', now: 2_000, canReload: false })
    expect(shown.effects).toEqual([])
    expect(refreshLook(shown.state, 2_000)).toBe('ready')
    expect(refreshStep(shown.state, { type: 'shown', now: 3_000, canReload: true }).effects).toEqual([])
    expect(refreshStep(shown.state, { type: 'pressed', now: 4_000 }).effects).toEqual(['reload'])
  })

  it('"New version ready" from the poll (someone else) is never reloaded by being shown', () => {
    const ready = run([{ type: 'others-changed', now: 1_000 }])
    expect(refreshStep(ready.state, { type: 'shown', now: 2_000, canReload: true }).effects).toEqual([])
  })

  it('shown with nothing held does nothing', () => {
    expect(refreshStep(REFRESH_START, { type: 'shown', now: 1, canReload: true })).toEqual({ state: REFRESH_START, effects: [] })
  })

  it('pressing Refresh while hidden-held reloads, and being shown later does not reload again', () => {
    const held = run([{ type: 'reload-request', now: 1_000, canReload: true, hidden: true }])
    const pressed = refreshStep(held.state, { type: 'pressed', now: 2_000 })
    const loaded = refreshStep(pressed.state, { type: 'loaded', now: 2_100 })
    expect(refreshStep(loaded.state, { type: 'shown', now: 3_000, canReload: true }).effects).toEqual([])
  })
})

describe('round 6: back-to-back turns keep spinning (acceptance v4 S08, R-flash)', () => {
  it('a turn that changed nothing ends drawn as working for SETTLE_MS, then idle', () => {
    const { state } = run([{ type: 'working', now: 0 }, { type: 'turn-end', now: 10_000, canReload: true }])
    expect(refreshLook(state, 10_000)).toBe('working-long')
    expect(refreshLook(state, 10_000 + SETTLE_MS - 1)).toBe('working-long')
    expect(nextChange(state, 10_000)).toBe(10_000 + SETTLE_MS)
    expect(refreshLook(state, 10_000 + SETTLE_MS)).toBe('idle')
  })

  it('the next queued turn starting 50 ms later goes on spinning — no idle, no second chip', () => {
    const { state } = run([{ type: 'working', now: 0 }, { type: 'turn-end', now: 14_160, canReload: true }, { type: 'working', now: 14_210 }])
    for (const at of [14_160, 14_185, 14_210, 14_300, 20_000]) expect(refreshLook(state, at)).toBe('working-long')
  })

  it('a turn starting after the settle window is a new turn with its chip', () => {
    const { state } = run([{ type: 'working', now: 0 }, { type: 'turn-end', now: 10_000, canReload: true }, { type: 'working', now: 10_000 + SETTLE_MS + 1 }])
    expect(refreshLook(state, 10_000 + SETTLE_MS + 1)).toBe('working')
  })
})

describe('round 9: the tab reconciles with the conversation\'s real turn state (acceptance v5 V5S-3)', () => {
  it('pressing Refresh while it spins and no turn runs ends the spinner and reloads once', () => {
    const working = run([{ type: 'working', now: 0 }]).state
    const pressed = refreshStep(working, { type: 'pressed', now: 70_000, turnRunning: false })
    expect(pressed.effects).toEqual(['reload'])
    expect(refreshLook(pressed.state, 70_000)).toBe('idle')
    // The reload it made lands: still idle, no chip.
    expect(refreshLook(refreshStep(pressed.state, { type: 'loaded', now: 70_100 }).state, 70_100)).toBe('idle')
  })

  it('pressing Refresh while a turn really runs (or nobody knows) reloads and keeps the working state', () => {
    const working = run([{ type: 'working', now: 0 }, { type: 'site-changed', now: 1 }]).state
    expect(refreshStep(working, { type: 'pressed', now: 5_000, turnRunning: true }).state).toBe(working)
    expect(refreshStep(working, { type: 'pressed', now: 5_000 }).state).toBe(working)
  })

  it('shown while spinning after the turn ended with a write unheard: the page reloads, then "New version updated"', () => {
    const working = run([{ type: 'working', now: 0 }, { type: 'site-changed', now: 1 }]).state
    const shown = refreshStep(working, { type: 'shown', now: 30_000, canReload: true, turnRunning: false })
    expect(shown.effects).toEqual(['reload'])
    const loaded = refreshStep(shown.state, { type: 'loaded', now: 30_200 })
    expect(refreshLook(loaded.state, 30_200)).toBe('updated')
    expect(refreshLook(loaded.state, 30_200 + CHIP_MS)).toBe('idle')
  })

  it('shown while spinning, no turn runs and nothing was heard written: idle, no reload', () => {
    const working = run([{ type: 'working', now: 0 }]).state
    const shown = refreshStep(working, { type: 'shown', now: 30_000, canReload: true, turnRunning: false })
    expect(shown.effects).toEqual([])
    expect(refreshLook(shown.state, 30_000 + SETTLE_MS)).toBe('idle')
  })

  it('shown under an open comment box after a write: "New version ready", never reloaded under the box', () => {
    const working = run([{ type: 'working', now: 0 }, { type: 'site-changed', now: 1 }]).state
    const shown = refreshStep(working, { type: 'shown', now: 30_000, canReload: false, turnRunning: false })
    expect(shown.effects).toEqual([])
    expect(refreshLook(shown.state, 30_000)).toBe('ready')
  })

  it('shown while the turn still runs keeps spinning', () => {
    const working = run([{ type: 'working', now: 0 }]).state
    expect(refreshStep(working, { type: 'shown', now: 30_000, canReload: true, turnRunning: true }).state).toBe(working)
    expect(refreshStep(working, { type: 'shown', now: 30_000, canReload: true }).state).toBe(working)
  })
})

describe('round 9: a send starts the working state at once (acceptance v5 V5S-6)', () => {
  it('spins with "Tracy is working" at the press, before the chat said the turn started', () => {
    const { state } = run([{ type: 'sending', now: 1_000 }])
    expect(refreshLook(state, 1_000)).toBe('working')
  })

  it('the turn\'s own start keeps the chip already running (no second chip)', () => {
    const { state } = run([{ type: 'sending', now: 1_000 }, { type: 'working', now: 2_500 }])
    expect(state.chipUntil).toBe(1_000 + CHIP_MS)
    expect(state.pendingUntil).toBe(0)
  })

  it('a send that failed puts the button back as it was', () => {
    const { state } = run([{ type: 'sending', now: 1_000 }, { type: 'send-failed', now: 1_400 }])
    expect(refreshLook(state, 1_400)).toBe('idle')
    const ready = run([{ type: 'others-changed', now: 500 }, { type: 'sending', now: 1_000 }, { type: 'send-failed', now: 1_400 }])
    expect(refreshLook(ready.state, 1_400)).toBe('ready')
  })

  it('a failure after the turn started changes nothing: the chat took it after all', () => {
    const started = run([{ type: 'sending', now: 1_000 }, { type: 'working', now: 1_800 }]).state
    expect(refreshStep(started, { type: 'send-failed', now: 2_000 }).state).toBe(started)
  })

  it('a send queued behind a running turn keeps that turn\'s write', () => {
    const busy = run([{ type: 'working', now: 0 }, { type: 'site-changed', now: 1 }]).state
    expect(refreshStep(busy, { type: 'sending', now: 5 }).state).toBe(busy)
  })

  it('a send whose turn never starts lets the spinner go after PENDING_MS', () => {
    const { state } = run([{ type: 'sending', now: 1_000 }])
    expect(nextChange(state, 1_000 + CHIP_MS)).toBe(1_000 + PENDING_MS)
    const expired = refreshStep(state, { type: 'send-expired', now: 1_000 + PENDING_MS })
    expect(refreshLook(expired.state, 1_000 + PENDING_MS)).toBe('idle')
    // Too early: nothing.
    expect(refreshStep(state, { type: 'send-expired', now: 1_000 + PENDING_MS - 1 }).state).toBe(state)
  })
})
