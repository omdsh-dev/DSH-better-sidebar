/**
 * Existing floating-window callers under the unified layer (S6): the task
 * window and the background-job output window keep their content, sizing and
 * close semantics, and they join the SAME z-order / Escape contract as the
 * public window host. Escape closes only the top window; a pointer on the
 * lower one raises it.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { TaskWindow } from '../src/client/TaskWindow.tsx'
import { JobOutputWindow } from '../src/client/JobsDrawer.tsx'
import type { Context, SidebarTeamTaskView } from '../src/context-types.ts'

setupReactAct()

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

function taskView(): SidebarTeamTaskView {
  return {
    id: 't1',
    revision: 1,
    subject: 'Review',
    description: 'body',
    status: 'in_progress',
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
  }
}

function frames(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-floating-window]')]
}

const roots: RenderedRoot[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

function mountTask(onClose: () => void): RenderedRoot {
  const root = renderRoot(createElement(TaskWindow, {
    rootId: 'root-1',
    task: taskView(),
    members: [],
    ctx: {} as Context,
    onClose,
  }))
  roots.push(root)
  return root
}

function mountJob(onClose: () => void): RenderedRoot {
  const root = renderRoot(createElement(JobOutputWindow, {
    jobs: undefined,
    job: { id: 'bash-1', kind: 'bash', label: 'bash-1', status: 'running', startedAt: 1 },
    ownerSessionId: 'root-1',
    observed: undefined,
    onClose,
  }))
  roots.push(root)
  return root
}

describe('legacy windows share the unified layer', () => {
  it('renders the task and job windows together and closes only the top on Escape', () => {
    const taskClosed = vi.fn()
    const jobClosed = vi.fn()
    mountTask(taskClosed)
    mountJob(jobClosed)
    expect(frames()).toHaveLength(2)

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(jobClosed).toHaveBeenCalledTimes(1)
    expect(taskClosed).not.toHaveBeenCalled()

    roots[1]!.unmount()
    roots.splice(1, 1)
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(taskClosed).toHaveBeenCalledTimes(1)
  })

  it('raises the task window when its title bar is pressed', () => {
    const taskClosed = vi.fn()
    const jobClosed = vi.fn()
    mountTask(taskClosed)
    mountJob(jobClosed)
    const taskFrame = frames().find(node => node.getAttribute('aria-label') !== 'bash-1')!
    const handle = taskFrame.querySelector('[data-window-handle]') as HTMLElement
    act(() => {
      handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(taskClosed).toHaveBeenCalledTimes(1)
    expect(jobClosed).not.toHaveBeenCalled()
  })
})
