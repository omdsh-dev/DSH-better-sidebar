/** Host Markdown remains the default; only identified, settled, visible
 * assistant rows expose their real root to the optional surface consumer. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { SidechatAssistantRow } from '../src/client/SidechatAssistantRow.tsx'
import { bindSidechatSurfaces, disposeSidechatSurfaces } from '../src/client/sidechat-surface.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()
const labels = { copyLabel: 'Copy', copiedLabel: 'Copied', codeLabel: 'Code', wrapLabel: 'Wrap', unwrapLabel: 'Unwrap' }
const row = { kind: 'assistant' as const, seq: 5, text: '**original**\n\n```dsh-ui\n{"type":"button"}\n```', settled: true, contentBlockIndex: 2 }
const rewrite = (row: { text: string }): string => row.text.replace('original', 'rewritten')

afterEach(() => { vi.restoreAllMocks() })

describe('SidechatAssistantRow', () => {
  it('keeps real Markdown without a consumer and exposes original text on late registration', () => {
    const service = {}
    const register = bindSidechatSurfaces(service)
    const surface = { service, threadId: 'child', visible: true, sendPrompt: vi.fn(async () => {}) }
    const rendered = renderRoot(createElement(SidechatAssistantRow, { row, labels, rewrite, surface }))
    expect(rendered.container.querySelector('strong')?.textContent).toBe('rewritten')
    expect(rendered.container.querySelector('pre code')?.textContent).toContain('"type":"button"')
    const cleanup = vi.fn()
    const mount = vi.fn(() => cleanup)
    const unregister = register({ id: 'genui', mount })
    expect(mount).toHaveBeenCalledWith(expect.objectContaining({
      root: rendered.container.firstElementChild, threadId: 'child', eventSeq: 5, contentBlockIndex: 2, text: row.text,
    }))
    rendered.rerender(createElement(SidechatAssistantRow, { row: { ...row }, labels, rewrite, surface: { ...surface } }))
    expect(mount).toHaveBeenCalledTimes(1)
    rendered.rerender(createElement(SidechatAssistantRow, { row, labels, rewrite, surface: { ...surface, visible: false } }))
    expect(cleanup).toHaveBeenCalledTimes(1)
    rendered.rerender(createElement(SidechatAssistantRow, { row, labels, rewrite, surface }))
    expect(mount).toHaveBeenCalledTimes(2)
    unregister()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(rendered.container.querySelector('pre code')?.textContent).toContain('"type":"button"')
    rendered.unmount()
    disposeSidechatSurfaces(service)
  })

  it.each([
    { name: 'streaming', row: { ...row, settled: false }, threadId: 'child', visible: true },
    { name: 'hidden', row, threadId: 'child', visible: false },
    { name: 'missing thread', row, threadId: undefined, visible: true },
    { name: 'blank thread', row, threadId: ' ', visible: true },
    { name: 'invalid event', row: { ...row, seq: -1 }, threadId: 'child', visible: true },
    { name: 'missing index', row: { ...row, contentBlockIndex: undefined }, threadId: 'child', visible: true },
  ])('does not opt in $name, but always keeps the scanner exclusion marker', ({ row: current, threadId, visible }) => {
    const service = {}
    const register = bindSidechatSurfaces(service)
    const mount = vi.fn(() => () => {})
    register({ id: 'genui', mount })
    const rendered = renderRoot(createElement(SidechatAssistantRow, {
      row: current, labels, rewrite, surface: { service, threadId, visible, sendPrompt: vi.fn(async () => {}) },
    }))
    expect(mount).not.toHaveBeenCalled()
    expect(rendered.container.firstElementChild?.getAttribute('data-genui-surface')).toBe('dsh-better-sidebar/sidechat')
    expect(rendered.container.querySelector('[data-chat-role], [data-chat-seq]')).toBeNull()
    expect(rendered.container.querySelector('strong')?.textContent).toBe('rewritten')
    rendered.unmount()
    disposeSidechatSurfaces(service)
  })
})
