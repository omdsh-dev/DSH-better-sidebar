/**
 * `openSidebarFile` (the shared entry of the file explorer and the intercepted
 * produced-files row) must let a tab type that explicitly claims a file own it.
 *
 * Both callers used to name this plugin's own `editor` type directly, which
 * bypasses the native tab registry: a third-party type registered with
 * `extension` priority and a specific address glob (a `.drawio` canvas, say)
 * wins the registry's ranking yet could never render from these entry points.
 * The probe must stay a no-op for every other file — the plugin's own `editor`
 * type is the best candidate there — and must never break opening.
 */
import { describe, expect, it, vi } from 'vitest'
import { openSidebarFile } from '../src/client/intercept.tsx'
import type { Context } from '../src/context-types.ts'

interface Claimant {
  readonly kind?: string
}

interface CtxOptions {
  /** Answers `sidebarRightTabs.candidates`; omit to model a host without the registry. */
  readonly candidates?: (address: string) => readonly Claimant[]
  /** Model a registry probe that throws (an incompatible implementation). */
  readonly probeThrows?: boolean
  /** Model a native surface without the write face (`openResource` absent). */
  readonly openerMissing?: boolean
}

interface Harness {
  readonly ctx: Context
  /** Seeds handed to `ctx.betterSidebar.openTab` (the plugin's own editor). */
  readonly opened: Record<string, unknown>[]
  /** Addresses handed to `ctx.sidebarRight.openResource` (the claiming type). */
  readonly resources: string[]
}

function makeCtx(options: CtxOptions = {}): Harness {
  const opened: Record<string, unknown>[] = []
  const resources: string[] = []
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ byId: { 'session-1': { cwd: '/ws' } } }) } },
    get: (name: string) => {
      if (name === 'sidebarRightTabs') {
        if (options.candidates === undefined) return undefined
        const candidates = options.candidates
        return {
          candidates: (address: string): readonly Claimant[] => {
            if (options.probeThrows === true) throw new Error('incompatible registry')
            return candidates(address)
          },
        }
      }
      if (name === 'sidebarRight') {
        return options.openerMissing === true ? {} : { openResource: (address: string): void => void resources.push(address) }
      }
      if (name === 'betterSidebar') {
        return { openTab: (seed: Record<string, unknown>): void => void opened.push(seed) }
      }
      return undefined
    },
  }
  return { ctx: ctx as unknown as Context, opened, resources }
}

const STORE = {} as never
const EXPECTED_ADDRESS = 'dsh-resource://file/session/session-1/out/coedit-sample.drawio'

describe('openSidebarFile', () => {
  it('hands the file to the type that claims it', () => {
    const harness = makeCtx({ candidates: () => [{ kind: 'drawio' }] })

    openSidebarFile(harness.ctx, STORE, 'session-1', 'out/coedit-sample.drawio')

    expect(harness.resources).toEqual([EXPECTED_ADDRESS])
    expect(harness.opened).toEqual([])
  })

  it('ranks by the registry order: the editor keeps files no other type claims', () => {
    // `editor` first is the normal case (our type registers `dsh-resource://file/**`
    // in the extension band, so it beats the built-in `text` fallback).
    const harness = makeCtx({ candidates: () => [{ kind: 'editor' }, { kind: 'text' }] })

    openSidebarFile(harness.ctx, STORE, 'session-1', 'out/notes.md')

    expect(harness.opened).toEqual([
      { type: 'editor', title: 'notes.md', path: '/ws/out/notes.md', id: 'editor:/ws/out/notes.md' },
    ])
    expect(harness.resources).toEqual([])
  })

  it('keeps the editor when nothing claims the address', () => {
    const harness = makeCtx({ candidates: () => [] })

    openSidebarFile(harness.ctx, STORE, 'session-1', 'out/notes.md')

    expect(harness.opened).toHaveLength(1)
    expect(harness.resources).toEqual([])
  })

  it('keeps the editor when the host has no registry or no native surface', () => {
    const withoutRegistry = makeCtx({})
    openSidebarFile(withoutRegistry.ctx, STORE, 'session-1', 'out/coedit-sample.drawio')
    expect(withoutRegistry.opened).toHaveLength(1)
    expect(withoutRegistry.resources).toEqual([])

    const withoutOpener = makeCtx({ candidates: () => [{ kind: 'drawio' }], openerMissing: true })
    openSidebarFile(withoutOpener.ctx, STORE, 'session-1', 'out/coedit-sample.drawio')
    expect(withoutOpener.opened).toHaveLength(1)
    expect(withoutOpener.resources).toEqual([])
  })

  it('never lets a failing probe break opening', () => {
    const harness = makeCtx({ candidates: () => [{ kind: 'drawio' }], probeThrows: true })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      openSidebarFile(harness.ctx, STORE, 'session-1', 'out/coedit-sample.drawio')
    } finally {
      logged.mockRestore()
    }

    expect(logged).toHaveBeenCalled()
    expect(harness.opened).toHaveLength(1)
    expect(harness.resources).toEqual([])
  })

  it('addresses an absolute path inside the workspace by its relative spelling', () => {
    const harness = makeCtx({ candidates: () => [{ kind: 'drawio' }] })

    openSidebarFile(harness.ctx, STORE, 'session-1', '/ws/out/coedit-sample.drawio')

    expect(harness.resources).toEqual([EXPECTED_ADDRESS])
  })

  it('addresses a path outside the workspace in that session scope as well', () => {
    const harness = makeCtx({ candidates: () => [{ kind: 'drawio' }] })

    openSidebarFile(harness.ctx, STORE, 'session-1', '/elsewhere/plan.drawio')

    expect(harness.resources).toHaveLength(1)
    expect(harness.resources[0]).toContain('session-1')
    expect(harness.resources[0]).toContain('elsewhere/plan.drawio')
  })
})
