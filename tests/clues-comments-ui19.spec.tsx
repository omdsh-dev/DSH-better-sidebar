/** UI19 observable discussion compose/reply contract; no real provider writes. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { ResourceDiscussion, type ResourceDiscussionProps } from '../src/client/clues/windows/comments.tsx'
import { SidebarApiError } from '../src/client/api.ts'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
setupReactAct()
let root: RenderedRoot | undefined
afterEach(() => { root?.unmount(); root = undefined })
const page: NonNullable<ResourceDiscussionProps['page']> = {
  status: 'ok', coverage: 'document', complete: true, fetchedAt: '', items: [
    { id: 'c1', kind: 'comment', format: 'text/plain', body: 'Original question', author: { handle: 'author' } },
  ],
}
function type(input: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const flush = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }) }

describe('ResourceDiscussion composition', () => {
  it('keeps failed reply drafts and reuses the request id on retry, then clears only on success', async () => {
    let fail = true
    const create = vi.fn(async () => { if (fail) throw new SidebarApiError('failed', 'sanitized failure') })
    root = renderRoot(createElement(ResourceDiscussion, { page, loading: false, capabilities: { read: true, create: true, reply: 'native' }, onLoad: () => {}, onCreate: create }))
    act(() => { root!.container.querySelector<HTMLButtonElement>('[data-clue-comment-reply="c1"]')!.click() })
    const input = root.container.querySelector<HTMLTextAreaElement>('[data-clue-comment-input]')!
    expect(document.activeElement).toBe(input)
    type(input, 'Answer draft')
    act(() => { root!.container.querySelector<HTMLButtonElement>('[data-clue-comment-submit]')!.click() })
    await flush()
    expect(input.value).toBe('Answer draft')
    expect(root.container.textContent).toContain('sanitized failure')
    expect(create.mock.calls[0]).toEqual(['Answer draft', 'c1', expect.any(String)])
    fail = false
    act(() => { root!.container.querySelector<HTMLButtonElement>('[data-clue-comment-submit]')!.click() })
    await flush()
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0])
    expect(input.value).toBe('')
    expect(root.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('does not offer writes on a snapshot and renders untrusted plain text safely', () => {
    root = renderRoot(createElement(ResourceDiscussion, { page: { ...page, items: [{ ...page.items[0]!, body: '<script>boom</script>', url: 'https://user:secret@example.com' }] }, loading: false, readOnly: true, capabilities: { read: true, create: true, reply: 'quote' }, onLoad: () => {}, onCreate: async () => {} }))
    expect(root.container.querySelector('textarea, script, a, [data-clue-comment-reply]')).toBeNull()
    expect(root.container.textContent).toContain('<script>boom</script>')
  })
})


it('places late-arriving older comments chronologically and keeps unknown-time slots and reply links stable', () => {
  const original: NonNullable<ResourceDiscussionProps['page']> = { ...page, items: [
    { id: 'new', kind: 'review', format: 'text/plain', body: 'New review', createdAt: '2026-10-24T03:00:00.000Z' },
    { id: 'unknown-1', kind: 'comment', format: 'text/plain', body: 'Unknown one' },
    { id: 'reply', kind: 'reply', format: 'text/plain', body: 'Reply', replyToId: 'root', createdAt: '2026-10-24T02:00:00.000Z' },
    { id: 'equal', kind: 'review', format: 'text/plain', body: 'Equal time', createdAt: '2026-10-24T03:00:00.000Z' },
    { id: 'unknown-2', kind: 'comment', format: 'text/plain', body: 'Unknown two', createdAt: 'invalid' },
  ] }
  const props = { loading: false, onLoad: () => {}, onCreate: async () => {} }
  root = renderRoot(createElement(ResourceDiscussion, { ...props, page: original }))
  root.rerender(createElement(ResourceDiscussion, { ...props, page: { ...original, items: [...original.items,
    { id: 'root', kind: 'comment', format: 'text/plain', body: 'Old root', author: { name: 'Root author' }, createdAt: '2026-10-24T01:00:00.000Z' },
    { id: 'updated', kind: 'comment', format: 'text/plain', body: 'Updated fallback', createdAt: 'bad', updatedAt: '2026-10-24T00:00:00.000Z' },
  ] } }))
  expect([...root.container.querySelectorAll('[data-clue-comment]')].map(item => item.getAttribute('data-clue-comment')))
    .toEqual(['updated', 'unknown-1', 'root', 'reply', 'unknown-2', 'new', 'equal'])
  const reply = root.container.querySelector('[data-clue-comment="reply"]')!
  expect(reply.getAttribute('data-clue-reply-to')).toBe('root')
  expect(reply.textContent).toContain('Root author')
})
