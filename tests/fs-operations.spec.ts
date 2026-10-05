import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { renameWorkspaceEntry, removeWorkspaceEntry, mkdirWorkspaceEntry, writeWorkspaceUpload } from '../src/fs-operations.ts'

/** The test workspace root (each suite gets its own temp tree). */
const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-upload-'))

/** Symlink creation needs privileges on Windows; the link cases skip there. */
const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-upload-probe-'))
  try {
    symlinkSync(dir, join(dir, 'probe-link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Names of leftover temp files under `dir` (must be empty after every run). */
function tmpLeftovers(dir: string): string[] {
  return readdirSync(dir).filter(name => name.includes('.dsh-upload-'))
}

/** Turn a string into the async-iterable chunk shape the route receives. */
function chunksOf(text: string): AsyncIterable<string | Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      // Split on two-byte boundaries so UTF-8 multi-byte sequences cross
      // chunk edges (streaming must reassemble them as raw bytes, not text).
      for (let i = 0; i < text.length; i += 2) yield text.slice(i, i + 2)
    },
  }
}

describe('writeWorkspaceUpload', () => {
  it('writes a file under the upload directory and returns its size', async () => {
    const { path, size } = await writeWorkspaceUpload({
      cwd: root,
      dir: root,
      relativePath: 'a.txt',
      chunks: chunksOf('hello 世界'),
      limit: 1024,
    })
    expect(path).toBe(join(root, 'a.txt'))
    expect(size).toBe(Buffer.byteLength('hello 世界'))
    expect(readFileSync(path, 'utf8')).toBe('hello 世界')
  })

  it('creates nested directories on demand (folder uploads)', async () => {
    const { path } = await writeWorkspaceUpload({
      cwd: root,
      dir: root,
      relativePath: 'docs/nested/deep.txt',
      chunks: chunksOf('x'),
      limit: 1024,
    })
    expect(existsSync(path)).toBe(true)
  })

  it('resolves relativePaths against the chosen directory', async () => {
    const { path } = await writeWorkspaceUpload({
      cwd: root,
      dir: join(root, 'docs'),
      relativePath: 'b.txt',
      chunks: chunksOf('y'),
      limit: 1024,
    })
    expect(path).toBe(join(root, 'docs', 'b.txt'))
  })

  it('refuses traversal, empty segments, and absolute relativePaths', async () => {
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: '../evil.txt', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: './a.txt', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: 'a/../b.txt', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: '//', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    // Empty segments are refused, not silently collapsed.
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: 'a//b.txt', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: 'a/b/', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    // Absolute paths (POSIX and Windows separators) are refused, not re-anchored.
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: '/x.txt', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: '\\x.txt', chunks: chunksOf('x'), limit: 1024,
    })).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('uploads into a directory outside the workspace (containment was removed)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-sidebar-upload-outside-'))
    try {
      // ⚠️ PERMISSION CHANGE: the workspace fence is gone, so an absolute
      // directory the host user can write is a valid upload target.
      const result = await writeWorkspaceUpload({
        cwd: root, dir: outside, relativePath: 'x.txt', chunks: chunksOf('x'), limit: 1024,
      })
      expect(result).toEqual({ path: join(outside, 'x.txt'), size: 1 })
      expect(readFileSync(join(outside, 'x.txt'), 'utf8')).toBe('x')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('follows an upload directory symlink outside the workspace (no realpath guard)', async () => {
    if (!canSymlink) return
    const outside = mkdtempSync(join(tmpdir(), 'dsh-sidebar-upload-symlink-outside-'))
    const link = join(root, 'upload-link')
    try {
      symlinkSync(outside, link)
      const viaLink = await writeWorkspaceUpload({
        cwd: root, dir: link, relativePath: 'a.txt', chunks: chunksOf('a'), limit: 1024,
      })
      expect(viaLink.path).toBe(join(link, 'a.txt'))
      // …and a relative path that walks through the link lands there too.
      const viaRelative = await writeWorkspaceUpload({
        cwd: root, dir: root, relativePath: 'upload-link/b.txt', chunks: chunksOf('b'), limit: 1024,
      })
      expect(viaRelative.path).toBe(join(root, 'upload-link', 'b.txt'))
      expect(readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('a')
      expect(readFileSync(join(outside, 'b.txt'), 'utf8')).toBe('b')
    } finally {
      rmSync(link, { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses oversized uploads without leaving a target or temp file', async () => {
    const target = join(root, 'big.bin')
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: 'big.bin', chunks: chunksOf('1234567890'), limit: 4,
    })).rejects.toMatchObject({ code: 'too-large' })
    expect(existsSync(target)).toBe(false)
    expect(tmpLeftovers(root)).toEqual([])
  })

  it('keeps concurrent uploads to the same target independent', async () => {
    const target = join(root, 'race.txt')
    await Promise.all([
      writeWorkspaceUpload({ cwd: root, dir: root, relativePath: 'race.txt', chunks: chunksOf('first'), limit: 1024 }),
      writeWorkspaceUpload({ cwd: root, dir: root, relativePath: 'race.txt', chunks: chunksOf('second'), limit: 1024 }),
    ])
    // Both renames succeed (unique temp names, no EEXIST cross-talk); the last
    // rename wins and the losers leave nothing behind.
    expect(['first', 'second']).toContain(readFileSync(target, 'utf8'))
    expect(tmpLeftovers(root)).toEqual([])
  })

  it('does not overwrite an existing file on a failed (oversized) retry', async () => {
    const target = join(root, 'keep.txt')
    await writeWorkspaceUpload({ cwd: root, dir: root, relativePath: 'keep.txt', chunks: chunksOf('original'), limit: 1024 })
    await expect(writeWorkspaceUpload({
      cwd: root, dir: root, relativePath: 'keep.txt', chunks: chunksOf('0123456789'), limit: 2,
    })).rejects.toMatchObject({ code: 'too-large' })
    expect(readFileSync(target, 'utf8')).toBe('original')
  })
})

describe('renameWorkspaceEntry', () => {
  it('renames a file within its directory', async () => {
    writeFileSync(join(root, 'old-name.txt'), 'x')
    const { path } = await renameWorkspaceEntry({ cwd: root, path: join(root, 'old-name.txt'), name: 'new-name.txt' })
    // The returned path is CANONICAL (realpath-resolved ancestors — on macOS
    // the tmpdir's /var becomes /private/var), so assert the shape, not the
    // lexical spelling.
    expect(path.endsWith('new-name.txt')).toBe(true)
    expect(existsSync(join(root, 'old-name.txt'))).toBe(false)
    expect(existsSync(join(root, 'new-name.txt'))).toBe(true)
  })

  it('renames a directory (recursive content moves with it)', async () => {
    mkdirSync(join(root, 'olddir/nested'), { recursive: true })
    writeFileSync(join(root, 'olddir/nested/deep.txt'), 'x')
    await renameWorkspaceEntry({ cwd: root, path: join(root, 'olddir'), name: 'newdir' })
    expect(readFileSync(join(root, 'newdir/nested/deep.txt'), 'utf8')).toBe('x')
  })

  it('is a no-op for the same name (destination-exists refusal must not bite)', async () => {
    writeFileSync(join(root, 'same.txt'), 'x')
    await renameWorkspaceEntry({ cwd: root, path: join(root, 'same.txt'), name: 'same.txt' })
    expect(existsSync(join(root, 'same.txt'))).toBe(true)
  })

  it('refuses single-segment violations (empty, dot, traversal, separators)', async () => {
    writeFileSync(join(root, 'r.txt'), 'x')
    for (const name of ['', '.', '..', 'a/b', 'a\\b']) {
      await expect(renameWorkspaceEntry({ cwd: root, path: join(root, 'r.txt'), name }))
        .rejects.toMatchObject({ code: 'bad-request' })
    }
  })

  it('refuses an existing destination instead of clobbering it', async () => {
    writeFileSync(join(root, 'src.txt'), 'src')
    writeFileSync(join(root, 'dst.txt'), 'dst')
    await expect(renameWorkspaceEntry({ cwd: root, path: join(root, 'src.txt'), name: 'dst.txt' }))
      .rejects.toMatchObject({ code: 'fs-error', status: 409 })
    expect(readFileSync(join(root, 'dst.txt'), 'utf8')).toBe('dst')
  })

  it('refuses the workspace root and missing sources', async () => {
    await expect(renameWorkspaceEntry({ cwd: root, path: root, name: 'nope' }))
      .rejects.toMatchObject({ code: 'fs-error' })
    await expect(renameWorkspaceEntry({ cwd: root, path: join(root, 'missing.txt'), name: 'x' }))
      .rejects.toMatchObject({ code: 'fs-error' })
  })

  it('renames a symlink ROW, not its target', async () => {
    writeFileSync(join(root, 'target.txt'), 't')
    symlinkSync(join(root, 'target.txt'), join(root, 'alias.txt'))
    await renameWorkspaceEntry({ cwd: root, path: join(root, 'alias.txt'), name: 'alias2.txt' })
    expect(existsSync(join(root, 'alias.txt'))).toBe(false)
    expect(existsSync(join(root, 'alias2.txt'))).toBe(true)
    expect(readFileSync(join(root, 'target.txt'), 'utf8')).toBe('t')
  })
})

describe('removeWorkspaceEntry', () => {
  it('unlinks a file', async () => {
    writeFileSync(join(root, 'gone.txt'), 'x')
    await removeWorkspaceEntry({ cwd: root, path: join(root, 'gone.txt') })
    expect(existsSync(join(root, 'gone.txt'))).toBe(false)
  })

  it('removes a directory recursively', async () => {
    mkdirSync(join(root, 'tree/sub'), { recursive: true })
    writeFileSync(join(root, 'tree/sub/leaf.txt'), 'x')
    await removeWorkspaceEntry({ cwd: root, path: join(root, 'tree') })
    expect(existsSync(join(root, 'tree'))).toBe(false)
  })

  it('unlinks a symlink row without touching (or recursing into) its target', async () => {
    mkdirSync(join(root, 'realdir'), { recursive: true })
    writeFileSync(join(root, 'realdir/keep.txt'), 'x')
    symlinkSync(join(root, 'realdir'), join(root, 'linkdir'))
    await removeWorkspaceEntry({ cwd: root, path: join(root, 'linkdir') })
    expect(existsSync(join(root, 'linkdir'))).toBe(false)
    expect(readFileSync(join(root, 'realdir/keep.txt'), 'utf8')).toBe('x')
  })

  it('refuses the workspace root and missing paths', async () => {
    await expect(removeWorkspaceEntry({ cwd: root, path: root }))
      .rejects.toMatchObject({ code: 'fs-error' })
    await expect(removeWorkspaceEntry({ cwd: root, path: join(root, 'no-such.txt') }))
      .rejects.toMatchObject({ code: 'fs-error' })
  })
})

describe('session-relative targets (the shared resolution contract, #646)', () => {
  it('uploads into a session-relative directory', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-sidebar-relupload-'))
    try {
      const { path, size } = await writeWorkspaceUpload({
        cwd: ws,
        dir: '.',
        relativePath: 'up/rel.txt',
        chunks: chunksOf('rel'),
        limit: 64,
      })
      expect(path).toBe(join(ws, 'up', 'rel.txt'))
      expect(size).toBe(3)
      expect(readFileSync(path, 'utf8')).toBe('rel')
      expect(tmpLeftovers(ws)).toEqual([])
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('renames a session-relative row', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-sidebar-relrename-'))
    try {
      writeFileSync(join(ws, 'a.txt'), 'x')
      const renamed = await renameWorkspaceEntry({ cwd: ws, path: 'a.txt', name: 'b.txt' })
      expect(renamed.path).toBe(join(ws, 'b.txt'))
      expect(existsSync(join(ws, 'b.txt'))).toBe(true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('removes a session-relative row', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-sidebar-relremove-'))
    try {
      writeFileSync(join(ws, 'gone.txt'), 'x')
      const removed = await removeWorkspaceEntry({ cwd: ws, path: 'gone.txt' })
      expect(removed.path).toBe(join(ws, 'gone.txt'))
      expect(existsSync(join(ws, 'gone.txt'))).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('mkdirs under a session-relative parent', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-sidebar-relmkdir-'))
    try {
      const made = await mkdirWorkspaceEntry({ cwd: ws, path: '.', name: 'sub' })
      expect(made.path).toBe(join(ws, 'sub'))
      expect(existsSync(join(ws, 'sub'))).toBe(true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})
