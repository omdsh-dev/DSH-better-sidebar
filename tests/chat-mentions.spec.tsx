// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { MarkdownText, type MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../src/context-types.ts'
import { isAbsoluteMarkdownPath, markdownMentionsFor, registerChatMarkdownMentions } from '../src/client/chat-mentions.ts'
import { markdownTextProps } from '../src/client/markdown-labels.tsx'
import { attachLocale } from '../src/client/locales.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

const labels = { copyLabel: 'Copy', copiedLabel: 'Copied', codeLabel: 'Code', wrapLabel: 'Wrap', unwrapLabel: 'Unwrap' }
const roots: Root[] = []
const disposers: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  document.body.innerHTML = ''
  attachLocale(undefined)
})

describe('absolute Markdown chat mentions', () => {
  it('recognizes complete absolute Markdown paths on supported platforms', () => {
    for (const path of ['/Users/x/notes/a.md', '/notes/README.MARKDOWN', 'C:\\notes\\a.md', 'D:/notes/a.MarkDown', '\\\\server\\share\\notes\\a.md', '//server/share/notes/a.md']) {
      expect(isAbsoluteMarkdownPath(path), path).toBe(true)
    }
    for (const value of ['notes/a.md', 'a.md', '@notes/a.md', '/notes/a.txt', '/notes/a.md?raw=1', 'https://example.com/a.md', '/notes/a b.md', '/notes/a.md\n', 'C:notes\\a.md', '\\\\server\\share.md']) {
      expect(isAbsoluteMarkdownPath(value), value).toBe(false)
    }
  })

  it('keeps a stock match and routes a new absolute path through the chat opener', () => {
    const opened: string[] = []
    const stockMatch = { open: () => { opened.push('stock') }, label: 'Stock file', title: '/stock/a.md' }
    const stock: MarkdownFileMentions = { resolve: value => value === '/stock/a.md' ? stockMatch : undefined }
    const mentions = markdownMentionsFor({ openFile: path => { opened.push(path) } }, stock)
    expect(mentions.resolve('/stock/a.md')).toBe(stockMatch)
    mentions.resolve('/stock/a.md')?.open()
    const path = '/Users/x/notes/a.md'
    expect(mentions.resolve(path)?.title).toBe(path)
    mentions.resolve(path)?.open()
    expect(mentions.resolve('notes/a.md')).toBeUndefined()
    expect(opened).toEqual(['stock', path])
  })

  it('registers after the real Cordis service arrives and restores its method on release', async () => {
    const context = new CordisContext()
    const disposeMentions = registerChatMarkdownMentions(context as unknown as Context)
    disposers.push(disposeMentions)
    expect(context.get('chatFileMentions')).toBeUndefined()

    const opened: string[] = []
    const stockMatch = { open: () => { opened.push('stock') }, label: 'Stock file', title: '/stock/a.md' }
    const stock: MarkdownFileMentions = { resolve: value => value === '/stock/a.md' ? stockMatch : undefined }
    const originalForClosing = (_owner: { openFile: (path: string) => void }, _sessionId: string): MarkdownFileMentions => stock
    const service = { forClosing: originalForClosing }
    disposers.push(context.provide('chatFileMentions', service))
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(service.forClosing).not.toBe(originalForClosing)
    const owner = { openFile: (path: string) => { opened.push(path) } }
    const mentions = service.forClosing(owner, 's1')
    expect(mentions?.resolve('/stock/a.md')).toBe(stockMatch)
    const path = '/Users/x/notes/a.md'
    mentions?.resolve(path)?.open()
    expect(opened).toEqual([path])

    await disposeMentions()
    expect(service.forClosing).toBe(originalForClosing)
    expect(service.forClosing(owner, 's1')?.resolve(path)).toBeUndefined()
  })

  it('stops extending results when a later host wrapper remains installed', async () => {
    const context = new CordisContext()
    const disposeMentions = registerChatMarkdownMentions(context as unknown as Context)
    disposers.push(disposeMentions)

    const stock: MarkdownFileMentions = { resolve: () => undefined }
    const originalForClosing = (_owner: { openFile: (path: string) => void }, _sessionId: string): MarkdownFileMentions => stock
    const service = { forClosing: originalForClosing }
    disposers.push(context.provide('chatFileMentions', service))
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    const installedWrapper = service.forClosing
    let laterWrapperCalls = 0
    service.forClosing = function (owner, sessionId) {
      laterWrapperCalls++
      return installedWrapper.call(service, owner, sessionId)
    }
    await disposeMentions()

    const owner = { openFile: (_path: string) => {} }
    const mentions = service.forClosing(owner, 's1')
    expect(laterWrapperCalls).toBe(1)
    expect(mentions).toBe(stock)
    expect(mentions?.resolve('/Users/x/notes/a.md')).toBeUndefined()
  })

  it('renders only a claimed inline-code path as a keyboard-accessible button', async () => {
    const opened: string[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const path = '/Users/x/notes/a.md'
    const tick = String.fromCharCode(96)
    await act(async () => {
      root.render(createElement(MarkdownText, {
        ...markdownTextProps(tick + path + tick + ' and ' + tick + 'notes/a.md' + tick, labels),
        fileMentions: markdownMentionsFor({ openFile: value => { opened.push(value) } }, undefined),
      }))
    })
    const button = container.querySelector('code button')
    expect(button?.getAttribute('type')).toBe('button')
    expect(button?.getAttribute('title')).toBe(path)
    expect(button?.getAttribute('aria-label')).toContain(path)
    expect(container.querySelectorAll('code button')).toHaveLength(1)
    expect(container.querySelectorAll('code')).toHaveLength(2)
    await act(async () => { (button as HTMLButtonElement).click() })
    expect(opened).toEqual([path])
  })
})
