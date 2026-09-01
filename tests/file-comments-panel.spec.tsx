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
      expect(selectedBeforeSend.checked).toBe(true)
      const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send selected comments to Agent"]')!

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
      expect(container.querySelector<HTMLInputElement>('input[aria-label="Select comment"]')?.checked).toBe(true)
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
      expect(bulkButtons[1]?.getAttribute('aria-label')).toBe('Send selected comments to Agent')
      expect(bulkButtons[1]?.textContent).toBe('Send')
      expect(checkboxes().every(checkbox => checkbox.checked)).toBe(true)
      expect(buttonWithText('Select all').disabled).toBe(true)

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

  it('sends only checked comments and leaves unchecked comments pending', async () => {
    const sessionId = `file-comments-panel-selection-${Date.now()}`
    const path = '/work/a.ts'
    const send = vi.fn(async (_text: string) => {})
    const ctx = {
      sessions: {
        scope: vi.fn(() => ({ get: vi.fn(() => ({ send })) })),
      },
    } as unknown as Context
    const included = fileCommentStore.add(sessionId, {
      path,
      lines: { start: 1, end: 1 },
      selectedText: 'const included = 1',
      body: 'include this comment',
    })
    const excluded = fileCommentStore.add(sessionId, {
      path,
      lines: { start: 2, end: 2 },
      selectedText: 'const excluded = 2',
      body: 'exclude this comment',
    })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(createElement(FileCommentsPanel, { ctx, sessionId, cwd: '/work', path }))
      })
      const rows = [...container.querySelectorAll<HTMLElement>('article')]
      const excludedRow = rows.find(row => row.textContent?.includes('exclude this comment'))!
      act(() => { excludedRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })

      const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send selected comments to Agent"]')!
      await act(async () => {
        sendButton.click()
        await Promise.resolve()
      })

      expect(send).toHaveBeenCalledOnce()
      expect(send.mock.calls[0]?.[0]).toContain('include this comment')
      expect(send.mock.calls[0]?.[0]).not.toContain('exclude this comment')
      expect(fileCommentStore.getSnapshot(sessionId).find(comment => comment.id === included.id)?.sentAt).toBeDefined()
      expect(fileCommentStore.getSnapshot(sessionId).find(comment => comment.id === excluded.id)?.sentAt).toBeUndefined()

      act(() => { container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[0]?.click() })
      expect(container.querySelector<HTMLInputElement>('input[aria-label="Select comment"]')?.checked).toBe(false)
      expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send selected comments to Agent"]')?.disabled).toBe(true)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('selects, resends, and deletes checked history comments', async () => {
    const sessionId = `file-comments-panel-history-${Date.now()}`
    const path = '/work/a.ts'
    const send = vi.fn(async (_text: string) => {})
    const ctx = {
      sessions: {
        scope: vi.fn(() => ({ get: vi.fn(() => ({ send })) })),
      },
    } as unknown as Context
    const first = fileCommentStore.add(sessionId, {
      path,
      lines: { start: 1, end: 1 },
      selectedText: 'const first = 1',
      body: 'resend this comment',
    })
    const second = fileCommentStore.add(sessionId, {
      path,
      lines: { start: 2, end: 2 },
      selectedText: 'const second = 2',
      body: 'keep this history comment',
    })
    fileCommentStore.markSent(sessionId, [first.id, second.id])
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(createElement(FileCommentsPanel, { ctx, sessionId, cwd: '/work', path }))
      })
      act(() => { container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]?.click() })

      const checkboxes = () => [...container.querySelectorAll<HTMLInputElement>('input[aria-label="Select comment"]')]
      const buttonWithText = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent === text)!
      expect(checkboxes()).toHaveLength(2)
      expect(checkboxes().every(checkbox => checkbox.checked)).toBe(true)

      act(() => { buttonWithText('Cancel').click() })
      expect(checkboxes().every(checkbox => !checkbox.checked)).toBe(true)
      expect(buttonWithText('Send').disabled).toBe(true)
      expect(buttonWithText('Delete').disabled).toBe(true)

      act(() => { buttonWithText('Select all').click() })
      const secondRow = [...container.querySelectorAll<HTMLElement>('article')]
        .find(row => row.textContent?.includes('keep this history comment'))!
      act(() => { secondRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })

      await act(async () => {
        buttonWithText('Send').click()
        await Promise.resolve()
      })
      expect(send).toHaveBeenCalledOnce()
      expect(send.mock.calls[0]?.[0]).toContain('resend this comment')
      expect(send.mock.calls[0]?.[0]).not.toContain('keep this history comment')
      expect(fileCommentStore.getSnapshot(sessionId).filter(comment => comment.sentAt !== undefined)).toHaveLength(2)

      act(() => { buttonWithText('Delete').click() })
      expect(fileCommentStore.getSnapshot(sessionId).find(comment => comment.id === first.id)).toBeUndefined()
      expect(fileCommentStore.getSnapshot(sessionId).find(comment => comment.id === second.id)).toBeDefined()
      expect(container.textContent).toContain('keep this history comment')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
