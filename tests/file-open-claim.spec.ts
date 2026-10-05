/**
 * `openSidebarFile` (the shared entry of the file explorer, the changes tab
 * and the editor's new-tab gesture) must let a tab type that explicitly
 * claims a file own it (#695, ported from PR #696 whose original carrier
 * `intercept.tsx` was deleted).
 *
 * The callers used to name this plugin's own `editor` type directly, which
 * bypasses the native tab registry: a third-party type registered with
 * `extension` priority and a specific address glob (a `.drawio` canvas, say)
 * wins the registry's ranking yet could never render from these entry
 * points, while the same file opened from the chat (`ctx.sidebarRight.
 * openResource`, which lets the registry rank) did reach it. The probe must
 * stay a no-op for every other file — the plugin's own `editor` type is the
 * best candidate there — and must never break opening.
 */
import { describe, expect, it, vi } from 'vitest'
import { claimingNativeKind, openClaimedNativeFile, openSidebarFile } from '../src/client/sidebar-file.ts'
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

const EXPECTED_ADDRESS = 'dsh-resource://file/session/session-1/out/coedit-sample.drawio'

describe('claimingNativeKind', () => {
  it('names the best candidate unless it is this plugin\'s editor', () => {
    const { ctx } = makeCtx({ candidates: () => [{ kind: 'drawio' }] })
    expect(claimingNativeKind(ctx, EXPECTED_ADDRESS)).toBe('drawio')
  })

  it('answers undefined when the editor ranks first (the normal case)', () => {
    // `editor` first is the normal case: our type registers
    // `dsh-resource://file/**` in the extension band, so it beats the
    // built-in `text` fallback for every file it has not yielded.
    const { ctx } = makeCtx({ candidates: () => [{ kind: 'editor' }, { kind: 'text' }] })
    expect(claimingNativeKind(ctx, 'dsh-resource://file/session/session-1/out/notes.md')).toBeUndefined()
  })

  it('answers undefined when nothing claims the address or there is no registry', () => {
    const empty = makeCtx({ candidates: () => [] })
    expect(claimingNativeKind(empty.ctx, EXPECTED_ADDRESS)).toBeUndefined()
    const bare = makeCtx({})
    expect(claimingNativeKind(bare.ctx, EXPECTED_ADDRESS)).toBeUndefined()
  })
})

describe('openClaimedNativeFile', () => {
  it('opens the address through the native surface and reports true', () => {
    const { ctx, resources } = makeCtx({ candidates: () => [{ kind: 'drawio' }] })
    expect(openClaimedNativeFile(ctx, 'session-1', '/ws', '/ws/out/coedit-sample.drawio')).toBe(true)
    expect(resources).toEqual([EXPECTED_ADDRESS])
  })

  it('reports false for an unclaimed file without touching the surface', () => {
    const { ctx, resources } = makeCtx({ candidates: () => [{ kind: 'editor' }] })
    expect(openClaimedNativeFile(ctx, 'session-1', '/ws', '/ws/out/notes.md')).toBe(false)
    expect(resources).toEqual([])
  })
})

describe('openSidebarFile', () => {
  it('hands the file to the type that claims it', () => {
    const harness = makeCtx({ candidates: () => [{ kind: 'drawio' }] })

    openSidebarFile(harness.ctx, 'session-1', 'out/coedit-sample.drawio')

    expect(harness.resources).toEqual([EXPECTED_ADDRESS])
    expect(harness.opened).toEqual([])
  })

  it('ranks by the registry order: the editor keeps files no other type claims', () => {
    // `editor` first is the normal case (our type registers
    // `dsh-resource://file/**` in the extension band, so it beats the
    // built-in `text` fallback).
    const harness = makeCtx({ candidates: () => [{ kind: 'editor' }, { kind: 'text' }] })

    openSidebarFile(harness.ctx, 'session-1', 'out/notes.md')

    expect(harness.opened).toEqual([
      { type: 'editor', title: 'notes.md', path: '/ws/out/notes.md', id: 'editor:/ws/out/notes.md' },
    ])
    expect(harness.resources).toEqual([])
  })

  it('keeps the editor when nothing claims the address', () => {
    const harness = makeCtx({ candidates: () => [] })

    openSidebarFile(harness.ctx, 'session-1', 'out/notes.md')

    expect(harness.opened).toHaveLength(1)
    expect(harness.resources).toEqual([])
  })

  it('keeps the editor when the host has no registry or no native surface', () => {
    const withoutRegistry = makeCtx({})
    openSidebarFile(withoutRegistry.ctx, 'session-1', 'out/coedit-sample.drawio')
    expect(withoutRegistry.opened).toHaveLength(1)
    expect(withoutRegistry.resources).toEqual([])

    const withoutOpener = makeCtx({ candidates: () => [{ kind: 'drawio' }], openerMissing: true })
    openSidebarFile(withoutOpener.ctx, 'session-1', 'out/coedit-sample.drawio')
    expect(withoutOpener.opened).toHaveLength(1)
    expect(withoutOpener.resources).toEqual([])
  })

  it('never lets a failing probe break opening', () => {
    const harness = makeCtx({ candidates: () => [{ kind: 'drawio' }], probeThrows: true })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      openSidebarFile(harness.ctx, 'session-1', 'out/coedit-sample.drawio')
      // Assert inside the spy's lifetime: mockRestore also clears the calls.
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }

    expect(harness.opened).toHaveLength(1)
    expect(harness.resources).toEqual([])
  })

  it('addresses an absolute path inside the workspace by its relative spelling', () => {
    // The cwd-ful spelling matches what the host's conversation file links
    // produce, so a claimed file opened here dedupes against the tab the
    // chat path already opened for the same file.
    const harness = makeCtx({ candidates: () => [{ kind: 'drawio' }] })

    openSidebarFile(harness.ctx, 'session-1', '/ws/out/coedit-sample.drawio')

    expect(harness.resources).toEqual([EXPECTED_ADDRESS])
  })

  it('addresses a path outside the workspace in that session scope as well', () => {
    const harness = makeCtx({ candidates: () => [{ kind: 'drawio' }] })

    openSidebarFile(harness.ctx, 'session-1', '/elsewhere/plan.drawio')

    expect(harness.resources).toHaveLength(1)
    expect(harness.resources[0]).toContain('session-1')
    expect(harness.resources[0]).toContain('elsewhere/plan.drawio')
  })
})
