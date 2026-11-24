/**
 * Host drive enumeration for the shell browser's "This PC" view.
 *
 * Windows probes each letter with `stat` and keeps the directories; POSIX
 * returns a single `/` root. The test is platform-independent: on Windows it
 * checks the shape and that at least the current drive appears, on POSIX it
 * checks the single root.
 */
import { describe, expect, it } from 'vitest'
import { listDrives } from '../src/fs-drives.ts'
import { isWin32 } from './platform.ts'

describe('fs-drives', () => {
  it('returns the filesystem roots in the shape the picker expects', async () => {
    const { drives } = await listDrives()
    expect(drives.length).toBeGreaterThan(0)
    for (const drive of drives) {
      expect(typeof drive.name).toBe('string')
      expect(typeof drive.path).toBe('string')
    }
    if (isWin32) {
      // Every drive is a letter root and the current one must be present.
      for (const drive of drives) {
        expect(drive.name).toMatch(/^[A-Z]:$/)
        expect(drive.path).toBe(`${drive.name}\\`)
      }
      expect(drives.some(d => d.name === 'C:')).toBe(true)
    } else {
      expect(drives).toEqual([{ name: '/', path: '/' }])
    }
  })
})
