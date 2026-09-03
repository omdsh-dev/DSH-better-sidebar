/**
 * The editor's "open with" settings panel: the SSH host row and the custom
 * editor list (name + URL template + VSCode-family flag, add/remove). Every
 * edit commits the whole `openWith` blob through the popup's
 * updatePluginSetting; removing an editor also prunes its pinned id.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { OpenWithSettings } from '../src/client/open-with-settings.tsx'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

interface Harness {
  container: HTMLDivElement
  update: ReturnType<typeof vi.fn>
  unmount: () => void
}

function mountSettings(rawOpenWith: unknown): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const update = vi.fn()
  act(() => {
    root.render(createElement(OpenWithSettings, {
      pluginSettings: { openWith: rawOpenWith },
      updatePluginSetting: update,
    }))
  })
  return {
    container,
    update,
    unmount: () => { act(() => { root.unmount() }) },
  }
}

const baseConfig = {
  sshHost: 'dev',
  customEditors: [
    { id: 'a', name: 'Windsurf', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false },
  ],
  pinned: ['vscode', 'custom:a'],
}

describe('OpenWithSettings', () => {
  let harness: Harness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
  })

  it('seeds the SSH host input from the persisted blob and commits edits', () => {
    harness = mountSettings(baseConfig)
    const input = harness.container.querySelector<HTMLInputElement>('input:not([type])')
    expect(input?.value).toBe('dev')
    // The native value setter (React's value tracker must see the change).
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, 'prod')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(harness.update.mock.calls[0]?.[0]).toBe('openWith')
    expect(harness.update.mock.calls[0]?.[1]).toMatchObject({ sshHost: 'prod' })
  })

  it('adds a custom editor row and commits the extended list', () => {
    harness = mountSettings(baseConfig)
    const add = [...harness.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Add')
    expect(add).toBeDefined()
    act(() => { add!.click() })
    const blob = harness.update.mock.calls[0]?.[1] as { customEditors: unknown[]; pinned: string[] }
    expect(blob.customEditors).toHaveLength(2)
    expect(blob.pinned).toEqual(['vscode', 'custom:a'])
  })

  it('removes an editor and prunes its pinned id', () => {
    harness = mountSettings(baseConfig)
    const remove = harness.container.querySelector<HTMLButtonElement>('button[aria-label="Remove"]')
    expect(remove).toBeDefined()
    act(() => { remove!.click() })
    const blob = harness.update.mock.calls[0]?.[1] as { customEditors: unknown[]; pinned: string[] }
    expect(blob.customEditors).toHaveLength(0)
    expect(blob.pinned).toEqual(['vscode'])
  })

  it('shows the validity hint when a row is incomplete', () => {
    harness = mountSettings({
      sshHost: '',
      customEditors: [{ id: 'x', name: 'Bad', urlTemplate: 'x://file/x', isVscodeFamily: true }],
      pinned: [],
    })
    expect(harness.container.textContent).toContain('are not shown in the menu')
  })

  it('edits the VSCode-family flag of one row', () => {
    harness = mountSettings(baseConfig)
    const checkbox = harness.container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(checkbox?.checked).toBe(false)
    act(() => { checkbox!.click() })
    const blob = harness.update.mock.calls[0]?.[1] as { customEditors: { isVscodeFamily: boolean }[] }
    expect(blob.customEditors[0]?.isVscodeFamily).toBe(true)
  })
})
