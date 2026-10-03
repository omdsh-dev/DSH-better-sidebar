/**
 * The native right sidebar parks mounted tabs. A CodeMirror view opened while
 * its host is hidden must request a fresh measure when the host is revealed;
 * otherwise the gutter can remain while the virtualized document is blank.
 */
// @vitest-environment jsdom
import './browser-globals.ts'
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import type { Context } from '../src/context-types.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { FileViewerProps } from '../src/client/service.ts'
import { setupReactAct } from './test-utils.ts'

setupReactAct()

const CTX = {} as Context
const instances: FakeResizeObserver[] = []
const OriginalResizeObserver = globalThis.ResizeObserver

class FakeResizeObserver {
  readonly targets: Element[] = []
  disconnected = false
  constructor(private readonly callback: ResizeObserverCallback) {
    instances.push(this)
  }
  observe(target: Element): void {
    this.targets.push(target)
  }
  unobserve(target: Element): void {
    const index = this.targets.indexOf(target)
    if (index >= 0) this.targets.splice(index, 1)
  }
  disconnect(): void {
    this.disconnected = true
    this.targets.length = 0
  }
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

function props(store: ReturnType<typeof createSidebarStore>): FileViewerProps {
  return {
    ctx: CTX,
    store,
    scope: { sessionId: 's1', cwd: '/workspace' },
    path: '/workspace/run_viewer/web/src/pages/Trajectory.tsx',
    title: 'Trajectory.tsx',
    viewerId: 'code',
    content: "/** editor visibility regression */\nexport function Trajectory() {\n  return null\n}\n",
    toolbar: 'host',
  }
}

describe('TextEditor visibility recovery', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  beforeEach(() => {
    instances.length = 0
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  })

  afterEach(() => {
    act(() => { root?.unmount() })
    container?.remove()
    root = undefined
    container = undefined
    instances.length = 0
    if (OriginalResizeObserver === undefined) {
      Reflect.deleteProperty(globalThis, 'ResizeObserver')
    } else {
      globalThis.ResizeObserver = OriginalResizeObserver
    }
    vi.restoreAllMocks()
  })

  it('observes the CodeMirror host and requests a measure after reveal', () => {
    const store = createSidebarStore()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => { root!.render(createElement(TextEditor, props(store))) })

    const host = container.querySelector('[class*="editorCm"]')
    expect(host).toBeInstanceOf(HTMLDivElement)
    const editorHost = host as HTMLDivElement
    Object.defineProperties(editorHost, {
      offsetWidth: { configurable: true, value: 480 },
      offsetHeight: { configurable: true, value: 640 },
    })
    const observer = instances.find(candidate => candidate.targets.includes(editorHost))
    expect(observer).toBeDefined()

    const requestMeasure = vi.spyOn(EditorView.prototype, 'requestMeasure')
    observer!.trigger()
    expect(requestMeasure).toHaveBeenCalled()
  })

  it('disconnects the observer when the editor unmounts', () => {
    const store = createSidebarStore()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => { root!.render(createElement(TextEditor, props(store))) })
    const host = container.querySelector('[class*="editorCm"]') as HTMLDivElement
    const observer = instances.find(candidate => candidate.targets.includes(host))
    expect(observer).toBeDefined()

    act(() => { root!.unmount() })
    expect(observer!.disconnected).toBe(true)
  })
})
