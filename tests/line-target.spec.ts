/**
 * The line-target side channel: a navigation's line RANGE is armed here at
 * open time and taken once by the viewer that renders that tab. The host's
 * resource-params map declares only `line`, so the range must not ride in
 * `params` (an undeclared host contract) — this module is the plugin-side
 * replacement, keyed by path + line so a stale arm cannot hit a later open.
 */
import { describe, expect, it } from 'vitest'
import { armLineEnd, takeLineEnd } from '../src/client/line-target.ts'

describe('armLineEnd / takeLineEnd', () => {
  it('hands the armed range to the taker', () => {
    armLineEnd('/w/a.ts', 3, 7)
    expect(takeLineEnd('/w/a.ts', 3)).toBe(7)
  })

  it('is one-shot: a second take finds nothing', () => {
    armLineEnd('/w/a.ts', 3, 7)
    expect(takeLineEnd('/w/a.ts', 3)).toBe(7)
    expect(takeLineEnd('/w/a.ts', 3)).toBeUndefined()
  })

  it('does not confuse two files that share a line number', () => {
    armLineEnd('/w/a.ts', 3, 7)
    expect(takeLineEnd('/w/b.ts', 3)).toBeUndefined()
    expect(takeLineEnd('/w/a.ts', 4)).toBeUndefined()
    expect(takeLineEnd('/w/a.ts', 3)).toBe(7)
  })

  it('replaces the pending range of the same path + line', () => {
    armLineEnd('/w/a.ts', 3, 7)
    armLineEnd('/w/a.ts', 3, 9)
    expect(takeLineEnd('/w/a.ts', 3)).toBe(9)
    expect(takeLineEnd('/w/a.ts', 3)).toBeUndefined()
  })

  it('clears the pending range when a plain jump reuses the slot', () => {
    armLineEnd('/w/a.ts', 3, 7)
    armLineEnd('/w/a.ts', 3, undefined)
    expect(takeLineEnd('/w/a.ts', 3)).toBeUndefined()
  })

  it('an armed range never outlives its own navigation', () => {
    armLineEnd('/w/a.ts', 3, 7)
    // The viewer took it for THIS open (path+line); a later plain open of the
    // same file at another line must not inherit the flash.
    takeLineEnd('/w/a.ts', 3)
    expect(takeLineEnd('/w/a.ts', 4)).toBeUndefined()
  })

  it('caps the pending map so a burst of opens cannot grow it forever', () => {
    for (let line = 1; line <= 200; line++) armLineEnd('/w/a.ts', line, line + 1)
    // The oldest arms were evicted: only the most recent MAX_ARMED survive.
    expect(takeLineEnd('/w/a.ts', 1)).toBeUndefined()
    expect(takeLineEnd('/w/a.ts', 200)).toBe(201)
  })
})
