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
      const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="Send current comments to Agent"]')!

      await act(async () => {
        sendButton.click()
        await Promise.resolve()
      })

      expect(send).toHaveBeenCalledOnce()
      expect(send.mock.calls[0]?.[0]).toContain('rename this value')
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
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
