/** @vitest-environment jsdom */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { FileCommentsPanel } from '../src/client/FileCommentsPanel.tsx'
import { fileCommentStore } from '../src/client/file-comments.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

describe('FileCommentsPanel', () => {
  it('freezes the submitted snapshot and leaves comments added during send pending', async () => {
    const sessionId = `file-comments-panel-${Date.now()}`
    const path = '/work/a.ts'
    let finishSend: (() => void) | undefined
    const send = vi.fn((_text: string) => new Promise<void>((resolve) => { finishSend = resolve }))
    const ctx = {
      sessions: {
        scope: vi.fn(() => ({ get: vi.fn(() => ({ send })) })),
      },
    } as unknown as Context
    const first = fileCommentStore.add(sessionId, {
      path,
      lines: { start: 1, end: 1 },
      selectedText: 'const value = 1',
      body: 'rename this value',
    })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(createElement(FileCommentsPanel, { ctx, sessionId, cwd: '/work', path }))
      })
      expect(container.textContent).toContain('a.ts:1')
      expect(container.querySelector('pre')?.textContent).toBe('const value = 1')
      expect(container.textContent).toContain('rename this value')
      const selectedBeforeSend = container.querySelector<HTMLInputElement>('input[aria-label="Select comment"]')!
      act(() => { selectedBeforeSend.click() })
      expect(selectedBeforeSend.checked).toBe(true)
      const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send current comments to Agent"]')!

      await act(async () => {
        sendButton.click()
        await Promise.resolve()
      })

      expect(send).toHaveBeenCalledOnce()
      expect(send.mock.calls[0]?.[0]).toContain('rename this value')
      expect(container.querySelector<HTMLInputElement>('input[aria-label="Select comment"]')?.disabled).toBe(true)
      expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Delete')?.disabled).toBe(true)
      expect(container.querySelector<HTMLButtonElement>('button[aria-label="Edit comment"]')?.disabled).toBe(true)
      expect(container.querySelector<HTMLButtonElement>('button[aria-label="Delete comment"]')?.disabled).toBe(true)

      let laterId = ''
      act(() => {
        laterId = fileCommentStore.add(sessionId, {
          path,
          lines: { start: 3, end: 3 },
          selectedText: 'const later = 2',
          body: 'this arrived later',
        }).id
      })
      await act(async () => {
        finishSend?.()
        await Promise.resolve()
      })

      expect(fileCommentStore.getSnapshot(sessionId).find(comment => comment.id === first.id)?.sentAt).toBeDefined()
      expect(fileCommentStore.getSnapshot(sessionId).find(comment => comment.id === laterId)?.sentAt).toBeUndefined()
      act(() => { container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[0]?.click() })
      expect(container.querySelector<HTMLInputElement>('input[aria-label="Select comment"]')?.checked).toBe(false)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('selects, clears, and deletes current comments while preserving review details', () => {
    const sessionId = `file-comments-panel-bulk-${Date.now()}`
    const path = '/work/chapters/00005_find-box.md'
    fileCommentStore.add(sessionId, {
      path,
      lines: { start: 5, end: 9 },
      selectedText: 'const selected = true',
      body: 'explain why this branch is needed',
    })
    fileCommentStore.add(sessionId, {
      path,
      lines: { start: 12, end: 12 },
      selectedText: 'return result',
      body: 'rename this result',
    })
    const ctx = {} as Context
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(createElement(FileCommentsPanel, { ctx, sessionId, cwd: '/work', path }))
      })
      expect(container.textContent).toContain('chapters/00005_find-box.md:5-9')
      expect(container.textContent).toContain('const selected = true')
      expect(container.textContent).toContain('explain why this branch is needed')

      const checkboxes = () => [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Select comment"]')]
      const buttonWithText = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent === text)!

      const bulkButtons = [...buttonWithText('Select all').parentElement!.querySelectorAll<HTMLButtonElement>('button')]
      expect(bulkButtons[1]?.getAttribute('aria-label')).toBe('Send current comments to Agent')

      act(() => { buttonWithText('Select all').click() })
      expect(checkboxes()).toHaveLength(2)
      expect(checkboxes().every(checkbox => checkbox.checked)).toBe(true)

      act(() => { buttonWithText('Cancel').click() })
      expect(checkboxes().every(checkbox => !checkbox.checked)).toBe(true)

      const firstRow = [...container.querySelectorAll<HTMLElement>('article')]
        .find(row => row.textContent?.includes('explain why this branch is needed'))!
      act(() => {
        firstRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
        firstRow.querySelector<HTMLButtonElement>('button[aria-label="Edit comment"]')!.click()
      })
      expect(container.querySelector('textarea[aria-label="Edit comment"]')).not.toBeNull()

      act(() => { buttonWithText('Delete').click() })
      expect(container.textContent).not.toContain('explain why this branch is needed')
      expect(container.textContent).toContain('rename this result')
      expect(container.querySelector('textarea[aria-label="Edit comment"]')).toBeNull()
      expect(checkboxes()).toHaveLength(1)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
