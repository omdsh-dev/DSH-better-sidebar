// @vitest-environment jsdom
/** Public source filter descriptors drive the same scope values in every browser. */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { ResourceFilters } from '../src/client/clues/resource-filters.tsx'
import type { ClueSourceDescriptor } from '../src/clues/types.ts'
setupReactAct()
function choose(container: ParentNode, label: string): void {
  act(() => { container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click() })
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(button => button.textContent?.trim() === label)
  expect(item).toBeDefined()
  act(() => { item!.click() })
}
const source = { sourceId: 'builtin.feishu.tasks', filters: [{ scopeKey: 'completed', defaultOptionId: 'all', options: [{ id: 'all' }, { id: 'active', value: false }, { id: 'completed', value: true }] }] } as unknown as ClueSourceDescriptor

describe('source completion filters', () => {
  const github = { sourceId: 'builtin.github.issues', filters: [{ scopeKey: 'state', defaultOptionId: 'open', options: [{ id: 'open', value: 'open' }, { id: 'closed', value: 'closed' }] }] } as unknown as ClueSourceDescriptor
  it('cannot persist a state-only GitHub range while the repository is unresolved', () => {
    const view = renderRoot(createElement(ResourceFilters, { source: github, scope: undefined, mode: 'list', onChange: vi.fn() }))
    expect(view.container.querySelector('button[aria-haspopup="menu"]')).toBeNull()
    view.unmount()
  })
  it('preserves a repository-string range while changing GitHub state', () => {
    const change = vi.fn()
    const view = renderRoot(createElement(ResourceFilters, { source: github, scope: 'acme/demo', mode: 'search', onChange: change }))
    choose(view.container, 'Closed')
    expect(change).toHaveBeenCalledWith({ repo: 'acme/demo', state: 'closed' })
    view.unmount()
  })
  it('sends false for incomplete tasks and removes only the filter for all tasks', () => {
    const change = vi.fn()
    const view = renderRoot(createElement(ResourceFilters, { source, scope: { kind: 'tasks', tasklistGuid: 'list1' }, mode: 'list', onChange: change }))
    choose(view.container, 'Incomplete')
    expect(change).toHaveBeenLastCalledWith({ kind: 'tasks', tasklistGuid: 'list1', completed: false })
    view.rerender(createElement(ResourceFilters, { source, scope: { kind: 'tasks', tasklistGuid: 'list1', completed: false }, mode: 'list', onChange: change }))
    choose(view.container, 'All')
    expect(change).toHaveBeenLastCalledWith({ kind: 'tasks', tasklistGuid: 'list1' })
    view.unmount()
  })
})
