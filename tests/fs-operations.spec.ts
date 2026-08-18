import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntry,
  fileVersion,
  moveWorkspaceEntry,
  writeWorkspaceText,
  writeWorkspaceUpload,
} from '../src/fs-operations.ts'
import { SidebarError } from '../src/wire.ts'

const roots: string[] = []
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'sidebar-fs-'))
  roots.push(path)
  return path
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('workspace filesystem operations', () => {
  it('creates, moves, and deletes files and directories without overwriting', async () => {
    const cwd = await workspace()
    const dir = join(cwd, 'docs')
    const source = join(dir, 'draft.md')
    const target = join(dir, 'final.md')
    await createWorkspaceDirectory(cwd, dir)
    await createWorkspaceFile(cwd, source)
    await expect(createWorkspaceFile(cwd, source)).rejects.toMatchObject({ code: 'fs-exists' })
    await moveWorkspaceEntry(cwd, source, target)
    await expect(stat(source)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(target)).isFile()).toBe(true)
    await deleteWorkspaceEntry(cwd, dir)
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('guards saves by version and permits an explicit overwrite', async () => {
    const cwd = await workspace()
    const path = join(cwd, 'note.md')
    await writeFile(path, 'one')
    const base = await fileVersion(path)
    await writeFile(path, 'changed elsewhere')
    await expect(writeWorkspaceText({ cwd, path, content: 'draft', expectedVersion: base }))
      .rejects.toMatchObject({ code: 'fs-conflict' })
    expect(await readFile(path, 'utf8')).toBe('changed elsewhere')
    const saved = await writeWorkspaceText({ cwd, path, content: '', force: true })
    expect(saved.version).toBe(await fileVersion(path))
    expect(await readFile(path, 'utf8')).toBe('')
  })

  it('rejects workspace escape paths and protecting the root', async () => {
    const cwd = await workspace()
    const outside = join(cwd, '..', 'outside.txt')
    await expect(createWorkspaceFile(cwd, outside)).rejects.toBeInstanceOf(SidebarError)
    await expect(deleteWorkspaceEntry(cwd, cwd)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('streams uploads, preserves bytes, and enforces the byte limit', async () => {
    const cwd = await workspace()
    const path = join(cwd, 'assets', 'blob.bin')
    async function* chunks() { yield new Uint8Array([0, 1]); yield new Uint8Array([2, 255]) }
    const result = await writeWorkspaceUpload({ cwd, path, chunks: chunks(), limit: 4 })
    expect(result.size).toBe(4)
    expect([...await readFile(path)]).toEqual([0, 1, 2, 255])

    const tooLarge = join(cwd, 'too-large.bin')
    await expect(writeWorkspaceUpload({ cwd, path: tooLarge, chunks: chunks(), limit: 3 }))
      .rejects.toMatchObject({ code: 'bad-request' })
    await expect(stat(tooLarge)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
