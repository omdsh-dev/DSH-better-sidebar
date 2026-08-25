/**
 * MdToc spec: the markdown preview's outline button + popover. Covers the
 * minimum-headings gate, collection from the rendered DOM (including headings
 * inside HTML `<details>` runs, which appear late through the observer),
 * jump behavior (smooth scroll + flash + auto-expanding collapsed ancestors)
 * and Esc-to-close.
 */
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MdToc, TOC_MIN_HEADINGS } from '../src/client/md-toc.tsx'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const scrollIntoView = vi.fn()
Element.prototype.scrollIntoView = scrollIntoView

/** The preview-harness shape MdToc mounts in: the bar is a direct child of
 *  the scroll container, headings are siblings (inside or outside details). */
interface HeadingSpec {
  tag: string
  text: string
  insideClosedDetails?: boolean
}

function Harness({ specs }: { specs: readonly HeadingSpec[] }): React.ReactElement {
  return createElement(
    'div',
    null,
    createElement(MdToc),
    ...specs.map((spec) => spec.insideClosedDetails === true
      ? createElement('details', null, createElement(spec.tag, null, spec.text))
      : createElement(spec.tag, null, spec.text)),
  )
}

/** Render the harness; returns the scroll container (the bar's parent). */
async function mountToc(specs: readonly HeadingSpec[]): Promise<{ container: HTMLDivElement; root: Root }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(Harness, { specs }))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
  const container = host.firstElementChild as HTMLDivElement
  return { container, root }
}

async function unmount(root: Root): Promise<void> {
  await act(async () => { root.unmount() })
}

beforeEach(() => {
  document.body.innerHTML = ''
  scrollIntoView.mockClear()
})

describe('MdToc', () => {
  it('exposes the minimum-headings threshold', () => {
    expect(TOC_MIN_HEADINGS).toBe(3)
  })

  it('stays hidden below the heading threshold', async () => {
    const { container, root } = await mountToc([
      { tag: 'h1', text: 'One' },
      { tag: 'h2', text: 'Two' },
    ])
    expect(container.querySelector('[data-dsh-md-toc]')).toBeNull()
    await unmount(root)
  })

  it('shows the button and lists collected headings', async () => {
    const { container, root } = await mountToc([
      { tag: 'h1', text: 'Title' },
      { tag: 'h2', text: 'Install' },
      { tag: 'h2', text: 'Usage' },
      { tag: 'h3', text: 'Deep' },
    ])
    const button = container.querySelector<HTMLButtonElement>('[data-dsh-md-toc]')
    expect(button).not.toBeNull()
    await act(async () => { button!.click() })
    const panel = container.querySelector('[data-dsh-md-toc-panel]')
    expect(panel).not.toBeNull()
    const items = [...panel!.querySelectorAll('button')]
    expect(items.map((item) => item.textContent)).toEqual(['1Title', '2Install', '2Usage', '3Deep'])
    await unmount(root)
  })

  it('jumps: expands collapsed details ancestors, smooth-scrolls, flashes, closes', async () => {
    // Mount with real timers (the settle await needs them), then fake only the
    // flash-removal timeout window.
    const { container, root } = await mountToc([
      { tag: 'h1', text: 'Title' },
      { tag: 'h2', text: 'Outside' },
      { tag: 'h3', text: 'Hidden', insideClosedDetails: true },
    ])
    vi.useFakeTimers()
    try {
      const button = container.querySelector<HTMLButtonElement>('[data-dsh-md-toc]')!
      await act(async () => { button.click() })
      const target = [...container.querySelectorAll('h3')].find((h) => h.textContent === 'Hidden')!
      const item = [...container.querySelectorAll<HTMLButtonElement>('[data-dsh-md-toc-panel] button')]
        .find((candidate) => candidate.textContent?.includes('Hidden'))!
      await act(async () => { item.click() })
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
      expect(target.closest('details')?.hasAttribute('open'), 'the collapsed ancestor must open').toBe(true)
      expect(target.className, 'the jumped-to heading must flash').not.toBe('')
      expect(container.querySelector('[data-dsh-md-toc-panel]'), 'the panel must close on jump').toBeNull()
      vi.advanceTimersByTime(1300)
      expect(target.className, 'the flash class must clear after the timeout').toBe('')
      await unmount(root)
    } finally {
      vi.useRealTimers()
    }
  })

  it('collects headings that appear after mount (observer path)', async () => {
    const { container, root } = await mountToc([
      { tag: 'h1', text: 'Title' },
      { tag: 'h2', text: 'Only two so far' },
    ])
    expect(container.querySelector('[data-dsh-md-toc]')).toBeNull()
    const late = document.createElement('h2')
    late.textContent = 'Late'
    await act(async () => {
      container.appendChild(late)
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    })
    expect(container.querySelector('[data-dsh-md-toc]'), 'late headings must surface the button').not.toBeNull()
    await unmount(root)
  })

  it('closes the popover on Escape', async () => {
    const { container, root } = await mountToc([
      { tag: 'h1', text: 'Title' },
      { tag: 'h2', text: 'A' },
      { tag: 'h2', text: 'B' },
    ])
    const button = container.querySelector<HTMLButtonElement>('[data-dsh-md-toc]')!
    await act(async () => { button.click() })
    expect(container.querySelector('[data-dsh-md-toc-panel]')).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(container.querySelector('[data-dsh-md-toc-panel]')).toBeNull()
    await unmount(root)
  })
})
