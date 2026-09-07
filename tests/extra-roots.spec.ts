import { afterAll, describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs'
import * as os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSidebarConfig } from '../src/config.ts'
import { ensureWorkspacePath, ensureWorkspaceWritePath } from '../src/path-security.ts'
import { writeWorkspaceUpload } from '../src/fs-operations.ts'

const canSymlink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-extra-symlink-probe-'))
  try {
    symlinkSync('target', join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

describe('resolveSidebarConfig extraRoots', () => {
  afterEach(() => vi.restoreAllMocks())

  it('expands ~ to homedir', () => {
    const home = os.homedir()
    const resolved = resolveSidebarConfig({ extraRoots: ['~/extra'] })
    expect(resolved.extraRoots).toEqual([join(home, 'extra')])
  })

  it('expands lone ~ to homedir', () => {
    const home = os.homedir()
    const resolved = resolveSidebarConfig({ extraRoots: ['~'] })
    expect(resolved.extraRoots).toEqual([home])
  })

  it('throws on non-absolute entry after expansion', () => {
    expect(() => resolveSidebarConfig({ extraRoots: ['relative/path'] })).toThrow(/not an absolute path/)
    expect(() => resolveSidebarConfig({ extraRoots: ['~/../relative'] })).not.toThrow()
    expect(() => resolveSidebarConfig({ extraRoots: ['not-abs'] })).toThrow(/not an absolute path/)
  })

  it('explicit [] means no extra roots', () => {
    const resolved = resolveSidebarConfig({ extraRoots: [] })
    expect(resolved.extraRoots).toEqual([])
  })

  it('removes empty strings and deduplicates', () => {
    const home = os.homedir()
    const p = join(home, 'dup')
    const resolved = resolveSidebarConfig({ extraRoots: [p, '', '  ', p, `${p}/`] })
    // posix.resolve normalizes trailing slash, so dup entries collapse
    expect(resolved.extraRoots).toEqual([p])
  })

  it('defaults to <homedir>/.dsh/external when that directory exists', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-extra-homedir-'))
    const external = join(fakeHome, '.dsh', 'external')
    mkdirSync(external, { recursive: true })
    const prevHome = process.env.HOME
    const prevUserProfile = process.env.USERPROFILE
    process.env.HOME = fakeHome
    // Windows fallback uses USERPROFILE
    process.env.USERPROFILE = fakeHome
    try {
      const resolved = resolveSidebarConfig(undefined)
      expect(resolved.extraRoots).toEqual([external])
      const resolved2 = resolveSidebarConfig({})
      expect(resolved2.extraRoots).toEqual([external])
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = prevUserProfile
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('defaults to [] when <homedir>/.dsh/external does not exist', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-extra-homedir-missing-'))
    // No .dsh/external created
    const prevHome = process.env.HOME
    const prevUserProfile = process.env.USERPROFILE
    process.env.HOME = fakeHome
    process.env.USERPROFILE = fakeHome
    try {
      const resolved = resolveSidebarConfig(undefined)
      expect(resolved.extraRoots).toEqual([])
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = prevUserProfile
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('explicit entries are not checked for existence (pure function)', () => {
    const missing = join(tmpdir(), `dsh-extra-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    // Ensure it does not exist
    expect(existsSync(missing)).toBe(false)
    const resolved = resolveSidebarConfig({ extraRoots: [missing] })
    expect(resolved.extraRoots).toEqual([missing])
  })
})

describe('ensureWorkspacePath with extraRoots', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-extra-path-'))
  const workspace = join(root, 'workspace')
  const extra = join(root, 'extra')
  const outside = join(root, 'outside')
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  beforeEach(() => {
    mkdirSync(workspace, { recursive: true })
    mkdirSync(extra, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(workspace, 'inside.txt'), 'ws')
    writeFileSync(join(extra, 'extra.txt'), 'extra')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
  })
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(extra, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('allows reading a file inside an extra root', async () => {
    const p = await ensureWorkspacePath(workspace, join(extra, 'extra.txt'), [extra])
    expect(p).toBe(join(extra, 'extra.txt'))
  })

  it('still forbids files outside any allowed root', async () => {
    await expect(ensureWorkspacePath(workspace, join(outside, 'secret.txt'), [extra])).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('is outside workspace'),
    })
  })

  it('skips non-existent extra roots without error', async () => {
    const missing = join(root, 'missing-root')
    // Reading inside existing extra should still succeed even with a missing root in list
    const p = await ensureWorkspacePath(workspace, join(extra, 'extra.txt'), [missing, extra])
    expect(p).toBe(join(extra, 'extra.txt'))
    // Reading outside should still 403, missing root does not grant access
    await expect(ensureWorkspacePath(workspace, join(outside, 'secret.txt'), [missing])).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it.skipIf(!canSymlink)('rejects symlink inside extra root that points outside', async () => {
    const targetOutside = join(outside, 'secret.txt')
    const link = join(extra, 'link-out')
    symlinkSync(targetOutside, link)
    await expect(ensureWorkspacePath(workspace, link, [extra])).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('allows writing a new file inside an extra root (missing target)', async () => {
    const target = join(extra, 'newdir', 'new.txt')
    const p = await ensureWorkspaceWritePath(workspace, target, [extra])
    expect(p).toBe(target)
    // Ensure we can actually write via the returned canonical path
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, 'hello')
    expect(readFileSync(target, 'utf8')).toBe('hello')
  })

  it('still forbids writing outside allowed roots', async () => {
    await expect(ensureWorkspaceWritePath(workspace, join(outside, 'new.txt'), [extra])).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it.skipIf(!canSymlink)('rejects symlink write through extra root that escapes', async () => {
    const linkOut = join(workspace, 'link')
    symlinkSync(outside, linkOut)
    await expect(ensureWorkspaceWritePath(workspace, join(linkOut, 'new.txt'), [extra])).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('skips non-existent extra root for write validation', async () => {
    const missing = join(root, 'missing-root-write')
    const target = join(extra, 'another.txt')
    const p = await ensureWorkspaceWritePath(workspace, target, [missing, extra])
    expect(p).toBe(target)
  })
})

describe('writeWorkspaceUpload with extraRoots', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-extra-upload-'))
  const workspace = join(root, 'workspace')
  const extra = join(root, 'extra-upload')
  const outside = join(root, 'outside-upload')
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  beforeEach(() => {
    mkdirSync(workspace, { recursive: true })
    mkdirSync(extra, { recursive: true })
    mkdirSync(outside, { recursive: true })
  })
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(extra, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  function chunksOf(text: string): AsyncIterable<string | Uint8Array> {
    return {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < text.length; i += 2) yield text.slice(i, i + 2)
      },
    }
  }

  it('writes a file inside an extra root', async () => {
    const { path, size } = await writeWorkspaceUpload({
      cwd: workspace,
      dir: extra,
      relativePath: 'a.txt',
      chunks: chunksOf('hello extra'),
      limit: 1024,
      extraRoots: [extra],
    })
    expect(path).toBe(join(extra, 'a.txt'))
    expect(size).toBe(Buffer.byteLength('hello extra'))
    expect(readFileSync(path, 'utf8')).toBe('hello extra')
  })

  it('writes a new nested file inside extra root when directory does not exist yet', async () => {
    const { path } = await writeWorkspaceUpload({
      cwd: workspace,
      dir: extra,
      relativePath: 'nested/deep.txt',
      chunks: chunksOf('x'),
      limit: 1024,
      extraRoots: [extra],
    })
    expect(existsSync(path)).toBe(true)
  })

  it('still forbids upload outside allowed roots', async () => {
    await expect(
      writeWorkspaceUpload({
        cwd: workspace,
        dir: outside,
        relativePath: 'x.txt',
        chunks: chunksOf('x'),
        limit: 1024,
        extraRoots: [extra],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('skips missing extra root and still allows upload to existing extra root', async () => {
    const missing = join(root, 'missing-upload-root')
    const { path } = await writeWorkspaceUpload({
      cwd: workspace,
      dir: extra,
      relativePath: 'b.txt',
      chunks: chunksOf('y'),
      limit: 1024,
      extraRoots: [missing, extra],
    })
    expect(existsSync(path)).toBe(true)
  })
})
