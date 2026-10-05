/**
 * The host's "new folder" mutation (`fs.mkdir` route → mkdirWorkspaceEntry):
 * shape rules, existence refusal, the root row as a legal PARENT, and the
 * happy path against a real temporary filesystem.
 *
 * The workspace fence is GONE: these cases assert the LEXICAL path is returned
 * as composed (no realpath) and that a parent outside the session workspace is
 * accepted like any other directory the host user can write.
 */
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirWorkspaceEntry } from '../src/fs-operations.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-mkdir-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The wire code of a rejected call (the route maps it to an HTTP status). */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code'
  }
  return 'resolved'
}

describe('mkdirWorkspaceEntry', () => {
  it('creates one directory inside the named row and returns its absolute path', async () => {
    await mkdir(join(root, 'sub'))
    const result = await mkdirWorkspaceEntry({ cwd: root, path: join(root, 'sub'), name: 'fresh' })
    // Lexical: the path comes back exactly as composed (no realpath — on macOS
    // /var would otherwise be reported as /private/var).
    expect(result.path).toBe(join(root, 'sub', 'fresh'))
    expect(await readdir(join(root, 'sub'))).toEqual(['fresh'])
  })

  it('accepts the workspace root itself as the parent', async () => {
    const result = await mkdirWorkspaceEntry({ cwd: root, path: root, name: 'top' })
    expect(result.path).toBe(join(root, 'top'))
    expect(await readdir(root)).toEqual(['top'])
  })

  it('refuses a name that is not a single path segment', async () => {
    expect(await codeOf(() => mkdirWorkspaceEntry({ cwd: root, path: root, name: 'a/b' }))).toBe('bad-request')
    expect(await codeOf(() => mkdirWorkspaceEntry({ cwd: root, path: root, name: '..' }))).toBe('bad-request')
    expect(await codeOf(() => mkdirWorkspaceEntry({ cwd: root, path: root, name: '' }))).toBe('bad-request')
  })

  it('refuses an existing destination with the same conflict code as rename', async () => {
    await mkdir(join(root, 'taken'))
    expect(await codeOf(() => mkdirWorkspaceEntry({ cwd: root, path: root, name: 'taken' }))).toBe('fs-error')
  })

  it('creates a directory under a parent outside the workspace (fence removed)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'))
    try {
      await writeFile(join(outside, 'marker.txt'), 'x')
      // ⚠️ PERMISSION CHANGE: no containment → any writable parent is legal.
      const result = await mkdirWorkspaceEntry({ cwd: root, path: outside, name: 'allowed' })
      expect(result.path).toBe(join(outside, 'allowed'))
      expect(await readdir(outside)).toEqual(['allowed', 'marker.txt'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('creates INSIDE a symlink that points outside the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-link-'))
    try {
      await symlink(outside, join(root, 'escape'))
      // The link is followed like any directory (no realpath guard).
      const result = await mkdirWorkspaceEntry({ cwd: root, path: join(root, 'escape'), name: 'inside-link' })
      expect(result.path).toBe(join(root, 'escape', 'inside-link'))
      expect(await readdir(outside)).toEqual(['inside-link'])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
