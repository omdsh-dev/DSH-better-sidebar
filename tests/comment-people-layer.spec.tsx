// @vitest-environment jsdom
/**
 * What the Browser tab DRAWS for people comments (Tracy, 29/09/2026; TCH stories
 * `PopoverTwoButtonsEmpty · PopoverTwoButtonsTyped · PopoverEditPending · ThreadCardSendToChat ·
 * ToolbarCommentsButton[Zero|Compact] · Refresh*` in `packages/dev/tracy-design/src/mockups/
 * browser-comment.mock.stories.tsx`). Each case renders `CommentLayer.tsx` with a hand-built controller
 * state (`comment-layer-fixture.ts`); the flow behind it is held by `comment-people-controller.spec.tsx`.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is stubbed: `Menu` draws its anchor and, open, its rows as
 * buttons.
 */
import { createElement, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement: h, Fragment } = await import('react')
  type Entry = { id: string; label?: ReactNode; icon?: ReactNode; danger?: boolean }
  return {
    Pill: (p: { className?: string; 'aria-label'?: string; onClick?: () => void; children?: ReactNode }) =>
      h('button', { type: 'button', className: p.className, 'aria-label': p['aria-label'], onClick: p.onClick }, p.children),
    Menu: (p: { open: boolean; anchor: ReactNode; items?: Entry[]; onSelect?: (id: string) => void }) =>
      h(Fragment, null, p.anchor, p.open
        ? h('div', { role: 'menu' }, (p.items ?? []).map(entry => h('button', { key: entry.id, type: 'button', role: 'menuitem', 'data-id': entry.id, 'data-danger': entry.danger === true ? '' : undefined, onClick: () => p.onSelect?.(entry.id) }, entry.icon, entry.label)))
        : null),
    IconRefreshOutlineRegular: (p: { className?: string }) => h('svg', { className: p.className, 'data-icon': 'refresh' }),
    IconPaperclipOutlineRegular: () => h('svg', { 'data-icon': 'paperclip' }),
  }
})

import { AUTHOR_COLOURS, CommentOverlay, CommentsButton, ModeBar, PIN_FAN_PX, RefreshButton, authorColor, avatarPinPlacement } from '../src/client/CommentLayer.tsx'
import { readFileSync } from 'node:fs'
const cssText = readFileSync(`${import.meta.dirname}/../src/client/sidebar.module.css`, 'utf8')
import type { CommentMode } from '../src/client/comment-controller.ts'
import { localeDicts } from '../src/client/chunks/locale.tsx'
import { en, zh } from '../src/client/locales.ts'
import css from '../src/client/sidebar.module.css'
import { LEE, MAI, PAGE as HOME, comment, fixtureMode, picked } from './comment-layer-fixture.ts'

let root: Root | null = null
let host: HTMLDivElement

beforeEach(() => {
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(async () => {
  if (root !== null) await act(async () => { root!.unmount() })
  root = null
  host.remove()
  vi.restoreAllMocks()
})

async function draw(node: ReactElement): Promise<void> {
  root ??= createRoot(host)
  await act(async () => { root!.render(node) })
}

const overlay = (mode: CommentMode): ReactElement => createElement(CommentOverlay, { mode, zoom: 100 })
const q = <T extends Element = HTMLElement>(selector: string): T | null => host.querySelector<T>(selector)
const hexToRgb = (hex: string): string => `rgb(${[1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
const qa = (selector: string): Element[] => Array.from(host.querySelectorAll(selector))
const buttons = (scope: Element): HTMLButtonElement[] => [...scope.querySelectorAll('button')]
const press = async (el: Element, init: KeyboardEventInit): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  await act(async () => { el.dispatchEvent(event) })
  return event
}
/** Enter while an input method (Telex, VNI, pinyin, kana) is still composing: it only ends the composition. */
const COMPOSING: KeyboardEventInit[] = [{ key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }]

describe('the new-place popover (PopoverTwoButtonsEmpty · PopoverTwoButtonsTyped)', () => {
  it('a header "Comment" + ✕, the text box, "Add comment" (no key) and "Send to Tracy ↵", both disabled while empty; no pin, no "+ Add another"', async () => {
    await draw(overlay(fixtureMode({ foot: 'new', picked: picked() })))
    const dialog = q('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Comment')
    expect(q(`.${css.commentHeadTitle!}`)!.textContent).toBe('Comment')
    expect(buttons(dialog).map(b => [b.getAttribute('aria-label') ?? b.textContent, b.disabled])).toEqual([['Close', false], ['Add comment', true], ['Send to Tracy↵', true]])
    expect(buttons(dialog)[0]!.title).toBe('Close (Esc)')
    expect((dialog.querySelector('textarea') as HTMLTextAreaElement).placeholder).toBe('Describe what should change…')
    expect(dialog.textContent).not.toContain('Add another')
    expect(q('[data-comment-pin]')).toBeNull()
  })

  it('typed: both enabled; tooltips "Add comment" and "Send to Tracy (Enter)"', async () => {
    await draw(overlay(fixtureMode({ foot: 'new', picked: picked(), text: 'Make only this menu item orange (#c8643b).' })))
    const [, add, send] = buttons(q('[role="dialog"]')!)
    expect([add!.disabled, send!.disabled]).toEqual([false, false])
    expect(add!.title).toBe('Add comment')
    expect(send!.title).toBe('Send to Tracy (Enter)')
    expect(q('textarea')!.classList.contains(css.commentTextareaFilled!)).toBe(true)
  })

  it('Enter sends to Tracy (no new line); Add comment is a click only; Esc is one step of escape', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), text: 'Words' })
    await draw(overlay(mode))
    const area = q('textarea')!
    const enter = await press(area, { key: 'Enter' })
    expect(mode.sendToTracy).toHaveBeenCalledTimes(1)
    expect(enter.defaultPrevented).toBe(true)
    expect(mode.addComment).not.toHaveBeenCalled()
    await act(async () => { buttons(q('[role="dialog"]')!)[1]!.click() })
    expect(mode.addComment).toHaveBeenCalledTimes(1)
    await act(async () => { buttons(q('[role="dialog"]')!)[2]!.click() })
    expect(mode.sendToTracy).toHaveBeenCalledTimes(2)
    await press(area, { key: 'Escape' })
    expect(mode.escape).toHaveBeenCalledWith('parent', expect.anything())
  })

  it('Shift+Enter is a new line: nothing sent, nothing added; ⇧⌘↵ / Alt+↵ are bound to nothing (dsh composer rule, Brian 30/09)', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), text: 'Words' })
    await draw(overlay(mode))
    const area = q('textarea')!
    const shift = await press(area, { key: 'Enter', shiftKey: true })
    expect(shift.defaultPrevented).toBe(false)
    for (const init of [{ metaKey: true, shiftKey: true }, { ctrlKey: true, shiftKey: true }, { altKey: true }, { ctrlKey: true, metaKey: true }]) {
      const event = await press(area, { key: 'Enter', ...init })
      expect(event.defaultPrevented).toBe(true)
    }
    expect(mode.sendToTracy).not.toHaveBeenCalled()
    expect(mode.addComment).not.toHaveBeenCalled()
  })

  it('⌘↵ and Ctrl+↵ send to Tracy too, as in dsh\'s chat composer (Brian 30/09)', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), text: 'Words' })
    await draw(overlay(mode))
    await press(q('textarea')!, { key: 'Enter', metaKey: true })
    await press(q('textarea')!, { key: 'Enter', ctrlKey: true })
    expect(mode.sendToTracy).toHaveBeenCalledTimes(2)
    expect(mode.addComment).not.toHaveBeenCalled()
  })

  it('a held-down Enter sends once; Enter while it is sending does nothing', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), text: 'Words' })
    await draw(overlay(mode))
    await press(q('textarea')!, { key: 'Enter' })
    for (let i = 0; i < 5; i += 1) await press(q('textarea')!, { key: 'Enter', repeat: true })
    expect(mode.sendToTracy).toHaveBeenCalledTimes(1)
    const busy = fixtureMode({ foot: 'new', picked: picked(), text: 'Words', sending: true })
    await draw(overlay(busy))
    const event = await press(q('textarea')!, { key: 'Enter' })
    expect(event.defaultPrevented).toBe(true)
    expect(busy.sendToTracy).not.toHaveBeenCalled()
  })

  it('the Enter that closes a Vietnamese composition (right after compositionend, isComposing false) never sends and is the browser\'s, as in dsh\'s composer (round 5, INPUT-new-3)', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), text: 'Chữ đỏ' })
    await draw(overlay(mode))
    const area = q('textarea')!
    await act(async () => { area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
    await act(async () => { area.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'đỏ' })) })
    const closing = await press(area, { key: 'Enter' })
    expect(closing.defaultPrevented).toBe(false)
    expect(mode.sendToTracy).not.toHaveBeenCalled()
    // The next Enter, after the composition's tail, sends.
    await new Promise(resolve => setTimeout(resolve, 40))
    await press(area, { key: 'Enter' })
    expect(mode.sendToTracy).toHaveBeenCalledTimes(1)
  })

  it('Enter while an input method composes (Telex, VNI, CJK) only ends the composition', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), text: 'Chữ' })
    await draw(overlay(mode))
    for (const init of COMPOSING) {
      const event = await press(q('textarea')!, init)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(mode.sendToTracy).not.toHaveBeenCalled()
  })

  it('Enter in an empty (whitespace-only) box does nothing', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), text: '  \n ' })
    await draw(overlay(mode))
    await press(q('textarea')!, { key: 'Enter' })
    expect(mode.sendToTracy).not.toHaveBeenCalled()
    expect(mode.addComment).not.toHaveBeenCalled()
  })

  it('Enter on a focused button is that button, not Send to Tracy', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), text: 'Words' })
    await draw(overlay(mode))
    await press(buttons(q('[role="dialog"]')!)[1]!, { key: 'Enter' })
    expect(mode.sendToTracy).not.toHaveBeenCalled()
  })

  it('on Windows and Linux it reads the same: ↵, "(Enter)"', async () => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true })
    await draw(overlay(fixtureMode({ foot: 'new', picked: picked(), text: 'x' })))
    const [, add, send] = buttons(q('[role="dialog"]')!)
    expect([add!.textContent, send!.textContent]).toEqual(['Add comment', 'Send to Tracy↵'])
    expect(send!.title).toBe('Send to Tracy (Enter)')
  })
})

describe('the text boxes grow with their words (Brian 30/09)', () => {
  /** jsdom lays nothing out: a text box's content height is 16 px of padding plus 20 px a line. */
  const LINE = 20
  beforeEach(() => {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLTextAreaElement) {
      return 16 + LINE * Math.max(1, this.value.split('\n').length)
    })
  })
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${String(i + 1)}`).join('\n')
  const mine = comment(1, 'Say hello')
  const root1 = comment(1, 'We have 14 subsidiaries now.', { author: MAI, can: { edit: false, delete: false } })

  for (const [name, make, field] of [
    ['the new-comment popover', (text: string) => fixtureMode({ foot: 'new', picked: picked(), text }), '[role="dialog"] textarea'],
    ['the edit popover', (text: string) => fixtureMode({ foot: 'edit', editing: mine, text, pageComments: [mine], rects: new Map([['c1', { x: 40, y: 200, width: 300, height: 40 }]]) }), '[role="dialog"] textarea'],
    ['the thread card\'s reply box', (replyText: string) => fixtureMode({ thread: root1, threadMessages: [root1], pageComments: [root1], replyText, rects: new Map([['c1', { x: 32, y: 300, width: 200, height: 40 }]]) }), '[data-thread] textarea'],
  ] as const) {
    it(`${name}: taller with each line up to 200 px, then it scrolls inside; shorter again when words go`, async () => {
      await draw(overlay(make(lines(1))))
      const area = (): HTMLTextAreaElement => q<HTMLTextAreaElement>(field)!
      expect(area().style.height).toBe('36px')
      expect(area().style.overflowY).toBe('hidden')
      await draw(overlay(make(lines(4))))
      expect(area().style.height).toBe('96px')
      await draw(overlay(make(lines(20))))
      expect(area().style.height).toBe('200px')
      expect(area().style.overflowY).toBe('auto')
      await draw(overlay(make(lines(2))))
      expect(area().style.height).toBe('56px')
      expect(area().style.overflowY).toBe('hidden')
    })
  }

  it('the popover flips over its element when the grown box no longer fits under it, and stays inside the frame', async () => {
    // The popover's height: its chrome (100 px) plus the text box's grown height.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') !== 'dialog') return 0
      const area = this.querySelector('textarea')
      return 100 + (area === null ? 0 : Number.parseInt(area.style.height || '0', 10))
    })
    const at = (text: string): CommentMode => fixtureMode({ foot: 'new', picked: picked({ x: 40, y: 480, width: 200, height: 40 }), text })
    await draw(overlay(at(lines(1))))
    const top = (): number => Number.parseFloat(q<HTMLElement>('[role="dialog"]')!.style.top)
    expect(top()).toBe(480 + 40 + 6 + 10)
    await draw(overlay(at(lines(12))))
    // 300 px tall now: under the element (768 − 536 = 232 px) it does not fit; over it, it does.
    expect(top()).toBe(480 - 6 - 10 - 300)
    await draw(overlay(at(lines(1))))
    expect(top()).toBe(480 + 40 + 6 + 10)
  })
})

describe('the edit popover (PopoverEditPending)', () => {
  it('"Save ↵", "Send to Tracy" (click only) and a small red "Delete"; Enter saves; the other bubbles are dimmed', async () => {
    const mine = comment(1, 'Say hello')
    const other = comment(2, 'Theirs', { author: MAI, can: { edit: false, delete: false } })
    const mode = fixtureMode({ foot: 'edit', editing: mine, text: 'Say hello', pageComments: [mine, other], rects: new Map([['c1', { x: 40, y: 200, width: 300, height: 40 }], ['c2', { x: 40, y: 400, width: 300, height: 40 }]]) })
    await draw(overlay(mode))
    const dialog = q('[role="dialog"]')!
    expect(buttons(dialog).map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Close', 'Delete', 'Save↵', 'Send to Tracy'])
    expect(buttons(dialog).slice(2).map(b => b.title)).toEqual(['Save (Enter)', 'Send to Tracy'])
    expect(buttons(dialog)[1]!.className).toBe(css.commentDelete)
    await act(async () => { buttons(dialog)[1]!.click() })
    expect(mode.deleteComment).toHaveBeenCalledWith('c1')
    await press(q('textarea')!, { key: 'Enter' })
    expect(mode.save).toHaveBeenCalledTimes(1)
    expect(mode.sendToTracy).not.toHaveBeenCalled()
    await act(async () => { buttons(dialog)[3]!.click() })
    expect(mode.sendToTracy).toHaveBeenCalledTimes(1)
    expect(q('[data-comment-pin="c2"]')!.classList.contains(css.commentPinDim!)).toBe(true)
    expect(q('[data-comment-pin="c1"]')!.classList.contains(css.commentPinDim!)).toBe(false)
  })
})

describe('the edit popover\'s keys', () => {
  const mine = comment(1, 'Say hello')
  const editMode = (text: string): CommentMode => fixtureMode({ foot: 'edit', editing: mine, text, pageComments: [mine], rects: new Map([['c1', { x: 40, y: 200, width: 300, height: 40 }]]) })

  it('Shift+Enter is a new line; ⌘↵ / Ctrl+↵ save, like Enter, and send nothing; a held-down Enter saves once', async () => {
    const mode = editMode('Say hello')
    await draw(overlay(mode))
    const shift = await press(q('textarea')!, { key: 'Enter', shiftKey: true })
    expect(shift.defaultPrevented).toBe(false)
    await press(q('textarea')!, { key: 'Enter', metaKey: true })
    await press(q('textarea')!, { key: 'Enter', ctrlKey: true })
    expect(mode.save).toHaveBeenCalledTimes(2)
    await press(q('textarea')!, { key: 'Enter', repeat: true })
    expect(mode.save).toHaveBeenCalledTimes(2)
    expect(mode.sendToTracy).not.toHaveBeenCalled()
  })

  it('Enter while composing does not save; Enter on an emptied box does nothing', async () => {
    const mode = editMode('Xin chào')
    await draw(overlay(mode))
    for (const init of COMPOSING) await press(q('textarea')!, init)
    expect(mode.save).not.toHaveBeenCalled()
    const empty = editMode('   ')
    await draw(overlay(empty))
    await press(q('textarea')!, { key: 'Enter' })
    expect(empty.save).not.toHaveBeenCalled()
  })
})

describe('"Deleted · Undo" IN PLACE of the deleted message (Brian 29/09 23:05)', () => {
  const root = comment(1, 'We have 14 subsidiaries now.', { author: MAI, can: { edit: false, delete: false } })
  const mine = comment(2, 'The About page says 13 as well.', { replyTo: 'c1' })
  const card = (over: Partial<CommentMode> = {}): CommentMode => fixtureMode({ thread: root, threadMessages: [root, mine], pageComments: [root], rects: new Map([['c1', { x: 32, y: 300, width: 200, height: 40 }]]), ...over })

  it('the deleted message\'s spot reads "Deleted · Undo"; the other messages stay; Undo calls undoDelete', async () => {
    const mode = card({ deleted: { id: 'c2', left: 4 } })
    await draw(overlay(mode))
    const spots = [...q('[data-thread="c1"]')!.querySelectorAll('[data-message]')]
    expect(spots.map(m => m.textContent)).toEqual([expect.stringContaining('We have 14 subsidiaries now.'), 'Deleted·Undo (4)'])
    const spot = spots[1]!
    expect(spot.hasAttribute('data-deleted')).toBe(true)
    expect(spot.getAttribute('role')).toBe('status')
    expect(spot.querySelector('[aria-label="More"]')).toBeNull()
    // The countdown's thin bar (Brian 23:20): it empties over the whole window.
    const bar = spot.querySelector(`.${css.commentCountdown!}`) as HTMLElement
    expect(bar.style.animationDuration).toBe('10000ms')
    await act(async () => { buttons(spot)[0]!.click() })
    expect(mode.undoDelete).toHaveBeenCalledTimes(1)
  })

  it('no floating notice anywhere else: not over the page, not in the popover', async () => {
    await draw(overlay(card({ deleted: { id: 'c2', left: 4 } })))
    expect(q('[data-comment-notice]')).toBeNull()
    expect(host.textContent!.split('Deleted').length - 1).toBe(1)
  })

  it('no Delete waiting: every message as it is', async () => {
    await draw(overlay(card()))
    expect(q('[data-deleted]')).toBeNull()
  })

  it('reads "Đã xoá · Hoàn tác" in Vietnamese, and every dictionary has its own words', () => {
    const dicts = { zh, ...localeDicts } as Record<string, Record<string, string>>
    expect(dicts.vi!.commentDeleted).toBe('Đã xoá')
    expect(dicts.vi!.commentUndo).toBe('Hoàn tác')
    for (const [lang, dict] of Object.entries(dicts)) for (const k of ['commentDeleted', 'commentUndo']) {
      expect(dict[k], `${lang}.${k}`).toBeTruthy()
      expect(dict[k], `${lang}.${k}`).not.toBe((en as Record<string, string>)[k])
    }
  })
})

describe('pins are the author\'s bubble: no number, no status (rule 4)', () => {
  it('the initial in a 22 px bubble whose bottom-left corner points at the block\'s top-left; a click opens the thread card', async () => {
    const c = comment(7, 'Hello', { author: MAI })
    const mode = fixtureMode({ pageComments: [c], rects: new Map([['c7', { x: 40, y: 200, width: 300, height: 40 }]]) })
    await draw(overlay(mode))
    const pin = q('[data-comment-pin="c7"]')!
    expect(pin.textContent).toBe('M')
    expect(pin.textContent).not.toContain('7')
    expect(pin.getAttribute('aria-label')).toBe('Comment by Mai')
    expect([pin.style.left, pin.style.top]).toEqual(['32px', '168px'])
    // The author's colour, by account (round 5, TH-6).
    expect(pin.style.background).toBe(hexToRgb(authorColor(MAI)))
    expect(pin.hasAttribute('data-status')).toBe(false)
    await act(async () => { (pin as HTMLButtonElement).click() })
    expect(mode.openThread).toHaveBeenCalledWith('c7')
  })

  it('F9 (stage-6 acceptance): a comment whose block is scrolled out of view has no pin — never one stuck to the frame\'s top edge', async () => {
    const above = comment(1, 'Above', { author: MAI })
    const below = comment(2, 'Below')
    const shown = comment(3, 'Shown')
    // jsdom measures nothing: the layer places against its nominal 1024 × 768 stage.
    const rects = new Map([['c1', { x: 40, y: -120, width: 300, height: 40 }], ['c2', { x: 40, y: 900, width: 300, height: 40 }], ['c3', { x: 40, y: 200, width: 300, height: 40 }]])
    await draw(overlay(fixtureMode({ pageComments: [above, below, shown], rects })))
    expect([...host.querySelectorAll('[data-comment-pin]')].map(p => p.getAttribute('data-comment-pin'))).toEqual(['c3'])
  })

  it('round 5 (acceptance v3 B04, B13, PICK-new-4): a block the page says is clipped or covered has no pin — not over a nested box, the admin bar or an open menu', async () => {
    const clipped = comment(1, 'Nested row')
    const covered = comment(2, 'Under the admin bar')
    const shown = comment(3, 'Shown')
    const rects = new Map([
      ['c1', { x: 40, y: 300, width: 300, height: 40, hidden: 'clipped' as const }],
      ['c2', { x: 40, y: 20, width: 300, height: 40, hidden: 'covered' as const }],
      ['c3', { x: 40, y: 200, width: 300, height: 40 }],
    ])
    await draw(overlay(fixtureMode({ pageComments: [clipped, covered, shown], rects })))
    expect([...host.querySelectorAll('[data-comment-pin]')].map(p => p.getAttribute('data-comment-pin'))).toEqual(['c3'])
  })

  it('stays inside the frame', () => {
    expect(avatarPinPlacement({ x: 2, y: 10, width: 50, height: 10 }, 400)).toEqual({ left: 0, top: 0 })
    expect(avatarPinPlacement({ x: 395, y: 100, width: 50, height: 10 }, 400)).toEqual({ left: 378, top: 68 })
  })

  it('an author\'s colour follows their account (round 5, TH-6); with no account yet, tracy-chat-input\'s name key; never terracotta', () => {
    // Without an account: the values tracy-chat-input's own `authorColor` computes from the name.
    expect(authorColor({ ...LEE, accountId: '' })).toBe('#0d9488')
    expect(authorColor({ ...MAI, accountId: '' })).toBe('#c026d3')
    expect(authorColor({ accountId: '', email: 'anna.k@example.com', initial: 'A' })).toBe('#4f46e5')
    expect(authorColor({ ...LEE, name: 'Renamed' })).toBe(authorColor(LEE))
    expect(AUTHOR_COLOURS).not.toContain('#bf5b3d')
  })

  it('a resolved comment shown for its open card is the author\'s bubble, faded', async () => {
    const done = comment(3, 'Done one', { author: MAI, status: 'resolved', resolvedAt: 5, resolvedBy: LEE })
    const open = comment(4, 'Still open')
    await draw(overlay(fixtureMode({ thread: done, threadMessages: [done], pageComments: [done, open], rects: new Map([['c3', { x: 40, y: 200, width: 300, height: 40 }], ['c4', { x: 40, y: 400, width: 300, height: 40 }]]) })))
    const pin = q('[data-comment-pin="c3"]')!
    expect(pin.textContent).toBe('M')
    expect(pin.classList.contains(css.commentPinDim!)).toBe(true)
    expect(q('[data-comment-pin="c4"]')!.classList.contains(css.commentPinDim!)).toBe(false)
  })

  it('in Interactive no pin is drawn', async () => {
    const c = comment(1, 'Hello')
    await draw(overlay(fixtureMode({ modes: { visible: true, edit: false, unavailable: false, selectEdit: vi.fn(), selectInteractive: vi.fn(), reload: vi.fn() }, pageComments: [c], rects: new Map([['c1', { x: 1, y: 1, width: 1, height: 1 }]]) })))
    expect(q('[data-comment-pin]')).toBeNull()
  })
})

describe('the thread card (ThreadCardSendToChat · CommentsTabRowOpensCard)', () => {
  const root1 = comment(1, 'We have 14 subsidiaries now.', { author: MAI, can: { edit: false, delete: false }, createdAt: Date.now() - 20 * 60_000 })
  const reply1 = comment(2, 'The About page says 13 as well.', { replyTo: 'c1', createdAt: Date.now() - 6 * 60_000 })
  const threadMode = (over: Partial<CommentMode> = {}): CommentMode => fixtureMode({ thread: root1, threadMessages: [root1, reply1], pageComments: [root1], rects: new Map([['c1', { x: 32, y: 300, width: 200, height: 40 }]]), ...over })

  it('messages in order with name and age, ⋮ on each; Resolve is small text by the first message\'s ⋮; under "Reply…" only "Reply" (no key) and "Send to Tracy ↵"; no ✕', async () => {
    const mode = threadMode()
    await draw(overlay(mode))
    const card = q('[data-thread="c1"]')!
    expect([...card.querySelectorAll('[data-message]')].map(m => m.textContent)).toEqual(['Mai20 min agoResolveWe have 14 subsidiaries now.', 'Lee6 min agoThe About page says 13 as well.'])
    expect(buttons(card).map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Resolve', 'More', 'More', 'Reply', 'Send to Tracy↵'])
    // Brian 23:08: the Comments tab row's quick Resolve, on the first message's head row — not a bordered button.
    const resolve = buttons(card)[0]!
    expect(resolve.className).toBe(css.threadResolve)
    expect(resolve.closest(`.${css.threadMessageHead!}`)).not.toBeNull()
    expect(card.querySelector(`.${css.commentFoot!}`)!.textContent).toBe('ReplySend to Tracy↵')
    await act(async () => { resolve.click() })
    expect(mode.resolve).toHaveBeenCalledWith(['c1'])
    expect(buttons(card).slice(3).map(b => b.disabled)).toEqual([true, true])
    expect((card.querySelector('textarea') as HTMLTextAreaElement).placeholder).toBe('Reply…')
    expect(buttons(card).slice(3).map(b => b.title)).toEqual(['Reply', 'Send to Tracy (Enter)'])
  })

  it('⋮ on another person\'s message offers Copy link only; on one\'s own Edit, Delete and Copy link', async () => {
    const mode = threadMode()
    await draw(overlay(mode))
    const [theirs, mine] = [...q('[data-thread="c1"]')!.querySelectorAll('[data-message]')]
    await act(async () => { (theirs!.querySelector('button[aria-label="More"]') as HTMLButtonElement).click() })
    expect(buttons(theirs!.querySelector('[role="menu"]')!).map(b => b.textContent)).toEqual(['Copy link'])
    await act(async () => { (mine!.querySelector('button[aria-label="More"]') as HTMLButtonElement).click() })
    const menu = mine!.querySelector('[role="menu"]')!
    expect(buttons(menu).map(b => b.textContent)).toEqual(['Edit', 'Delete', 'Copy link'])
    await act(async () => { (menu.querySelector('[data-id="edit"]') as HTMLButtonElement).click() })
    expect(mode.editMessage).toHaveBeenCalledWith('c2')
  })

  it('F14 (stage-6 acceptance): ⋮ Copy link says "Link copied" in the toolbar copy button\'s bubble for 1.5 s; a refused copy says so', async () => {
    vi.useFakeTimers()
    const mode = threadMode()
    await draw(overlay(mode))
    const theirs = q('[data-thread="c1"]')!.querySelector('[data-message]')!
    await act(async () => { (theirs.querySelector('button[aria-label="More"]') as HTMLButtonElement).click() })
    await act(async () => { (theirs.querySelector('[data-id="link"]') as HTMLButtonElement).click() })
    await act(async () => { await Promise.resolve() })
    expect(mode.copyLink).toHaveBeenCalledWith('c1')
    const tip = theirs.querySelector('[role="status"]')!
    expect(tip.textContent).toBe('Link copied')
    expect(tip.className).toBe(css.copyLinkTip)
    await act(async () => { vi.advanceTimersByTime(1_500) })
    expect(theirs.querySelector('[role="status"]')).toBeNull()
    vi.mocked(mode.copyLink).mockResolvedValueOnce(false)
    await act(async () => { (theirs.querySelector('button[aria-label="More"]') as HTMLButtonElement).click() })
    await act(async () => { (theirs.querySelector('[data-id="link"]') as HTMLButtonElement).click() })
    await act(async () => { await Promise.resolve() })
    expect(theirs.querySelector('[role="status"]')!.textContent).toBe('Could not copy the link')
    vi.useRealTimers()
  })

  it('F15 (stage-6 acceptance): the ages in an open card move on by themselves (every 30 s)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_790_000_000_000)
    const fresh = comment(5, 'Just said', { createdAt: Date.now() - 10_000 })
    await draw(overlay(threadMode({ thread: fresh, threadMessages: [fresh], rects: new Map([['c5', { x: 32, y: 300, width: 200, height: 40 }]]) })))
    const age = (): string => q('[data-thread="c5"] [data-message]')!.textContent!
    expect(age()).toBe('Leejust nowResolveJust said')
    await act(async () => { vi.advanceTimersByTime(90_000) })
    expect(age()).toBe('Lee1 min agoResolveJust said')
    vi.useRealTimers()
  })

  it('Enter (and ⌘↵ / Ctrl+↵) sends the thread to Tracy; Reply is a click only; Shift+Enter is a new line', async () => {
    const mode = threadMode({ replyText: 'Update it on both pages, please.' })
    await draw(overlay(mode))
    const area = q('[data-thread] textarea')!
    const shift = await press(area, { key: 'Enter', shiftKey: true })
    expect(shift.defaultPrevented).toBe(false)
    expect(mode.sendThread).not.toHaveBeenCalled()
    expect(mode.reply).not.toHaveBeenCalled()
    const enter = await press(area, { key: 'Enter' })
    expect(enter.defaultPrevented).toBe(true)
    expect(mode.sendThread).toHaveBeenCalledTimes(1)
    await press(area, { key: 'Enter', metaKey: true })
    await press(area, { key: 'Enter', ctrlKey: true })
    expect(mode.sendThread).toHaveBeenCalledTimes(3)
    expect(mode.reply).not.toHaveBeenCalled()
    await act(async () => { buttons(q('[data-thread="c1"]')!)[3]!.click() })
    expect(mode.reply).toHaveBeenCalledTimes(1)
  })

  it('Enter while composing, or in an empty reply box, sends nothing', async () => {
    const mode = threadMode({ replyText: 'Cập nhật' })
    await draw(overlay(mode))
    for (const init of COMPOSING) await press(q('[data-thread] textarea')!, init)
    expect(mode.sendThread).not.toHaveBeenCalled()
    const empty = threadMode({ replyText: ' ' })
    await draw(overlay(empty))
    await press(q('[data-thread] textarea')!, { key: 'Enter' })
    expect(empty.sendThread).not.toHaveBeenCalled()
  })

  it('⋮ Delete on one\'s own message: red, with the trash icon (the same as Delete all in the Comments tab)', async () => {
    const mode = threadMode()
    await draw(overlay(mode))
    const mine = [...q('[data-thread="c1"]')!.querySelectorAll('[data-message]')][1]!
    await act(async () => { (mine.querySelector('button[aria-label="More"]') as HTMLButtonElement).click() })
    const del = mine.querySelector('[data-id="delete"]') as HTMLButtonElement
    expect(del.textContent).toBe('Delete')
    expect(del.hasAttribute('data-danger')).toBe(true)
    expect(del.querySelector('[data-icon="trash"]')).not.toBeNull()
    await act(async () => { del.click() })
    expect(mode.deleteComment).toHaveBeenCalledWith('c2')
  })

  it('Esc or a click outside closes it; a click inside does not', async () => {
    const mode = threadMode()
    await draw(overlay(mode))
    await act(async () => { q('[data-thread] textarea')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(mode.closeThread).not.toHaveBeenCalled()
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(mode.closeThread).toHaveBeenCalledTimes(1)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(mode.escape).toHaveBeenCalledWith('parent', expect.anything())
  })

  it('a resolved thread: "Resolved by <name> · a reply reopens it", no Resolve button', async () => {
    const done = { ...root1, status: 'resolved' as const, resolvedAt: 5, resolvedBy: LEE }
    await draw(overlay(threadMode({ thread: done, threadMessages: [done] })))
    const card = q('[data-thread="c1"]')!
    expect(card.textContent).toContain('Resolved by Lee · a reply reopens it')
    expect(buttons(card).map(b => b.textContent)).not.toContain('Resolve')
  })
})

describe('F13 (stage-6 acceptance): the Edit hint fits a 320 px frame', () => {
  function frameOf(width: number): void {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains(css.commentOverlay!) ? width : 0 })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains(css.commentOverlay!) ? 700 : 0 })
  }

  it('wide: the whole sentence on one line; compact: the short one, allowed to wrap, never cut', async () => {
    frameOf(1024)
    await draw(overlay(fixtureMode()))
    expect(q(`.${css.commentHint!}`)!.textContent).toBe('Click anything on the page to edit· Esc for Interactive')
    await act(async () => { root!.unmount() })
    root = null
    frameOf(320)
    await draw(overlay(fixtureMode()))
    const hint = q(`.${css.commentHint!}`)!
    expect(hint.textContent).toBe('Click anything on the page to edit')
    expect(hint.classList.contains(css.commentHintCompact!)).toBe(true)
  })
})

describe('Edit on a page with no picker (TCH e2e v7 ADDR-9, finding 4)', () => {
  it('says it cannot edit there, offers Reload, and never the "Click anything" hint', async () => {
    const reload = vi.fn()
    await draw(overlay(fixtureMode({ modes: { visible: true, edit: true, unavailable: true, selectEdit: vi.fn(), selectInteractive: vi.fn(), reload } })))
    expect(q(`.${css.commentHint!}`)).toBeNull()
    const line = q('[data-comment-unavailable]')!
    expect(line.getAttribute('role')).toBe('status')
    expect(line.textContent).toBe('Editing is not available on this page right now. Reload the page to try again.Reload')
    const button = line.querySelector('button')!
    expect(button.textContent).toBe('Reload')
    await act(async () => { button.click() })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('in Interactive, or with the picker there, the line is not drawn', async () => {
    await draw(overlay(fixtureMode({ modes: { visible: true, edit: false, unavailable: false, selectEdit: vi.fn(), selectInteractive: vi.fn(), reload: vi.fn() } })))
    expect(q('[data-comment-unavailable]')).toBeNull()
    await draw(overlay(fixtureMode()))
    expect(q('[data-comment-unavailable]')).toBeNull()
  })
})

describe('a door that refused says what did not happen', () => {
  it('a refused send reads "Not sent." with the door\'s sentence; a refused write "Not saved."', async () => {
    await draw(overlay(fixtureMode({ serverNotice: 'Ask the owner for a seat.', serverNoticeKind: 'send' })))
    expect(q('[data-comment-notice="server"]')!.textContent).toBe('Not sent. Ask the owner for a seat.')
    await draw(overlay(fixtureMode({ serverNotice: '', serverNoticeKind: 'save' })))
    expect(q('[data-comment-notice="server"]')!.textContent).toBe('Not saved.')
  })
})

describe('runtime 11 holds the page\'s clicks itself: no shield, the wheel reaches the page', () => {
  it('holdable: no shield over the frame; a pick-outside from the page applies the rule (empty → close, typed → flash)', async () => {
    let tell: ((at: { x: number; y: number }) => void) | null = null
    const onPageOutside = vi.fn((fn: (at: { x: number; y: number }) => void) => { tell = fn; return () => { tell = null } })
    const empty = fixtureMode({ holdable: true, onPageOutside, foot: 'new', picked: picked() })
    await draw(overlay(empty))
    expect(q(`.${css.commentShield!}`)).toBeNull()
    await act(async () => { tell!({ x: 1, y: 2 }) })
    expect(empty.close).toHaveBeenCalledTimes(1)
    const typed = fixtureMode({ holdable: true, onPageOutside, foot: 'new', picked: picked(), text: 'words', unsaved: true })
    await draw(overlay(typed))
    await act(async () => { tell!({ x: 1, y: 2 }) })
    expect(typed.close).not.toHaveBeenCalled()
    expect(q('[role="dialog"]')!.classList.contains(css.commentFlash!)).toBe(true)
  })

  it('a runtime-9 page (not holdable) keeps the shield', async () => {
    await draw(overlay(fixtureMode({ holdable: false, foot: 'new', picked: picked() })))
    expect(q(`.${css.commentShield!}`)).not.toBeNull()
  })
})

describe('round 7: ✕ and Esc in the popover are one rule, and the Esc stays in the box (IN4-1, IN4-3)', () => {
  it('✕ asks the controller (which flashes or drops); Esc goes to the controller and no further', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), text: 'abc', unsaved: true })
    await draw(overlay(mode))
    await act(async () => { buttons(q('[role="dialog"]')!)[0]!.click() })
    expect(mode.close).toHaveBeenCalledTimes(1)
    const heard = vi.fn()
    window.addEventListener('keydown', heard)
    try {
      await act(async () => { q('[role="dialog"] textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    } finally {
      window.removeEventListener('keydown', heard)
    }
    expect(mode.escape).toHaveBeenCalledTimes(1)
    expect(heard).not.toHaveBeenCalled()
  })
})

describe('a click outside an open box only closes it (Brian 23:08)', () => {
  const shield = (): HTMLElement | null => q(`.${css.commentShield!}`)
  const onPage = comment(9, 'Another', { author: MAI })
  const pinned = { pageComments: [onPage], rects: new Map([['c9', { x: 40, y: 500, width: 200, height: 40 }]]) }

  it('nothing open: no shield, clicks reach the page and a pin opens its card', async () => {
    const mode = fixtureMode(pinned)
    await draw(overlay(mode))
    expect(shield()).toBeNull()
    await act(async () => { (q('[data-comment-pin="c9"]') as HTMLButtonElement).click() })
    expect(mode.openThread).toHaveBeenCalledWith('c9')
  })

  it('an empty new-place popover: the first click on the page (or a pin) closes it — no pick, no link, no card', async () => {
    const mode = fixtureMode({ ...pinned, foot: 'new', picked: picked() })
    await draw(overlay(mode))
    // The shield covers the frame under the popover: the page never sees that click.
    expect(shield()).not.toBeNull()
    await act(async () => { shield()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(mode.close).toHaveBeenCalledTimes(1)
    await act(async () => { (q('[data-comment-pin="c9"]') as HTMLButtonElement).click() })
    expect(mode.openThread).not.toHaveBeenCalled()
    expect(mode.close).toHaveBeenCalledTimes(2)
  })

  it('a popover with typed words does NOT close: it flashes and keeps the focus', async () => {
    vi.useFakeTimers()
    const mode = fixtureMode({ ...pinned, foot: 'new', picked: picked(), text: 'half a thought', unsaved: true })
    await draw(overlay(mode))
    ;(document.activeElement as HTMLElement | null)?.blur()
    await act(async () => { shield()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(mode.close).not.toHaveBeenCalled()
    // Round 7 (IN4-2): the controller hears it, so the click never counts as a first attempt.
    expect(mode.clickedOutside).toHaveBeenCalledTimes(1)
    expect(q('[role="dialog"]')!.classList.contains(css.commentFlash!)).toBe(true)
    expect(document.activeElement).toBe(q('[role="dialog"] textarea'))
    await act(async () => { (q('[data-comment-pin="c9"]') as HTMLButtonElement).click() })
    expect(mode.openThread).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(q('[role="dialog"]')!.classList.contains(css.commentFlash!)).toBe(false)
    vi.useRealTimers()
  })

  it('the edit popover follows the same rule: its saved words untouched close on the first click (round 4)', async () => {
    const mine = comment(1, 'Say hello')
    const mode = fixtureMode({ foot: 'edit', editing: mine, text: 'Say hello', unsaved: false, pageComments: [mine], rects: new Map([['c1', { x: 40, y: 200, width: 300, height: 40 }]]) })
    await draw(overlay(mode))
    await act(async () => { shield()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(mode.close).toHaveBeenCalledTimes(1)
    const changed = fixtureMode({ foot: 'edit', editing: mine, text: 'Say hello there', unsaved: true, pageComments: [mine], rects: new Map([['c1', { x: 40, y: 200, width: 300, height: 40 }]]) })
    await draw(overlay(changed))
    await act(async () => { shield()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(changed.close).not.toHaveBeenCalled()
  })

  it('a thread card: empty reply closes on the first click; a typed reply flashes and stays', async () => {
    const root1 = comment(1, 'Root', { author: MAI })
    const open = fixtureMode({ ...pinned, thread: root1, threadMessages: [root1] })
    await draw(overlay(open))
    await act(async () => { shield()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(open.closeThread).toHaveBeenCalledTimes(1)
    const typed = fixtureMode({ ...pinned, thread: root1, threadMessages: [root1], replyText: 'and also', unsaved: true })
    await draw(overlay(typed))
    await act(async () => { shield()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(typed.closeThread).not.toHaveBeenCalled()
    expect(q('[data-thread]')!.classList.contains(css.commentFlash!)).toBe(true)
    expect(document.activeElement).toBe(q('[data-thread] textarea'))
  })
})

describe('"Comments N" (ToolbarCommentsButton · …Zero · …Compact, rule 9; UI fine-tune U16)', () => {
  it('one grey button, N = open threads of the page shown, "Comments 0" at zero; no ▾, no menu', async () => {
    const onOpen = vi.fn()
    await draw(createElement(CommentsButton, { comments: [], url: HOME, compact: false, onOpen }))
    const button = q<HTMLButtonElement>('button')!
    expect(button.getAttribute('aria-label')).toBe('Comments, 0')
    expect(button.textContent).toBe('Comments0')
    expect(host.querySelectorAll('button')).toHaveLength(1)
    expect(host.querySelector('[aria-haspopup]')).toBeNull()
    await act(async () => { button.click() })
    expect(onOpen).toHaveBeenCalledTimes(1)
    const others = [comment(1, 'a', { author: MAI, can: { edit: false, delete: false } }), comment(2, 'b', { replyTo: 'c1' }), comment(3, 'c', { url: 'http://northgate.tracy.test:8080/about' }), comment(4, 'd', { status: 'resolved', resolvedAt: 1 })]
    await draw(createElement(CommentsButton, { comments: others, url: HOME, compact: false, onOpen }))
    expect(q('button')!.getAttribute('aria-label')).toBe('Comments, 1')
    // A #hash is the same page; the other page counts its own (U8, U16).
    await draw(createElement(CommentsButton, { comments: others, url: 'http://northgate.tracy.test:8080/about#team', compact: false, onOpen }))
    expect(q('button')!.getAttribute('aria-label')).toBe('Comments, 1')
    await draw(createElement(CommentsButton, { comments: others, url: null, compact: false, onOpen }))
    expect(q('button')!.getAttribute('aria-label')).toBe('Comments, 0')
  })

  it('compact: the icon with the count as a corner badge, the word in the tooltip', async () => {
    await draw(createElement(CommentsButton, { comments: [comment(1, 'a')], url: HOME, compact: true, onOpen: vi.fn() }))
    const button = q<HTMLButtonElement>('button')!
    expect(button.textContent).toBe('1')
    expect(button.title).toBe('Comments')
    expect(q(`.${css.commentsCountCorner!}`)).not.toBeNull()
  })
})

describe('Refresh carries Tracy\'s progress (Refresh*, rule 5)', () => {
  const look = async (value: 'idle' | 'working' | 'working-long' | 'updated' | 'ready'): Promise<HTMLButtonElement> => {
    await draw(createElement(RefreshButton, { look: value, onClick: vi.fn() }))
    return q<HTMLButtonElement>('button')!
  }

  it('working: spins + "Tracy is working"; long: spins, no chip', async () => {
    await look('working')
    expect(q('[role="status"]')!.textContent).toBe('Tracy is working')
    expect(q('svg')!.getAttribute('class')).toBe(css.commentSpin)
    const button = await look('working-long')
    expect(q('[role="status"]')).toBeNull()
    expect(q('svg')!.getAttribute('class')).toBe(css.commentSpin)
    expect(button.getAttribute('aria-label')).toBe('Refresh: Tracy is working')
  })

  it('updated: still, "New version updated"; ready: terracotta, "New version ready"; idle: plain', async () => {
    await look('updated')
    expect(q('[role="status"]')!.textContent).toBe('New version updated')
    expect(q('svg')!.getAttribute('class')).toBeNull()
    const ready = await look('ready')
    expect(q('[role="status"]')!.textContent).toBe('New version ready')
    expect(ready.classList.contains(css.refreshReady!)).toBe(true)
    const idle = await look('idle')
    expect(q('[role="status"]')).toBeNull()
    expect(idle.getAttribute('aria-label')).toBe('Refresh')
  })
})

describe('every new string is translated in every dictionary the sidebar ships', () => {
  const KEYS = ['commentTitle', 'commentAdd', 'commentReply', 'commentResolve', 'commentResolvedBy', 'commentPinLabel', 'refreshWorking', 'refreshUpdated', 'refreshReady', 'editPlaceholder'] as const
  it('not the English fallback, and every placeholder kept', () => {
    const dicts = { zh, ...localeDicts } as Record<string, Record<string, string>>
    expect(Object.keys(dicts).length).toBeGreaterThanOrEqual(20)
    for (const [lang, dict] of Object.entries(dicts)) {
      for (const key of KEYS) {
        const text = dict[key]
        expect(text, `${lang}.${key}`).toBeTruthy()
        expect(text, `${lang}.${key}`).not.toBe(en[key])
        for (const hole of en[key].match(/\{\w+\}/g) ?? []) expect(text, `${lang}.${key}`).toContain(hole)
      }
    }
  })

  it('the stage-5 status words and the ⇧↵ / ⌘↵ tooltips (Brian 29/09 22:40) are gone from every dictionary', () => {
    const dicts = { zh, en, ...localeDicts } as Record<string, Record<string, string>>
    for (const dict of Object.values(dicts)) for (const key of ['commentAddTitle', 'commentSaveTitle', 'commentSendTitle', 'commentSendThreadTitle', 'commentReplyTitle', 'editPinAsked', 'editPinFailed', 'editPinLost', 'editAddAnother', 'editSendMany', 'editDiscardMany', 'editRefusedFull', 'commentsMore', 'commentsOpen']) expect(dict).not.toHaveProperty(key)
  })
})

describe('files in the boxes (attachments contract §B–§D)', () => {
  const ON = { enabled: true, maxBytes: 20 * 1024 * 1024, maxFiles: 20 }
  const png = new File(['PNG'], 'shot.png', { type: 'image/png' })
  const pdf = new File(['x'.repeat(1_240_000)], 'brief.pdf', { type: 'application/pdf' })
  const attach = (scope: Element): HTMLButtonElement | null => scope.querySelector<HTMLButtonElement>('[data-attach]')
  const fileInput = (scope: Element): HTMLInputElement => scope.querySelector<HTMLInputElement>('input[type="file"]')!
  beforeEach(() => {
    let n = 0
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => { n += 1; return `blob:t/${String(n)}` }), revokeObjectURL: vi.fn() }))
  })

  it('the popover has a paperclip before its buttons; the thread card\'s reply box has one too', async () => {
    await draw(overlay(fixtureMode({ foot: 'new', picked: picked(), attachments: ON })))
    const button = attach(q('[role="dialog"]')!)!
    expect(button.getAttribute('aria-label')).toBe('Attach files')
    expect(button.querySelector('[data-icon="paperclip"]')).not.toBeNull()
    expect(fileInput(q('[role="dialog"]')!).multiple).toBe(true)
    const root = comment(1, 'Numbers are off.')
    await draw(overlay(fixtureMode({ thread: root, threadMessages: [root], attachments: ON })))
    expect(attach(q('[data-thread]')!)).not.toBeNull()
  })

  it('hidden when the server keeps no files (attachments.enabled false): no button, no picker, drop and paste do nothing', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), text: 'Words' })
    await draw(overlay(mode))
    const dialog = q('[role="dialog"]')!
    expect(attach(dialog)).toBeNull()
    expect(dialog.querySelector('input[type="file"]')).toBeNull()
    await act(async () => { dialog.dispatchEvent(dropEvent([png])) })
    await act(async () => { q('textarea')!.dispatchEvent(pasteEvent([png])) })
    expect(mode.addFiles).not.toHaveBeenCalled()
    const root = comment(1, 'Numbers are off.')
    await draw(overlay(fixtureMode({ thread: root, threadMessages: [root] })))
    expect(attach(q('[data-thread]')!)).toBeNull()
  })

  it('picking files adds them to the box (the button opens the file picker)', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), attachments: ON })
    await draw(overlay(mode))
    const input = fileInput(q('[role="dialog"]')!)
    const clicked = vi.spyOn(input, 'click')
    await act(async () => { attach(q('[role="dialog"]')!)!.click() })
    expect(clicked).toHaveBeenCalled()
    Object.defineProperty(input, 'files', { value: [png, pdf], configurable: true })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(mode.addFiles).toHaveBeenCalledWith('popover', [png, pdf])
  })

  it('dropping files on the box adds them; pasting an image into the text adds it (text paste stays text)', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), attachments: ON })
    await draw(overlay(mode))
    await act(async () => { q('[role="dialog"]')!.dispatchEvent(dropEvent([pdf])) })
    expect(mode.addFiles).toHaveBeenLastCalledWith('popover', [pdf])
    const paste = pasteEvent([png, pdf])
    await act(async () => { q('textarea')!.dispatchEvent(paste) })
    expect(mode.addFiles).toHaveBeenLastCalledWith('popover', [png])
    expect(paste.defaultPrevented).toBe(true)
    const words = pasteEvent([])
    await act(async () => { q('textarea')!.dispatchEvent(words) })
    expect(mode.addFiles).toHaveBeenCalledTimes(2)
    expect(words.defaultPrevented).toBe(false)
  })

  it('the thread card\'s reply box takes drops and pastes for itself', async () => {
    const root = comment(1, 'Numbers are off.')
    const mode = fixtureMode({ thread: root, threadMessages: [root], attachments: ON })
    await draw(overlay(mode))
    await act(async () => { q('[data-thread]')!.dispatchEvent(dropEvent([pdf])) })
    expect(mode.addFiles).toHaveBeenLastCalledWith('reply', [pdf])
  })

  it('chips under the text: a thumbnail for an image, name and size otherwise, ✕ removes one; a kept file shows its stored thumbnail', async () => {
    const kept = { id: 'att-9', name: 'old.png', size: 2048, type: 'image/png', url: '/api/sites/northgate/comments/attachments/att-9' }
    const mode = fixtureMode({
      foot: 'new',
      picked: picked(),
      attachments: ON,
      draft: [{ kind: 'stored', key: 's:att-9', attachment: kept }, { kind: 'file', key: 'f:1', file: png }, { kind: 'file', key: 'f:2', file: pdf }],
    })
    await draw(overlay(mode))
    const chips = [...host.querySelectorAll('[data-attach-chip]')]
    expect(chips.map(c => c.getAttribute('data-attach-chip'))).toEqual(['s:att-9', 'f:1', 'f:2'])
    expect(chips[0]!.querySelector('img')!.getAttribute('src')).toBe(kept.url)
    expect(chips[1]!.querySelector('img')!.getAttribute('src')).toBe('blob:t/1')
    expect(chips[2]!.querySelector('img')).toBeNull()
    expect(chips[2]!.textContent).toContain('brief.pdf')
    expect(chips[2]!.textContent).toContain('1.2 MB')
    const remove = chips[2]!.querySelector('button')!
    expect(remove.getAttribute('aria-label')).toBe('Remove brief.pdf')
    await act(async () => { remove.click() })
    expect(mode.removeDraft).toHaveBeenCalledWith('popover', 'f:2')
  })

  it('a refused file is said in plain words in its own box', async () => {
    await draw(overlay(fixtureMode({ foot: 'new', picked: picked(), attachments: ON, draftError: { box: 'popover', refusal: { code: 'too-large', name: 'poster.png', limit: 20 * 1024 * 1024 } } })))
    expect(q('[data-attach-error]')!.textContent).toBe('poster.png is too large. Files can be up to 21 MB')
    await draw(overlay(fixtureMode({ foot: 'new', picked: picked(), attachments: ON, draftError: { box: 'popover', refusal: { code: 'too-many', limit: 20 } } })))
    expect(q('[data-attach-error]')!.textContent).toBe('Too many files: up to 20 at once')
    const root = comment(1, 'Numbers are off.')
    await draw(overlay(fixtureMode({ thread: root, threadMessages: [root], attachments: ON, draftError: { box: 'popover', refusal: { code: 'too-many', limit: 20 } } })))
    expect(q('[data-attach-error]')).toBeNull()
  })

  it('a chat that refused the files says so (attachment-too-large · attachment-failed)', async () => {
    await draw(overlay(fixtureMode({ foot: 'new', picked: picked(), text: 'x', notice: 'attachment-too-large' })))
    expect(q(`.${css.commentError!}`)!.textContent).toBe('A file is too large for the chat. Send a smaller one')
    await draw(overlay(fixtureMode({ foot: 'new', picked: picked(), text: 'x', notice: 'attachment-failed' })))
    expect(q(`.${css.commentError!}`)!.textContent).toBe('A file could not be added to the chat. Try again')
  })

  it('the thread card shows each message\'s files: a lazy thumbnail for an image, name and size otherwise; an image opens in a new tab, any other file downloads in place (round 5)', async () => {
    const shot = { id: 'a1', name: 'shot.png', size: 3000, type: 'image/png', url: '/api/sites/northgate/comments/attachments/a1' }
    const doc = { id: 'a2', name: 'brief.pdf', size: 1_240_000, type: 'application/pdf', url: '/api/sites/northgate/comments/attachments/a2' }
    const root = comment(1, 'Numbers are off.', { attachments: [shot] })
    const answer = comment(2, 'Report attached.', { replyTo: 'c1', author: MAI, attachments: [doc] })
    await draw(overlay(fixtureMode({ thread: root, threadMessages: [root, answer] })))
    const [first, second] = [...host.querySelectorAll('[data-message]')]
    const image = first!.querySelector<HTMLAnchorElement>('a[data-attachment="a1"]')!
    expect(image.getAttribute('href')).toBe(shot.url)
    expect(image.target).toBe('_blank')
    expect(image.rel).toContain('noopener')
    const img = image.querySelector('img')!
    expect([img.getAttribute('src'), img.getAttribute('loading'), img.getAttribute('alt')]).toEqual([shot.url, 'lazy', 'shot.png'])
    const file = second!.querySelector<HTMLAnchorElement>('a[data-attachment="a2"]')!
    expect(file.querySelector('img')).toBeNull()
    expect(file.textContent).toContain('brief.pdf')
    expect(file.textContent).toContain('1.2 MB')
    expect([file.getAttribute('href'), file.target, file.getAttribute('download')]).toEqual([doc.url, '', 'brief.pdf'])
    expect(file.getAttribute('aria-label')).toBe('Open brief.pdf')
  })

  describe('a file dragged into the Browser tab while a box is open (Brian, 30/09)', () => {
    /** The Browser tab as BrowserView draws it: a toolbar, then the stage with the layer. */
    const tab = (mode: CommentMode): ReactElement => createElement('div', { 'data-browser-tab': '' },
      createElement('button', { type: 'button', 'data-toolbar': '' }, 'Refresh'),
      createElement('div', { 'data-stage': '' }, overlay(mode)))
    const drag = (type: string, over: { relatedTarget?: EventTarget | null } = {}): Event & { dataTransfer: { dropEffect: string } } => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: { files: [pdf], types: ['Files'], dropEffect: 'copy' } })
      if (over.relatedTarget !== undefined) Object.defineProperty(event, 'relatedTarget', { value: over.relatedTarget })
      return event as Event & { dataTransfer: { dropEffect: string } }
    }

    it('dropped on the toolbar it is caught and ignored: never opened by the browser, never attached', async () => {
      const mode = fixtureMode({ foot: 'new', picked: picked(), attachments: ON })
      await draw(tab(mode))
      const toolbar = q('[data-toolbar]')!
      const over = drag('dragover')
      await act(async () => { toolbar.dispatchEvent(over) })
      expect([over.defaultPrevented, over.dataTransfer.dropEffect]).toEqual([true, 'none'])
      const drop = drag('drop')
      await act(async () => { toolbar.dispatchEvent(drop) })
      expect(drop.defaultPrevented).toBe(true)
      expect(mode.addFiles).not.toHaveBeenCalled()
    })

    it('over the page frame a catcher stands for the length of the drag, and a drop on it is ignored', async () => {
      const mode = fixtureMode({ foot: 'new', picked: picked(), attachments: ON, holdable: true })
      await draw(tab(mode))
      expect(q('[data-comment-dropcatch]')).toBeNull()
      await act(async () => { q('[data-toolbar]')!.dispatchEvent(drag('dragenter')) })
      const catcher = q('[data-comment-dropcatch]')!
      expect(catcher).not.toBeNull()
      const drop = drag('drop')
      await act(async () => { catcher.dispatchEvent(drop) })
      expect(drop.defaultPrevented).toBe(true)
      expect(mode.addFiles).not.toHaveBeenCalled()
      expect(q('[data-comment-dropcatch]')).toBeNull()
      // Leaving the tab ends it too.
      await act(async () => { q('[data-toolbar]')!.dispatchEvent(drag('dragenter')) })
      await act(async () => { q('[data-toolbar]')!.dispatchEvent(drag('dragleave', { relatedTarget: null })) })
      expect(q('[data-comment-dropcatch]')).toBeNull()
    })

    it('with the server keeping no files, a drop on the box itself is ignored too', async () => {
      const mode = fixtureMode({ foot: 'new', picked: picked() })
      await draw(tab(mode))
      const drop = drag('drop')
      await act(async () => { q('[role="dialog"]')!.dispatchEvent(drop) })
      expect(drop.defaultPrevented).toBe(true)
      expect(mode.addFiles).not.toHaveBeenCalled()
    })

    it('no box open: the tab leaves drags alone', async () => {
      await draw(tab(fixtureMode({ attachments: ON })))
      const over = drag('dragover')
      await act(async () => { q('[data-toolbar]')!.dispatchEvent(over) })
      expect(over.defaultPrevented).toBe(false)
      await act(async () => { q('[data-toolbar]')!.dispatchEvent(drag('dragenter')) })
      expect(q('[data-comment-dropcatch]')).toBeNull()
    })

    it('the box lights up while files are dragged over it, and not after they leave or drop', async () => {
      const mode = fixtureMode({ foot: 'new', picked: picked(), attachments: ON })
      await draw(tab(mode))
      const dialog = q('[role="dialog"]')!
      await act(async () => { dialog.dispatchEvent(drag('dragenter')) })
      expect([dialog.getAttribute('data-drop'), dialog.classList.contains(css.commentDropOn!)]).toEqual(['on', true])
      // Into a child of the box: still on.
      await act(async () => { q('textarea')!.dispatchEvent(drag('dragenter')) })
      await act(async () => { dialog.dispatchEvent(drag('dragleave')) })
      expect(dialog.getAttribute('data-drop')).toBe('on')
      await act(async () => { q('textarea')!.dispatchEvent(drag('dragleave')) })
      expect(dialog.getAttribute('data-drop')).toBeNull()
      await act(async () => { dialog.dispatchEvent(drag('dragenter')) })
      const drop = drag('drop')
      await act(async () => { dialog.dispatchEvent(drop) })
      expect(dialog.getAttribute('data-drop')).toBeNull()
      expect(mode.addFiles).toHaveBeenCalledWith('popover', [pdf])
    })

    it('the thread card lights up the same way', async () => {
      const root = comment(1, 'Numbers are off.')
      await draw(tab(fixtureMode({ thread: root, threadMessages: [root], attachments: ON })))
      const card = q('[data-thread]')!
      await act(async () => { card.dispatchEvent(drag('dragenter')) })
      expect(card.getAttribute('data-drop')).toBe('on')
    })

    // Round 11 (acceptance v5 V5-2): dsh's chat box listens for file drops on the whole document
    // (`ui-attachment` drop-events.ts) and takes every one that reaches it, prevented or not.
    describe('a file dropped in a comment box never reaches dsh\'s chat box (V5-2)', () => {
      const KINDS = ['dragenter', 'dragover', 'dragleave', 'drop'] as const
      const heard: string[] = []
      const listen = (event: Event): void => { heard.push(event.type) }
      beforeEach(() => {
        heard.length = 0
        for (const kind of KINDS) document.addEventListener(kind, listen)
      })
      afterEach(() => { for (const kind of KINDS) document.removeEventListener(kind, listen) })
      const boxes: Array<[string, () => CommentMode, string]> = [
        ['the popover', () => fixtureMode({ foot: 'new', picked: picked(), attachments: ON }), '[role="dialog"]'],
        ['the thread card', () => { const root = comment(1, 'Numbers are off.'); return fixtureMode({ thread: root, threadMessages: [root], attachments: ON }) }, '[data-thread]'],
        ['the popover of a server keeping no files', () => fixtureMode({ foot: 'new', picked: picked() }), '[role="dialog"]'],
      ]
      for (const [name, make, selector] of boxes) {
        it(`${name}: no drag event of a file stops at the document; the box still takes what it takes`, async () => {
          const mode = make()
          await draw(tab(mode))
          const box = q(selector)!
          const drop = drag('drop')
          for (const kind of ['dragenter', 'dragover', 'dragleave'] as const) await act(async () => { box.dispatchEvent(drag(kind)) })
          await act(async () => { q(`${selector} textarea`)!.dispatchEvent(drop) })
          expect(heard).toEqual([])
          expect(drop.defaultPrevented).toBe(true)
          if (mode.attachments.enabled) expect(mode.addFiles).toHaveBeenCalledWith(selector === '[data-thread]' ? 'reply' : 'popover', [pdf])
          else expect(mode.addFiles).not.toHaveBeenCalled()
        })
      }
      it('a drop outside every box keeps today\'s rule: caught by the tab, and the document still hears it', async () => {
        await draw(tab(fixtureMode({ foot: 'new', picked: picked(), attachments: ON })))
        const drop = drag('drop')
        await act(async () => { q('[data-toolbar]')!.dispatchEvent(drop) })
        expect(drop.defaultPrevented).toBe(true)
        expect(heard).toEqual(['drop'])
      })
      it('a drag with no file (words, a link) is left alone', async () => {
        await draw(tab(fixtureMode({ foot: 'new', picked: picked(), attachments: ON })))
        const words = new Event('drop', { bubbles: true, cancelable: true })
        Object.defineProperty(words, 'dataTransfer', { value: { files: [], types: ['text/plain'], dropEffect: 'copy' } })
        await act(async () => { q('[role="dialog"]')!.dispatchEvent(words) })
        expect(heard).toEqual(['drop'])
      })
    })
  })

  it('Enter rules unchanged with files in the box: Enter sends to Tracy, Shift+Enter is a new line, ⇧⌘↵ is bound to nothing', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), text: 'Words', attachments: ON, draft: [{ kind: 'file', key: 'f:1', file: png }] })
    await draw(overlay(mode))
    const area = q('textarea')!
    await press(area, { key: 'Enter', shiftKey: true })
    await press(area, { key: 'Enter', metaKey: true, shiftKey: true })
    expect(mode.addComment).not.toHaveBeenCalled()
    expect(mode.sendToTracy).not.toHaveBeenCalled()
    await press(area, { key: 'Enter' })
    expect(mode.sendToTracy).toHaveBeenCalledTimes(1)
    expect(mode.addComment).not.toHaveBeenCalled()
  })
})

function dropEvent(files: File[]): Event {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files, types: ['Files'] } })
  return event
}

function pasteEvent(files: File[]): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files, types: files.length > 0 ? ['Files'] : ['text/plain'] } })
  return event
}

describe('a box that refused to drop its words flashes (round 4: Esc, Interactive, a navigation)', () => {
  it('each bump of mode.flash flashes the popover and puts the focus back in its text', async () => {
    vi.useFakeTimers()
    const base = { foot: 'new' as const, picked: picked(), text: 'Draft', unsaved: true }
    await draw(overlay(fixtureMode({ ...base, flash: 0 })))
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(q('[role="dialog"]')!.classList.contains(css.commentFlash!)).toBe(false)
    await draw(overlay(fixtureMode({ ...base, flash: 1 })))
    expect(q('[role="dialog"]')!.classList.contains(css.commentFlash!)).toBe(true)
    expect(document.activeElement).toBe(q('[role="dialog"] textarea'))
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(q('[role="dialog"]')!.classList.contains(css.commentFlash!)).toBe(false)
    vi.useRealTimers()
  })

  it('the thread card flashes too', async () => {
    const root1 = comment(1, 'Root', { author: MAI })
    const base = { thread: root1, threadMessages: [root1], replyText: 'and also', unsaved: true }
    await draw(overlay(fixtureMode({ ...base, flash: 0 })))
    await draw(overlay(fixtureMode({ ...base, flash: 1 })))
    expect(q('[data-thread]')!.classList.contains(css.commentFlash!)).toBe(true)
  })
})

describe('the wheel over a box scrolls the page (round 4, item 8)', () => {
  const wheel = async (el: Element, init: WheelEventInit): Promise<WheelEvent> => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
    await act(async () => { el.dispatchEvent(event) })
    return event
  }
  /** Give a box a scroll state jsdom does not compute. */
  const scrollState = (el: HTMLElement, s: { top: number; client: number; height: number }): void => {
    el.style.overflowY = 'auto'
    Object.defineProperty(el, 'scrollTop', { value: s.top, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: s.client, configurable: true })
    Object.defineProperty(el, 'scrollHeight', { value: s.height, configurable: true })
  }

  it('over the popover: the page scrolls by the wheel, in the page\'s pixels (the tab\'s zoom taken out); the tab does not', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked() })
    await draw(createElement(CommentOverlay, { mode, zoom: 150 }))
    const event = await wheel(q('[role="dialog"] textarea')!, { deltaY: 120 })
    // Round 10: no id — the page scrolls the box the open pick sits in (`pick-wheel`, runtime 16).
    expect(mode.wheelPage).toHaveBeenCalledWith(0, 80, null)
    expect(event.defaultPrevented).toBe(true)
  })

  it('lines and pages are turned into pixels', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked() })
    await draw(overlay(mode))
    await wheel(q('[role="dialog"]')!, { deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE })
    expect(mode.wheelPage).toHaveBeenLastCalledWith(0, 48, null)
  })

  it('a text box that can still scroll that way scrolls first; at its end the page takes the wheel', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), text: 'many lines' })
    await draw(overlay(mode))
    const box = q<HTMLTextAreaElement>('[role="dialog"] textarea')!
    scrollState(box, { top: 0, client: 200, height: 400 })
    const inside = await wheel(box, { deltaY: 100 })
    expect(mode.wheelPage).not.toHaveBeenCalled()
    expect(inside.defaultPrevented).toBe(false)
    await wheel(box, { deltaY: -100 })
    expect(mode.wheelPage).toHaveBeenCalledWith(0, -100, null)
    scrollState(box, { top: 200, client: 200, height: 400 })
    await wheel(box, { deltaY: 100 })
    expect(mode.wheelPage).toHaveBeenLastCalledWith(0, 100, null)
  })

  it('over the thread card too', async () => {
    const root1 = comment(1, 'Root', { author: MAI })
    const mode = fixtureMode({ thread: root1, threadMessages: [root1] })
    await draw(overlay(mode))
    await wheel(q('[data-thread]')!, { deltaY: 50 })
    expect(mode.wheelPage).toHaveBeenCalledWith(0, 50, root1.id)
  })

  it('round 10: over a pin too — the page scrolls, for the box its element sits in (acceptance v5 PICK-new-9)', async () => {
    const c = comment(7, 'Hello', { author: MAI })
    const mode = fixtureMode({ pageComments: [c], rects: new Map([['c7', { x: 40, y: 200, width: 300, height: 40 }]]) })
    await draw(createElement(CommentOverlay, { mode, zoom: 200 }))
    const event = await wheel(q('[data-comment-pin="c7"]')!, { deltaY: 100 })
    expect(mode.wheelPage).toHaveBeenCalledWith(0, 50, 'c7')
    expect(event.defaultPrevented).toBe(true)
    // A pinch is the browser's.
    await wheel(q('[data-comment-pin="c7"]')!, { deltaY: 100, ctrlKey: true })
    expect(mode.wheelPage).toHaveBeenCalledTimes(1)
  })
})


describe('round 5 (acceptance v3)', () => {
  const SAM_A = { accountId: 'a3', email: 'e2e3-thread-a@example.test', name: 'Sam Tester', initial: 'S' }
  const SAM_B = { accountId: 'a4', email: 'e2e3-thread-b@example.test', name: 'Sam Tester', initial: 'S' }
  const R = { x: 40, y: 300, width: 300, height: 40 }

  it('TH-2: a box a failed save gave back says why, in its own box', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked(), text: 'Words', saveError: { box: 'popover', key: 'commentErrTooLong', params: { max: 4000 } } })
    await draw(overlay(mode))
    expect(q('[data-save-error]')!.textContent).toBe('Too long to save. Keep it to 4000 characters or fewer.')
    const c = comment(1, 'Root')
    await draw(overlay(fixtureMode({ thread: c, threadMessages: [c], replyText: 'x', saveError: { box: 'reply', key: 'commentErrUnknown' } })))
    expect(q('[data-save-error]')!.textContent).toBe('Could not save. Your words are kept. Try again.')
  })

  it('TH-2: a count near the limit; over it Add comment, Send to Tracy, Save and Reply are disabled and Enter does nothing', async () => {
    const near = fixtureMode({ foot: 'new', picked: picked(), text: 'x'.repeat(3700), maxChars: 4000 })
    await draw(overlay(near))
    expect(q('[data-char-count]')!.textContent).toBe('3700 / 4000')
    expect(q('[data-char-count]')!.hasAttribute('data-over')).toBe(false)
    const over = fixtureMode({ foot: 'new', picked: picked(), text: 'x'.repeat(4001), maxChars: 4000 })
    await draw(overlay(over))
    expect(q('[data-char-count]')!.hasAttribute('data-over')).toBe(true)
    for (const b of qa('[data-comment-box] .' + css.commentFootEnd + ' button')) expect((b as HTMLButtonElement).disabled).toBe(true)
    await press(q('textarea')!, { key: 'Enter' })
    expect(over.sendToTracy).not.toHaveBeenCalled()
    const short = fixtureMode({ foot: 'new', picked: picked(), text: 'short', maxChars: 4000 })
    await draw(overlay(short))
    expect(q('[data-char-count]')).toBeNull()
    const c = comment(1, 'Root')
    const card = fixtureMode({ thread: c, threadMessages: [c], replyText: 'x'.repeat(4001), maxChars: 4000 })
    await draw(overlay(card))
    for (const b of qa('[data-thread] .' + css.commentFootEnd + ' button')) expect((b as HTMLButtonElement).disabled).toBe(true)
  })

  it('TH-2: a refused Resolve or Delete says it in plain words over the page', async () => {
    await draw(overlay(fixtureMode({ serverError: { key: 'commentErrSignedOut' } })))
    expect(q('[data-comment-notice="server"]')!.textContent).toBe('You are signed out. Sign in again, then try again.')
  })

  it('TH-4: a deleted first message reads "Comment deleted", muted, with its replies under it and Resolve still there', async () => {
    const tomb = comment(1, '', { removed: true, can: { edit: false, delete: false } })
    const reply = comment(2, 'Seconded', { replyTo: 'c1', author: MAI, can: { edit: false, delete: false } })
    await draw(overlay(fixtureMode({ thread: tomb, threadMessages: [tomb, reply], pageComments: [tomb], rects: new Map([['c1', R]]) })))
    const first = q('[data-message="c1"]')!
    expect(first.querySelector('[data-tombstone]')!.textContent).toBe('Comment deleted')
    expect(first.querySelector('[data-tombstone]')!.classList.contains(css.threadTombstone!)).toBe(true)
    expect(q('[data-message="c2"]')!.textContent).toContain('Seconded')
    expect(first.querySelector('.' + css.threadResolve)).not.toBeNull()
    expect(q('[data-comment-pin="c1"]')).not.toBeNull()
  })

  it('TH-5: the messages scroll inside the card; the reply box and its buttons stay after the list', async () => {
    const root = comment(1, 'Root')
    const replies = Array.from({ length: 22 }, (_, i) => comment(i + 2, `Reply ${String(i)}`, { replyTo: 'c1' }))
    await draw(overlay(fixtureMode({ thread: root, threadMessages: [root, ...replies], rects: new Map([['c1', R]]) })))
    const list = q('[data-thread-list]')!
    expect(list.classList.contains(css.threadList!)).toBe(true)
    expect(list.querySelectorAll('[data-message]')).toHaveLength(23)
    const card = q('[data-thread]')!
    const kids = Array.from(card.children)
    expect(kids.indexOf(list)).toBeLessThan(kids.indexOf(card.querySelector('textarea')!))
    expect(card.querySelector('textarea')!.closest('[data-thread-list]')).toBeNull()
  })

  it('TH-6: two people of one name read "Name (email before @)" in the card, the pin\'s tooltip and "Resolved by"; each has their own colour', async () => {
    const a = comment(1, 'From A', { author: SAM_A })
    const b = comment(2, 'From B', { author: SAM_B, replyTo: 'c1', can: { edit: false, delete: false } })
    const done = comment(3, 'Done', { author: SAM_A, status: 'resolved', resolvedAt: 5, resolvedBy: SAM_B })
    await draw(overlay(fixtureMode({ comments: [a, b, done], thread: done, threadMessages: [done], pageComments: [a, done], rects: new Map([['c1', R], ['c3', { ...R, y: 500 }]]) })))
    expect(q('[data-message="c3"] .' + css.threadAuthor)!.textContent).toBe('Sam Tester (e2e3-thread-a)')
    expect(q('.' + css.threadResolved)!.textContent).toContain('Sam Tester (e2e3-thread-b)')
    expect(q('[data-comment-pin="c1"]')!.getAttribute('title')).toBe('Sam Tester (e2e3-thread-a)')
    expect((q('[data-comment-pin="c1"]') as HTMLElement).style.background).not.toBe('')
    expect(authorColor(SAM_A)).not.toBe(authorColor(SAM_B))
  })

  it('TH-8: "Deleted · Undo (10)" is one line; the author ellipsizes and the time never wraps', () => {
    const rule = (name: string): string => cssText.match(new RegExp(`\\.${name} \\{[^}]*\\}`))?.[0] ?? ''
    expect(rule('threadDeleted')).toMatch(/white-space: nowrap/)
    // `.threadMessage` (a column) is declared after `.threadDeleted`: the notice needs the two-class rule to stay a row.
    expect(cssText).toMatch(/\.threadMessage\.threadDeleted \{[^}]*flex-direction: row/)
    expect(rule('threadAge')).toMatch(/white-space: nowrap/)
    expect(rule('threadAuthor')).toMatch(/text-overflow: ellipsis/)
  })

  it('SEND-new-1: two pins on one element fan out, so the lower one can be clicked', async () => {
    const a = comment(1, 'One')
    const b = comment(2, 'Two', { author: MAI })
    await draw(overlay(fixtureMode({ pageComments: [a, b], rects: new Map([['c1', R], ['c2', R]]) })))
    const left = (id: string): number => Number.parseFloat((q(`[data-comment-pin="${id}"]`) as HTMLElement).style.left)
    expect(left('c2') - left('c1')).toBe(PIN_FAN_PX)
    expect(PIN_FAN_PX).toBeGreaterThanOrEqual(10)
  })

  it('A07: a file that is not an image downloads in place; an image still opens in a new tab', async () => {
    const files = [
      { id: 'f1', name: 'brief.pdf', size: 10, type: 'application/pdf', url: '/api/sites/k/comments/attachments/f1' },
      { id: 'f2', name: 'shot.png', size: 10, type: 'image/png', url: '/api/sites/k/comments/attachments/f2' },
    ]
    const c = comment(1, 'With files', { attachments: files })
    await draw(overlay(fixtureMode({ thread: c, threadMessages: [c], rects: new Map([['c1', R]]) })))
    const pdf = q('[data-attachment="f1"]') as HTMLAnchorElement
    expect(pdf.getAttribute('download')).toBe('brief.pdf')
    expect(pdf.hasAttribute('target')).toBe(false)
    const png = q('[data-attachment="f2"]') as HTMLAnchorElement
    expect(png.getAttribute('target')).toBe('_blank')
    expect(png.hasAttribute('download')).toBe(false)
  })
})

describe('round 5: a box by an element the page no longer shows waits at the frame corner (acceptance v3 B04, J06, J38)', () => {
  it('the popover of a pick hidden since it opened waits at the top corner with its words; covered, it stays by the block', async () => {
    const pick = picked({ x: 40, y: 300, width: 380, height: 40 })
    await draw(overlay(fixtureMode({ foot: 'new', picked: pick, text: 'Draft' })))
    const byBlock = (q('[data-comment-box]') as HTMLElement).style.top
    await draw(overlay(fixtureMode({ doc: 2, foot: 'new', picked: { ...pick, target: { ...pick.target, hidden: 'clipped' } }, text: 'Draft' })))
    const box = q('[data-comment-box]') as HTMLElement
    // A new document where the element was never seen: the corner an edit popover of a comment the
    // page cannot find takes (anchor 14, 4).
    expect([box.style.left, box.style.top]).toEqual(['8px', '20px'])
    expect(box.style.visibility).toBe('')
    expect((box.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Draft')
    await draw(overlay(fixtureMode({ doc: 2, foot: 'new', picked: { ...pick, target: { ...pick.target, hidden: 'covered' } }, text: 'Draft' })))
    expect((q('[data-comment-box]') as HTMLElement).style.top).toBe(byBlock)
  })

  it('the thread card of a clipped block opens at the frame corner (from the Comments tab too)', async () => {
    const c = comment(1, 'Row five')
    await draw(overlay(fixtureMode({ thread: c, threadMessages: [c], pageComments: [c], rects: new Map([['c1', { x: 40, y: 300, width: 300, height: 40, hidden: 'clipped' as const }]]) })))
    // The corner a whole-page comment's card takes.
    expect((q('[data-thread="c1"]') as HTMLElement).style.top).toBe('14px')
  })
})

describe('round 8 (acceptance v5 JS-v5-new-1, J38): a box whose element hides stays where it was, and says so', () => {
  const NEWS = { x: 40, y: 300, width: 200, height: 30 }
  const newsPick = (hidden?: 'clipped'): ReturnType<typeof picked> => {
    const pick = picked(hidden === undefined ? NEWS : { x: 0, y: 0, width: 0, height: 0 })
    return { ...pick, target: { ...pick.target, text: 'Newsletter', ...(hidden === undefined ? {} : { hidden }) } }
  }

  it('a hover menu closes while the pointer travels to the popover: the popover stays put, its head names the element', async () => {
    await draw(overlay(fixtureMode({ foot: 'new', picked: newsPick() })))
    const box = (): HTMLElement => q('[data-comment-box]') as HTMLElement
    const at = [box().style.left, box().style.top]
    expect(q('[data-hidden-note]')).toBeNull()
    await draw(overlay(fixtureMode({ foot: 'new', picked: newsPick('clipped') })))
    expect([box().style.left, box().style.top]).toEqual(at)
    expect(q('[data-hidden-note]')!.textContent).toBe('Newsletter (hidden now)')
    // Shown again: by the element, no note.
    await draw(overlay(fixtureMode({ foot: 'new', picked: newsPick() })))
    expect(q('[data-hidden-note]')).toBeNull()
  })

  it('verify6 L2: a long name is what the head shortens; the "(hidden now)" suffix always shows whole', async () => {
    const long = 'Newsletter Digest email template with a much longer label than the head can hold'
    const pick = newsPick('clipped')
    await draw(overlay(fixtureMode({ foot: 'new', picked: { ...pick, target: { ...pick.target, text: long } } })))
    const note = q('[data-hidden-note]') as HTMLElement
    const name = note.querySelector('[data-hidden-note-name]') as HTMLElement
    const suffix = note.querySelector('[data-hidden-note-suffix]') as HTMLElement
    // The name alone carries the ellipsis; the suffix is its own piece that never shrinks.
    expect(name.textContent).toBe(note.title.replace(/ \(hidden now\)$/, ''))
    expect(suffix.textContent).toBe(' (hidden now)')
    expect(note.textContent).toBe(note.title)
    expect(name.className).not.toBe(suffix.className)
  })

  it('the thread card and the edit popover keep their place the same way', async () => {
    const c = comment(1, 'Row five', { element: { ...comment(1, '').element!, text: 'Row five link' } })
    const rects = (hidden?: 'clipped') => new Map([['c1', hidden === undefined ? NEWS : { x: 0, y: -600, width: 0, height: 0, hidden }]])
    await draw(overlay(fixtureMode({ thread: c, threadMessages: [c], pageComments: [c], rects: rects() })))
    const top = (q('[data-thread="c1"]') as HTMLElement).style.top
    await draw(overlay(fixtureMode({ thread: c, threadMessages: [c], pageComments: [c], rects: rects('clipped') })))
    expect((q('[data-thread="c1"]') as HTMLElement).style.top).toBe(top)
    expect(q('[data-hidden-note]')!.textContent).toBe('Row five link (hidden now)')
    await draw(overlay(fixtureMode({ foot: 'edit', editing: c, text: 'Row five', pageComments: [c], rects: rects() })))
    const edit = (q('[data-comment-box]') as HTMLElement).style.top
    await draw(overlay(fixtureMode({ foot: 'edit', editing: c, text: 'Row five', pageComments: [c], rects: rects('clipped') })))
    expect((q('[data-comment-box]') as HTMLElement).style.top).toBe(edit)
  })

  it('a click the page reports where the popover stands (or stood a moment ago) is not a click outside: the box keeps the focus', async () => {
    let tell: ((at: { x: number; y: number }) => void) | null = null
    const onPageOutside = vi.fn((fn: (at: { x: number; y: number }) => void) => { tell = fn; return () => { tell = null } })
    const mode = fixtureMode({ holdable: true, onPageOutside, foot: 'new', picked: newsPick() })
    await draw(overlay(mode))
    const box = q('[data-comment-box]') as HTMLElement
    const x = Number.parseFloat(box.style.left) + 20
    const y = Number.parseFloat(box.style.top) + 20
    ;(document.activeElement as HTMLElement | null)?.blur()
    await act(async () => { tell!({ x, y }) })
    expect(mode.close).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(box.querySelector('textarea'))
    await act(async () => { tell!({ x: 1000, y: 700 }) })
    expect(mode.close).toHaveBeenCalledTimes(1)
  })

  it('pick-refocus from the page frame puts the focus back in the open box; from anyone else it does nothing', async () => {
    await draw(createElement('div', null, createElement('iframe', { title: 'page' }), overlay(fixtureMode({ holdable: true, foot: 'new', picked: newsPick() }))))
    const frame = host.querySelector('iframe')!
    const area = q('[data-comment-box] textarea') as HTMLTextAreaElement
    const refocus = (source: MessageEventSource | null) =>
      act(async () => { window.dispatchEvent(new MessageEvent('message', { data: { channel: 'tracy-preview', v: 1, kind: 'pick-refocus' }, origin: 'https://site.test', source })) })
    area.blur()
    await refocus(window)
    expect(document.activeElement).not.toBe(area)
    await refocus(frame.contentWindow)
    expect(document.activeElement).toBe(area)
  })
})

describe('round 5 (acceptance v3 J38): Interactive | Edit never takes the focus out of the page', () => {
  it('a press on either button keeps the focus where it is (a WordPress mobile menu closes when the page loses it); the click still switches', async () => {
    const selectEdit = vi.fn()
    const selectInteractive = vi.fn()
    await draw(createElement(ModeBar, { zoom: 100, onZoom: vi.fn(), modes: { visible: true, edit: false, unavailable: false, selectEdit, selectInteractive, reload: vi.fn() }, hideZoom: true }))
    for (const button of [...host.querySelectorAll('[role="group"] button')] as HTMLButtonElement[]) {
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      button.dispatchEvent(down)
      expect(down.defaultPrevented).toBe(true)
      await act(async () => { button.click() })
    }
    expect(selectInteractive).toHaveBeenCalledTimes(1)
    expect(selectEdit).toHaveBeenCalledTimes(1)
  })
})

describe('round 5 (runtime 14 lockstep): the layer answers pick-drawn once it has drawn a step', () => {
  it('a pick-step from the page frame is answered after the commit, to that frame and origin only', async () => {
    const mode = fixtureMode({ foot: 'new', picked: picked({ x: 40, y: 300, width: 380, height: 40 }) })
    await draw(createElement('div', null, createElement('iframe', { title: 'page' }), overlay(mode)))
    const frame = host.querySelector('iframe')!
    const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
    const step = (n: unknown, source: MessageEventSource | null = frame.contentWindow) =>
      act(async () => { window.dispatchEvent(new MessageEvent('message', { data: { channel: 'tracy-preview', v: 1, kind: 'pick-step', step: n }, origin: 'https://site.test', source })) })
    await step(3)
    expect(post).toHaveBeenCalledWith({ channel: 'tracy-preview', v: 1, kind: 'pick-drawn', step: 3 }, 'https://site.test')
    post.mockClear()
    await step(4, window)
    await step('x')
    expect(post).not.toHaveBeenCalled()
  })
})


describe('round 6: the thread card (acceptance v4 thread)', () => {
  const R6 = { x: 40, y: 300, width: 300, height: 40 }
  const longThread = (): { root: ReturnType<typeof comment>; replies: Array<ReturnType<typeof comment>> } => ({
    root: comment(1, 'Root'),
    replies: Array.from({ length: 9 }, (_, i) => comment(i + 2, `Reply ${String(i)}`, { replyTo: 'c1' })),
  })
  /** jsdom lays nothing out: each message sits 50 px under the one before, the list is 2000 px tall. */
  const layout = (): void => {
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      const id = this.getAttribute('data-message')
      return id === null ? 0 : Number(id.slice(1)) * 50
    })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-thread-list') ? 2000 : 0
    })
  }

  it('a link to a reply (`threadFocus`) opens the card AT that reply, highlighted — not at the newest', async () => {
    layout()
    const { root, replies } = longThread()
    await draw(overlay(fixtureMode({ thread: root, threadMessages: [root, ...replies], threadFocus: 'c3', rects: new Map([['c1', R6]]) })))
    const list = q('[data-thread-list]')!
    expect(list.scrollTop).toBe(3 * 50 - 8)
    expect(q('[data-message="c3"]')!.hasAttribute('data-focus')).toBe(true)
    expect(q('[data-message="c3"]')!.classList.contains(css.threadFocus!)).toBe(true)
    expect(qa('[data-focus]')).toHaveLength(1)
  })

  it('without a focus the card opens at the newest, as before (TH-5)', async () => {
    layout()
    const { root, replies } = longThread()
    await draw(overlay(fixtureMode({ thread: root, threadMessages: [root, ...replies], rects: new Map([['c1', R6]]) })))
    expect(q('[data-thread-list]')!.scrollTop).toBe(2000)
    expect(qa('[data-focus]')).toHaveLength(0)
  })

  it('my own reply sent while the list is scrolled up: the list goes down to show it', async () => {
    layout()
    const { root, replies } = longThread()
    const before = fixtureMode({ thread: root, threadMessages: [root, ...replies], ownReplies: 0, rects: new Map([['c1', R6]]) })
    await draw(overlay(before))
    const list = q('[data-thread-list]')!
    list.scrollTop = 100
    await act(async () => { list.dispatchEvent(new Event('scroll')) })
    const mine = comment(20, 'My new reply', { replyTo: 'c1' })
    await draw(overlay(fixtureMode({ ...before, threadMessages: [root, ...replies, mine], ownReplies: 1 })))
    expect(q('[data-thread-list]')!.scrollTop).toBe(2000)
  })

  it('someone else\'s reply arriving while scrolled up does not move the list', async () => {
    layout()
    const { root, replies } = longThread()
    const before = fixtureMode({ thread: root, threadMessages: [root, ...replies], ownReplies: 0, rects: new Map([['c1', R6]]) })
    await draw(overlay(before))
    const list = q('[data-thread-list]')!
    list.scrollTop = 100
    await act(async () => { list.dispatchEvent(new Event('scroll')) })
    const theirs = comment(20, 'Their reply', { replyTo: 'c1', author: MAI })
    await draw(overlay(fixtureMode({ ...before, threadMessages: [root, ...replies, theirs] })))
    expect(q('[data-thread-list]')!.scrollTop).toBe(100)
  })

  // Round 11 (acceptance v5 V5-1): a card opened from a link, or from a tab row while the page still
  // scrolls to the element, is first drawn uncapped (683 px of list) and only then capped beside its
  // element (251 px). A browser keeps `scrollTop` where it was clamped, so the list stood mid-thread.
  describe('the list keeps its aim through every change of the card\'s size until the person scrolls (V5-1)', () => {
    const TALL = 683
    const CAPPED = 251
    /** A browser's list: each message 50 px under the one before, 2000 px in all, `scrollTop` clamped to what fits. */
    const browser = (): { resize: () => void } => {
      layout()
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
        if (!this.hasAttribute('data-thread-list')) return 0
        return this.closest<HTMLElement>('[data-thread]')?.style.maxHeight ? CAPPED : TALL
      })
      const tops = new WeakMap<Element, number>()
      vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) { return tops.get(this) ?? 0 })
      vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, value: number) {
        tops.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)))
      })
      let observe: (() => void) | null = null
      vi.stubGlobal('ResizeObserver', class {
        constructor(fn: () => void) { observe = fn }
        observe(): void {}
        disconnect(): void { observe = null }
      })
      return { resize: () => { observe?.() } }
    }
    afterEach(() => { vi.unstubAllGlobals() })

    it('opened before its element\'s place is known, then capped beside it: at the newest', async () => {
      browser()
      const { root, replies } = longThread()
      const before = fixtureMode({ thread: root, threadMessages: [root, ...replies] })
      await draw(overlay(before))
      expect(q('[data-thread-list]')!.scrollTop).toBe(2000 - TALL)
      await draw(overlay(fixtureMode({ ...before, rects: new Map([['c1', R6]]) })))
      expect(q<HTMLElement>('[data-thread]')!.style.maxHeight).not.toBe('')
      expect(q('[data-thread-list]')!.scrollTop).toBe(2000 - CAPPED)
    })

    it('a link to a late reply: once capped, the list stands AT that reply (highlighted), not where the tall list clamped it', async () => {
      browser()
      const { root, replies } = longThread()
      // Each message 180 px apart: c9 at 1620 px is past what the tall list reaches (2000 − 683 = 1317).
      vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
        const id = this.getAttribute('data-message')
        return id === null ? 0 : Number(id.slice(1)) * 180
      })
      const before = fixtureMode({ thread: root, threadMessages: [root, ...replies], threadFocus: 'c9' })
      await draw(overlay(before))
      expect(q('[data-thread-list]')!.scrollTop).toBe(2000 - TALL)
      await draw(overlay(fixtureMode({ ...before, rects: new Map([['c1', R6]]) })))
      expect(q('[data-thread-list]')!.scrollTop).toBe(9 * 180 - 8)
      expect(q('[data-message="c9"]')!.hasAttribute('data-focus')).toBe(true)
    })

    it('a size change the card is not re-rendered for (an image loading, a font): the observer puts it back', async () => {
      const page = browser()
      const { root, replies } = longThread()
      await draw(overlay(fixtureMode({ thread: root, threadMessages: [root, ...replies] })))
      const list = q<HTMLElement>('[data-thread-list]')!
      // The card is capped from outside React (the same effect as a thumbnail growing the list).
      q<HTMLElement>('[data-thread]')!.style.maxHeight = '371px'
      page.resize()
      expect(list.scrollTop).toBe(2000 - CAPPED)
    })

    it('once the person scrolls the list (wheel), a later change of size leaves it where they put it', async () => {
      browser()
      const { root, replies } = longThread()
      const before = fixtureMode({ thread: root, threadMessages: [root, ...replies] })
      await draw(overlay(before))
      const list = q<HTMLElement>('[data-thread-list]')!
      await act(async () => { list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -300 })) })
      list.scrollTop = 400
      await act(async () => { list.dispatchEvent(new Event('scroll')) })
      await draw(overlay(fixtureMode({ ...before, rects: new Map([['c1', R6]]) })))
      expect(list.scrollTop).toBe(400)
    })

    it('a scroll the list did not cause by changing size (a scrollbar drag) is the person\'s too', async () => {
      browser()
      const { root, replies } = longThread()
      const before = fixtureMode({ thread: root, threadMessages: [root, ...replies] })
      await draw(overlay(before))
      const list = q<HTMLElement>('[data-thread-list]')!
      list.scrollTop = 300
      await act(async () => { list.dispatchEvent(new Event('scroll')) })
      await draw(overlay(fixtureMode({ ...before, rects: new Map([['c1', R6]]) })))
      expect(list.scrollTop).toBe(300)
    })
  })

  it('the popover, reply and edit boxes count as the Comments tab does: "3600 / 4000"', async () => {
    await draw(overlay(fixtureMode({ foot: 'new', picked: picked(), text: 'x'.repeat(3600) })))
    expect(q('[data-char-count]')!.textContent).toBe('3600 / 4000')
  })
})

describe('round 11: a box whose comment someone else deleted keeps its words (acceptance v5 V5-3)', () => {
  const R = { x: 40, y: 300, width: 300, height: 40 }
  const KEPT = 'This comment was deleted. Your words are kept.'

  it('the thread card stays with its words and messages, says so in one plain line, and offers Send to Tracy, Add as new comment, Discard', async () => {
    const root = comment(1, 'Root by Mai', { author: MAI, can: { edit: false, delete: false } })
    const mode = fixtureMode({ thread: root, threadMessages: [root], replyText: 'My reply draft', lost: 'thread', rects: new Map([['c1', R]]) })
    await draw(overlay(mode))
    const card = q('[data-thread]')!
    expect(q('[data-lost]')!.textContent).toBe(KEPT)
    expect(q<HTMLTextAreaElement>('[data-thread] textarea')!.value).toBe('My reply draft')
    expect(card.textContent).toContain('Root by Mai')
    // Nothing that acts on the deleted comment: no Reply, no Resolve, no ⋮.
    const labels = buttons(card).map(b => b.textContent)
    expect(labels).not.toContain('Reply')
    expect(labels).not.toContain('Resolve')
    expect(card.querySelector('[aria-haspopup="menu"]')).toBeNull()
    const pressed = (label: string): HTMLButtonElement => buttons(card).find(b => b.textContent?.startsWith(label))!
    await act(async () => { pressed('Send to Tracy').click() })
    await act(async () => { pressed('Add as new comment').click() })
    await act(async () => { pressed('Discard').click() })
    expect([mode.sendLost, mode.addLost, mode.discardLost].map(f => (f as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([1, 1, 1])
    // Enter is the card's Enter: to Tracy.
    await press(q('[data-thread] textarea')!, { key: 'Enter' })
    expect(mode.sendLost).toHaveBeenCalledTimes(2)
    expect(mode.sendThread).not.toHaveBeenCalled()
  })

  it('emptied words: Send and Add wait, Discard does not', async () => {
    const root = comment(1, 'Root')
    await draw(overlay(fixtureMode({ thread: root, threadMessages: [root], replyText: '  ', lost: 'thread' })))
    const card = q('[data-thread]')!
    const state = (label: string): boolean => buttons(card).find(b => b.textContent?.startsWith(label))!.disabled
    expect([state('Send to Tracy'), state('Add as new comment'), state('Discard')]).toEqual([true, true, false])
  })

  it('the edit popover the same way: its words, the line, the three actions; Enter adds (the edit popover\'s Enter keeps words)', async () => {
    const mine = comment(1, 'Say hello')
    const mode = fixtureMode({ foot: 'edit', editing: mine, text: 'Say hello, warmly', lost: 'edit', rects: new Map([['c1', R]]) })
    await draw(overlay(mode))
    const box = q('[role="dialog"]')!
    expect(q('[data-lost]')!.textContent).toBe(KEPT)
    const labels = buttons(box).map(b => b.textContent ?? '')
    expect(labels.some(l => l.startsWith('Save'))).toBe(false)
    expect(labels.some(l => l === 'Delete')).toBe(false)
    await press(q('[role="dialog"] textarea')!, { key: 'Enter' })
    expect(mode.addLost).toHaveBeenCalledTimes(1)
    expect(mode.save).not.toHaveBeenCalled()
  })

  it('no line and the usual buttons while the comment stands', async () => {
    const root = comment(1, 'Root')
    await draw(overlay(fixtureMode({ thread: root, threadMessages: [root], replyText: 'x' })))
    expect(q('[data-lost]')).toBeNull()
    expect(buttons(q('[data-thread]')!).map(b => b.textContent)).toContain('Reply')
  })

  it('the three new words are translated in every dictionary', () => {
    const dicts = { zh, ...localeDicts } as Record<string, Record<string, string>>
    for (const [lang, dict] of Object.entries(dicts)) {
      for (const key of ['commentLostKept', 'commentLostAdd', 'commentLostDiscard', 'commentErrNotSentNetwork'] as const) {
        expect(dict[key], `${lang}.${key}`).toBeTruthy()
        expect(dict[key], `${lang}.${key}`).not.toBe(en[key])
      }
    }
  })
})

describe('round 11: over the limit, every box says why in the Comments tab\'s own sentence (L2)', () => {
  const OVER = 'x'.repeat(4001)
  const SENTENCE = 'Too long to save. Keep it to 4000 characters or fewer.'
  const boxes: Array<[string, () => CommentMode, string]> = [
    ['the new-place popover', () => fixtureMode({ foot: 'new', picked: picked(), text: OVER }), '[role="dialog"]'],
    ['the edit popover', () => fixtureMode({ foot: 'edit', editing: comment(1, 'Say hello'), text: OVER, rects: new Map([['c1', { x: 40, y: 300, width: 300, height: 40 }]]) }), '[role="dialog"]'],
    ['the thread card\'s reply box', () => { const root = comment(1, 'Root'); return fixtureMode({ thread: root, threadMessages: [root], replyText: OVER }) }, '[data-thread]'],
  ]
  for (const [name, make, selector] of boxes) {
    it(`${name}: the sentence under the count, in its own box`, async () => {
      await draw(overlay(make()))
      expect(q(`${selector} [data-too-long]`)!.textContent).toBe(SENTENCE)
    })
  }
  it('under the limit: the count only, no sentence', async () => {
    await draw(overlay(fixtureMode({ foot: 'new', picked: picked(), text: 'x'.repeat(3600) })))
    expect(q('[data-char-count]')).not.toBeNull()
    expect(q('[data-too-long]')).toBeNull()
  })
})

describe('no em-dash in what the Browser tab, its comments and Refresh show (Brian 30/09)', () => {
  it('every dictionary: none of the words these files use carries "—"', async () => {
    const { readdirSync } = await import('node:fs')
    const dir = `${import.meta.dirname}/../src/client`
    const sources = [...readdirSync(dir), ...readdirSync(`${dir}/builtins`).map(f => `builtins/${f}`), ...readdirSync(`${dir}/native`).map(f => `native/${f}`)]
      .filter(f => /\.tsx?$/.test(f) && /browser|comment|refresh/i.test(f) && !f.startsWith('locales'))
    const code = sources.map(f => readFileSync(`${dir}/${f}`, 'utf8')).join('\n')
    const keys = Object.keys(en).filter(key => new RegExp(`['"\`]${key}['"\`]`).test(code))
    expect(keys).toEqual(expect.arrayContaining(['editTitle', 'attachTitle', 'commentLostKept', 'commentErrTooLong', 'refreshReady']))
    const dicts = { zh, en, ...localeDicts } as Record<string, Record<string, string>>
    const dashed = Object.entries(dicts).flatMap(([lang, dict]) => keys.filter(key => dict[key]?.includes('—')).map(key => `${lang}.${key}`))
    expect(dashed).toEqual([])
  })
})
