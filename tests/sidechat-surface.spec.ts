/** Opt-in sidechat bridge: scoped roots, late registration, exact identity,
 * failure isolation and disposal. No timer, global DOM scan or host session. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachSidechatSurface, bindSidechatSurfaces, disposeSidechatSurfaces,
  type SidechatSurface, type SidechatSurfaceAdapter,
} from '../src/client/sidechat-surface.ts'

function fixture() {
  const service = {}
  const register = bindSidechatSurfaces(service)
  const root = document.createElement('div')
  root.innerHTML = '<pre><code>synthetic dsh-ui source</code></pre>'
  document.body.append(root)
  const prompt = vi.fn(async () => {})
  const surface: SidechatSurface = {
    root, source: 'dsh-better-sidebar/sidechat', threadId: 'child-a',
    eventSeq: 5, contentBlockIndex: 2, text: 'synthetic dsh-ui source', sendPrompt: prompt,
  }
  return { service, register, root, surface, prompt }
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('sidechat surface registration', () => {
  it('mounts an existing visible surface on late registration and restores it on unregister', () => {
    const { service, register, root, surface } = fixture()
    const detach = attachSidechatSurface(service, surface)
    const code = root.querySelector('pre')!
    const cleanup = vi.fn(() => { code.hidden = false })
    const mount = vi.fn((received: SidechatSurface) => {
      expect(received).toMatchObject({ root, source: surface.source, threadId: 'child-a', eventSeq: 5, contentBlockIndex: 2, text: surface.text })
      code.hidden = true
      return cleanup
    })
    const unregister = register({ id: 'genui', mount })
    expect(mount).toHaveBeenCalledTimes(1)
    expect(code.hidden).toBe(true)
    unregister(); unregister()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(code.hidden).toBe(false)
    detach(); detach()
    expect(cleanup).toHaveBeenCalledTimes(1)
    disposeSidechatSurfaces(service)
  })

  it('does not retain detached rows for later adapters', () => {
    const { service, register, surface } = fixture()
    const detach = attachSidechatSurface(service, surface)
    detach()
    const mount = vi.fn(() => () => {})
    register({ id: 'late', mount })
    expect(mount).not.toHaveBeenCalled()
    disposeSidechatSurfaces(service)
  })

  it('rejects duplicate adapter ids without mounting twice, then permits the released id', () => {
    const { service, register, surface } = fixture()
    attachSidechatSurface(service, surface)
    const mount = vi.fn(() => () => {})
    const unregister = register({ id: 'genui', mount })
    expect(() => register({ id: 'genui', mount })).toThrow('already registered')
    expect(mount).toHaveBeenCalledTimes(1)
    unregister()
    register({ id: 'genui', mount })
    expect(mount).toHaveBeenCalledTimes(2)
    disposeSidechatSurfaces(service)
  })

  it('isolates mount and cleanup failures so another adapter still mounts and cleans up', () => {
    const { service, register, surface } = fixture()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    register({ id: 'throws-on-mount', mount: () => { throw new Error('synthetic mount failure') } })
    register({ id: 'throws-on-cleanup', mount: () => () => { throw new Error('synthetic cleanup failure') } })
    const cleanup = vi.fn()
    const mount = vi.fn(() => cleanup)
    register({ id: 'healthy', mount })
    const detach = attachSidechatSurface(service, surface)
    expect(mount).toHaveBeenCalledTimes(1)
    detach()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledTimes(2)
    disposeSidechatSurfaces(service)
  })

  it.each(['row', 'adapter', 'plugin'] as const)('revokes old send callbacks on %s disposal', async (target) => {
    const { service, register, surface, prompt } = fixture()
    let received: SidechatSurface | undefined
    const unregister = register({ id: 'genui', mount: value => { received = value; return () => {} } })
    const detach = attachSidechatSurface(service, surface)
    await received!.sendPrompt('synthetic child prompt')
    expect(prompt).toHaveBeenCalledWith('synthetic child prompt')
    if (target === 'row') detach()
    else if (target === 'adapter') unregister()
    else disposeSidechatSurfaces(service)
    await expect(received!.sendPrompt('must not send')).rejects.toThrow('no longer active')
    expect(prompt).toHaveBeenCalledTimes(1)
    disposeSidechatSurfaces(service)
  })

  it('cleans all roots once on plugin unload and rejects stale registration', () => {
    const { service, register, surface } = fixture()
    const cleanup = vi.fn()
    register({ id: 'genui', mount: () => cleanup })
    const detach = attachSidechatSurface(service, surface)
    const secondRoot = document.createElement('div')
    document.body.append(secondRoot)
    attachSidechatSurface(service, { ...surface, root: secondRoot, contentBlockIndex: 4 })
    disposeSidechatSurfaces(service); disposeSidechatSurfaces(service); detach()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(() => register({ id: 'late', mount: () => () => {} })).toThrow('disposed')
  })

  it.each([
    { threadId: '' }, { threadId: '  ' }, { eventSeq: -1 }, { eventSeq: 0.5 },
    { eventSeq: Number.NaN }, { contentBlockIndex: -1 }, { contentBlockIndex: undefined },
    { source: 'main-conversation' },
  ])('fails closed for invalid identity %j', (invalid) => {
    const { service, register, surface } = fixture()
    const mount = vi.fn(() => () => {})
    register({ id: 'genui', mount })
    attachSidechatSurface(service, { ...surface, ...invalid } as SidechatSurface)
    expect(mount).not.toHaveBeenCalled()
    disposeSidechatSurfaces(service)
  })

  it('releases the previous lease when the same root is reattached', () => {
    const { service, register, surface } = fixture()
    const cleanups: ReturnType<typeof vi.fn>[] = []
    const adapter: SidechatSurfaceAdapter = { id: 'genui', mount: () => {
      const cleanup = vi.fn(); cleanups.push(cleanup); return cleanup
    } }
    register(adapter)
    const oldDetach = attachSidechatSurface(service, surface)
    const newDetach = attachSidechatSurface(service, { ...surface, eventSeq: 6 })
    expect(cleanups[0]).toHaveBeenCalledTimes(1)
    oldDetach()
    expect(cleanups[1]).not.toHaveBeenCalled()
    newDetach()
    expect(cleanups[1]).toHaveBeenCalledTimes(1)
    disposeSidechatSurfaces(service)
  })
})
