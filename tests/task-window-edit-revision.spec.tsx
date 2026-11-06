/**
 * The task window's edit save is a CAS write: `expectedRevision` must be the
 * revision the draft was OPENED against, not the live one the projection keeps
 * pushing while the window stays open. Saving with the live revision makes the
 * host's conflict check a no-op and silently overwrites a teammate's write.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { TaskWindow } from '../src/client/TaskWindow.tsx'
import type { Context, SidebarTeamTaskView } from '../src/context-types.ts'
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

function taskView(revision: number, subject: string): SidebarTeamTaskView {
  return {
    id: 't1',
    revision,
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

/** Render — or RE-render in place — the one window, as the projection does
 *  when a teammate's write lands during an open edit. */
async function render(task: SidebarTeamTaskView): Promise<void> {
  await act(async () => {
    root.render(createElement(TaskWindow, {
      rootId: 'root-1',
      task,
      members: [],
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

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  teamsTaskUpdate.mockClear()
})

describe('TaskWindow edit revision snapshot', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  it('saves against the revision present when editing opened, not the live one', async () => {
    await render(taskView(1, 'First'))
    act(() => { button('Edit').click() })
    // A teammate's write lands while the draft is open: the projection hands
    // over revision 2, but the draft still describes revision 1.
    await render(taskView(2, 'Changed elsewhere'))
    await act(async () => { button('Save').click() })

    expect(teamsTaskUpdate).toHaveBeenCalledWith('root-1', expect.objectContaining({
      taskId: 't1',
      action: 'edit',
      expectedRevision: 1,
    }))
  })

  it('re-bases the snapshot when editing is reopened', async () => {
    await render(taskView(1, 'First'))
    act(() => { button('Edit').click() })
    act(() => { button('Cancel').click() })
    await render(taskView(3, 'Changed elsewhere'))
    act(() => { button('Edit').click() })
    await act(async () => { button('Save').click() })

    expect(teamsTaskUpdate).toHaveBeenCalledWith('root-1', expect.objectContaining({
      expectedRevision: 3,
    }))
  })

  it('re-bases after a conflict so the next Save commits, keeping the draft', async () => {
    await render(taskView(1, 'First'))
    act(() => { button('Edit').click() })

    // The reader types a real draft into both fields.
    await act(async () => {
      const subject = document.querySelector<HTMLInputElement>('input[aria-label="Subject"]')!
      const subjectSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      subjectSetter?.call(subject, 'My draft')
      subject.dispatchEvent(new Event('input', { bubbles: true }))

      const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]')!
      const areaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      areaSetter?.call(area, 'draft body')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // A teammate's write lands while the draft is open: projection → rev2.
    await render(taskView(2, 'Changed elsewhere'))

    // First Save carries the stale rev1 snapshot → rejected (409 team-conflict,
    // which does NOT advance the revision). Second Save must use rev2 → ok.
    teamsTaskUpdate
      .mockImplementationOnce(async () => ({ ok: false, code: 'team-conflict', message: 'stale' }))
      .mockImplementationOnce(async () => ({ ok: true }))

    await act(async () => { button('Save').click() })
    expect(teamsTaskUpdate).toHaveBeenNthCalledWith(1, 'root-1', expect.objectContaining({
      action: 'edit',
      expectedRevision: 1,
      subject: 'My draft',
      description: 'draft body',
    }))
    // The conflict is reported, but the draft is NOT discarded and editing is
    // NOT left (the only exit used to throw away unsaved text): the textarea
    // is still here with the reader's text, not the task's current content.
    expect(document.body.textContent).toContain('The task changed elsewhere; refreshed')
    const kept = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]')!
    expect(kept.value).toBe('draft body')

    // Second Save now submits against the re-based rev2 and succeeds (the
    // window returns to the read-only view, i.e. the Edit button is back).
    await act(async () => { button('Save').click() })
    expect(teamsTaskUpdate).toHaveBeenNthCalledWith(2, 'root-1', expect.objectContaining({
      action: 'edit',
      expectedRevision: 2,
      subject: 'My draft',
      description: 'draft body',
    }))
    expect(button('Edit')).toBeDefined()
  })
})
