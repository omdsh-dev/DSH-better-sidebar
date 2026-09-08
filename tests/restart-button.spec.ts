/** @vitest-environment jsdom */
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { RestartButton, type RestartButtonProps } from '../src/client/RestartButton.tsx'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('RestartButton', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    vi.restoreAllMocks()
  })

  const render = (props: RestartButtonProps): HTMLButtonElement => {
    act(() => { root.render(createElement(RestartButton, props)) })
    return container.querySelector('button') as HTMLButtonElement
  }

  it('waits for a different host pid and reloads the current page', async () => {
    const restart = vi.fn(async () => ({ pid: 10 }))
    const status = vi.fn(async () => ({ pid: 11 }))
    const reload = vi.fn()
    const button = render({ restart, status, reload, sleep: async () => {} })

    await act(async () => { button.click() })

    expect(restart).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledOnce()
    expect(reload).toHaveBeenCalledOnce()
    expect(button.dataset.phase).toBe('restarting')
  })

  it('returns to a retryable error state when the replacement never appears', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const status = vi.fn(async () => ({ pid: 10 }))
    const reload = vi.fn()
    const button = render({
      restart: async () => ({ pid: 10 }),
      status,
      reload,
      sleep: async () => {},
    })

    await act(async () => { button.click() })

    expect(status).toHaveBeenCalledTimes(150)
    expect(reload).not.toHaveBeenCalled()
    expect(button.dataset.phase).toBe('error')
    expect(button.disabled).toBe(false)
  })

  it('returns to a retryable error state when the handshake fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const button = render({
      restart: async () => { throw new Error('refused') },
      status: async () => ({ pid: 1 }),
      reload: vi.fn(),
      sleep: async () => {},
    })

    await act(async () => { button.click() })

    expect(button.dataset.phase).toBe('error')
    expect(button.disabled).toBe(false)
  })
})
