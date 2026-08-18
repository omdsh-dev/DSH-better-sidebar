/**
 * Secondary-settings modal close-button regression: feature popups (Terminal,
 * Browser, HTML viewer, etc.) attach the scoped content class that restyles
 * Modal's header close control to the parent Settings card recipe.
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { SIDEBAR_PREFS_DEFAULTS } from '../src/prefs-shared.ts'
import { api } from '../src/client/api.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { SideCardSection, type SideCardSectionProps } from '../src/client/SideCardSection.tsx'
import css from '../src/client/SideCardSection.module.css'
import { createSidebarStore } from '../src/client/state.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

describe('secondary settings popup close control', () => {
  it('scopes the Settings-card close recipe onto a feature popup', async () => {
    const store = createSidebarStore()
    const service = createBetterSidebarService(store)
    service.registerTab({
      id: 'terminal',
      title: 'Terminal',
      settings: {
        toggles: [{ key: 'terminalFontFamily', title: 'Font family', type: 'text' }],
      },
      component: () => null,
    })
    vi.spyOn(api, 'settingsGet').mockResolvedValue({ value: SIDEBAR_PREFS_DEFAULTS, revision: 1 })

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(
        SideCardSection,
        { store, service } as unknown as SideCardSectionProps,
      ))
    })

    const settingsButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Terminal Feature settings"]',
    )
    expect(settingsButton).not.toBeNull()
    act(() => { settingsButton!.click() })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Terminal"]')
    const closeButton = dialog?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    expect(closeButton?.closest(`.${css.popupContent}`)).not.toBeNull()

    act(() => { root.unmount() })
    container.remove()
    vi.restoreAllMocks()
  })

  it('keeps the parent Settings card geometry, color and hover tokens exact', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/client/SideCardSection.module.css'),
      'utf8',
    )
    const rule = source.match(/\.popupContent > :first-child > button \{([^}]*)\}/)?.[1] ?? ''
    for (const declaration of [
      'display: inline-flex;',
      'align-items: center;',
      'justify-content: center;',
      'width: 28px;',
      'height: 28px;',
      'padding: 0;',
      'border: none;',
      'border-radius: 28px;',
      'background: transparent;',
      'cursor: pointer;',
      'color: var(--dsw-alias-label-primary);',
    ]) {
      expect(rule).toContain(declaration)
    }
    expect(source).toMatch(/\.popupContent > :first-child > button:hover \{\s*background: var\(--dsw-alias-interactive-bg-hover\);\s*\}/)
  })
})
