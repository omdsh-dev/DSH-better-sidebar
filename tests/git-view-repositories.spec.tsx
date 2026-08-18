// @vitest-environment jsdom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/client/api.ts'
import { GitView } from '../src/client/GitView.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

describe('GitView nested repositories', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    vi.restoreAllMocks()
  })

  it('shows nested repository changes and stages them in that repository', async () => {
    vi.spyOn(api, 'gitStatus').mockResolvedValue([
      { root: '/workspace', isRepo: true, branch: 'main', entries: [] },
      {
        root: '/workspace/nested',
        isRepo: true,
        branch: 'feature',
        entries: [{ path: 'inner.txt', xy: ' M' }],
      },
    ] as never)
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
    vi.spyOn(api, 'gitLog').mockResolvedValue([])
    const stage = vi.spyOn(api, 'gitStage').mockResolvedValue({ ok: true })

    await act(async () => {
      root.render(<GitView scope={{ sessionId: 's1', cwd: '/workspace' }} onOpenFile={() => {}} onOpenDiff={() => {}} />)
    })

    await vi.waitFor(() => expect(container.textContent).toContain('inner.txt'))
    const row = container.querySelector<HTMLElement>('[title="inner.txt"]')?.parentElement
    const button = row?.querySelector<HTMLButtonElement>('button[aria-label]')
    expect(button).not.toBeNull()
    await act(async () => { button?.click() })
    expect(stage).toHaveBeenCalledWith(expect.anything(), '/workspace/nested', 'inner.txt')
  })

  it('opens distinct diff tabs for the same relative path in different repositories', async () => {
    vi.spyOn(api, 'gitStatus').mockResolvedValue([
      {
        root: '/workspace',
        isRepo: true,
        branch: 'main',
        entries: [{ path: 'same.txt', xy: ' M' }],
      },
      {
        root: '/workspace/nested',
        isRepo: true,
        branch: 'main',
        entries: [{ path: 'same.txt', xy: ' M' }],
      },
    ] as never)
    vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
    vi.spyOn(api, 'gitLog').mockResolvedValue([])
    const onOpenDiff = vi.fn()

    await act(async () => {
      root.render(<GitView scope={{ sessionId: 's1', cwd: '/workspace' }} onOpenFile={() => {}} onOpenDiff={onOpenDiff} />)
    })

    await vi.waitFor(() => expect(container.querySelectorAll('[title="same.txt"]')).toHaveLength(2))
    const rows = container.querySelectorAll<HTMLButtonElement>('[title="same.txt"]')
    await act(async () => { rows[0]!.click(); rows[1]!.click() })

    expect(onOpenDiff).toHaveBeenCalledTimes(2)
    const outer = onOpenDiff.mock.calls[0]![0] as { id: string; diff: { repository?: string } }
    const nested = onOpenDiff.mock.calls[1]![0] as { id: string; diff: { repository?: string } }
    expect(outer.id).not.toBe(nested.id)
    expect(outer.diff.repository).toBe('/workspace')
    expect(nested.diff.repository).toBe('/workspace/nested')
  })
})
