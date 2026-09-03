/**
 * Client/host routing for the file tree's external-open action. Remote
 * VSCode-family SSH URLs must launch on the browser machine, while local
 * editor URLs and reveal actions keep using the DSH host opener.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/client/api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function hostOk(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, value: { started: true } }),
  }))
}

describe('api.openExternal', () => {
  it('launches an SSH remote-editor URL on the client without calling the host', async () => {
    const assign = vi.fn()
    const fetchMock = hostOk()
    vi.stubGlobal('window', { location: { assign } })
    vi.stubGlobal('fetch', fetchMock)
    const url = 'vscode://vscode-remote/ssh-remote+dev/home/u/f.ts'

    await expect(api.openExternal({ action: 'url', url })).resolves.toEqual({ started: true })
    expect(assign).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenCalledWith(url)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('launches Cursor/custom VSCode-family SSH URLs on the client too', async () => {
    const assign = vi.fn()
    const fetchMock = hostOk()
    vi.stubGlobal('window', { location: { assign } })
    vi.stubGlobal('fetch', fetchMock)

    await api.openExternal({
      action: 'url',
      url: 'cursor://vscode-remote/ssh-remote+dev/home/u/f.ts',
    })
    await api.openExternal({
      action: 'url',
      url: 'myfork://vscode-remote/ssh-remote+dev/home/u/f.ts',
    })

    expect(assign).toHaveBeenCalledTimes(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps local editor URLs on the host opener', async () => {
    const assign = vi.fn()
    const fetchMock = hostOk()
    vi.stubGlobal('window', { location: { assign } })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.openExternal({
      action: 'url',
      url: 'vscode://file//tmp/a.ts',
    })).resolves.toEqual({ started: true })

    expect(assign).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/sidebar/api/open.external')
  })

  it('keeps reveal actions and http(s) lookalikes on the host opener', async () => {
    const assign = vi.fn()
    const fetchMock = hostOk()
    vi.stubGlobal('window', { location: { assign } })
    vi.stubGlobal('fetch', fetchMock)

    await api.openExternal({ action: 'reveal', path: '/tmp/a.ts' })
    await api.openExternal({
      action: 'url',
      url: 'https://vscode-remote/ssh-remote+dev/home/u/f.ts',
    })

    expect(assign).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns a rejected promise when client navigation throws', async () => {
    const error = new Error('navigation failed')
    const fetchMock = hostOk()
    vi.stubGlobal('window', { location: { assign: vi.fn(() => { throw error }) } })
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.openExternal({
      action: 'url',
      url: 'vscode://vscode-remote/ssh-remote+dev/home/u/f.ts',
    })).rejects.toBe(error)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
