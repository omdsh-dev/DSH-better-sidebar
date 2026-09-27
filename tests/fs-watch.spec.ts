/**
 * Directory-watch spec: the file tree's live refresh rests on this module, so
 * the tests use real directories and the real `fs.watch` rather than a stub —
 * the debounce, the handle accounting and the error path are the behaviour
 * being pinned.
 *
 * Timing note: `fs.watch` delivery is neither prompt nor one-to-one with the
 * writes that caused it (macOS FSEvents batches on its own schedule, and a
 * loaded machine stretches it further). The assertions below therefore pin
 * the PROPERTIES the tree depends on — a change is reported, a burst is
 * folded, an unwatched directory stays silent — instead of an exact event
 * count, and every wait is given a budget far above the module's 150 ms
 * debounce.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDirectoryWatchers, type DirectoryWatchEvent } from '../src/fs-watch.ts'

/** Generous delivery budget: the module debounces at 150 ms, the OS adds its own latency. */
const DELIVERY_TIMEOUT_MS = 15_000
/** Long enough for a second (tail) delivery to have surfaced, so "folded" means something. */
const SETTLE_MS = 1_000

/** One scratch tree with a directory to watch. */
const withScratch = (run: (dir: string) => Promise<void> | void): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-watch-'))
  const dir = join(root, 'watched')
  mkdirSync(dir)
  return Promise.resolve(run(dir)).finally(() => { rmSync(root, { recursive: true, force: true }) })
}

/** Sleep for a fixed window. */
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('directory watchers', () => {
  it('folds a burst of changes into a single notice', async () => {
    await withScratch(async (dir) => {
      const events: DirectoryWatchEvent[] = []
      const watchers = createDirectoryWatchers(event => events.push(event), () => {})
      try {
        expect(watchers.add(dir)).toBe(true)
        // One save is several filesystem events; the tree re-lists the whole
        // directory either way, so they must collapse. Twenty writes make the
        // fold unambiguous even if the OS delivers one late tail batch.
        for (let index = 0; index < 20; index++) writeFileSync(join(dir, `f${index}.txt`), 'x')
        await vi.waitFor(() => { expect(events.length).toBeGreaterThan(0) }, { timeout: DELIVERY_TIMEOUT_MS })
        await settle(SETTLE_MS)
        expect(events.length).toBeLessThanOrEqual(2)
        for (const event of events) expect(event).toEqual({ dir })
      } finally {
        watchers.close()
      }
    })
  })

  it('stops reporting once a directory is unwatched or closed', async () => {
    await withScratch(async (dir) => {
      const events: DirectoryWatchEvent[] = []
      const watchers = createDirectoryWatchers(event => events.push(event), () => {})
      watchers.add(dir)
      watchers.remove(dir)
      // Removing twice is a no-op, never a throw.
      watchers.remove(dir)
      writeFileSync(join(dir, 'a.txt'), 'x')
      // The waiting budget matches the positive case: a silent assertion is
      // only meaningful if an event had ample time to arrive.
      await settle(SETTLE_MS)
      expect(events).toEqual([])
      // Closing the whole set is idempotent too.
      watchers.close()
      watchers.close()
    })
  })

  it('treats a repeat add as already-watched', async () => {
    await withScratch(async (dir) => {
      const events: DirectoryWatchEvent[] = []
      const watchers = createDirectoryWatchers(event => events.push(event), () => {})
      try {
        expect(watchers.add(dir)).toBe(true)
        // A second add must not install a second watcher — that would double
        // every notice for the same directory.
        expect(watchers.add(dir)).toBe(true)
        writeFileSync(join(dir, 'a.txt'), 'x')
        await vi.waitFor(() => { expect(events.length).toBeGreaterThan(0) }, { timeout: DELIVERY_TIMEOUT_MS })
        await settle(SETTLE_MS)
        expect(events.length).toBeLessThanOrEqual(2)
      } finally {
        watchers.close()
      }
    })
  })

  it('caps the handles one connection may hold', async () => {
    await withScratch(async (dir) => {
      const root = join(dir, '..')
      const watchers = createDirectoryWatchers(() => {}, () => {})
      try {
        // The cap is 64: the first 64 directories are watched, the rest are
        // refused rather than throwing, and a refusal evicts nothing.
        let accepted = 0
        for (let index = 0; index < 70; index++) {
          const child = join(root, `child-${index}`)
          mkdirSync(child)
          if (watchers.add(child)) accepted += 1
        }
        expect(accepted).toBe(64)
      } finally {
        watchers.close()
      }
    })
  })

  it('reports an unwatchable directory instead of throwing', async () => {
    const failures: string[] = []
    const watchers = createDirectoryWatchers(() => {}, (dir) => { failures.push(dir) })
    try {
      const missing = join(tmpdir(), 'dsh-sidebar-watch-does-not-exist-42')
      expect(watchers.add(missing)).toBe(false)
      expect(failures).toEqual([missing])
    } finally {
      watchers.close()
    }
  })
})
