import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeWorkspaceUpload } from '../src/fs-operations.ts'

/** The test workspace root (each suite gets its own temp tree). */
const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-upload-'))

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

  it('refuses an upload directory outside the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dsh-sidebar-upload-outside-'))
    try {
      await expect(writeWorkspaceUpload({
        cwd: root, dir: outside, relativePath: 'x.txt', chunks: chunksOf('x'), limit: 1024,
      })).rejects.toMatchObject({ code: 'forbidden' })
    } finally {
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
