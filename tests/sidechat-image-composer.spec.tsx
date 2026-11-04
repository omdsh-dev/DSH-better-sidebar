/** Paste and picker share image drafts; delayed sends preserve newer owners and edits, and saved previews release their URLs. */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { SideChatView } from '../src/client/SideChatView.tsx'
import type { Context } from '../src/context-types.ts'
import type { RenderedRoot } from './test-utils.ts'

const limits = { maxImagesPerMessage: 8, maxImageBytes: 1000, maxMessageImageBytes: 2000, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }
let harness: SidechatHarness
let mounted: RenderedRoot
let calls: Record<string, unknown>[]
let imageReads: string[]
let hold: Promise<void> | undefined
let rejectSend = false
const createUrl = vi.fn(() => `blob:preview-${createUrl.mock.calls.length}`)
const revokeUrl = vi.fn()
const response = (value: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) }) as Response
const image = (name = 'shot.png') => new File(['abc'], name, { type: 'image/png' })

beforeEach(() => {
  calls = []; imageReads = []; hold = undefined; rejectSend = false; createUrl.mockClear(); revokeUrl.mockClear()
  harness = installSidechatHarness({ info: { live: true, images: { available: true, limits } } })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl })
  vi.stubGlobal('fetch', async (url: string | URL, options?: RequestInit) => {
    if (String(url).includes('sidechat-image?')) {
      imageReads.push(String(url))
      return { ok: true, blob: async () => new Blob(['abc'], { type: 'image/png' }) } as Response
    }
    const method = String(url).split('/').pop()
    if (method === 'sidechat.events') return response({ events: harness.wire.events, live: [], pending: harness.wire.pending })
    if (method === 'sidechat.info') return response(harness.wire.info)
    if (method === 'sidechat.models') return response(harness.wire.catalog)
    if (method === 'sidechat.prompt') {
      calls.push(JSON.parse(String(options?.body)))
      await hold
      if (rejectSend) throw new Error('Connection lost; acceptance unknown')
      return response({ accepted: true, messageId: `message-${calls.length}` })
    }
    return response({})
  })
  mounted = harness.mount()
})
afterEach(() => { mounted.unmount(); harness.cleanup() })

function select(files: File[]): void {
  const input = mounted.container.querySelector<HTMLInputElement>('input[type=file]')!
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  act(() => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}
function paste(file: File): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } })
  act(() => { mounted.container.querySelector('textarea')!.dispatchEvent(event) })
  return event
}
async function send(): Promise<void> {
  await act(async () => {
    mounted.container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!.click()
    await new Promise(resolve => setTimeout(resolve, 15))
  })
}
function bind(childId: string): void {
  const ctx = { get: () => undefined, sessions: { list: { subscribe: () => () => {}, getSnapshot: () => snapshot } } } as unknown as Context
  const snapshot = { byId: { root: { id: 'root', displayTitle: 'root', running: false }, [childId]: { id: childId, displayTitle: 'Side: thread', origin: 'subagent', parentId: 'root', running: false } } }
  mounted.rerender(createElement(SideChatView, { ctx, scope: { sessionId: 'root', cwd: '/p' }, tab: { id: 'tab1', type: 'sidechat', title: 'thread', meta: { threadId: childId } }, visible: true }))
}

describe('sidechat image composer', () => {
  it('shares paste and choice, removes previews and sends pure images', async () => {
    await harness.flush()
    const bubbled = vi.fn()
    document.addEventListener('paste', bubbled)
    const event = paste(image())
    document.removeEventListener('paste', bubbled)
    expect(event.defaultPrevented).toBe(true)
    expect(bubbled.mock.calls).toEqual([])
    select([image('second.png')])
    expect(mounted.container.querySelectorAll('img')).toHaveLength(2)
    act(() => { mounted.container.querySelector<HTMLButtonElement>('button[aria-label="移除 shot.png"]')!.click() })
    expect(revokeUrl.mock.calls).toEqual([['blob:preview-1']])
    await send()
    expect(calls).toEqual([{ childId: 't1', text: '', images: [{ mediaType: 'image/png', name: 'second.png', data: 'YWJj' }] }])
    expect(mounted.container.querySelector('textarea')?.value).toBe('')
    expect(imageReads).toEqual([])
    expect(mounted.container.textContent).toContain('正在加载图片')
    expect(revokeUrl.mock.calls).toContainEqual(['blob:preview-2'])
  })

  it('does not swallow a clipboard that has no image file', async () => {
    await harness.flush()
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'string', type: 'text/plain', getAsString: () => 'hello' }] } })
    act(() => { mounted.container.querySelector('textarea')!.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
    expect(mounted.container.querySelectorAll('img')).toHaveLength(0)
  })

  it('retains the draft on network uncertainty and surfaces unsupported files', async () => {
    await harness.flush()
    select([new File(['text'], 'bad.svg', { type: 'image/svg+xml' })])
    expect(mounted.container.textContent).toContain('请选择 PNG')
    expect(mounted.container.querySelectorAll('img')).toHaveLength(0)
    select([image()])
    harness.typeComposer('keep me')
    rejectSend = true
    await send()
    expect(mounted.container.textContent).toContain('消息可能已被接收')
    expect(harness.composerValue()).toBe('keep me')
    expect(mounted.container.querySelector('img')?.getAttribute('src')).toBe('blob:preview-1')
    expect(calls).toHaveLength(1)
    expect(revokeUrl.mock.calls).toEqual([])
  })

  it('keeps newer edits and images when an older send completes', async () => {
    await harness.flush()
    let release!: () => void
    hold = new Promise(resolve => { release = resolve })
    select([image()]); harness.typeComposer('old')
    await send()
    harness.typeComposer('new')
    select([image('new.png')])
    await act(async () => { release(); await Promise.resolve() })
    expect(harness.composerValue()).toBe('new')
    expect(mounted.container.querySelectorAll('button[aria-label^="移除"]')).toHaveLength(1)
    expect(mounted.container.querySelector('button[aria-label="移除 new.png"]')).not.toBeNull()
    expect(calls[0]).toMatchObject({ text: 'old', images: [{ name: 'shot.png' }] })
    expect(revokeUrl.mock.calls).toEqual([['blob:preview-1']])
  })

  it('does not clear an A-to-B-to-A draft with an old completion and releases owner URLs', async () => {
    await harness.flush()
    let release!: () => void
    hold = new Promise(resolve => { release = resolve })
    select([image()]); harness.typeComposer('old')
    await send()
    bind('t2'); await harness.flush()
    bind('t1'); await harness.flush()
    harness.typeComposer('new binding')
    await act(async () => { release(); await Promise.resolve() })
    expect(harness.composerValue()).toBe('new binding')
    expect(revokeUrl.mock.calls).toEqual([['blob:preview-1']])
    expect(mounted.container.textContent).not.toContain('排队中')
    expect(calls).toHaveLength(1)
  })

  it('reattaches a restored native tab to the remembered thread without sending again', async () => {
    await harness.flush()
    const snapshot = { byId: { root: { id: 'root', displayTitle: 'root', running: false }, t1: { id: 't1', displayTitle: 'Side: thread', origin: 'subagent', parentId: 'root', running: false } } }
    const ctx = { get: (key: string) => key === 'betterSidebar' ? harness.host : undefined, sessions: { list: { subscribe: () => () => {}, getSnapshot: () => snapshot } } } as unknown as Context
    mounted.rerender(createElement(SideChatView, { ctx, scope: { sessionId: 'root', cwd: '/p' }, tab: { id: 'restored', type: 'sidechat', title: 'Side Chat' }, visible: true }))
    await harness.flush()
    expect(harness.host.updateTab).toHaveBeenCalledWith('restored', { meta: { threadId: 't1' } }, 'root')
    expect(calls).toEqual([])
  })

  it('renders saved and cold pending images by occurrence, disables cold dequeue and cleans loaded URLs', async () => {
    harness.wire.events = [{ type: 'user/message', seq: 1, time: 1, data: { id: 'saved', source: { kind: 'user' }, content: [{ type: 'image', attachment: { mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'saved.png' } }] } }]
    harness.wire.pending = [{ id: 'queued', target: 'next-turn', text: '', removable: false, images: [{ blockIndex: 0, mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'queued.png' }] }]
    bind('reloaded'); await harness.flush(5)
    expect([...mounted.container.querySelectorAll('img')].map(node => node.alt)).toEqual(['saved.png', 'queued.png'])
    expect(mounted.container.querySelector<HTMLButtonElement>('button[aria-label="从队列移除"]')?.disabled).toBe(true)
    bind('another'); await harness.flush(3)
    expect(revokeUrl.mock.calls).toContainEqual(['blob:preview-1'])
    expect(revokeUrl.mock.calls).toContainEqual(['blob:preview-2'])
  })
})
