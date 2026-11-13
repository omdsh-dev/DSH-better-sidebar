// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerWindowLayer } from '../src/client/windows/layer.ts'
const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); document.body.innerHTML = '' })

describe('floating window Escape ownership', () => {
  it('leaves the window open when a child menu consumes Escape', () => {
    const close = vi.fn()
    disposers.push(registerWindowLayer({ close }).dispose)
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu')
    const item = document.createElement('button'); menu.append(item); document.body.append(menu)
    item.addEventListener('keydown', event => { if (event.key === 'Escape') event.preventDefault() })
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(close).not.toHaveBeenCalled()
    menu.remove()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('honors stopped propagation and still closes only the top unhandled window', () => {
    const lower = vi.fn(); const upper = vi.fn()
    disposers.push(registerWindowLayer({ close: lower }).dispose)
    disposers.push(registerWindowLayer({ close: upper }).dispose)
    const editor = document.createElement('textarea'); document.body.append(editor)
    editor.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation() })
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(lower).not.toHaveBeenCalled(); expect(upper).not.toHaveBeenCalled()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(lower).not.toHaveBeenCalled(); expect(upper).toHaveBeenCalledTimes(1)
  })
})
