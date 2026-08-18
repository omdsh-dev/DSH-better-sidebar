/** Header split utility: preferred direct-open, chooser menu, and Simple Icons. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { IdeLauncherAction } from '../src/client/IdeLauncherAction.tsx'
import { IdeIcon } from '../src/client/IdeIcon.tsx'
import type { SidebarSessionList } from '../src/context-types.ts'
import { IDE_CATALOG, type InstalledIde } from '../src/ide-catalog.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const copy: Record<string, string> = {
  ideOpen: 'Open in IDE',
  ideOpenWith: 'Open current folder with {name}',
  ideChoose: 'Choose IDE',
  ideInstalled: 'Installed IDEs',
  ideDetecting: 'Detecting IDEs…',
  ideNone: 'No supported IDE detected on the DSH host',
  ideError: 'Action failed: {message}',
}

const translate = (key: string, params?: Record<string, string | number>): string => {
  let value = copy[key] ?? key
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}

const sessions: SidebarSessionList = {
  current: 's1',
  byId: { s1: { id: 's1', displayTitle: 'Session', cwd: '/workspace/current' } },
}

const useSessions = <T,>(selector: (state: SidebarSessionList) => T): T => selector(sessions)

function mount(node: ReactNode): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(node) })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

function component(
  listIdes: () => Promise<InstalledIde[]>,
  openIde = vi.fn(async () => {}),
): ReactNode {
  return createElement(IdeLauncherAction, {
    sessionId: 's1',
    useSessions,
    t: translate,
    listIdes,
    openIde,
  })
}

afterEach(() => {
  for (const child of [...document.body.children]) child.remove()
})

describe('IdeLauncherAction', () => {
  it('pre-detects and replaces the text action with the first IDE icon', async () => {
    const listIdes = vi.fn(async () => [
      { id: 'cursor', name: 'Cursor' } as const,
      { id: 'intellij', name: 'IntelliJ IDEA' } as const,
    ])
    const { container, unmount } = mount(component(listIdes))
    await act(async () => {})
    const primary = container.querySelector<HTMLButtonElement>('button[aria-label="Open current folder with Cursor"]')!
    expect(primary).not.toBeNull()
    expect(primary.textContent).toBe('')
    expect(primary.querySelector('[data-simple-icon="cursor"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Open in IDE')
    expect(listIdes).toHaveBeenCalled()
    unmount()
  })

  it('clicking the preferred IDE icon opens it directly without showing the list', async () => {
    const openIde = vi.fn(async () => {})
    const { container, unmount } = mount(component(
      async () => [
        { id: 'cursor', name: 'Cursor' },
        { id: 'zed', name: 'Zed' },
      ],
      openIde,
    ))
    await act(async () => {})
    const primary = container.querySelector<HTMLButtonElement>('button[aria-label="Open current folder with Cursor"]')!
    await act(async () => { primary.click() })
    expect(openIde).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/workspace/current' }, 'cursor')
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0)
    unmount()
  })

  it('only the chooser icon expands the menu and a picked row opens that IDE', async () => {
    const openIde = vi.fn(async () => {})
    const { container, unmount } = mount(component(
      async () => [
        { id: 'cursor', name: 'Cursor' },
        { id: 'zed', name: 'Zed' },
      ],
      openIde,
    ))
    await act(async () => {})
    const chooser = container.querySelector<HTMLButtonElement>('button[aria-label="Choose IDE"]')!
    expect(chooser.getAttribute('aria-expanded')).toBe('false')
    expect(chooser.querySelectorAll('svg')).toHaveLength(2)
    await act(async () => { chooser.click() })
    const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(rows.slice(0, 2).map(row => row.textContent)).toEqual(['Cursor', 'Zed'])
    expect(rows[0]?.querySelector('[data-simple-icon="cursor"]')).not.toBeNull()
    expect(rows[1]?.querySelector('[data-simple-icon="zedindustries"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('DSH host')
    await act(async () => { rows[1]!.click() })
    expect(openIde).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/workspace/current' }, 'zed')
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0)
    unmount()
  })

  it('keeps the direct-open half disabled when no supported IDE is detected', async () => {
    const { container, unmount } = mount(component(async () => []))
    await act(async () => {})
    const primary = container.querySelector<HTMLButtonElement>('button[aria-label="Open in IDE"]')!
    expect(primary.disabled).toBe(true)
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Choose IDE"]')!.click() })
    expect(document.body.textContent).toContain('No supported IDE detected on the DSH host')
    unmount()
  })

  it('opens the chooser with a direct-launch failure so the error remains visible', async () => {
    const openIde = vi.fn(async () => { throw new Error('application disappeared') })
    const { container, unmount } = mount(component(
      async () => [{ id: 'zed', name: 'Zed' }],
      openIde,
    ))
    await act(async () => {})
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Open current folder with Zed"]')!.click() })
    expect(document.body.textContent).toContain('Action failed: application disappeared')
    expect(container.querySelector('[aria-expanded="true"]')).not.toBeNull()
    unmount()
  })
})

describe('IdeIcon Simple Icons coverage', () => {
  it('uses Simple Icons for every covered IDE and explicit monograms only for missing brands', () => {
    const { container, unmount } = mount(
      createElement('div', {}, IDE_CATALOG.map(ide => createElement(IdeIcon, { key: ide.id, id: ide.id }))),
    )
    expect(container.querySelectorAll('[data-simple-icon]')).toHaveLength(14)
    expect(container.querySelector('[data-ide-icon="vscode"]')).not.toBeNull()
    expect(container.querySelector<HTMLImageElement>('[data-ide-icon="vscode"]')?.src)
      .toMatch(/^data:image\/svg\+xml;base64,/)
    expect(container.querySelector('[data-simple-icon="xcode"]')).not.toBeNull()
    expect(container.querySelector('[data-simple-icon="cursor"]')).not.toBeNull()
    expect(container.querySelector('[data-simple-icon="zedindustries"]')).not.toBeNull()
    expect(container.textContent).toBe('VS')
    unmount()
  })
})
