import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, SidebarApiError, type SessionScope } from '../src/client/api.ts'
import {
  MAX_UPLOAD_BYTES, summarizeResults, uploadHintText, uploadItemsFromDrop, uploadItemsFromFiles,
  uploadToDir, type UploadItem,
} from '../src/client/upload.ts'

/** Fake t(): returns the key (and params) so assertions see which copy fired. */
const t: Parameters<typeof summarizeResults>[1] = (key, params) =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`

const scope: SessionScope = { sessionId: 's', cwd: '/ws' }

/** A File with an optional webkitRelativePath (folder entries). */
function fileOf(name: string, rel?: string): File {
  const file = new File(['x'], name)
  if (rel !== undefined) Object.defineProperty(file, 'webkitRelativePath', { value: rel })
  return file
}

const items = (names: string[]): UploadItem[] =>
  names.map(name => ({ file: fileOf(name), relativePath: name }))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('uploadItemsFromFiles', () => {
  it('keeps plain file names as their relative path', () => {
    expect(uploadItemsFromFiles([fileOf('a.txt')])).toEqual([{ file: expect.any(File), relativePath: 'a.txt' }])
  })

  it('keeps the directory structure of folder entries', () => {
    expect(uploadItemsFromFiles([fileOf('a.txt', 'docs/nested/a.txt')]))
      .toEqual([{ file: expect.any(File), relativePath: 'docs/nested/a.txt' }])
  })

  it('rejects absolute paths (POSIX, Windows separators, drive letters)', () => {
    expect(uploadItemsFromFiles([
      fileOf('a', '/abs.txt'),
      fileOf('a', '\\abs.txt'),
      fileOf('a', 'C:/abs.txt'),
    ])).toEqual([])
  })

  it('rejects traversal and empty segments', () => {
    expect(uploadItemsFromFiles([
      fileOf('a', 'a/../b.txt'),
      fileOf('a', './a.txt'),
      fileOf('a', 'a//b.txt'),
    ])).toEqual([])
  })
})

describe('uploadItemsFromDrop', () => {
  /** A DataTransfer stub: flat file list, no entry API. */
  const dataOf = (files: File[], items: unknown[] = []): DataTransfer =>
    ({ files, items }) as unknown as DataTransfer
  /** A dropped file entry stub (webkitGetAsEntry world). */
  const fileEntryOf = (name: string): FileSystemEntry =>
    ({
      isFile: true, isDirectory: false, name,
      file: (ok: (file: File) => void) => { ok(new File(['x'], name)) },
    }) as unknown as FileSystemEntry
  /** A dropped directory entry stub: readEntries serves one batch, then empty. */
  const dirEntryOf = (name: string, children: FileSystemEntry[]): FileSystemEntry =>
    ({
      isFile: false, isDirectory: true, name,
      createReader: () => {
        let drained = false
        return {
          readEntries: (ok: (entries: FileSystemEntry[]) => void) => {
            ok(drained ? [] : children)
            drained = true
          },
        }
      },
    }) as unknown as FileSystemEntry
  const itemOf = (entry: FileSystemEntry): unknown => ({ kind: 'file', webkitGetAsEntry: () => entry })

  it('falls back to the flat file list when the entry API is unavailable', async () => {
    const data = dataOf([fileOf('a.txt'), fileOf('b.txt', 'dir/b.txt')])
    const items = await uploadItemsFromDrop(data)
    expect(items.map(item => item.relativePath)).toEqual(['a.txt', 'dir/b.txt'])
  })

  it('returns nothing for an empty drop', async () => {
    expect(await uploadItemsFromDrop(undefined)).toEqual([])
  })

  it('traverses dropped directories, keeping every nested relative path', async () => {
    const tree = dirEntryOf('docs', [
      fileEntryOf('a.txt'),
      dirEntryOf('nested', [fileEntryOf('b.txt')]),
    ])
    const data = dataOf([], [itemOf(fileEntryOf('top.txt')), itemOf(tree)])
    const items = await uploadItemsFromDrop(data)
    expect(items.map(item => item.relativePath)).toEqual(['top.txt', 'docs/a.txt', 'docs/nested/b.txt'])
  })

  it('skips an unreadable entry instead of failing the whole drop', async () => {
    const broken = {
      isFile: true, isDirectory: false, name: 'bad.txt',
      file: (_ok: unknown, fail: (error: Error) => void) => { fail(new Error('denied')) },
    } as unknown as FileSystemEntry
    const data = dataOf([], [itemOf(broken), itemOf(fileEntryOf('good.txt'))])
    const items = await uploadItemsFromDrop(data)
    expect(items.map(item => item.relativePath)).toEqual(['good.txt'])
  })

  it('sanitizes entry-derived paths (absolute and traversal segments rejected)', async () => {
    const data = dataOf([], [itemOf(dirEntryOf('..', [fileEntryOf('evil.txt')]))])
    expect(await uploadItemsFromDrop(data)).toEqual([])
  })
})

describe('uploadHintText', () => {
  it('shows the target directory while no file is in flight', () => {
    expect(uploadHintText(0, 3, '', '/ws', t)).toBe('uploadingTo:{"dir":"/ws"}')
  })

  it('shows per-file progress once a file is being uploaded', () => {
    expect(uploadHintText(1, 3, 'docs/a.txt', '/ws', t)).toBe('uploadProgress:{"done":1,"total":3,"name":"docs/a.txt"}')
  })
})

describe('summarizeResults', () => {
  it('reports the uploaded count when everything succeeded', () => {
    expect(summarizeResults([
      { relativePath: 'a.txt', ok: true, path: '/ws/a.txt' },
      { relativePath: 'b.txt', ok: true, path: '/ws/b.txt' },
    ], t)).toBe('uploadDone:{"count":2}')
  })

  it('localizes the too-large wire code instead of showing the raw message', () => {
    expect(summarizeResults([
      { relativePath: 'big.bin', ok: false, code: 'too-large', error: 'upload exceeds the 134217728 byte limit' },
    ], t)).toBe('uploadFailed:{"error":"uploadTooLarge"}')
  })

  it('passes through other failures raw, falling back to the unknown copy', () => {
    expect(summarizeResults([
      { relativePath: 'a.txt', ok: false, error: 'boom' },
    ], t)).toBe('uploadFailed:{"error":"boom"}')
    expect(summarizeResults([
      { relativePath: 'a.txt', ok: false, code: 'internal' },
    ], t)).toBe('uploadFailed:{"error":"uploadFailedUnknown"}')
  })
})

describe('uploadToDir', () => {
  it('uploads every item sequentially and reports progress', async () => {
    const spy = vi.spyOn(api, 'uploadFile')
      .mockResolvedValueOnce({ path: '/ws/a.txt', size: 1 })
      .mockResolvedValueOnce({ path: '/ws/b.txt', size: 1 })
    const progress: Array<[number, number, string]> = []
    const results = await uploadToDir(scope, '/ws', items(['a.txt', 'b.txt']), (done, total, current) => {
      progress.push([done, total, current])
    })
    expect(results).toEqual([
      { relativePath: 'a.txt', ok: true, path: '/ws/a.txt' },
      { relativePath: 'b.txt', ok: true, path: '/ws/b.txt' },
    ])
    expect(spy).toHaveBeenCalledTimes(2)
    expect(progress).toEqual([
      [0, 2, 'a.txt'],
      [1, 2, 'b.txt'],
      [2, 2, ''],
    ])
  })

  it('pre-checks the client cap without calling the route', async () => {
    const spy = vi.spyOn(api, 'uploadFile')
    const big = fileOf('big.bin')
    Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES + 1 })
    const results = await uploadToDir(scope, '/ws', [{ file: big, relativePath: 'big.bin' }])
    expect(results).toEqual([{ relativePath: 'big.bin', ok: false, code: 'too-large' }])
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps the wire error code from the route', async () => {
    vi.spyOn(api, 'uploadFile').mockRejectedValueOnce(new SidebarApiError('forbidden', 'target escapes the session workspace'))
    const results = await uploadToDir(scope, '/ws', items(['a.txt']))
    expect(results).toEqual([{
      relativePath: 'a.txt', ok: false, code: 'forbidden', error: 'target escapes the session workspace',
    }])
  })

  it('an already-aborted signal uploads nothing', async () => {
    const spy = vi.spyOn(api, 'uploadFile')
    const controller = new AbortController()
    controller.abort()
    const results = await uploadToDir(scope, '/ws', items(['a.txt', 'b.txt']), undefined, controller.signal)
    expect(results).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('an abort mid-flight keeps completed files and stops the queue', async () => {
    const spy = vi.spyOn(api, 'uploadFile')
      .mockResolvedValueOnce({ path: '/ws/a.txt', size: 1 })
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    const controller = new AbortController()
    const results = await uploadToDir(scope, '/ws', items(['a.txt', 'b.txt', 'c.txt']), undefined, controller.signal)
    expect(results).toEqual([{ relativePath: 'a.txt', ok: true, path: '/ws/a.txt' }])
    // a resolved, b was aborted mid-flight, c never started.
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
