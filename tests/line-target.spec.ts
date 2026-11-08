/**
 * The line-target side channel: a navigation's line RANGE and IDENTITY are
 * armed here at open time, read without spending (render-safe peek), and spent
 * once by the editor that hands the navigation to its viewer. The host's
 * resource-params map declares only `line`, and its tab adapter drops a
 * navigation whose line did not move — so the nonce is what distinguishes a
 * second click on the same chip from the already-spent first one, and the
 * consume is what keeps a stale arm from flashing a later ordinary open.
 */
import { describe, expect, it } from 'vitest'
import { armLineEnd, consumeLineTarget, peekLineTarget } from '../src/client/line-target.ts'

describe('armLineEnd / peekLineTarget / consumeLineTarget', () => {
  it('hands the armed range to the reader without spending it', () => {
    armLineEnd('/w/a.ts', 3, 7)
    const first = peekLineTarget('/w/a.ts', 3)
    expect(first?.end).toBe(7)
    // Peeking is render-safe: a re-render (or a discarded concurrent render)
    // must not eat the arm the committed one still needs.
    expect(peekLineTarget('/w/a.ts', 3)).toBe(first)
  })

  it('is one-shot: consuming removes the arm', () => {
    armLineEnd('/w/a.ts', 3, 7)
    consumeLineTarget('/w/a.ts', 3)
    expect(peekLineTarget('/w/a.ts', 3)).toBeUndefined()
  })

  it('does not confuse two files that share a line number', () => {
    armLineEnd('/w/a.ts', 3, 7)
    expect(peekLineTarget('/w/b.ts', 3)).toBeUndefined()
    expect(peekLineTarget('/w/a.ts', 4)).toBeUndefined()
    expect(peekLineTarget('/w/a.ts', 3)?.end).toBe(7)
  })

  it('replaces the pending range of the same path + line', () => {
    armLineEnd('/w/a.ts', 3, 7)
    const next = armLineEnd('/w/a.ts', 3, 9)
    const target = peekLineTarget('/w/a.ts', 3)
    expect(target?.end).toBe(9)
    expect(target?.nonce).toBe(next)
  })

  it('gives every arm of the same path + line a new identity (the re-click case)', () => {
    // Clicking the SAME chip again names the same `path#line`; the host's
    // navigation does not move, so without a new nonce the editor would read
    // the click as an already-spent landing and neither jump nor flash. This
    // is the module-level guarantee the editor's journal keys on.
    const first = armLineEnd('/w/a.ts', 3, 7)
    expect(peekLineTarget('/w/a.ts', 3)?.nonce).toBe(first)
    consumeLineTarget('/w/a.ts', 3)
    const second = armLineEnd('/w/a.ts', 3, 7)
    expect(second).not.toBe(first)
    expect(peekLineTarget('/w/a.ts', 3)).toEqual({ nonce: second, end: 7 })
  })

  it('still arms a navigation identity when there is no range (single-line chips)', () => {
    // A one-line quote lands (and must re-land on every click) without a flash
    // span: `end` is absent but the navigation is still fresh.
    const nonce = armLineEnd('/w/a.ts', 3, undefined)
    expect(peekLineTarget('/w/a.ts', 3)).toEqual({ nonce })
    consumeLineTarget('/w/a.ts', 3)
    expect(peekLineTarget('/w/a.ts', 3)).toBeUndefined()
  })

  it('an armed range never outlives the landing that spent it', () => {
    armLineEnd('/w/a.ts', 3, 7)
    // The editor took it for THIS navigation; a later ordinary open of the
    // same file at another line must not inherit the flash.
    consumeLineTarget('/w/a.ts', 3)
    expect(peekLineTarget('/w/a.ts', 4)).toBeUndefined()
    // A re-click arms a new one; the next landing sees it again.
    armLineEnd('/w/a.ts', 3, 7)
    expect(peekLineTarget('/w/a.ts', 3)?.end).toBe(7)
  })

  it('caps the pending map so a burst of opens cannot grow it forever', () => {
    for (let line = 1; line <= 200; line++) armLineEnd('/w/a.ts', line, line + 1)
    // The oldest arms were evicted: only the most recent MAX_ARMED survive.
    expect(peekLineTarget('/w/a.ts', 1)).toBeUndefined()
    expect(peekLineTarget('/w/a.ts', 200)?.end).toBe(201)
  })
})
