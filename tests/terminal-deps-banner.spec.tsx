/**
 * TerminalDepsBanner tests (issue #140): the degraded-mode banner the
 * terminal tab shows when node-pty fails to load. It must render the
 * failure title, the PASTEABLE repair command (bash / cmd / PowerShell),
 * a copy button that writes the command to the clipboard with a transient
 * "Copied" feedback, and a retry button.
 *
 * The banner is tested directly (like PluginListBody): it is a pure
 * presentational component, so server-side renderToString covers the
 * static content and createRoot + act() covers the copy click.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { TerminalDepsBanner } from '../src/client/TerminalView.tsx'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const deps = {
  ok: false as const,
  cause: 'Cannot find package node-pty',
  command: 'bash "/Users/u/.dsh/profiles/web/node_modules/.pnpm/dsh-better-sidebar@0.0.0/node_modules/dsh-better-sidebar/scripts/install.sh" --repair --profile "web"',
  profile: 'web',
}

describe('TerminalDepsBanner (render)', () => {
  it('renders the failure title, the pasteable command and the actions', () => {
    const html = renderToString(createElement(TerminalDepsBanner, { deps, onRetry: () => {} }))
    // The jsdom locale is en-US, so the en dictionary applies.
    expect(html).toContain('Terminal dependency node-pty failed to load')
    // renderToString HTML-escapes the quotes inside the command block.
    expect(html).toContain(deps.command.replaceAll('"', '&quot;'))
    expect(html).toContain('Copy')
    expect(html).toContain('Retry')
    // The profile the command targets is shown next to the hint.
    expect(html).toContain('detected profile: web')
  })
})

describe('TerminalDepsBanner copy click (interactive)', () => {
  it('clicking Copy writes the repair command and flashes "Copied"', async () => {
    vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(true)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onRetry = vi.fn()
    act(() => {
      root.render(createElement(TerminalDepsBanner, { deps, onRetry }))
    })
    const copyButton = container.querySelector('button[aria-label="Copy"]') as HTMLButtonElement
    expect(copyButton).not.toBeNull()
    expect(copyButton.textContent).toBe('Copy')
    await act(async () => { copyButton.click() })
    expect(primitives.writeClipboard).toHaveBeenCalledWith(deps.command)
    expect(copyButton.textContent).toBe('Copied')
    act(() => { root.unmount() })
    container.remove()
    vi.restoreAllMocks()
  })

  it('clicking Retry fires the callback (the view reconnects)', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onRetry = vi.fn()
    act(() => {
      root.render(createElement(TerminalDepsBanner, { deps, onRetry }))
    })
    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[]
    const retry = buttons.find(button => button.textContent === 'Retry')
    expect(retry).toBeDefined()
    await act(async () => { retry!.click() })
    expect(onRetry).toHaveBeenCalledTimes(1)
    act(() => { root.unmount() })
    container.remove()
  })
})
