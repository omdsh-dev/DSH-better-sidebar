/**
 * The request-wide probe budget behind `fs.trees`.
 *
 * One batch lists up to `FS_TREES_MAX_PATHS` levels concurrently, and each
 * level runs its own bounded probe pool (a `stat` per symlink row, an
 * `opendir` per directory row for the singleton fold mark). Without a shared
 * budget those bounds multiply — a cold mount of a wide tree could hold
 * levels × pool probes open at once. The bound itself is proved on the gate;
 * these tests prove the WIRING: every probe of every level spends the one
 * gate the request was given (and a cache hit spends nothing at all). The
 * route's per-request gate SHARING is asserted in tests/smoke.spec.ts.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProbeGate, listDirectory, type ProbeGate } from '../src/fs-tree.ts'
import { removeTree } from './temp-tree.ts'

/** A gate that only COUNTS acquisitions: it bounds nothing of its own, so the
 *  count it reports is exactly the probes the caller routed through it. */
function countingGate(): { gate: ProbeGate; calls: () => number } {
  const state = { calls: 0 }
  return {
    gate: {
      async run<T>(task: () => Promise<T>): Promise<T> {
        state.calls += 1
        return await task()
      },
    },
    calls: () => state.calls,
  }
}

describe('createProbeGate', () => {
  it('keeps at most `limit` tasks in flight', async () => {
    const gate = createProbeGate(2)
    let live = 0
    let peak = 0
    await Promise.all(Array.from({ length: 8 }, () => gate.run(async () => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise(resolve => setTimeout(resolve, 1))
      live -= 1
    })))
    expect(peak).toBe(2)
    expect(live).toBe(0)
  })

  it('releases the slot when a queued task throws, in FIFO order', async () => {
    const gate = createProbeGate(1)
    const order: string[] = []
    const first = gate.run(async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      order.push('first')
    })
    const failing = gate.run(async () => {
      order.push('failing')
      throw new Error('probe failed')
    })
    const last = gate.run(async () => {
      order.push('last')
      return 'ok'
    })
    await first
    await expect(failing).rejects.toThrow('probe failed')
    // A thrown probe must not strand the waiter behind it.
    await expect(last).resolves.toBe('ok')
    expect(order).toEqual(['first', 'failing', 'last'])
  })

  it('clamps a limit below one so the gate still runs', async () => {
    const gate = createProbeGate(0)
    const settled = await Promise.race([
      gate.run(async () => 'ok'),
      new Promise<string>(resolve => { setTimeout(() => { resolve('timed out') }, 100) }),
    ])
    expect(settled).toBe('ok')
  })
})

describe('listDirectory probe budget', () => {
  it('spends one gate slot per directory probe, and none on a cache hit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-probe-gate-'))
    try {
      // Four singleton dirs (one child each) plus one ordinary dir: every
      // directory row costs exactly one compact probe.
      for (let index = 0; index < 4; index += 1) {
        mkdirSync(join(dir, `only-${index}`))
        writeFileSync(join(dir, `only-${index}`, 'child.txt'), 'x')
      }
      mkdirSync(join(dir, 'plain'))
      writeFileSync(join(dir, 'plain', 'a.txt'), 'x')
      writeFileSync(join(dir, 'plain', 'b.txt'), 'x')

      const counted = countingGate()
      const listing = await listDirectory(dir, 1000, undefined, counted.gate)
      expect(counted.calls()).toBe(5)
      expect(listing.entries.filter(entry => entry.compact === true).map(entry => entry.name).sort())
        .toEqual(['only-0', 'only-1', 'only-2', 'only-3'])

      // A fresh call is answered from the level cache, which runs no probe at
      // all — so it must not spend budget either.
      const spent = counted.calls()
      const cached = await listDirectory(dir, 1000, undefined, counted.gate)
      expect(counted.calls()).toBe(spent)
      expect(cached).toBe(listing)
    } finally {
      removeTree(dir)
    }
  })

  it('routes a whole batch of levels through ONE shared gate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-probe-batch-'))
    try {
      const levels: string[] = []
      for (let index = 0; index < 3; index += 1) {
        const level = join(root, `l${index}`)
        mkdirSync(level)
        for (let child = 0; child < 3; child += 1) {
          mkdirSync(join(level, `s${child}`))
          writeFileSync(join(level, `s${child}`, 'child.txt'), 'x')
        }
        levels.push(level)
      }

      const counted = countingGate()
      // Exactly the shape the `fs.trees` route builds: one gate, many levels.
      const listings = await Promise.all(levels.map(level => listDirectory(level, 1000, undefined, counted.gate)))
      // 3 levels × 3 directory rows: every probe went through the shared gate.
      expect(counted.calls()).toBe(9)
      for (const listing of listings) {
        expect(listing.entries.filter(entry => entry.compact === true)).toHaveLength(3)
      }
    } finally {
      removeTree(root)
    }
  })

  /**
   * The fold mark is decoration, so a wide level must not pay one `opendir`
   * per directory row: past the per-level cap the remaining rows stay
   * un-folded (and, crucially, un-probed).
   */
  it('caps the compact probes of one wide level', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-probe-cap-'))
    try {
      const level = join(root, 'wide')
      mkdirSync(level)
      // 100 singleton chains: without the cap every one of them is probed.
      for (let index = 0; index < 100; index += 1) {
        mkdirSync(join(level, `only-${String(index).padStart(3, '0')}`))
        writeFileSync(join(level, `only-${String(index).padStart(3, '0')}`, 'child.txt'), 'x')
      }

      const counted = countingGate()
      const listing = await listDirectory(level, 1000, undefined, counted.gate)
      expect(listing.entries).toHaveLength(100)
      expect(counted.calls()).toBe(32)
      // Probed in row order: the first 32 rows are folded, the rest are left
      // alone rather than probed.
      const folded = listing.entries.filter(entry => entry.compact === true)
      expect(folded).toHaveLength(32)
      expect(folded.map(entry => entry.name)).toEqual(
        listing.entries.slice(0, 32).map(entry => entry.name),
      )
    } finally {
      removeTree(root)
    }
  })

  it('skips the compact probe entirely on a truncated level', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-probe-truncated-'))
    try {
      const level = join(root, 'wide')
      mkdirSync(level)
      for (let index = 0; index < 6; index += 1) {
        mkdirSync(join(level, `only-${index}`))
        writeFileSync(join(level, `only-${index}`, 'child.txt'), 'x')
      }

      const counted = countingGate()
      // A row cap below the level's width flags it truncated: the rows on
      // screen are an arbitrary slice, so none of them is folded.
      const listing = await listDirectory(level, 3, undefined, counted.gate)
      expect(listing.truncated).toBe(true)
      expect(listing.entries).toHaveLength(3)
      expect(counted.calls()).toBe(0)
      expect(listing.entries.every(entry => entry.compact === undefined)).toBe(true)
    } finally {
      removeTree(root)
    }
  })
})
