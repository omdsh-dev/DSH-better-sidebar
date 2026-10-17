/**
 * Clue store durability on a failed write (S1).
 *
 * The store's contract is that a mutation either commits or leaves the
 * previous document untouched — a disk failure must never report success and
 * must never replace the committed library with the in-memory mutation. This
 * case fakes the atomic-write step failing (ENOSPC) so no privileges or
 * read-only mounts are needed, which keeps it valid on the Windows lane too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clue } from '../src/clues/types.ts'
import { removeTree } from './temp-tree.ts'

const fault = vi.hoisted(() => ({ failStateWrites: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const writeFile = actual.writeFile as (...args: unknown[]) => Promise<void>
  return {
    ...actual,
    writeFile: async (...args: unknown[]) => {
      if (fault.failStateWrites && String(args[0]).includes('state.json')) {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      }
      return writeFile(...args)
    },
  }
})

// Imported after the mock so the store's atomic writer is the failing one.
const { CluesStore } = await import('../src/clues/store.ts')

const roots: string[] = []

afterEach(() => {
  fault.failStateWrites = false
  for (const path of roots.splice(0)) removeTree(path)
})

/** One valid clue row (the store deep-validates parsed documents). */
function sampleClue(id: string): Clue {
  return {
    id,
    sourceId: 'test.source',
    typeId: 'test.source.text',
    locator: { id },
    title: id,
    workspaceId: 'ws-1',
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  }
}

describe('clue store write failure', () => {
  it('fails the transaction and keeps the committed document intact', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-clues-write-failure-'))
    roots.push(root)
    const store = new CluesStore({ root })
    const first = await store.transact('ws-1', undefined, (state) => {
      state.clues.push(sampleClue('kept'))
    })
    expect(first.revision).toBe(1)

    fault.failStateWrites = true
    await expect(store.transact('ws-1', undefined, (state) => {
      state.clues.push(sampleClue('lost'))
    })).rejects.toMatchObject({ category: 'failed' })

    fault.failStateWrites = false
    const after = await store.read('ws-1')
    // Neither the revision nor the rows advanced: the failed commit is not
    // reported as a success and the old document was never replaced.
    expect(after.revision).toBe(1)
    expect(after.clues.map(clue => clue.id)).toEqual(['kept'])
  })
})
