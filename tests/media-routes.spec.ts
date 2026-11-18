/**
 * Session media host routes: the JSON methods behind the viewer's catalogue
 * and the two raw-bytes answers.
 *
 * What matters here, in the order a real deployment breaks it:
 *  - the catalogue is folded from the LOG the host has (live session first,
 *    persisted artifact otherwise), with the two per-row availability facts the
 *    page renders;
 *  - the thumbnail store is the plugin's own directory under the harness home,
 *    and a bare `media.thumb.save` is a no-op that answers the stored size;
 *  - the ORIGINAL bytes are re-derived from the log, never from the client —
 *    the attachment service verifies media type, byte length and dimensions,
 *    so a hand-built reference must not pass;
 *  - a missing original answers the plugin's `not-found` code, which is exactly
 *    the state the durable thumbnail exists for.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildMediaApi, respondMedia } from '../src/media-routes.ts'
import { thumbPathOf, thumbRootOf } from '../src/media-store.ts'
import type { Context, SidebarHttpResponse, SidebarImageAttachmentRef, SidebarSessionEvent } from '../src/context-types.ts'

/** A 1×1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sidebar-media-routes-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** One image attachment reference as the log carries it. */
function imageRef(id: string, name = 'shot.png'): Record<string, unknown> {
  return { attachmentId: id, mediaType: 'image/png', bytes: 12, width: 4, height: 3, ...(name === '' ? {} : { name }) }
}

/** One `{ type: 'image' }` block. */
function imageBlock(id: string, name?: string): Record<string, unknown> {
  return { type: 'image', attachment: imageRef(id, name) }
}

/** One log event. */
function event(seq: number, type: string, data: Record<string, unknown>): SidebarSessionEvent {
  return { type, seq, time: 1_000 + seq, data }
}

/** A response double that records what the route wrote. */
function response(): { res: SidebarHttpResponse; status: number; headers: Record<string, string>; body: Buffer } {
  const chunks: Buffer[] = []
  const record = { status: 0, headers: {} as Record<string, string>, chunks }
  // A real Writable destination: `streamFileToResponse` pipes the file into
  // the response, while a thumbnail answer calls `end(bytes)` directly. Both
  // land in `chunks`, so one helper serves both shapes. `end` is left to the
  // stream itself — overriding it would recurse.
  class Sink extends Writable {
    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      chunks.push(Buffer.from(chunk))
      callback()
    }
  }
  const sink = new Sink()
  const res = Object.assign(sink, {
    writeHead(status: number, headers?: Record<string, string>) {
      record.status = status
      record.headers = headers ?? {}
    },
  }) as unknown as SidebarHttpResponse
  return {
    get status() { return record.status },
    get headers() { return record.headers },
    get body() { return Buffer.concat(chunks) },
    res,
  }
}

/** The cwd resolver the routes take (one session, one workspace). */
const cwdOf = async (payload: unknown) => ({
  sessionId: (payload as { sessionId: string }).sessionId,
  cwd: '/workspace',
})

/**
 * A context double carrying only what the media routes touch.
 * @param options.events - the live session's event log.
 * @param options.attachments - the attachment service face (absent = unmounted).
 * @param options.persisted - the persisted log, when the session is NOT live.
 */
function contextWith(options: {
  events?: readonly SidebarSessionEvent[]
  persisted?: readonly SidebarSessionEvent[]
  attachments?: unknown
  home?: string
}): Context {
  const handlers: Record<string, unknown> = {
    profileContext: { home: options.home ?? home },
    sessions: {
      get: (_id: string) => (options.events === undefined
        ? undefined
        : { header: {}, snapshotEvents: () => options.events }),
    },
    get: (key: string) => {
      if (key === 'attachments') return options.attachments
      if (key === 'sessionPersistence' && options.persisted !== undefined) {
        return {
          open: async () => ({
            header: {},
            read: async () => ({ events: options.persisted }),
            close: async () => {},
          }),
        }
      }
      return undefined
    },
  }
  return handlers as unknown as Context
}

describe('media.list', () => {
  it('folds the live session log and reports per-row availability', async () => {
    const ctx = contextWith({
      events: [
        event(1, 'user/message', { content: [imageBlock('sha256:aa')], source: { kind: 'user' } }),
        event(2, 'tool/result', { message: { content: [imageBlock('sha256:bb')] } }),
        event(3, 'deliverables/presented', { files: [{ path: '/workspace/missing.pdf' }] }),
      ],
      // `imageHostPath` answers for ONE id only: the other original is gone.
      attachments: {
        imageHostPath: (ref: SidebarImageAttachmentRef) => (ref.attachmentId === 'sha256:aa'
          ? join(home, 'present-object')
          : join(home, 'gone-object')),
      },
    })
    // The reachable object exists on disk; the other one does not.
    await writeFile(join(home, 'present-object'), PNG)

    const api = buildMediaApi(ctx, cwdOf)
    const value = await api['media.list']({ sessionId: 's1' })
    expect(value.attachments).toBe(true)
    expect(value.rows.map(row => row.id)).toEqual(['/workspace/missing.pdf', 'sha256:bb', 'sha256:aa'])
    const byId = new Map(value.rows.map(row => [row.id, row]))
    expect(byId.get('sha256:aa')).toMatchObject({ thumb: false, original: true, kind: 'image' })
    expect(byId.get('sha256:bb')).toMatchObject({ thumb: false, original: false })
    // No file exists at the delivered path, so its original is gone too.
    expect(byId.get('/workspace/missing.pdf')).toMatchObject({ original: false, source: 'presented' })
  })

  it('reports a stored thumbnail per row', async () => {
    const ctx = contextWith({ events: [event(1, 'user/message', { content: [imageBlock('sha256:aa')] })] })
    const api = buildMediaApi(ctx, cwdOf)
    await api['media.thumb.save']({ id: 'sha256:aa', data: PNG.toString('base64') })
    const value = await api['media.list']({ sessionId: 's1' })
    expect(value.rows[0]).toMatchObject({ id: 'sha256:aa', thumb: true })
  })

  it('falls back to the persisted log for a detached session', async () => {
    const ctx = contextWith({
      persisted: [event(7, 'user/message', { content: [imageBlock('sha256:zz')] })],
    })
    const api = buildMediaApi(ctx, cwdOf)
    const value = await api['media.list']({ sessionId: 'detached' })
    expect(value.rows.map(row => row.id)).toEqual(['sha256:zz'])
  })

  it('answers an empty catalogue when neither source can be read', async () => {
    const api = buildMediaApi(contextWith({}), cwdOf)
    const value = await api['media.list']({ sessionId: 'nope' })
    expect(value).toEqual({ rows: [], attachments: false })
  })

  it('reports attachments unmounted so the page can say so', async () => {
    const api = buildMediaApi(contextWith({ events: [event(1, 'user/message', { content: [imageBlock('sha256:aa')] })] }), cwdOf)
    const value = await api['media.list']({ sessionId: 's1' })
    expect(value.attachments).toBe(false)
    expect(value.rows[0]?.original).toBe(false)
  })
})

describe('media.thumb.save / media.thumb.delete', () => {
  it('stores the first capture and answers the stored size afterwards', async () => {
    const api = buildMediaApi(contextWith({}), cwdOf)
    const first = await api['media.thumb.save']({ id: 'sha256:aa', data: PNG.toString('base64') })
    expect(first).toEqual({ bytes: PNG.length, created: true })
    const second = await api['media.thumb.save']({ id: 'sha256:aa', data: PNG.toString('base64') })
    expect(second).toEqual({ bytes: PNG.length, created: false })
  })

  it('deletes one stored thumbnail', async () => {
    const api = buildMediaApi(contextWith({}), cwdOf)
    await api['media.thumb.save']({ id: 'sha256:aa', data: PNG.toString('base64') })
    expect(await api['media.thumb.delete']({ id: 'sha256:aa' })).toEqual({ removed: true })
    // Deleting one that is not there answers the same shape, never throws.
    expect(await api['media.thumb.delete']({ id: 'sha256:aa' })).toEqual({ removed: false })
  })

  it('refuses a payload that is not base64 PNG data', async () => {
    const api = buildMediaApi(contextWith({}), cwdOf)
    await expect(api['media.thumb.save']({ id: 'sha256:aa' })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(api['media.thumb.save']({ id: 'sha256:aa', data: 'bm90IGEgcG5n' })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(api['media.thumb.save']({ data: 'x' })).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('refuses the whole store when the harness home is unknown', async () => {
    const ctx = contextWith({})
    ;(ctx as unknown as { profileContext?: unknown }).profileContext = undefined
    const api = buildMediaApi(ctx, cwdOf)
    await expect(api['media.thumb.save']({ id: 'a', data: PNG.toString('base64') })).rejects.toMatchObject({ code: 'unavailable' })
    await expect(api['media.list']({ sessionId: 's1' })).resolves.toMatchObject({ rows: [] })
  })
})

describe('respondMedia', () => {
  it('serves a stored thumbnail by identity alone', async () => {
    const ctx = contextWith({})
    const api = buildMediaApi(ctx, cwdOf)
    await api['media.thumb.save']({ id: 'sha256:aa', data: PNG.toString('base64') })
    const out = response()
    await respondMedia(ctx, cwdOf, { id: 'sha256:aa', thumb: true }, out.res)
    expect(out.status).toBe(200)
    expect(out.headers['content-type']).toBe('image/png')
    expect(out.headers['content-length']).toBe(String(PNG.length))
    expect(out.body).toEqual(PNG)
  })

  it('answers not-found for an identity with no thumbnail', async () => {
    const out = response()
    await expect(respondMedia(contextWith({}), cwdOf, { id: 'sha256:none', thumb: true }, out.res))
      .rejects.toMatchObject({ code: 'not-found' })
  })

  it('re-derives an attachment reference from the log and serves its bytes', async () => {
    const ctx = contextWith({
      events: [event(1, 'user/message', { content: [imageBlock('sha256:aa', 'shot.png')] })],
      attachments: {
        readImage: async (ref: SidebarImageAttachmentRef) => ({ ref, data: PNG }),
      },
    })
    const out = response()
    await respondMedia(ctx, cwdOf, { id: 'sha256:aa', thumb: false, sessionId: 's1' }, out.res)
    expect(out.status).toBe(200)
    expect(out.headers['content-type']).toBe('image/png')
    expect(out.body).toEqual(PNG)
  })

  it('answers not-found (not a crash) when the original object is gone', async () => {
    const ctx = contextWith({
      events: [event(1, 'user/message', { content: [imageBlock('sha256:aa')] })],
      attachments: {
        readImage: async () => { throw Object.assign(new Error('Attachment object is missing.'), { code: 'ATTACHMENT_NOT_FOUND' }) },
      },
    })
    const out = response()
    await expect(respondMedia(ctx, cwdOf, { id: 'sha256:aa', thumb: false, sessionId: 's1' }, out.res))
      .rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses an attachment id the session does not carry', async () => {
    const ctx = contextWith({ events: [], attachments: { readImage: async () => ({ ref: {}, data: PNG }) } })
    const out = response()
    await expect(respondMedia(ctx, cwdOf, { id: 'sha256:other', thumb: false, sessionId: 's1' }, out.res))
      .rejects.toMatchObject({ code: 'not-found' })
  })

  it('requires a session for the original bytes', async () => {
    const out = response()
    await expect(respondMedia(contextWith({}), cwdOf, { id: 'sha256:aa', thumb: false }, out.res))
      .rejects.toMatchObject({ code: 'bad-request' })
  })

  it('streams a delivered workspace file with its own content type', async () => {
    const workspace = join(home, 'workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'clip.mp4'), Buffer.from('fake mp4 bytes'))
    const ctx = contextWith({})
    const out = response()
    const scopedCwd = async (payload: unknown) => ({ sessionId: (payload as { sessionId: string }).sessionId, cwd: workspace })
    await respondMedia(ctx, scopedCwd, { id: join(workspace, 'clip.mp4'), thumb: false, sessionId: 's1' }, out.res)
    expect(out.status).toBe(200)
    expect(out.headers['content-type']).toBe('video/mp4')
    expect(out.headers['content-disposition']).toContain('inline')
  })

  it('answers not-found for a delivered file that is gone', async () => {
    const workspace = join(home, 'workspace')
    await mkdir(workspace, { recursive: true })
    const scopedCwd = async (payload: unknown) => ({ sessionId: (payload as { sessionId: string }).sessionId, cwd: workspace })
    const out = response()
    await expect(respondMedia(contextWith({}), scopedCwd, { id: join(workspace, 'gone.pdf'), thumb: false, sessionId: 's1' }, out.res))
      .rejects.toMatchObject({ code: 'not-found' })
  })

  it('marks a delivered download as an attachment disposition', async () => {
    const workspace = join(home, 'workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'report.pdf'), Buffer.from('pdf'))
    const scopedCwd = async (payload: unknown) => ({ sessionId: (payload as { sessionId: string }).sessionId, cwd: workspace })
    const out = response()
    await respondMedia(contextWith({}), scopedCwd, { id: join(workspace, 'report.pdf'), thumb: false, sessionId: 's1', download: true }, out.res)
    expect(out.headers['content-disposition']).toContain('attachment')
  })

  it('keeps the thumbnail store under the harness home', async () => {
    const ctx = contextWith({})
    const api = buildMediaApi(ctx, cwdOf)
    await api['media.thumb.save']({ id: 'sha256:aa', data: PNG.toString('base64') })
    expect(thumbPathOf(thumbRootOf(home), 'sha256:aa')).toContain('better-sidebar')
    expect(thumbPathOf(thumbRootOf(home), 'sha256:aa')).toContain('media-thumbs')
  })
})
