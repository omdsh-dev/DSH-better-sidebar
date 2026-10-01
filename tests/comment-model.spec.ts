/**
 * Comment mode's pure half (Tracy, 27/09/2026): which page messages are believed, where the
 * preview ticket may go, the bounded recovery, the plain words the chat chip gets for a pick, and
 * what one comment sends to the chat (the `content.locate` answer rides along untouched).
 */
import { describe, expect, it } from 'vitest'
import {
  AIMED_MS,
  aimedAtBox,
  boxStand,
  hiddenName,
  COMMENT_FAILED_EVENT,
  COMMENT_SENT_EVENT,
  READY_ECHO_MS,
  READY_START,
  RECOVERY_START,
  commentSendDetail,
  locateParams,
  plainLabel,
  popoverPlacement,
  threadCardMaxHeight,
  THREAD_CARD_MIN,
  readCommentAnswer,
  readPickTarget,
  readPick,
  readReady,
  readyStep,
  recoveryStep,
  resolvedLabel,
  sameElement,
  samePage,
  silenceOf,
  siteKeyOfBase,
  ticketAnswerOf,
  withPreviewTicket,
  withReloadNonce,
  withoutReloadNonce,
  type RecoveryEvent,
  type RecoveryState,
} from '../src/client/comment-model.ts'
import { PREVIEW_CHANNEL, PREVIEW_VERSION, type PreviewPickTarget } from '../src/client/preview-protocol.generated.ts'

const msg = (kind: string, extra: Record<string, unknown> = {}) => ({ channel: PREVIEW_CHANNEL, v: PREVIEW_VERSION, kind, ...extra })

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

/** The Joomla header menu item from the approved drawing (story "Picked"). */
const MENU_TARGET: PreviewPickTarget = {
  text: 'Services',
  tag: 'a',
  image: null,
  domPath: 'header > nav > li.item-104 > a',
  selector: 'li.item-104 > a',
  rect: rect(760, 60, 60, 24),
  marks: ['menu-item:104', 'module:87'],
  levels: [
    { tag: 'a', mark: 'menu-item:104', text: 'Services', rect: rect(760, 60, 60, 24) },
    { tag: 'nav', mark: 'module:87', text: 'Home About Services', rect: rect(640, 56, 380, 32) },
    { tag: 'header', mark: null, text: 'NORTHGATE', rect: rect(0, 40, 1040, 70) },
  ],
  level: 0,
}

/**
 * The locate answer for it, in the shape `content-locate.js` `levelsOf` gives: the levels of ONE
 * record, innermost first, ending with the record itself.
 */
const MENU_LOCATE = {
  status: 'resolved',
  levels: [
    { kind: 'field', id: '104#title', contentId: '104', fieldKey: 'title', label: 'Services › title', writable: true },
    { kind: 'record', id: '104', contentId: '104', label: 'Menu item "Services"', writable: true },
  ],
  sources: { value: 'resolved', mark: 'confirmed' },
  impact: { pages: 0 },
}

describe('messages from the page', () => {
  it('reads ready with and without features, and nothing else', () => {
    expect(readReady(msg('ready', { features: ['pick'] }))).toEqual({ features: ['pick'], url: null })
    expect(readReady(msg('ready'))).toEqual({ features: [], url: null })
    expect(readReady(msg('ready', { features: ['pick', 7, null] }))?.features).toEqual(['pick'])
    expect(readReady(msg('ready', { features: ['pick'], url: 'https://a.tracy.test/news' }))?.url).toBe('https://a.tracy.test/news')
    expect(readReady(msg('refresh'))).toBeNull()
    expect(readReady({ channel: PREVIEW_CHANNEL, v: 2, kind: 'ready', features: ['pick'] })).toBeNull()
    expect(readReady('ready')).toBeNull()
  })

  it('reads hover / picked / cancel and refuses a target with no usable box', () => {
    expect(readPick(msg('pick-cancel'))).toEqual({ kind: 'cancel' })
    const hover = readPick(msg('pick-hover', { target: MENU_TARGET }))
    expect(hover?.kind).toBe('hover')
    expect(readPick(msg('picked', { target: MENU_TARGET }))?.kind).toBe('picked')
    expect(readPick(msg('picked', { target: { ...MENU_TARGET, rect: { x: 1 } } }))).toBeNull()
    expect(readPick(msg('picked'))).toBeNull()
    expect(readPick(msg('pick-start'))).toBeNull()
  })

  it('tells a box the page sent again (moved: true) from a pick, and reads the page address', () => {
    // 28/09/2026: the page reports the picked element's new box when it scrolls; that report must
    // never open a pick the tab already closed, so it is read as a move, not a pick.
    const url = 'https://a.tracy.test/about/'
    expect(readPick(msg('picked', { target: MENU_TARGET, url }))).toMatchObject({ kind: 'picked', url, moved: false })
    expect(readPick(msg('picked', { target: MENU_TARGET, moved: true }))).toMatchObject({ kind: 'picked', url: null, moved: true })
    expect(readPick(msg('picked', { target: MENU_TARGET, moved: 'yes' }))).toMatchObject({ moved: false })
    expect(readPick(msg('pick-hover', { target: MENU_TARGET, moved: true }))).not.toHaveProperty('moved')
  })

  it('cuts a target to the contract limits and never trusts its shape', () => {
    const long = 'x'.repeat(5000)
    const picked = readPick(msg('picked', {
      target: {
        ...MENU_TARGET,
        text: long,
        marks: Array.from({ length: 40 }, (_, i) => `m:${i}`),
        levels: [...Array.from({ length: 20 }, () => MENU_TARGET.levels[0]), 'junk'],
        level: 99,
        tag: 'A',
      },
    }))
    expect(picked?.kind).toBe('picked')
    if (picked?.kind !== 'picked') return
    expect(picked.target.text.length).toBe(300)
    expect(picked.target.marks.length).toBe(12)
    expect(picked.target.levels.length).toBe(8)
    expect(picked.target.level).toBe(7)
    expect(picked.target.tag).toBe('a')
  })
})

describe('the reload nonce', () => {
  it('goes into the frame address as tracy_reload, fresh on every call', () => {
    expect(withReloadNonce('https://a.tracy.test/news?x=1#top', 'n1')).toBe('https://a.tracy.test/news?x=1&tracy_reload=n1#top')
    expect(withReloadNonce('https://a.tracy.test/?tracy_reload=old', 'n2')).toBe('https://a.tracy.test/?tracy_reload=n2')
    expect(withReloadNonce('https://a.tracy.test/')).not.toBe(withReloadNonce('https://a.tracy.test/'))
    expect(withReloadNonce('not a url', 'n')).toBe('not a url')
  })

  it('is taken off what the page reports, and nothing else is', () => {
    expect(withoutReloadNonce('https://a.tracy.test/news?x=1&tracy_reload=n1#top')).toBe('https://a.tracy.test/news?x=1#top')
    expect(withoutReloadNonce('https://a.tracy.test/news?x=1')).toBe('https://a.tracy.test/news?x=1')
    expect(readReady(msg('ready', { url: 'https://a.tracy.test/?tracy_reload=n1' }))?.url).toBe('https://a.tracy.test/')
    const pick = readPick(msg('picked', { target: MENU_TARGET, url: 'https://a.tracy.test/news?tracy_reload=n1' }))
    expect(pick !== null && pick.kind === 'picked' ? pick.url : null).toBe('https://a.tracy.test/news')
  })
})

describe('the preview ticket', () => {
  it('goes into the frame address only as the tracy_preview parameter', () => {
    expect(withPreviewTicket('https://a.tracy.test/news?x=1#top', 'pv1.abc.def')).toBe('https://a.tracy.test/news?x=1&tracy_preview=pv1.abc.def#top')
    expect(withPreviewTicket('not a url', 't')).toBe('not a url')
  })

  it('reads the door: 200 ticket, 404 off, 400/401/403 refused, anything else error', () => {
    expect(ticketAnswerOf(200, { ticket: 't', exp: 5 })).toEqual({ kind: 'ticket', ticket: 't', exp: 5 })
    expect(ticketAnswerOf(200, {})).toEqual({ kind: 'error' })
    expect(ticketAnswerOf(404, null)).toEqual({ kind: 'off' })
    for (const status of [400, 401, 403]) expect(ticketAnswerOf(status, null)).toEqual({ kind: 'refused' })
    expect(ticketAnswerOf(500, null)).toEqual({ kind: 'error' })
  })

  it('finds the site key in the page base, and none for /new/ or no base', () => {
    expect(siteKeyOfBase('https://cowork.tracy.ai/northgate/', 'https://cowork.tracy.ai')).toBe('northgate')
    expect(siteKeyOfBase('https://cowork.tracy.ai/new/', 'https://cowork.tracy.ai')).toBeNull()
    expect(siteKeyOfBase('https://cowork.tracy.ai/', 'https://cowork.tracy.ai')).toBeNull()
    expect(siteKeyOfBase('https://cowork.tracy.ai/a/b/', 'https://cowork.tracy.ai')).toBeNull()
    expect(siteKeyOfBase('https://evil.example/northgate/', 'https://cowork.tracy.ai')).toBeNull()
    expect(siteKeyOfBase(undefined, undefined)).toBeNull()
  })
})

describe('which ready is news (two per load, measured on the stand)', () => {
  const run = (events: Array<{ type: 'ready' | 'load'; now: number; url?: string }>) => {
    let state = READY_START
    return events.map((event) => {
      const step = readyStep(state, event)
      state = step.state
      return event.type === 'ready' ? (step.fresh ? 'fresh' : 'echo') : (step.announced ? 'announced' : 'silent')
    })
  }

  it('start + pageshow before the load: one fresh, one echo, the load announced', () => {
    expect(run([{ type: 'ready', now: 0 }, { type: 'ready', now: 100 }, { type: 'load', now: 150 }])).toEqual(['fresh', 'echo', 'announced'])
  })

  it('the pageshow echo AFTER the load is not carried into the next load', () => {
    const out = run([
      { type: 'ready', now: 0 }, { type: 'load', now: 50 }, { type: 'ready', now: 120 },
      // Minutes later the frame navigates to a page with no picker (its cookie ran out): no ready.
      { type: 'load', now: 900_000 },
    ])
    expect(out).toEqual(['fresh', 'announced', 'echo', 'silent'])
  })

  it('a page that announces only after its load is attributed to that load, once', () => {
    expect(run([{ type: 'load', now: 0 }, { type: 'ready', now: 40 }, { type: 'ready', now: 140 }])).toEqual(['silent', 'fresh', 'echo'])
  })

  it('a back/forward restore (pageshow, no load) is news', () => {
    expect(run([{ type: 'ready', now: 0 }, { type: 'load', now: 50 }, { type: 'ready', now: 60_000 }])).toEqual(['fresh', 'announced', 'fresh'])
  })

  it('round 5 (runtime 14 `route`, acceptance v3 J16): every route change a single-page site announces is news, however close', () => {
    const A = 'https://s.test/en/'
    const B = 'https://s.test/en/virtual-route'
    const C = 'https://s.test/en/another-route'
    expect(run([
      { type: 'ready', now: 0, url: A }, { type: 'load', now: 50 }, { type: 'ready', now: 120, url: A },
      { type: 'ready', now: 5_000, url: B }, { type: 'ready', now: 5_100, url: C }, { type: 'ready', now: 5_150, url: A },
    ] as Array<{ type: 'ready' | 'load'; now: number; url?: string }>)).toEqual(['fresh', 'announced', 'echo', 'fresh', 'fresh', 'fresh'])
    // A route change is the loaded document's: the next load that announces nothing is still silent.
    expect(run([
      { type: 'ready', now: 0, url: A }, { type: 'load', now: 50 }, { type: 'ready', now: 5_000, url: B }, { type: 'load', now: 900_000 },
    ] as Array<{ type: 'ready' | 'load'; now: number; url?: string }>)).toEqual(['fresh', 'announced', 'fresh', 'silent'])
  })
})

describe('bounded recovery', () => {
  const run = (events: RecoveryEvent[], from: RecoveryState = RECOVERY_START) => {
    let state = from
    const effects: string[] = []
    for (const event of events) {
      const step = recoveryStep(state, event)
      state = step.state
      effects.push(...step.effects.map(e => e.type))
    }
    return { state, effects }
  }
  const silent = { type: 'load', commentOn: true, announced: false } as const

  it('a load that announced the picker needs no watching', () => {
    const { state, effects } = run([{ type: 'load', commentOn: true, announced: true }])
    expect(state.status).toBe('idle')
    expect(effects).toEqual([])
  })

  it('watches nothing while Comment is off', () => {
    expect(run([{ type: 'load', commentOn: false, announced: false }]).effects).toEqual([])
  })

  it('a silent load while Comment is on starts the 5 s timer; a late fresh ready cancels it', () => {
    const { state, effects } = run([silent, { type: 'ready-pick' }])
    expect(effects).toEqual(['start-timer', 'cancel-timer'])
    expect(state.status).toBe('idle')
  })

  it('reloads ONCE with a new ticket, then says unavailable and stops', () => {
    const { state, effects } = run([silent, { type: 'timeout' }, silent, { type: 'timeout' }, silent, { type: 'timeout' }])
    expect(effects).toEqual(['start-timer', 'warn', 'reload-with-ticket', 'start-timer', 'warn'])
    expect(state.status).toBe('unavailable')
  })

  it('pressing Comment again allows one more reload; a new address forgets everything', () => {
    const unavailable: RecoveryState = { status: 'unavailable', retried: true }
    const pressed = run([{ type: 'press-unavailable' }], unavailable)
    expect(pressed.effects).toEqual(['reload-with-ticket'])
    const again = run([silent, { type: 'timeout' }], pressed.state)
    expect(again.state.status).toBe('unavailable')
    expect(run([{ type: 'reset' }], unavailable).state).toEqual(RECOVERY_START)
  })

  it('a page that announces the picker again leaves unavailable by itself', () => {
    expect(run([{ type: 'ready-pick' }], { status: 'unavailable', retried: true }).state.status).toBe('idle')
  })

  // 28/09/2026: the picker's cookie lapses while the tab is in Interactive (no load is watched there);
  // the next load carries no picker, and turning Edit on posted pick-start into a page that no longer
  // listens — Edit showed as on and did nothing, with no recovery ever starting.
  it('Edit turned on over a silent page reloads once with a new ticket; the reload counts as the one retry', () => {
    const pressed = run([{ type: 'press-silent', settled: true }])
    expect(pressed.effects).toEqual(['warn', 'reload-with-ticket'])
    expect(pressed.state).toEqual({ status: 'idle', retried: true })
    // The reloaded page is still silent: watched, then unavailable — no second reload.
    const after = run([silent, { type: 'timeout' }], pressed.state)
    expect(after.effects).toEqual(['start-timer', 'warn'])
    expect(after.state.status).toBe('unavailable')
  })

  /**
   * 🔒 A PICKER THAT ANSWERED CLEARS THE RETRY (28/09/2026). `retried` was carried through
   * `ready-pick`, so only the FIRST cookie expiry on a tab ever recovered: the cookie lasts about
   * fifteen minutes, and from the second expiry on the tab had already "used" its one reload and
   * silently stopped offering to pick. A `ready` is proof the trade worked, which is exactly the thing
   * the cap exists to stop looping on.
   */
  it('🔒 a ready after the one reload clears it, so the NEXT cookie expiry recovers too', () => {
    // First expiry: Edit over a silent page trades a ticket for one reload.
    const first = run([{ type: 'press-silent', settled: true }])
    expect(first.effects).toEqual(['warn', 'reload-with-ticket'])
    expect(first.state.retried).toBe(true)
    // The reloaded page announces its picker: the trade worked, and the cap is spent, not owed.
    const answered = run([{ type: 'ready-pick' }], first.state)
    expect(answered.state).toEqual({ status: 'idle', retried: false })
    // Fifteen minutes later the cookie lapses again — and this expiry recovers exactly like the first.
    const second = run([{ type: 'press-silent', settled: true }], answered.state)
    expect(second.effects).toEqual(['warn', 'reload-with-ticket'])
    // A page that stays silent still cannot loop: no `ready` arrives to clear the cap, so the load
    // after the reload is watched and ends `unavailable` — and a further wait adds nothing.
    const stillSilent = run([silent, { type: 'timeout' }], second.state)
    expect(stillSilent.state).toEqual({ status: 'unavailable', retried: true })
    expect(stillSilent.effects).toEqual(['start-timer', 'warn'])
    expect(run([{ type: 'timeout' }], stillSilent.state).effects).toEqual([])
  })

  it('a page still inside its echo window is watched, not reloaded: a late announcement cancels it', () => {
    const pressed = run([{ type: 'press-silent', settled: false }])
    expect(pressed.effects).toEqual(['start-timer'])
    expect(pressed.state.status).toBe('watching')
    expect(run([{ type: 'ready-pick' }], pressed.state).state.status).toBe('idle')
    expect(run([{ type: 'timeout' }], pressed.state).effects).toEqual(['warn', 'reload-with-ticket'])
  })

  it('a silent page already being watched keeps its own timer: pressing adds no reload', () => {
    const watching = run([silent])
    expect(run([{ type: 'press-silent', settled: true }], watching.state)).toEqual({ state: watching.state, effects: [] })
  })
})

describe('a page that loaded without the picker', () => {
  const at = (events: Array<{ type: 'ready' | 'load'; now: number }>, now: number) => {
    let state = READY_START
    for (const event of events) state = readyStep(state, event).state
    return silenceOf(state, now)
  }

  it('nothing loaded yet says nothing', () => {
    expect(silenceOf(READY_START, 10_000)).toBe('none')
  })

  it('a load whose document announced (before or just after it) is not silent', () => {
    expect(at([{ type: 'ready', now: 0 }, { type: 'load', now: 50 }], 60_000)).toBe('none')
    expect(at([{ type: 'load', now: 0 }, { type: 'ready', now: 40 }], 60_000)).toBe('none')
  })

  it('a later load with no announcement is silent once the echo window has passed', () => {
    const lapsed = [{ type: 'ready', now: 0 }, { type: 'load', now: 50 }, { type: 'ready', now: 120 }, { type: 'load', now: 900_000 }] as const
    expect(at([...lapsed], 900_100)).toBe('settling')
    expect(at([...lapsed], 900_000 + READY_ECHO_MS)).toBe('silent')
  })

  // The blank frame loads while the ticket is asked; the page's first announcement lands within the
  // echo window of THAT load and is credited to it, so the page's own load reads as silent until
  // its `pageshow` echo arrives. A press in between must not throw a new ticket at a working page.
  it('an early announcement credited to the blank frame leaves the next load settling, then its echo clears it', () => {
    const early = [{ type: 'load', now: 0 }, { type: 'ready', now: 300 }, { type: 'load', now: 400 }] as const
    expect(at([...early], 450)).toBe('settling')
    expect(at([...early, { type: 'ready', now: 500 }], 450)).toBe('none')
  })

  it('a back/forward restore that announced is not silent', () => {
    expect(at([{ type: 'load', now: 0 }, { type: 'ready', now: 60_000 }], 120_000)).toBe('none')
  })
})

describe('which pick a report belongs to', () => {
  it('the same selector in the same document is the same pick', () => {
    expect(sameElement({ doc: 3, selector: 'h1' }, { doc: 3, selector: 'h1' })).toBe(true)
  })

  // `develop` kept content.locate answers by selector alone: the h1 of a second page inherited the
  // record of the h1 picked on the first, and the chat turn carried its ids to the agent.
  it('the same selector in another document is another element, and another pick', () => {
    expect(sameElement({ doc: 3, selector: 'h1' }, { doc: 4, selector: 'h1' })).toBe(false)
    expect(sameElement({ doc: 3, selector: 'h1' }, { doc: 3, selector: 'h2' })).toBe(false)
    expect(sameElement(null, { doc: 3, selector: 'h1' })).toBe(false)
  })

  it('the same page is origin, path and query; the fragment does not count', () => {
    expect(samePage('https://a.tracy.test/about?x=1', 'https://a.tracy.test/about?x=1#team')).toBe(true)
    expect(samePage('https://a.tracy.test/about', 'https://a.tracy.test/news')).toBe(false)
    expect(samePage('https://a.tracy.test/about', 'https://b.tracy.test/about')).toBe(false)
    expect(samePage('https://a.tracy.test/about?x=1', 'https://a.tracy.test/about?x=2')).toBe(false)
    expect(samePage('not a url', 'not a url')).toBe(true)
  })
})

describe('the plain words for a pick (the chat chip)', () => {
  it('names the record when content.locate is sure: the last level, the record itself', () => {
    expect(resolvedLabel(MENU_LOCATE)).toBe('Menu item "Services"')
    expect(plainLabel(MENU_TARGET, MENU_LOCATE)).toBe('Menu item "Services"')
  })

  it('otherwise quotes the element\'s own words, cut to 40 characters', () => {
    const stat = { ...MENU_TARGET, text: '13 subsidiaries', tag: 'span' }
    for (const status of ['candidates', 'conflict', 'unconfirmed', 'unknown']) {
      expect(plainLabel(stat, { ...MENU_LOCATE, status })).toBe('"13 subsidiaries"')
    }
    expect(plainLabel(stat, null)).toBe('"13 subsidiaries"')
    const long = plainLabel({ ...stat, text: 'Northgate Group   is a family of thirteen companies across Europe' }, null)
    expect(long).toBe('"Northgate Group is a family of thirteen…"')
    expect(long.length).toBe(42)
  })

  it('F10 (stage-6 acceptance): an answer naming only the page the element sits on is not the element\'s name — its own words, image or inside win', () => {
    const pageOnly = { status: 'resolved', levels: [{ kind: 'record', id: '7', contentId: '7', label: 'page "Home"', writable: true }] }
    const logo = { ...MENU_TARGET, text: '', tag: 'img', image: { src: 'https://s.test/images/logo-ru-2.png', alt: '' } }
    expect(plainLabel(logo, pageOnly)).toBe('image')
    const section = { ...MENU_TARGET, text: '', tag: 'section', image: null, inside: 'Clients we have built for Электра Волгамаш' }
    expect(plainLabel(section, pageOnly)).toBe('"Clients we have built for Электра Волга…"')
    expect(plainLabel({ ...MENU_TARGET, text: 'Northgate Industrial wins' }, { ...pageOnly, levels: [{ ...pageOnly.levels[0]!, label: 'article "News"' }] })).toBe('"Northgate Industrial wins"')
    // A record-only answer naming a record that is not a page (a menu item, a module) still names it.
    expect(plainLabel(MENU_TARGET, { status: 'resolved', levels: [{ kind: 'record', label: 'Menu item "Services"' }] })).toBe('Menu item "Services"')
    // With nothing of its own, the page is still better than nothing — in plain words (round 9).
    expect(plainLabel({ ...MENU_TARGET, text: '', tag: 'div', image: null }, pageOnly)).toBe('Home page')
  })

  it('round 5 (acceptance v3 K05): an element located to a FIELD of a page is named by itself, never by the page it sits on', () => {
    // content.locate of the hero image on Home: its field, its block, then the page record (out-sends.json n=117).
    const heroLocate = {
      status: 'resolved',
      levels: [
        { kind: 'field', id: '7#b/hero.img', contentId: '7', fieldKey: 'hero.img', label: 'Home › hero.img', writable: true },
        { kind: 'block', id: 'b', contentId: '7', label: 'Home › hero', writable: true },
        { kind: 'record', id: '7', contentId: '7', label: 'page "Home"', writable: true },
      ],
    }
    const hero = { ...MENU_TARGET, text: '', tag: 'img', image: { src: 'https://s.test/wp-content/uploads/hero-ru-1024x640.png', alt: 'Drop a site photo here · 4:5' } }
    expect(plainLabel(hero, heroLocate)).toBe('Drop a site photo here · 4:5')
    // A heading on the same page: its own words, not `page "Home"`.
    expect(plainLabel({ ...MENU_TARGET, text: 'Building the ground the next industrial era stands on', tag: 'h1' }, heroLocate)).toBe('"Building the ground the next industrial…"')
    // A shared template part (the header) is where the element sits, not what it is.
    const header = { status: 'resolved', levels: [{ kind: 'record', label: 'shared "Header"' }] }
    expect(plainLabel({ ...MENU_TARGET, text: '', tag: 'button', image: null, name: 'Search' }, header)).toBe('Search')
    // With nothing of its own, the record is still better than nothing — in plain words (round 9).
    expect(plainLabel({ ...MENU_TARGET, text: '', tag: 'div', image: null }, heroLocate)).toBe('Home page')
  })

  it('round 5: the page\'s plain name (runtime 14 `name`) names an element with no words — an icon button, an embed, a captioned image', () => {
    const bare = { ...MENU_TARGET, text: '', tag: 'button', image: null }
    expect(plainLabel({ ...bare, name: 'Search' }, null)).toBe('Search')
    expect(plainLabel({ ...bare, tag: 'iframe', name: 'embedded video "Company film" · youtube.com' }, null)).toBe('embedded video "Company film" · youtube.com')
    // A captioned image with no alt: the caption, not the file name.
    const img = { ...bare, tag: 'img', image: { src: 'https://s.test/12f6e6ac883957ea6fc4e6cb73890c8b.png', alt: '' }, name: 'Our harbour office' }
    expect(plainLabel(img, null)).toBe('Our harbour office')
    // Words always win over a name.
    expect(plainLabel({ ...bare, text: 'Dark', name: 'Switch theme' }, null)).toBe('"Dark"')
  })

  it('round 5: a hashed file name is never a label — "image" instead', () => {
    const img = { ...MENU_TARGET, text: '', tag: 'img', image: { src: 'https://s.test/wp-content/uploads/12f6e6ac883957ea6fc4e6cb73890c8b93e556c1.png', alt: '' } }
    expect(plainLabel(img, null)).toBe('image')
    // Round 9: no file name either — a person never named it (`image`).
    expect(plainLabel({ ...img, image: { ...img.image, src: 'https://s.test/flags/us.png' } }, null)).toBe('image')
  })

  it('round 9 (acceptance v5 V5S-5): an image picked into its field is never named by the field path (`Home › hero.img`)', () => {
    // content.locate of the hero image as the stand answers it on e3sw0330 (field, block, page record).
    const heroLocate = {
      status: 'resolved',
      levels: [
        { kind: 'field', id: '7#b/hero.img', contentId: '7', fieldKey: 'hero.img', label: 'Home › hero.img', writable: true },
        { kind: 'block', id: 'b', contentId: '7', label: 'Home › hero', writable: true },
        { kind: 'record', id: '7', contentId: '7', label: 'page "Home"', writable: true },
      ],
    }
    const hero = { ...MENU_TARGET, text: '', tag: 'img', image: { src: 'https://s.test/wp-content/uploads/hero-ru-1024x640.png', alt: '' } }
    // No alt: `image`; with alt: the alt; with a caption: the caption.
    expect(plainLabel(hero, heroLocate)).toBe('image')
    expect(plainLabel({ ...hero, image: { ...hero.image, alt: 'Crew on the substation roof' } }, heroLocate)).toBe('Crew on the substation roof')
    expect(plainLabel({ ...hero, name: 'Our harbour office' }, heroLocate)).toBe('Our harbour office')
    // The alt wins over the caption the page read for the same image.
    expect(plainLabel({ ...hero, name: 'Caption', image: { ...hero.image, alt: 'Alt words' } }, heroLocate)).toBe('Alt words')
    // An answer whose last level is a field or a block (a record level missing) names nothing by its path.
    const fieldOnly = { status: 'resolved', levels: [heroLocate.levels[0]!] }
    expect(plainLabel(hero, fieldOnly)).toBe('image')
    expect(plainLabel({ ...MENU_TARGET, text: '', tag: 'div', image: null }, fieldOnly)).toBe('')
    for (const label of [plainLabel(hero, heroLocate), plainLabel(hero, fieldOnly)]) expect(label).not.toMatch(/›|\.img\b/)
  })

  it('round 9: a record is named in plain words — "Home page", never `page "Home"`', () => {
    const bare = { ...MENU_TARGET, text: '', tag: 'div', image: null }
    const only = (label: string) => ({ status: 'resolved', levels: [{ kind: 'record', label }] })
    expect(plainLabel(bare, only('page "Home"'))).toBe('Home page')
    expect(plainLabel(bare, only('article "Company news"'))).toBe('Company news article')
    expect(plainLabel(bare, only('post "Hello world"'))).toBe('Hello world post')
    expect(plainLabel(bare, only('shared "Header"'))).toBe('Header')
    expect(plainLabel(bare, only('template part "Footer"'))).toBe('Footer')
    // A record that IS the element keeps its own words.
    expect(plainLabel(MENU_TARGET, only('Menu item "Services"'))).toBe('Menu item "Services"')
  })

  it('round 5: readPickTarget keeps the page\'s name and hidden, bounded, and drops anything else', () => {
    const t = readPickTarget({ ...MENU_TARGET, name: 'x'.repeat(500), hidden: 'clipped' })!
    expect(t.name).toHaveLength(300)
    expect(t.hidden).toBe('clipped')
    expect(readPickTarget({ ...MENU_TARGET, name: 7, hidden: 'gone' })).not.toHaveProperty('name')
    expect(readPickTarget({ ...MENU_TARGET, hidden: 'gone' })).not.toHaveProperty('hidden')
    expect(readPickTarget({ ...MENU_TARGET, hidden: 'covered' })!.hidden).toBe('covered')
  })

  it('an image is its alt text, else `image` (round 9: never its file name)', () => {
    const img = { ...MENU_TARGET, text: '', tag: 'img', image: { src: 'https://s.test/images/hero%20team.jpg?v=2', alt: '' } }
    expect(plainLabel(img, null)).toBe('image')
    expect(plainLabel({ ...img, image: { ...img.image, alt: 'Our team at the harbour' } }, null)).toBe('Our team at the harbour')
  })

  it('never an HTML tag or a status word: nothing to say gives an empty label', () => {
    const bare = { ...MENU_TARGET, text: '', tag: 'div', image: null }
    expect(plainLabel(bare, null)).toBe('')
    expect(plainLabel(bare, { status: 'unknown', levels: [] })).toBe('')
    expect(resolvedLabel({ status: 'resolved', levels: [] })).toBeNull()
    expect(resolvedLabel('resolved')).toBeNull()
  })
})

describe('placing the popover', () => {
  it('opens under the outline, aligned to the nearer side, inside the frame', () => {
    const right = popoverPlacement(rect(760, 60, 60, 24), { width: 1040, height: 660 }, 280)
    expect(right).toMatchObject({ above: false, align: 'right', top: 60 + 24 + 6 + 10, width: 300 })
    expect(right.left).toBe(760 + 60 + 6 - 300)
    const left = popoverPlacement(rect(40, 60, 60, 24), { width: 1040, height: 660 }, 280)
    expect(left).toMatchObject({ align: 'left', left: 34 })
  })

  it('opens above when there is no room below, and shrinks in a narrow frame', () => {
    const above = popoverPlacement(rect(40, 520, 100, 20), { width: 1040, height: 660 }, 300)
    expect(above.above).toBe(true)
    expect(above.top).toBe(520 - 6 - 10 - 300)
    const narrow = popoverPlacement(rect(10, 10, 20, 20), { width: 300, height: 600 }, 280)
    expect(narrow.width).toBe(284)
    expect(narrow.left).toBe(8)
  })

  it('a saved comment reopened from its pin opens by that pin, even on a block wider than the popover', () => {
    // Brian 29/09: pin 3 on a full-width section; the popover opened at the section's far-left corner,
    // ~1100 px from the pin he clicked, so the click seemed to open nothing.
    const section = rect(40, 300, 960, 300)
    const byBox = popoverPlacement(section, { width: 1040, height: 660 }, 120, 360)
    expect(byBox).toMatchObject({ align: 'left', left: 34 })
    const byPin = popoverPlacement(section, { width: 1040, height: 660 }, 120, 360, 'pin')
    expect(byPin).toMatchObject({ align: 'right', left: 40 + 960 + 6 - 360, width: 360 })
    // A block narrower than the popover keeps today's side: the popover already spans its pin.
    expect(popoverPlacement(rect(40, 60, 60, 24), { width: 1040, height: 660 }, 120, 360, 'pin')).toMatchObject({ align: 'left', left: 34 })
  })

  it('stays by its element while the page scrolls: once the outline has left the frame the popover goes with it, never pinned to an edge (Brian 30/09)', () => {
    const frame = { width: 1040, height: 660 }
    // In view: kept inside the frame, as before.
    expect(popoverPlacement(rect(40, 20, 100, 20), frame, 150).top).toBe(20 + 20 + 6 + 10)
    // Scrolled up and out (its outline's bottom above the frame): still under it, leaving over the top.
    const up = popoverPlacement(rect(40, -120, 100, 20), frame, 150)
    expect(up.top).toBe(-120 + 20 + 6 + 10)
    // Scrolled down and out (its outline's top below the frame): still over it, leaving under the bottom.
    const down = popoverPlacement(rect(40, 700, 100, 20), frame, 150)
    expect(down).toMatchObject({ above: true, top: 700 - 6 - 10 - 150 })
    // Partly in view: placed and kept inside, as before (a popover taller than the room is clamped).
    expect(popoverPlacement(rect(40, -10, 100, 20), frame, 150).top).toBe(-10 + 20 + 6 + 10)
    expect(popoverPlacement(rect(40, 300, 100, 20), { width: 1040, height: 400 }, 380).top).toBe(8)
  })
})

describe('sending one comment', () => {
  it('carries the element, the locate answer as the server gave it, and queue mode', () => {
    const detail = commentSendDetail({
      requestId: 'r1',
      sessionId: 's1',
      siteKey: 'northgate',
      text: '  Make only this menu item orange (#c8643b).  ',
      url: 'https://northgate.tracy.test/',
      target: MENU_TARGET,
      locate: MENU_LOCATE,
    })
    expect(detail).toEqual({
      v: 1,
      requestId: 'r1',
      sessionId: 's1',
      siteKey: 'northgate',
      text: 'Make only this menu item orange (#c8643b).',
      mode: 'queue',
      element: { url: 'https://northgate.tracy.test/', selector: 'li.item-104 > a', label: 'Menu item "Services"', text: 'Services', rect: MENU_TARGET.rect, marks: ['menu-item:104', 'module:87'] },
      locate: MENU_LOCATE,
    })
    expect(JSON.stringify(detail)).not.toContain('tracy_preview')
  })

  it('with no locate answer (failed, or not in 3 s) sends locate:null and the element\'s own words', () => {
    const detail = commentSendDetail({ requestId: 'r2', sessionId: 's1', siteKey: 'northgate', text: 'Rename.', url: 'https://northgate.tracy.test/', target: MENU_TARGET, locate: null })
    expect(detail.locate).toBeNull()
    expect(detail.element.label).toBe('"Services"')
  })

  it('reads only the answer for its own request', () => {
    expect(readCommentAnswer(COMMENT_SENT_EVENT, { requestId: 'r1', queued: true }, 'r1')).toEqual({ ok: true, queued: true })
    expect(readCommentAnswer(COMMENT_SENT_EVENT, { requestId: 'r2' }, 'r1')).toBeNull()
    expect(readCommentAnswer(COMMENT_FAILED_EVENT, { requestId: 'r1', code: 'no-session' }, 'r1')).toEqual({ ok: false, code: 'no-session' })
    expect(readCommentAnswer(COMMENT_FAILED_EVENT, { requestId: 'r1', code: 'weird' }, 'r1')).toEqual({ ok: false, code: 'unknown' })
  })

  it('asks content.locate with the six fields the door reads', () => {
    expect(Object.keys(locateParams(MENU_TARGET, 'https://a/'))).toEqual(['url', 'text', 'image', 'marks', 'domPath', 'selector'])
  })
})

describe('a picked container carries its words (`inside`)', () => {
  const card = { ...MENU_TARGET, text: '', tag: 'div' }

  it('readPickTarget keeps inside, capped at 200 with the page\'s cut mark, and leaves it out when absent', () => {
    const whole = readPickTarget({ ...card, inside: 'Ana Lopez Head of design' })
    expect(whole?.inside).toBe('Ana Lopez Head of design')
    const cut = `${'w'.repeat(199)}…`
    expect(readPickTarget({ ...card, inside: cut })?.inside).toBe(cut)
    expect(readPickTarget({ ...card, inside: 'x'.repeat(500) })?.inside).toHaveLength(200)
    expect('inside' in (readPickTarget(card) ?? {})).toBe(false)
    expect('inside' in (readPickTarget({ ...card, inside: 7 }) ?? {})).toBe(false)
  })

  it('the comment carries inside into the element; locateParams still sends only the element\'s own text', () => {
    const target = { ...card, inside: 'Ana Lopez Head of design' }
    const detail = commentSendDetail({ requestId: 'r', sessionId: 's', siteKey: 'k', text: 'Add one.', url: 'https://k.tracy.test/', target, locate: null })
    expect(detail.element.inside).toBe('Ana Lopez Head of design')
    expect(locateParams(target, 'https://k.tracy.test/').text).toBe('')
    expect('inside' in commentSendDetail({ requestId: 'r', sessionId: 's', siteKey: 'k', text: 'x', url: 'u', target: card, locate: null }).element).toBe(false)
  })
})


describe('round 6: a long thread card never covers its own element (acceptance v4 thread)', () => {
  it('caps the card to the larger room beside the element (below or above), less the margin', () => {
    // Element near the top: 520 px below it.
    expect(threadCardMaxHeight(rect(40, 100, 300, 40), { width: 900, height: 700 })).toBe(700 - (100 + 40 + 6 + 10) - 8)
    // Element near the bottom: the room above wins.
    expect(threadCardMaxHeight(rect(40, 600, 300, 40), { width: 900, height: 700 })).toBe(600 - 6 - 10 - 8)
  })

  it('never below THREAD_CARD_MIN; no cap for a whole-page comment or an element out of view', () => {
    expect(threadCardMaxHeight(rect(40, 20, 300, 640), { width: 900, height: 700 })).toBe(THREAD_CARD_MIN)
    expect(threadCardMaxHeight(null, { width: 900, height: 700 })).toBeUndefined()
    expect(threadCardMaxHeight(rect(40, -200, 300, 40), { width: 900, height: 700 })).toBeUndefined()
    expect(threadCardMaxHeight(rect(40, 100, 300, 40), { width: 0, height: 0 })).toBeUndefined()
  })

  it('a capped card fits on its side: placed there, it does not overlap the outline', () => {
    const r = rect(40, 600, 300, 40)
    const frame = { width: 900, height: 700 }
    const h = threadCardMaxHeight(r, frame)!
    const place = popoverPlacement(r, frame, h, 320, 'box')
    expect(place.above).toBe(true)
    expect(place.top + h).toBeLessThanOrEqual(600 - 6)
  })
})

describe('round 8 (acceptance v5 JS-v5-new-1, J38): a box whose element hides stays where the person last saw it', () => {
  const SEEN = { x: 40, y: 300, width: 200, height: 30 }
  it('shown: by the element; hidden after it was seen: at the last place, marked gone; never seen: no place (the corner)', () => {
    expect(boxStand(SEEN, null)).toEqual({ rect: SEEN, gone: false })
    expect(boxStand({ ...SEEN, hidden: 'covered' }, null)).toEqual({ rect: { ...SEEN, hidden: 'covered' }, gone: false })
    expect(boxStand({ x: 0, y: -900, width: 0, height: 0, hidden: 'clipped' }, SEEN)).toEqual({ rect: SEEN, gone: true })
    expect(boxStand({ ...SEEN, hidden: 'clipped' }, null)).toEqual({ rect: null, gone: true })
    expect(boxStand(undefined, SEEN)).toEqual({ rect: null, gone: false })
  })

  it('the element is named in plain words for the note: its words, else its name, image or tag', () => {
    const t = (over: Partial<PreviewPickTarget>): PreviewPickTarget => ({ text: '', tag: 'a', image: null, domPath: 'a', selector: 'a', rect: SEEN, marks: [], levels: [], level: 0, ...over })
    expect(hiddenName(t({ text: 'Newsletter' }))).toBe('Newsletter')
    expect(hiddenName(t({ name: 'Open search' }))).toBe('Open search')
    expect(hiddenName(t({ image: { src: 'https://s.test/logo.png', alt: '' } }))).toBe('image')
    expect(hiddenName(t({ tag: 'canvas' }))).toBe('canvas')
    expect(hiddenName(t({ text: 'A very long menu label that goes on and on past what a head can hold' })).length).toBeLessThanOrEqual(41)
  })

  it('a click the page reports where the box stands, or stood a moment ago, was aimed at the box', () => {
    const trail = [{ left: 100, top: 200, width: 340, height: 150, at: 1_000 }, { left: 14, top: 4, width: 340, height: 150, at: 1_200 }]
    expect(aimedAtBox({ x: 150, y: 250 }, trail, 1_300)).toBe(true)
    expect(aimedAtBox({ x: 20, y: 10 }, trail, 1_300)).toBe(true)
    expect(aimedAtBox({ x: 150, y: 250 }, trail, 1_200 + AIMED_MS + 1)).toBe(false)
    expect(aimedAtBox({ x: 900, y: 700 }, trail, 1_300)).toBe(false)
  })
})
