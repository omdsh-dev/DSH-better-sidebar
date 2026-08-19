import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsWatcherManager, isIgnoredPath } from '../src/fs-watcher.ts'
import { isWin32 } from './platform.ts'

describe('fs-watcher', () => {
  it('ignores generated subdirectory segments but not the workspace root itself', () => {
    // A workspace root literally named build/tmp must stay watched.
    expect(isIgnoredPath('/tmp/build', '/tmp/build')).toBe(false)
    expect(isIgnoredPath('C:\\work\\tmp', 'C:\\work\\tmp')).toBe(false)
    // Generated directories inside the root are ignored.
    expect(isIgnoredPath('/tmp/build/node_modules', '/tmp/build')).toBe(true)
    expect(isIgnoredPath('/tmp/build/src/dist', '/tmp/build')).toBe(true)
    expect(isIgnoredPath('C:\\work\\tmp\\obj', 'C:\\work\\tmp')).toBe(true)
    // Relative Windows watch filenames are filtered the same way.
    expect(isIgnoredPath('src\\node_modules\\x')).toBe(true)
    // Unrelated names are not ignored.
    expect(isIgnoredPath('/tmp/build/buildings', '/tmp/build')).toBe(false)
  })

  // Windows keeps an open fs.watch handle on a watched directory/file, so a
  // parent folder cannot be renamed while any generated child (obj, bin, ...)
  // is still being watched. The watcher must avoid creating per-child handles
  // on Windows; this is a Windows-only filesystem behavior (POSIX allows the
  // rename even with active watches), so the repro is guarded to win32.
  it.skipIf(!isWin32)('does not block moving a folder that contains generated subdirectories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-fs-watcher-test-'))
    const source = join(root, 'src')
    const project = join(source, 'OdxExportNet')
    // obj is in IGNORED; bin deliberately is not. The Windows recursive
    // watcher must handle both without needing to enumerate every generated
    // directory name.
    const obj = join(project, 'obj')
    const bin = join(project, 'bin')
    mkdirSync(obj, { recursive: true })
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(obj, 'file.txt'), 'x')
    writeFileSync(join(bin, 'file.txt'), 'x')

    const manager = new FsWatcherManager()
    const unsubscribe = manager.subscribe(root, () => {})
    // Wait for the watcher to be fully active before trying the rename.
    await new Promise((resolve) => setTimeout(resolve, 1000))

    try {
      const dest = join(root, 'moved')
      expect(() => renameSync(project, dest)).not.toThrow()
    } finally {
      unsubscribe()
      manager.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
