/**
 * The archive client's WIRE payloads.
 *
 * The file tree's async "zip and download" failed in v0.24.1 because
 * `archiveStatus` posted a bare `{ id }` while the host requires
 * `requireString(payload, 'id')` AND `requireString(payload, 'sessionId')` —
 * a 400 on every poll, so the download never happened. The unit specs for the
 * tree mock this module wholesale, and `tests/archive.spec.ts` drives the HOST
 * side with hand-built payloads, so nothing covered what the client actually
 * sends. These cases run the real module against a stubbed `fetch` and assert
 * the request bodies, including the session scope on every archive call.
 *
 * The shapes come from the host: `archive.build` answers `{id, name, entries}`
 * — `name` is the FINAL name, because the host appends the extension of the
 * tool it actually has — and the client therefore posts a STEM. `archive.status`
 * answers `{state, bytes}` only: the system `zip`/`tar` reports no per-entry
 * progress, so there is no `done`/`total` left to carry.
 */
import './browser-globals.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { archiveBuild, archiveDownloadUrl, archiveStatus, type SessionScope } from '../src/client/api.ts'

const scope: SessionScope = { sessionId: 's1', cwd: '/w' }

interface Posted {
  url: string
  body: Record<string, unknown>
}

/** Stub `fetch` with one successful envelope and record the request. */
function stubFetch(value: unknown): Posted[] {
  const posted: Posted[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    posted.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value }),
    } as unknown as Response
  }))
  return posted
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('archive client payloads', () => {
  it('posts the session scope on archive.status (the host requires BOTH keys)', async () => {
    // The exact new shape: a module still answering `done`/`total` fails here.
    const posted = stubFetch({ state: 'ready', bytes: 8 })
    await expect(archiveStatus(scope, 'job-1')).resolves.toEqual({ state: 'ready', bytes: 8 })
    expect(posted).toEqual([{ url: 'http://localhost/sidebar/api/archive.status', body: { sessionId: 's1', cwd: '/w', id: 'job-1' } }])
  })

  it('carries the scope on archive.build, plus the selection and the STEM', async () => {
    // The caller names a STEM and the host answers with the final name (it has
    // only `tar`, so the extension is `.tar.gz`). The client posts the stem
    // VERBATIM — appending a guessed suffix here would be a lie.
    const posted = stubFetch({ id: 'job-2', name: 'selection.tar.gz', entries: 2 })
    await expect(archiveBuild(scope, ['/w/a.ts', '/w/b.ts'], 'selection'))
      .resolves.toEqual({ id: 'job-2', name: 'selection.tar.gz', entries: 2 })
    expect(posted).toEqual([{
      url: 'http://localhost/sidebar/api/archive.build',
      body: { sessionId: 's1', cwd: '/w', paths: ['/w/a.ts', '/w/b.ts'], name: 'selection' },
    }])
  })

  it('puts the session on the download URL (it answers only the session that built it)', () => {
    // A session without a cwd keeps the URL scoped and free of an empty cwd.
    expect(archiveDownloadUrl({ sessionId: 's9' }, 'job-9')).toBe('http://localhost/sidebar/archive?sessionId=s9&id=job-9')
  })

  it('omits an empty cwd but never the sessionId', async () => {
    const posted = stubFetch({ state: 'building', bytes: 0 })
    await archiveStatus({ sessionId: 's2', cwd: '' }, 'job-3')
    expect(posted[0]?.body).toEqual({ sessionId: 's2', id: 'job-3' })
  })
})
