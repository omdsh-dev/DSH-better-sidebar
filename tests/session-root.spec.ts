/**
 * The explicit root pin (the explorer's root picker's host half).
 *
 * The pin is the ONE thing that outranks the automatic root, so its own
 * contract is small but load-bearing: per session, revocable, BOUNDED (the host
 * never forgets a session, so an unbounded map would grow with every session
 * ever opened — the repo's bounded-cache rule), and self-dropping once the
 * pinned directory disappears. That last part is #960's shape: a checkout
 * removed while the host keeps running must not pin every route to a directory
 * that no longer exists.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PINNED_SESSIONS_MAX, livePinnedRootOf, pinSessionRoot, pinnedRootOf, unpinSessionRoot,
} from '../src/session-root.ts'

/** Every session pinned by one case, so the suite can always clean up. */
const touched = new Set<string>()

const TEMP: string[] = []

afterEach(() => {
  for (const sessionId of touched) unpinSessionRoot(sessionId)
  touched.clear()
  for (const dir of TEMP.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Pin one session and remember it for the afterEach sweep. */
function pin(sessionId: string, root: string): void {
  touched.add(sessionId)
  pinSessionRoot(sessionId, root)
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-session-root-'))
  TEMP.push(dir)
  return dir
}

describe('explicit session roots', () => {
  it('reads back one session\'s pin without touching another\'s', () => {
    pin('s-a', '/ws/a')
    pin('s-b', '/ws/b')
    expect(pinnedRootOf('s-a')).toBe('/ws/a')
    expect(pinnedRootOf('s-b')).toBe('/ws/b')
    unpinSessionRoot('s-a')
    expect(pinnedRootOf('s-a')).toBeUndefined()
    // Revoking one session never disturbs its neighbour.
    expect(pinnedRootOf('s-b')).toBe('/ws/b')
  })

  it('holds at most PINNED_SESSIONS_MAX pins, evicting the least recently read', () => {
    for (let index = 0; index <= PINNED_SESSIONS_MAX; index += 1) pin(`s-${index}`, `/ws/${index}`)
    // The (MAX+1)-th pin evicted the oldest entry…
    expect(pinnedRootOf('s-0')).toBeUndefined()
    // …but a READ refreshes recency, so one that is read first survives the
    // eviction of the next-oldest instead.
    expect(pinnedRootOf('s-1')).toBe('/ws/1')
    pin('s-beyond', '/ws/beyond')
    expect(pinnedRootOf('s-1')).toBe('/ws/1')
    expect(pinnedRootOf('s-2')).toBeUndefined()
  })

  it('serves a pin whose directory is still there', async () => {
    const dir = tempDir()
    pin('s-live', dir)
    await expect(livePinnedRootOf('s-live')).resolves.toBe(dir)
  })

  it('drops a pin whose checkout was removed instead of serving a dead path', async () => {
    const dir = tempDir()
    const gone = join(dir, 'worktree')
    mkdirSync(gone)
    pin('s-gone', gone)
    await expect(livePinnedRootOf('s-gone')).resolves.toBe(gone)
    rmSync(gone, { recursive: true, force: true })
    // The read drops the stale pin, so the caller falls back to the automatic
    // root on the same call (and the client's next poll reports it).
    await expect(livePinnedRootOf('s-gone')).resolves.toBeUndefined()
    expect(pinnedRootOf('s-gone')).toBeUndefined()
  })

  it('treats a path that is no longer a directory as gone', async () => {
    const dir = tempDir()
    const target = join(dir, 'checkout')
    mkdirSync(target)
    pin('s-file', target)
    rmSync(target, { recursive: true, force: true })
    // A FILE at the pinned path is not a usable root, so the pin goes too.
    writeFileSync(target, 'not a checkout\n')
    await expect(livePinnedRootOf('s-file')).resolves.toBeUndefined()
    expect(pinnedRootOf('s-file')).toBeUndefined()
  })
})
