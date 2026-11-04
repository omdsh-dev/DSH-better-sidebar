// @vitest-environment jsdom
/**
 * D3 — `present` deliverables card in Side Chat (spec:
 * docs/plans/2026-10-22-sidechat-render-parity/spec.md, contract C2 /
 * deliverable D3).
 *
 * Side Chat renders the thread's OWN conversation, so a `present` tool call
 * (or the `deliverables/presented` event the tool appends) must surface as a
 * compact deliverables card: one entry per file with its basename, optional
 * description, a file-type affordance, an image thumbnail through the
 * session-scoped `/sidebar/file` route, and a click that opens the file
 * through the plugin's own `openSidebarFile` path. One call yields one card;
 * the event attaches to the call's card by `callId`; inherited seed events are
 * never rendered.
 *
 * Copy is locale-owned (spec: no hardcoded product text); the shipped
 * dictionaries' key parity is enforced by tests/locales.spec.ts, which the
 * implementer's new keys must satisfy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'

const SESSION_CWD = '/p'
/** The panel's session and the thread it renders are both live sessions; a
 *  session-scoped media route may name either one. */
const SESSION_IDS = ['root', 't1']

/** The `present` tool's arguments (paths relative to the session cwd). */
const CALL_ARGS = JSON.stringify({
  files: [
    { path: 'report.pdf', description: '季度报告' },
    { path: 'chart.png', description: '流量趋势' },
  ],
})

/** A leaf element whose whole visible text is exactly `text`. */
function leafWithText(container: HTMLElement, text: string): Element | undefined {
  return [...container.querySelectorAll('*')]
    .find(element => element.children.length === 0 && (element.textContent ?? '').trim() === text)
}

/** The clickable entries (one per delivered file) naming `name`. */
function fileRows(container: HTMLElement, name: string): Element[] {
  return [...container.querySelectorAll('button, [role="button"], a')]
    .filter(element => (element.textContent ?? '').includes(name))
}

/** The file-type affordance the file's own row draws (the host's FileTypeIcon
 *  artwork is an svg, like every glyph this sidebar uses). */
function iconNear(nameLeaf: Element): SVGElement | null {
  let node: Element | null = nameLeaf
  for (let depth = 0; depth < 3 && node !== null; depth += 1, node = node.parentElement) {
    const svg = node.querySelector('svg')
    if (svg !== null) return svg
  }
  return null
}

/** The media-route thumbnail for one absolute local path, if the DOM has it. */
function thumbnail(container: HTMLElement, path: string): HTMLImageElement | undefined {
  return [...container.querySelectorAll('img')].find((img) => {
    const url = new URL(img.getAttribute('src') ?? '', document.baseURI)
    return url.pathname.endsWith('/sidebar/file') && url.searchParams.get('path') === path
  })
}

/** The `present` call row: turn 1, step 1, call id `c-present`. */
const PRESENT_CALL = {
  type: 'tool/call',
  seq: 3,
  time: 3_000,
  data: { turn: 1, step: 1, callId: 'c-present', name: 'present', arguments: CALL_ARGS },
}

describe('SideChatView present deliverables card (C2)', () => {
  let harness: SidechatHarness

  beforeEach(() => {
    harness = installSidechatHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('renders a compact card from the present call: name, description, type icon, image thumbnail, open action', async () => {
    harness.wire.events = [
      { type: 'session/end-seed', seq: 0, time: 0, data: {} },
      { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'present these' }], source: { kind: 'user' } } },
      { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
      PRESENT_CALL,
    ]
    const view = harness.mount()
    await harness.flush()

    // A dedicated basename element (the collapsed tool row's raw JSON would
    // not produce one) and the per-file description.
    const pdfName = leafWithText(view.container, 'report.pdf')
    expect(pdfName, 'the presented file appears by basename').toBeDefined()
    expect(view.container.textContent ?? '').toContain('季度报告')
    expect(leafWithText(view.container, 'chart.png'), 'every presented file gets an entry').toBeDefined()
    expect(view.container.textContent ?? '').toContain('流量趋势')

    // The file-type affordance lives in the file's own row.
    expect(iconNear(pdfName!), 'the file row draws a file-type icon').not.toBeNull()

    // An image deliverable gets a thumbnail through the session media route.
    const chart = thumbnail(view.container, `${SESSION_CWD}/chart.png`)
    expect(chart, 'an image deliverable gets a thumbnail').toBeDefined()
    expect(chart!.getAttribute('src')).toMatch(/^https?:\/\//)
    const chartUrl = new URL(chart!.getAttribute('src') ?? '', document.baseURI)
    expect(chartUrl.pathname).toMatch(/\/sidebar\/file$/)
    expect(chartUrl.searchParams.get('cwd')).toBe(SESSION_CWD)
    expect(SESSION_IDS, 'the thumbnail route stays session-scoped').toContain(chartUrl.searchParams.get('sessionId'))

    // Clicking the file takes the plugin's own open path with the cwd-resolved
    // absolute path (the call's argument was relative).
    const pdfRow = fileRows(view.container, 'report.pdf')
    expect(pdfRow, 'the file entry is clickable').toHaveLength(1)
    const pdfButton = pdfRow[0] as HTMLElement
    // N1: the accessible name carries the visible description, and the title
    // tooltip is the cwd-resolved spelling of the (relative) call argument.
    expect(pdfButton.getAttribute('aria-label')).toContain('report.pdf')
    expect(pdfButton.getAttribute('aria-label')).toContain('季度报告')
    expect(pdfButton.getAttribute('title')).toBe(`${SESSION_CWD}/report.pdf`)
    await act(async () => { pdfButton.click() })
    expect(harness.host.openTab).toHaveBeenCalledTimes(1)
    expect(harness.host.openTab).toHaveBeenCalledWith(expect.objectContaining({
      type: 'editor',
      path: `${SESSION_CWD}/report.pdf`,
    }))

    view.unmount()
  })

  it('renders one card per call and lets the presented event attach to it', async () => {
    harness.wire.events = [
      { type: 'session/end-seed', seq: 0, time: 0, data: {} },
      { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'present these' }], source: { kind: 'user' } } },
      { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
      { ...PRESENT_CALL, data: { ...PRESENT_CALL.data, arguments: JSON.stringify({ files: [{ path: 'report.pdf', description: '来自调用参数' }] }) } },
      {
        type: 'tool/result',
        seq: 4,
        time: 4_000,
        data: {
          turn: 1,
          step: 1,
          message: {
            source: { kind: 'tool', callId: 'c-present' },
            content: [{ type: 'tool-result', toolCallId: 'c-present', content: [{ type: 'text', text: 'Presented /p/report.pdf' }] }],
          },
        },
      },
      {
        type: 'deliverables/presented',
        seq: 5,
        time: 5_000,
        data: { turn: 1, callId: 'c-present', files: [{ path: `${SESSION_CWD}/report.pdf`, description: '来自交付事件' }] },
      },
    ]
    const view = harness.mount()
    await harness.flush()

    // The event's own copy is what the card shows (nothing else in the
    // transcript carries that string).
    expect(view.container.textContent ?? '').toContain('来自交付事件')
    // The call and its event are ONE card, not two.
    expect(fileRows(view.container, 'report.pdf'), 'one delivered file, one card entry').toHaveLength(1)

    view.unmount()
  })

  it('renders the thread’s own presented event and never an inherited seed one', async () => {
    harness.wire.events = [
      // Inherited from the parent log (before the fork seed marker): the
      // thread did not present this file, so it must not render.
      {
        type: 'deliverables/presented',
        seq: 0,
        time: 0,
        data: { turn: 1, callId: 'c-seed', files: [{ path: `${SESSION_CWD}/seed-only.pdf`, description: 'seed 交付' }] },
      },
      { type: 'session/end-seed', seq: 1, time: 1_000, data: { inherited: true } },
      { type: 'user/message', seq: 2, time: 2_000, data: { content: [{ type: 'text', text: 'and now?' }], source: { kind: 'user' } } },
      { type: 'turn/start', seq: 3, time: 3_000, data: { turn: 2 } },
      {
        type: 'deliverables/presented',
        seq: 4,
        time: 4_000,
        data: { turn: 2, callId: 'c-own', files: [{ path: `${SESSION_CWD}/own-deliverable.pdf`, description: '自己的交付' }] },
      },
    ]
    const view = harness.mount()
    await harness.flush()

    const text = view.container.textContent ?? ''
    expect(text, 'the thread’s own presented event renders a card').toContain('own-deliverable.pdf')
    expect(text).toContain('自己的交付')
    expect(text, 'an inherited seed delivery never renders').not.toContain('seed-only.pdf')
    expect(text).not.toContain('seed 交付')

    view.unmount()
  })
})
