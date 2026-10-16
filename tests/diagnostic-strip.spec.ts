// @vitest-environment jsdom
/**
 * Diagnostic-strip lifecycle tests (issue #767).
 *
 * `fail()` is the plugin's last-resort reporter: it pins a visible strip to
 * the page so a blank panel is never the only symptom. Before this module the
 * strip was create-and-append only — one element per failure, no id, no
 * removal path — so a repeated failure (or one per settings broadcast, now
 * that `sync()` reports its rejections) stacked bars until the page was
 * reloaded.
 *
 * These cases pin the lifecycle contract instead: one host with a stable id,
 * one row per PHASE (a repeat rewrites its own row), a bounded row count, a
 * per-row close button, and a `clear()` the fiber's disposer calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDiagnosticStrips,
  DIAGNOSTIC_MAX_ROWS,
  DIAGNOSTIC_PHASE_ATTR,
  DIAGNOSTIC_STRIP_ID,
} from '../src/client/diagnostic-strip.ts'

const strips = (): ReturnType<typeof createDiagnosticStrips> => createDiagnosticStrips()

/** The one host, or null when the strip owns nothing. */
const host = (): HTMLElement | null => document.getElementById(DIAGNOSTIC_STRIP_ID)

/** The rendered rows, in DOM order. */
const rows = (): HTMLElement[] =>
  host() === null ? [] : Array.from(host()!.children) as HTMLElement[]

/** The phases currently rendered, in DOM order. */
const phases = (): (string | null)[] => rows().map(row => row.getAttribute(DIAGNOSTIC_PHASE_ATTR))

/** The phase row's own text (the close button carries no text of value). */
const rowText = (row: HTMLElement): string => row.querySelector('span')?.textContent ?? ''

afterEach(() => {
  document.body.innerHTML = ''
})

describe('diagnostic strip lifecycle', () => {
  it('reports one row per phase and rewrites the row on a repeat', () => {
    const strip = strips()
    strip.report('mount', 'mount error: boom')
    strip.report('mount', 'mount error: boom again')

    expect(rows()).toHaveLength(1)
    expect(rowText(rows()[0]!)).toBe('mount error: boom again')
    // Still exactly one host, so a repeat never pins a second bar.
    expect(document.querySelectorAll(`#${DIAGNOSTIC_STRIP_ID}`)).toHaveLength(1)
  })

  it('keeps one host across distinct phases', () => {
    const strip = strips()
    strip.report('mount', 'mount error: a')
    strip.report('sync', 'sync error: b')
    strip.report('ime guard', 'ime guard error: c')

    expect(document.querySelectorAll(`#${DIAGNOSTIC_STRIP_ID}`)).toHaveLength(1)
    expect(phases()).toEqual(['mount', 'sync', 'ime guard'])
    expect(document.body.lastElementChild).toBe(host())
  })

  it('drops the oldest phase once the row cap is reached', () => {
    const strip = strips()
    const phasesReported = ['a', 'b', 'c', 'd', 'e']
    for (const phase of phasesReported) strip.report(phase, `${phase} error: x`)

    expect(rows()).toHaveLength(DIAGNOSTIC_MAX_ROWS)
    expect(phases()).toEqual(phasesReported.slice(-DIAGNOSTIC_MAX_ROWS))
    // Dropping a row does not disturb the host the survivors live in.
    expect(document.querySelectorAll(`#${DIAGNOSTIC_STRIP_ID}`)).toHaveLength(1)
  })

  it('closes one phase at a time, and the host goes with the last row', () => {
    const strip = strips()
    strip.report('mount', 'mount error: a')
    strip.report('load', 'load error: b')

    const close = rows()[0]!.querySelector('button')
    expect(close, 'every row must carry its own close control').not.toBeNull()
    expect(close!.getAttribute('aria-label')).toContain('mount')
    close!.click()

    expect(phases()).toEqual(['load'])
    rows()[0]!.querySelector('button')!.click()
    expect(host()).toBeNull()
  })

  it('clear() removes every row and the host (the disposer path)', () => {
    const strip = strips()
    strip.report('mount', 'mount error: a')
    strip.report('sync', 'sync error: b')

    strip.clear()

    expect(host()).toBeNull()
    expect(document.body.children).toHaveLength(0)
  })

  it('adopts a leftover host from a previous activation instead of stacking one', () => {
    const first = strips()
    first.report('mount', 'mount error: from the previous activation')
    // A teardown that never ran: the old host is still in the page.
    const second = strips()
    second.report('mount', 'mount error: after the replacement')

    expect(document.querySelectorAll(`#${DIAGNOSTIC_STRIP_ID}`)).toHaveLength(1)
    expect(rows()).toHaveLength(1)
    expect(rowText(rows()[0]!)).toBe('mount error: after the replacement')
  })

  it('never throws when the DOM refuses to cooperate', () => {
    const strip = strips()
    const create = vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new Error('no DOM for you')
    })
    try {
      expect(() => { strip.report('mount', 'mount error: a') }).not.toThrow()
    } finally {
      create.mockRestore()
    }
    // The failure left nothing half-mounted behind.
    expect(host()).toBeNull()
  })
})
