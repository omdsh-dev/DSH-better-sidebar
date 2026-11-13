/**
 * `builtin.files` pagination bound (S1).
 *
 * A page whose next offset would exceed the source's own cursor bound must
 * NOT emit that cursor: the source would reject it on the following request.
 * The filesystem walkers are faked here so the case can exercise a 10,501-row
 * level (`offset + limit` crossing MAX_PAGE_OFFSET) without creating ten
 * thousand files on every CI run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCluesService, type CluesService } from '../src/clues/service.ts'
import type { SidebarFsEntry } from '../src/fs-tree.ts'
import { removeTree } from './temp-tree.ts'

interface MockedSearch {
  /** Raw matches the walker/engine would have found. */
  matches: string[]
}

const mocked = vi.hoisted(() => ({
  entries: [] as unknown[],
  search: { matches: [] } as MockedSearch,
}))

vi.mock('../src/fs-tree.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fs-tree.ts')>()
  return {
    ...actual,
    listDirectory: async (_path: string, maxEntries: number) => {
      const entries = mocked.entries as SidebarFsEntry[]
      return {
        path: '',
        entries: entries.slice(0, maxEntries),
        truncated: entries.length > maxEntries,
      }
    },
  }
})

vi.mock('../src/fs-search.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/fs-search.ts')>()
  const mockedSearch = (): MockedSearch => mocked.search as MockedSearch
  return {
    ...actual,
    searchFiles: async (_root: string, _query: string, options?: { maxMatches?: number }) => {
      const maxMatches = options?.maxMatches ?? 200
      const raw = mockedSearch().matches
      return {
        matches: raw.slice(0, maxMatches),
        dirs: [],
        truncated: raw.length > maxMatches,
      }
    },
  }
})

// Imported after the mocks so the source sees the fakes.
const { createLocalFileSource } = await import('../src/clues/local-files.ts')

const roots: string[] = []
const WORKSPACE_ID = 'ws-1'

afterEach(() => {
  mocked.entries.length = 0
  mocked.search.matches = []
  for (const path of roots.splice(0)) removeTree(path)
})

/** A service backed by a real (empty) workspace directory and the fake walkers. */
function fixture(): CluesService {
  const base = mkdtempSync(join(tmpdir(), 'dsh-clues-page-'))
  roots.push(base)
  const workspace = join(base, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const service = createCluesService({
    root: join(base, 'store'),
    builtinSources: [createLocalFileSource()],
    resolveWorkspacePath: id => (id === WORKSPACE_ID ? workspace : undefined),
  })
  return service
}

/** One fake listing row. */
function row(index: number): SidebarFsEntry {
  const name = `f${String(index).padStart(5, '0')}.txt`
  return { name, path: name, isDir: false, hidden: false, isSymlink: false, broken: false }
}

/** The bound the source's own cursor parser enforces. */
const MAX_PAGE_OFFSET = 10_000

describe('builtin.files pagination bound', () => {
  it('does not emit a list cursor the source would reject', async () => {
    const service = fixture()
    mocked.entries = Array.from({ length: MAX_PAGE_OFFSET + 501 }, (_, index) => row(index))

    const crossing = await service.list({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      cursor: String(MAX_PAGE_OFFSET),
      limit: 500,
    })
    expect(crossing.items).toHaveLength(500)
    // The underlying level has more rows, but the next offset (10500) is
    // beyond the source bound: the walk ENDS here (`limited` stays true).
    expect(crossing.nextCursor).toBeUndefined()
    expect(crossing.limited).toBe(true)

    // A page that stays inside the bound still hands out the next cursor.
    const inside = await service.list({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      cursor: String(MAX_PAGE_OFFSET - 100),
      limit: 100,
    })
    expect(inside.nextCursor).toBe(String(MAX_PAGE_OFFSET))
    // …and following it is accepted rather than refused.
    await expect(service.list({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      cursor: inside.nextCursor,
      limit: 100,
    })).resolves.toMatchObject({ items: expect.any(Array) })
  })

  it('does not emit a search cursor the source would reject', async () => {
    const service = fixture()
    mocked.search.matches = Array.from(
      { length: MAX_PAGE_OFFSET + 501 },
      (_, index) => `f${String(index).padStart(5, '0')}.txt`,
    )

    const crossing = await service.search({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      query: 'f',
      cursor: String(MAX_PAGE_OFFSET),
      limit: 500,
    })
    expect(crossing.items).toHaveLength(500)
    expect(crossing.nextCursor).toBeUndefined()
    expect(crossing.limited).toBe(true)
  })

  it('still paginates ordinary pages with an opaque numeric cursor', async () => {
    const service = fixture()
    mocked.entries = [row(0), row(1), row(2)]

    const first = await service.list({ workspaceId: WORKSPACE_ID, sourceId: 'builtin.files', limit: 2 })
    expect(first.nextCursor).toBe('2')
    const second = await service.list({
      workspaceId: WORKSPACE_ID,
      sourceId: 'builtin.files',
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.items.map(item => item.title)).toEqual(['f00002.txt'])
    expect(second.nextCursor).toBeUndefined()
  })
})
