/**
 * S8 source-plugin catalog (Major review gap): the "Add source plugin" flow
 * must offer a SOURCE-category catalog — not an empty "no catalog" state and
 * not the tab/viewer catalogs dressed up as source recommendations.
 *
 * This spec pins:
 * - the catalog data contract (unique ids, https repo URLs, install-command
 *   shape, a category per entry) so a future entry cannot ship half-formed;
 * - the mirrored body: GitHub topic button, search, category groups and the
 *   same jump/copy actions as the generic AddPluginModal;
 * - copy only ever writes the command to the clipboard (with "Copied"
 *   feedback after a successful write) and jump opens a REAL new tab;
 * - nothing claims the plugin or its CLI was installed.
 *
 * The section-level wiring (opening this body from the sources panel) is
 * covered by clues-settings-section.spec.tsx.
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement, type FunctionComponent } from 'react'
import { renderToString } from 'react-dom/server'
import { act } from 'react-dom/test-utils'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import {
  builtinClueSourcePlugins,
  type ClueSourceCatalogEntry,
} from '../src/client/clues/settings/source-catalog.ts'
import { SourceCatalogBody, type SourceCatalogBodyProps } from '../src/client/clues/settings/source-catalog-modal.tsx'
import { en, zh } from '../src/client/locales.ts'

setupReactAct()
beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

/** Resolve an i18n-friendly string-or-function value. */
function textOf(value: string | (() => string)): string {
  return typeof value === 'function' ? value() : value
}

/** A minimal custom catalog entry for injection tests. */
function entry(id: string, name: string, extra: Partial<ClueSourceCatalogEntry> = {}): ClueSourceCatalogEntry {
  return {
    id,
    name,
    url: 'https://github.com/example/source-plugin',
    description: 'An example source plugin.',
    category: 'Example',
    install: 'cd ~/.dsh && dsh plugin --profile web add example-source',
    ...extra,
  }
}

/** The component as a typed function (createElement overload resolution). */
const Body = SourceCatalogBody as FunctionComponent<SourceCatalogBodyProps>

/** Mount the body and return its container plus unmount. */
function mountBody(entries?: readonly ClueSourceCatalogEntry[]): RenderedRoot {
  return renderRoot(createElement(Body, entries === undefined ? {} : { entries }))
}

describe('source-plugin catalog data', () => {
  it('ships at least one curated source entry with stable shape', () => {
    expect(builtinClueSourcePlugins.length).toBeGreaterThan(0)
    const ids = new Set<string>()
    for (const item of builtinClueSourcePlugins) {
      // Unique React keys / copy-feedback identities.
      expect(ids.has(item.id), item.id).toBe(false)
      ids.add(item.id)
      expect(item.name).toBeTruthy()
      expect(textOf(item.category).trim()).not.toBe('')
      expect(textOf(item.description).trim()).not.toBe('')
      // Repository discovery goes to a real HTTPS repo page.
      expect(item.url).toMatch(/^https:\/\/github\.com\//)
      // Same install-command contract as the tab/viewer catalogs.
      expect(item.install.startsWith('cd ~/.dsh && dsh plugin --profile web add ')).toBe(true)
    }
  })

  it('lists the GitHub and Feishu source categories', () => {
    const categories = new Set(builtinClueSourcePlugins.map(item => textOf(item.category)))
    expect(categories).toContain('GitHub')
    expect(categories).toContain('Feishu')
  })

  it('routes its user-visible copy through the locale dictionaries, not hardcoded English', () => {
    const previous = navigator.language
    Object.defineProperty(navigator, 'language', { value: 'zh-CN', configurable: true })
    try {
      const github = builtinClueSourcePlugins[0]!
      const feishu = builtinClueSourcePlugins[1]!
      expect(textOf(github.name)).toBe(zh.clueSourceCatalogGithubName)
      expect(textOf(github.description)).toBe(zh.clueSourceCatalogGithubDesc)
      expect(textOf(github.category)).toBe(zh.clueSourceCatalogGithubCategory)
      expect(textOf(feishu.name)).toBe(zh.clueSourceCatalogFeishuName)
      expect(textOf(feishu.description)).toBe(zh.clueSourceCatalogFeishuDesc)
      expect(textOf(feishu.category)).toBe(zh.clueSourceCatalogFeishuCategory)
      // The zh strings really branch from en (not EN copy rendered verbatim).
      expect(textOf(github.name)).not.toBe(en.clueSourceCatalogGithubName)
      expect(textOf(feishu.description)).not.toBe(en.clueSourceCatalogFeishuDesc)
    } finally {
      Object.defineProperty(navigator, 'language', { value: previous, configurable: true })
    }
  })
})

describe('SourceCatalogBody (render)', () => {
  it('renders the topic, search, category groups and one row per entry', () => {
    const html = renderToString(createElement(Body))
    expect(html).toContain('Browse more plugins on GitHub')
    expect(html).toContain(en.addPluginsSearch)
    expect(html).toContain('data-clue-add-source')
    for (const item of builtinClueSourcePlugins) {
      const name = textOf(item.name)
      expect(html).toContain(textOf(item.category))
      // SSR escapes `&` in the copy.
      expect(html).toContain(name.replaceAll('&', '&amp;'))
      expect(html).toContain(`data-clue-source-plugin="${item.id}"`)
      // Each row carries the same jump/copy controls as the generic modal.
      const escaped = name.replaceAll('&', '&amp;')
      expect(html).toContain(`aria-label="${en.openPlugin}: ${escaped}"`)
      expect(html).toContain(`aria-label="${en.copyInstall}: ${escaped}"`)
    }
    // The install command is rendered as copyable text, escaped for HTML.
    expect(html).toContain('dsh plugin --profile web add dsh-better-sidebar')
    // No "installed" claim anywhere.
    expect(html.toLowerCase()).not.toContain('installed successfully')
    expect(html.toLowerCase()).not.toContain('installation complete')
  })

  it('renders the empty and no-match states instead of a phantom list', () => {
    const empty = renderToString(createElement(Body, { entries: [] }))
    expect(empty).toContain(en.addPluginsEmpty)
    expect(empty).not.toContain('data-clue-source-plugin')

    const body = mountBody()
    try {
      const input = body.container.querySelector<HTMLInputElement>('input[type="search"]')!
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      act(() => {
        setter?.call(input, 'no-such-source')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(body.container.textContent).toContain(en.addPluginsNoMatch)
    } finally {
      body.unmount()
    }
  })
})

describe('SourceCatalogBody actions', () => {
  it('copying writes the install command to the clipboard and flashes Copied', async () => {
    vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(true)
    const target = builtinClueSourcePlugins[0]!
    const body = mountBody()
    try {
      // Attribute selectors trip jsdom on the '&' in 'Issues & PRs'; match
      // by the accessible name instead.
      const button = [...body.container.querySelectorAll<HTMLButtonElement>('button')]
        .find(candidate => candidate.getAttribute('aria-label') === `${en.copyInstall}: ${textOf(target.name)}`)!
      await act(async () => { button.click() })
      expect(primitives.writeClipboard).toHaveBeenCalledWith(target.install)
      expect(button.textContent).toBe(en.copied)
      // Nothing was closed or navigated by the copy action.
      expect(body.container.querySelector('[data-clue-add-source]')).not.toBeNull()
    } finally {
      body.unmount()
      vi.restoreAllMocks()
    }
  })

  it('does not show Copied when the clipboard write fails', async () => {
    vi.spyOn(primitives, 'writeClipboard').mockResolvedValue(false)
    const body = mountBody()
    try {
      const button = body.container.querySelector<HTMLButtonElement>('button[aria-label^="Copy install command:"]')!
      await act(async () => { button.click() })
      expect(button.textContent).toBe(en.copy)
    } finally {
      body.unmount()
      vi.restoreAllMocks()
    }
  })

  it('jumping opens the repository in a real new tab and the topic button opens the topic', () => {
    const opened: string[] = []
    const open = vi.spyOn(window, 'open').mockImplementation((url: string | URL | undefined) => {
      opened.push(String(url))
      return null
    })
    const target = builtinClueSourcePlugins[0]!
    const body = mountBody()
    try {
      const jump = [...body.container.querySelectorAll<HTMLButtonElement>('button')]
        .find(candidate => candidate.getAttribute('aria-label') === `${en.openPlugin}: ${textOf(target.name)}`)!
      act(() => { jump.click() })
      const topic = [...body.container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.trim() === en.addPluginsBrowseMore)!
      act(() => { topic.click() })
      expect(opened).toContain(target.url)
      expect(opened).toContain('https://github.com/topics/dsh-better-sidebar')
    } finally {
      body.unmount()
      open.mockRestore()
    }
  })

  it('groups entries by category in authoring order', () => {
    const custom = [
      entry('a.one', 'A one', { category: 'Alpha' }),
      entry('b.one', 'B one', { category: 'Beta' }),
      entry('a.two', 'A two', { category: 'Alpha' }),
    ]
    const html = renderToString(createElement(Body, { entries: custom }))
    const alpha = html.indexOf('Alpha')
    const beta = html.indexOf('Beta')
    expect(alpha).toBeGreaterThan(-1)
    expect(beta).toBeGreaterThan(alpha)
    // The count reflects the filtered catalog, not the category count.
    expect(html).toContain('>3<')
  })
})

describe('SourceCatalogBody search', () => {
  it('filters by name, id and description', () => {
    const body = mountBody([
      entry('alpha.source', 'Alpha Source', { description: 'Reads alpha documents.' }),
      entry('beta.source', 'Beta Source', { description: 'Reads beta documents.' }),
    ])
    try {
      const input = body.container.querySelector<HTMLInputElement>('input[type="search"]')!
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      act(() => {
        setter?.call(input, 'beta documents')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(body.container.textContent).toContain('Beta Source')
      expect(body.container.textContent).not.toContain('Alpha Source')
    } finally {
      body.unmount()
    }
  })
})
