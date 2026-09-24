/**
 * Media failure diagnosis (the image/video panes' reason line): the route's
 * JSON envelope carries the real cause, anything else falls back to the HTTP
 * status, and a transport failure to the generic headline. Pinned here because
 * the alternative — a broken `<img>` showing its `alt` text (the file name) —
 * is exactly the unhelpful state this module exists to replace.
 */
import { describe, expect, it } from 'vitest'
import { failureReason } from '../src/client/media-failure.ts'

/** A fetch stub returning one canned response. */
function stubFetch(response: { status: number; text: string } | Error): typeof fetch {
  return (async () => {
    if (response instanceof Error) throw response
    return {
      status: response.status,
      text: async () => response.text,
    } as unknown as Response
  }) as unknown as typeof fetch
}

describe('failureReason', () => {
  it('reports the message the media route sent', async () => {
    const fetchImpl = stubFetch({
      status: 400,
      text: JSON.stringify({ ok: false, error: { code: 'fs-error', message: 'not a file or too large' } }),
    })
    expect(await failureReason('/sidebar/file?x=1', fetchImpl)).toBe('not a file or too large')
  })

  it('falls back to the HTTP status when the body is not our envelope', async () => {
    expect(await failureReason('/sidebar/file?x=1', stubFetch({ status: 502, text: '<html>proxy</html>' })))
      .toBe('HTTP 502')
    expect(await failureReason('/sidebar/file?x=1', stubFetch({ status: 404, text: '' }))).toBe('HTTP 404')
  })

  it('stays generic when the call itself fails', async () => {
    expect(await failureReason('/sidebar/file?x=1', stubFetch(new Error('offline')))).toBe('Could not load this file')
  })
})
