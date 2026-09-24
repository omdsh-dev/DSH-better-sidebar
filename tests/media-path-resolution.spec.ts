/**
 * The two places a workspace-relative path used to slip through to the host
 * and die with `"x/y.png" is not an absolute path` (which the browser then
 * showed as the `<img>`'s `alt` text — the file name, nothing else):
 *
 * - `mediaUrl` / `downloadUrl`, the URLs every image / video / PDF / markdown
 *   viewer hands to the browser and to `fetch`;
 * - `fileTabTarget`, the file address → tab path resolution the native right
 *   Sidebar drives (the chat opens produced files relative to the session).
 */
import { describe, expect, it } from 'vitest'
import { downloadUrl, mediaUrl } from '../src/client/api.ts'
import { fileTabTarget } from '../src/client/native/file-tab.ts'
import { sessionFileAddress, absoluteFileAddress } from '../src/client/resource-address.ts'

const SCOPE = { sessionId: 's-1', cwd: '/home/me/ws' }

describe('media URLs resolve a workspace-relative path', () => {
  it('joins a relative path onto the session cwd', () => {
    const url = mediaUrl(SCOPE, 'emote_verify/final/flow5000_s4.png')
    expect(new URLSearchParams(url.split('?')[1]).get('path')).toBe('/home/me/ws/emote_verify/final/flow5000_s4.png')
    expect(downloadUrl(SCOPE, 'emote_verify/final/flow5000_s4.png'))
      .toContain(`path=${encodeURIComponent('/home/me/ws/emote_verify/final/flow5000_s4.png')}`)
  })

  it('leaves an absolute path untouched', () => {
    expect(mediaUrl(SCOPE, '/abs/x.png')).toContain(`path=${encodeURIComponent('/abs/x.png')}`)
    expect(mediaUrl(SCOPE, 'C:\\abs\\x.png')).toContain(`path=${encodeURIComponent('C:\\abs\\x.png')}`)
  })

  it('passes a relative path through when the scope carries no cwd', () => {
    // The host answers with its own refusal, which the failure pane shows.
    expect(mediaUrl({ sessionId: 's-1' }, 'a/b.png')).toContain(`path=${encodeURIComponent('a/b.png')}`)
  })
})

describe('fileTabTarget', () => {
  const cwdOf = (sessionId: string): string | undefined => (sessionId === 's-1' ? '/home/me/ws' : undefined)

  it('resolves a session-relative address against that session cwd', () => {
    expect(fileTabTarget(sessionFileAddress('s-1', 'emote_verify/final/flow5000_s4.png'), cwdOf))
      .toEqual({ path: '/home/me/ws/emote_verify/final/flow5000_s4.png', sessionId: 's-1' })
  })

  it('keeps an absolute path inside a session address absolute', () => {
    expect(fileTabTarget(sessionFileAddress('s-1', '/outside/x.png'), cwdOf))
      .toEqual({ path: '/outside/x.png', sessionId: 's-1' })
  })

  it('keeps the absolute scope as-is and carries no session', () => {
    expect(fileTabTarget(absoluteFileAddress('/outside/x.png'), cwdOf)).toEqual({ path: '/outside/x.png' })
  })

  it('leaves a relative path alone while that session cwd is unknown', () => {
    expect(fileTabTarget(sessionFileAddress('s-2', 'a/b.png'), cwdOf)).toEqual({ path: 'a/b.png', sessionId: 's-2' })
  })

  it('rejects strings that are not file addresses', () => {
    expect(fileTabTarget('https://example.com/x.png', cwdOf)).toBeUndefined()
    expect(fileTabTarget('dsh-resource://file/', cwdOf)).toBeUndefined()
  })
})
