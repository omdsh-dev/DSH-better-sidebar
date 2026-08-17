/**
 * Host-sidebar keeper machine tests (pure — no DOM).
 *
 * The keeper re-expands the host's LEFT sidebar when OUR right-panel push
 * crosses the host's 1024px breakpoint (see src/client/host-sidebar.ts).
 * These tests pin the state machine:
 *
 *  - ARM only on a real ≥1024 → <1024 frame crossing while the push is
 *    live and the window itself is not below the breakpoint (a user ⌘B
 *    collapse never changes the frame width, so it never arms);
 *  - CONSUME only on the collapse attribute APPEARING after an arm (a
 *    pre-existing collapse fires no mutation → never fought);
 *  - the arm is one-shot and self-clears on recovery / dead push.
 */
import { describe, expect, it } from 'vitest'
import {
  createHostSidebarKeeper,
  HOST_SIDEBAR_AUTO_COLLAPSE,
  type HostSidebarKeeper,
} from '../src/client/host-sidebar.ts'

const WIDE = HOST_SIDEBAR_AUTO_COLLAPSE + 200 // 1224: a comfortably wide frame
const NARROW = HOST_SIDEBAR_AUTO_COLLAPSE - 100 // 924: squeezed below the breakpoint

/** A keeper with scripted inputs (push live, window wide by default). */
function keeper(overrides?: { pushLive?: boolean; windowWidth?: number }): {
  keeper: HostSidebarKeeper
  setPushLive: (live: boolean) => void
} {
  const state = { pushLive: overrides?.pushLive ?? true }
  return {
    keeper: createHostSidebarKeeper({
      isPushLive: () => state.pushLive,
      windowWidth: () => overrides?.windowWidth ?? WIDE + 200,
    }),
    setPushLive: (live: boolean) => { state.pushLive = live },
  }
}

describe('createHostSidebarKeeper — the arm decision', () => {
  it('arms on a real ≥1024 → <1024 crossing while the push is live', () => {
    const { keeper: k } = keeper()
    k.onFrameResize(WIDE) // baseline (no crossing on the first observation)
    k.onFrameResize(NARROW) // our push squeezed the frame below the breakpoint
    // The host renders the collapse rail → the appearance consumes the arm.
    expect(k.onCollapsedAttrChanged(true)).toBe(true)
    // One-shot: a second appearance (or any later change) is ignored.
    expect(k.onCollapsedAttrChanged(true)).toBe(false)
  })

  it('does not arm on the FIRST observation (no baseline to cross from)', () => {
    const { keeper: k } = keeper()
    k.onFrameResize(NARROW)
    expect(k.onCollapsedAttrChanged(true)).toBe(false)
  })

  it('does not arm without a real crossing (already narrow stays narrow)', () => {
    const { keeper: k } = keeper()
    k.onFrameResize(NARROW)
    k.onFrameResize(NARROW - 10)
    expect(k.onCollapsedAttrChanged(true)).toBe(false)
  })

  it('does not arm while the push is not live (panel closed — not our squeeze)', () => {
    const { keeper: k } = keeper({ pushLive: false })
    k.onFrameResize(WIDE)
    k.onFrameResize(NARROW)
    expect(k.onCollapsedAttrChanged(true)).toBe(false)
  })

  it('does not arm on a genuinely narrow window (host design — never fought)', () => {
    const { keeper: k } = keeper({ windowWidth: NARROW })
    k.onFrameResize(WIDE)
    k.onFrameResize(NARROW)
    expect(k.onCollapsedAttrChanged(true)).toBe(false)
  })

  it('consumes only the APPEARANCE: an attr removal after an arm returns false', () => {
    const { keeper: k } = keeper()
    k.onFrameResize(WIDE)
    k.onFrameResize(NARROW)
    // The host restored itself (attr removed) instead of collapsing → the
    // arm settles without any re-expand.
    expect(k.onCollapsedAttrChanged(false)).toBe(false)
    expect(k.onCollapsedAttrChanged(true)).toBe(false)
  })

  it('self-clears on recovery: the frame back above the breakpoint drops the arm', () => {
    const { keeper: k } = keeper()
    k.onFrameResize(WIDE)
    k.onFrameResize(NARROW) // armed
    k.onFrameResize(WIDE) // panel closed / window widened → recovery
    expect(k.onCollapsedAttrChanged(true)).toBe(false)
  })

  it('self-clears when the push dies while narrow (panel closed on a small window)', () => {
    const { keeper: k, setPushLive } = keeper()
    k.onFrameResize(WIDE)
    k.onFrameResize(NARROW) // armed
    setPushLive(false) // the user closes the right panel
    k.onFrameResize(NARROW) // the frame stays narrow (small window)
    expect(k.onCollapsedAttrChanged(true)).toBe(false)
  })

  it('re-arms on repeated crossings (drag the panel across the breakpoint twice)', () => {
    const { keeper: k } = keeper()
    k.onFrameResize(WIDE)
    k.onFrameResize(NARROW) // crossing 1 → armed
    expect(k.onCollapsedAttrChanged(true)).toBe(true)
    k.onFrameResize(WIDE) // recovery
    k.onFrameResize(NARROW) // crossing 2 → armed again
    expect(k.onCollapsedAttrChanged(true)).toBe(true)
  })

  it('crossing exactly AT the breakpoint does not arm (1024 is not narrow)', () => {
    const { keeper: k } = keeper()
    k.onFrameResize(WIDE)
    k.onFrameResize(HOST_SIDEBAR_AUTO_COLLAPSE)
    expect(k.onCollapsedAttrChanged(true)).toBe(false)
  })
})
