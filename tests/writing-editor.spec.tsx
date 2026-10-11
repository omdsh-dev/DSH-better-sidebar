// @vitest-environment jsdom
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { WritingEditor } from '../src/client/WritingEditor.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('WritingEditor', () => {
  it('renders Markdown as editable content and saves with Ctrl+S', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let saves = 0
    await act(async () => { root.render(<WritingEditor value={'# Draft\n\nA **bold** paragraph.'} onChange={() => {}} onSave={() => { saves += 1 }} />) })

    const editor = host.querySelector<HTMLElement>('[contenteditable="true"]')
    expect(editor?.querySelector('h1')?.textContent).toBe('Draft')
    expect(editor?.querySelector('strong')?.textContent).toBe('bold')
    expect(host.querySelector('[role="toolbar"]')).not.toBeNull()
    await act(async () => { editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })) })
    expect(saves).toBe(1)

    await act(async () => { root.unmount() })
    host.remove()
  })
})
