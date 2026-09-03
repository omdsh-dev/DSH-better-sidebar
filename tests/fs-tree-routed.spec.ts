/**
 * Routed filesystem listing: workspace anchors can represent files in another
 * execution world (for example dsh-ssh-remote). The explorer must list through
 * the host filesystem service instead of re-reading the empty local anchor.
 */
import { describe, expect, it, vi } from 'vitest'
import { listDirectoryWith, type SidebarFileSystem } from '../src/fs-tree.ts'

const root = '/home/me/.dsh/ssh-workspace-anchors/project'

/** Minimal filesystem fake for the listing seam. */
function fakeFs(entries: Array<{
  name: string
  type: 'file' | 'directory' | 'other'
  target: { targetKey: string; displayPath: string }
  size?: number
}>): SidebarFileSystem & {
  resolve: ReturnType<typeof vi.fn>
  lstat: ReturnType<typeof vi.fn>
  stat: ReturnType<typeof vi.fn>
  listDir: ReturnType<typeof vi.fn>
} {
  return {
    resolve: vi.fn(async (path: string) => ({ targetKey: `ssh://gpu${path}`, displayPath: 'gpu:/work/project' })),
    lstat: vi.fn(async (_path: string) => ({ type: 'file' as const })),
    stat: vi.fn(async (_target: { targetKey: unknown; displayPath: string }) => ({ type: 'file' as const })),
    listDir: vi.fn(async (_target: { targetKey: unknown; displayPath: string }) => entries),
  }
}

describe('fs-tree routed filesystem listing', () => {
  it('lists and classifies remote children through the filesystem service', async () => {
    const fs = fakeFs([
      { name: 'src', type: 'directory', target: { targetKey: 'ssh://gpu/work/project/src', displayPath: 'gpu:/work/project/src' } },
      { name: '.env', type: 'file', target: { targetKey: 'ssh://gpu/work/project/.env', displayPath: 'gpu:/work/project/.env' }, size: 7 },
      { name: 'link', type: 'other', target: { targetKey: 'ssh://gpu/work/project/link', displayPath: 'gpu:/work/project/link' } },
    ])

    const listing = await listDirectoryWith(fs, root, 1000)

    expect(fs.resolve).toHaveBeenCalledWith(root)
    expect(fs.listDir).toHaveBeenCalledWith(expect.objectContaining({ targetKey: `ssh://gpu${root}` }))
    expect(listing).toEqual({
      path: root,
      entries: [
        { name: 'src', path: `${root}/src`, isDir: true, hidden: false, isSymlink: false, broken: false },
        { name: '.env', path: `${root}/.env`, isDir: false, hidden: true, isSymlink: false, broken: false },
        { name: 'link', path: `${root}/link`, isDir: false, hidden: false, isSymlink: false, broken: false },
      ],
      truncated: false,
    })
  })

  it('preserves routed symlink classification without local filesystem probes', async () => {
    const fs = fakeFs([
      { name: 'linked-docs', type: 'other', target: { targetKey: 'ssh://gpu/work/shared-docs', displayPath: 'gpu:/work/shared-docs' } },
      { name: 'dangling', type: 'other', target: { targetKey: 'ssh://gpu/work/missing', displayPath: 'gpu:/work/missing' } },
    ])
    fs.lstat.mockImplementation(async (path: string) => path.endsWith('linked-docs') || path.endsWith('dangling')
      ? { type: 'symlink' as const }
      : { type: 'file' as const })
    fs.stat.mockImplementation(async (target: { targetKey: string }) => target.targetKey.endsWith('shared-docs')
      ? { type: 'directory' as const }
      : undefined)

    const listing = await listDirectoryWith(fs, root)

    expect(listing.entries).toEqual([
      expect.objectContaining({ name: 'linked-docs', isDir: true, isSymlink: true, broken: false }),
      expect.objectContaining({ name: 'dangling', isDir: false, isSymlink: true, broken: true }),
    ])
  })

  it('applies the explorer row limit after remote listing', async () => {
    const fs = fakeFs([
      { name: 'a', type: 'directory', target: { targetKey: 'a', displayPath: 'a' } },
      { name: 'b', type: 'file', target: { targetKey: 'b', displayPath: 'b' } },
    ])

    const listing = await listDirectoryWith(fs, root, 1)
    expect(listing.entries.map(entry => entry.name)).toEqual(['a'])
    expect(listing.truncated).toBe(true)
  })
})
