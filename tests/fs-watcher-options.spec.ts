import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsWatcherManager } from '../src/fs-watcher.ts'

const watchMock = vi.hoisted(() => vi.fn())

vi.mock('chokidar', () => ({
  watch: watchMock,
}))

const fakeWatcher = {
  on: vi.fn(),
  close: vi.fn(async () => {}),
}

let originalPlatform: NodeJS.Platform

beforeEach(() => {
  originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  watchMock.mockClear()
  watchMock.mockReturnValue(fakeWatcher)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

describe('fs-watcher chokidar options', () => {
  it('creates the chokidar watcher without following symlinks and with root-aware ignores', async () => {
    const { FsWatcherManager } = await import('../src/fs-watcher.ts')
    const manager: FsWatcherManager = new FsWatcherManager()
    const unsubscribe = manager.subscribe('/work/build', () => {})

    expect(watchMock).toHaveBeenCalledTimes(1)
    const options = watchMock.mock.calls[0]![1] as {
      ignored: (path: string) => boolean
      followSymlinks: boolean
      depth: number
    }
    expect(options.followSymlinks).toBe(false)
    expect(options.depth).toBe(4)
    // A root named build is not ignored; a generated subdirectory is.
    expect(options.ignored('/work/build')).toBe(false)
    expect(options.ignored('/work/build/node_modules')).toBe(true)
    expect(options.ignored('/work/build/dist')).toBe(true)

    unsubscribe()
    manager.dispose()
  })
})
