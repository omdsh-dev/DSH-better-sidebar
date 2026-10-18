/**
 * The task window's delete is a TWO-step button armed in component state: the
 * first click arms it ("Confirm delete"), the second one deletes. Every task
 * surface swaps the subject task through props with no `key`, so React reuses
 * the instance — an armed button carried into the next task made that reader's
 * FIRST click the delete itself, one click away from removing a task they
 * never armed.
 *
 * What must NOT change: arming still works, and the second click still goes
 * through with the visible task's id.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TaskWindow } from '../src/client/TaskWindow.tsx'
import type { Context } from '../src/context-types.ts'
import type { SidebarTeamTaskView } from '../src/context-types.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest follows the OS locale; pin en-US so the button copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { teamsTaskUpdate } = vi.hoisted(() => ({
  teamsTaskUpdate: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../src/client/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.ts')>()
  return { ...actual, api: { ...actual.api, teamsTaskUpdate } }
})

/** One board row as the projection hands it over. */
function taskView(id: string, subject: string): SidebarTeamTaskView {
  return {
    id,
    revision: 1,
    subject,
    description: 'body',
    status: 'in_progress',
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
  }
}

let container: HTMLDivElement
let root: Root

/** Render — or RE-render in place — the one window, as the caller's popover
 *  state does when another task is opened. */
async function render(task: SidebarTeamTaskView): Promise<void> {
  await act(async () => {
    root.render(createElement(TaskWindow, {
      rootId: 'root-1',
      task,
      members: [],
      // The window renders the description through the plugin's markdown
      // surface; this spec is about the delete button's arming, so a bare
      // context stands in (the surface tolerates a service-less ctx).
      ctx: {} as Context,
      onClose: () => {},
    }))
  })
}

/** One footer button by its copy (the window is body-portaled). */
function button(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('button')]
    .find(el => el.textContent?.trim() === label)
  if (found === undefined) throw new Error(`button not found: ${label}`)
  return found
}

function hasButton(label: string): boolean {
  return [...document.querySelectorAll<HTMLElement>('button')]
    .some(el => el.textContent?.trim() === label)
}

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  teamsTaskUpdate.mockClear()
})

describe('TaskWindow two-step delete', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  it('disarms the delete when the window swaps to another task', async () => {
    await render(taskView('t1', 'First'))
    act(() => { button('Delete').click() })
    expect(hasButton('Confirm delete')).toBe(true)
    expect(hasButton('Delete')).toBe(false)
    expect(teamsTaskUpdate).not.toHaveBeenCalled()

    // Another task opened in the same instance (no key on the caller's side).
    await render(taskView('t2', 'Second'))

    expect(hasButton('Delete')).toBe(true)
    expect(hasButton('Confirm delete')).toBe(false)
  })

  it('makes the first click on the next task an arm, never the delete', async () => {
    await render(taskView('t1', 'First'))
    act(() => { button('Delete').click() })      // armed on t1
    await render(taskView('t2', 'Second'))
    await act(async () => { button('Delete').click() })   // first click on t2

    expect(teamsTaskUpdate).not.toHaveBeenCalled()
    expect(hasButton('Confirm delete')).toBe(true)
  })

  it('still deletes the visible task on the second click', async () => {
    await render(taskView('t9', 'Only'))
    act(() => { button('Delete').click() })
    await act(async () => { button('Confirm delete').click() })

    expect(teamsTaskUpdate).toHaveBeenCalledWith('root-1', {
      taskId: 't9',
      expectedRevision: 1,
      action: 'delete',
    })
  })
})
