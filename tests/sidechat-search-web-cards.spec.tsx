// @vitest-environment jsdom
/**
 * D16 — a grep / glob / web_search / web_fetch row renders the host's
 * `SearchBlock` / `WebBlock` when the tool's `tool/result` meta carries the
 * shape the host itself consumes. Design basis: `/tmp/bsb-parity/spec.md` §D16,
 * `/root/dsh-web/app/packages/client/ui-tool/src/client/tool/models/search-card-model.ts:83-104`
 * and `…/web-card-model.ts:65-101`.
 *
 * Why this spec exists: only bash / edit / write / read / present get structured
 * cards in the side chat (`toolCardBody`). Everything else — grep, glob,
 * web_search, web_fetch, the highest-frequency tools after bash — falls through
 * to raw arguments JSON plus raw output. The host does not parse that text
 * either: it reads `tool/result.meta` and draws a real card, declining (generic
 * row) whenever the shape is anything less than exact. That narrowing is cheap
 * to mirror and gives the side chat the same scan-at-a-glance rows.
 *
 * ============================ CONTRACT ============================
 * Cards are derived from `tool/result` `meta` ONLY (never by parsing the result
 * text), under the host's own narrowing:
 *
 * 1. `grep`  + `{ shape: 'matches', truncated: boolean, total: int ≥ 0,
 *               files: [{ path: string, matches: [{ lineNumber: int, line: string }] }] }`
 *    → the host `SearchBlock` in its `matches` shape.
 * 2. `glob`  + `{ shape: 'paths', truncated: boolean, total: int ≥ 0,
 *               paths: string[] }`
 *    → the host `SearchBlock` in its `paths` shape.
 * 3. `web_search` + `{ truncated: boolean, sources: [{ url: string, title?,
 *               snippet?, publishedAt? }], answer?: string }`
 *    → the host `WebBlock` in its `search` shape.
 * 4. `web_fetch`  + `{ truncated: boolean, url: string, statusCode: int }`
 *    → the host `WebBlock` in its `fetch` shape.
 * 5. Anything less — meta missing, a wrong `shape`, a missing/ill-typed field, or
 *    a FAILED result — keeps today's generic row: the labelled arguments/result
 *    sections, never a blank row and never a half-built card.
 * 6. The cards' chrome is localized: `SearchBlock`'s copy control shows
 *    `t('copy')` (the dictionary pair the markdown chrome already uses) — no
 *    hardcoded Chinese.
 *
 * The DOM hooks this spec asserts are the host components' own markers:
 * `data-search="matches" | "paths"` and `data-web="search" | "fetch"`.
 * ==================================================================
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { t } from '../src/client/locales.ts'

/** One tool call + its result, with the result meta supplied as `meta`. */
function toolTurn(name: string, args: Record<string, unknown>, meta: unknown, failed = false): unknown[] {
  const callId = `c-${name}`
  return [
    { type: 'tool/call', seq: 3, time: 3_000, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } },
    {
      type: 'tool/result',
      seq: 4,
      time: 4_000,
      data: {
        turn: 1,
        step: 1,
        ...(meta === undefined ? {} : { meta }),
        ...(failed ? { error: 'boom' } : {}),
        message: {
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'raw output line' }] }],
        },
      },
    },
  ]
}

/** The thread's own log around one tool call. */
function eventsFor(name: string, args: Record<string, unknown>, meta: unknown, failed = false): unknown[] {
  return [
    { type: 'session/end-seed', seq: 0, time: 0, data: {} },
    { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'search it' }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
    ...toolTurn(name, args, meta, failed),
  ]
}

/** The host's grep meta shape. */
const GREP_META = {
  shape: 'matches',
  truncated: false,
  total: 2,
  files: [{ path: 'src/a.ts', matches: [{ lineNumber: 3, line: 'needle found' }] }],
}

/** The host's glob meta shape. */
const GLOB_META = { shape: 'paths', truncated: false, total: 2, paths: ['src/a.ts', 'src/b.ts'] }

/** The host's web_search meta shape. */
const WEB_SEARCH_META = {
  truncated: false,
  sources: [{ url: 'https://example.com/a', title: 'Result A', snippet: 'snippet text' }],
}

/** The host's web_fetch meta shape. */
const WEB_FETCH_META = { truncated: false, url: 'https://example.com/b', statusCode: 200 }

/** The disclosure row whose summary names `tool`. */
function toolRow(container: HTMLElement, tool: string): HTMLElement {
  const rows = [...container.querySelectorAll<HTMLElement>('details')]
  const row = rows.find(element => element.querySelector('summary')?.textContent?.includes(tool) === true)
  expect(row, `a ${tool} tool row renders`).toBeDefined()
  return row as HTMLElement
}

let harness: SidechatHarness

beforeEach(() => {
  harness = installSidechatHarness()
})

afterEach(() => {
  harness.cleanup()
})

/** Mount a transcript holding exactly one tool turn. */
async function mountTool(name: string, args: Record<string, unknown>, meta: unknown, failed = false) {
  harness.wire.events = eventsFor(name, args, meta, failed)
  const rendered = harness.mount()
  await harness.flush(4)
  return rendered
}

describe('search and web cards from tool meta (D16)', () => {
  it('renders a grep result as the host matches card', async () => {
    const rendered = await mountTool('grep', { pattern: 'needle', path: 'src' }, GREP_META)
    try {
      const row = toolRow(rendered.container, 'grep')
      const card = row.querySelector('[data-search]')
      expect(card, 'the host SearchBlock renders').not.toBeNull()
      expect(card?.getAttribute('data-search'), 'in its matches shape').toBe('matches')
      const text = card?.textContent ?? ''
      expect(text, 'the matched file is shown').toContain('src/a.ts')
      expect(text, 'the matched line is shown').toContain('needle found')
      // Localized chrome: the copy control uses the dictionary pair.
      const copyButton = [...(card?.querySelectorAll('button') ?? [])]
        .find(button => button.textContent?.trim() === t('copy'))
      expect(copyButton, 'the card copy control is localized').toBeDefined()
    } finally {
      rendered.unmount()
    }
  })

  it('renders a glob result as the host paths card', async () => {
    const rendered = await mountTool('glob', { pattern: '*.ts' }, GLOB_META)
    try {
      const card = toolRow(rendered.container, 'glob').querySelector('[data-search]')
      expect(card, 'the host SearchBlock renders').not.toBeNull()
      expect(card?.getAttribute('data-search'), 'in its paths shape').toBe('paths')
      const text = card?.textContent ?? ''
      expect(text, 'the discovered paths are shown').toContain('src/a.ts')
      expect(text).toContain('src/b.ts')
    } finally {
      rendered.unmount()
    }
  })

  it('renders a web_search result as the host search card', async () => {
    const rendered = await mountTool('web_search', { query: 'anything' }, WEB_SEARCH_META)
    try {
      const card = toolRow(rendered.container, 'web_search').querySelector('[data-web]')
      expect(card, 'the host WebBlock renders').not.toBeNull()
      expect(card?.getAttribute('data-web'), 'in its search shape').toBe('search')
      const text = card?.textContent ?? ''
      expect(text, 'the cited source is shown').toContain('Result A')
    } finally {
      rendered.unmount()
    }
  })

  it('renders a web_fetch result as the host fetch card', async () => {
    const rendered = await mountTool('web_fetch', { url: WEB_FETCH_META.url }, WEB_FETCH_META)
    try {
      const card = toolRow(rendered.container, 'web_fetch').querySelector('[data-web]')
      expect(card, 'the host WebBlock renders').not.toBeNull()
      expect(card?.getAttribute('data-web'), 'in its fetch shape').toBe('fetch')
      const text = card?.textContent ?? ''
      expect(text, 'the fetched URL is shown').toContain('example.com/b')
      expect(text, 'the status code is shown').toContain('200')
    } finally {
      rendered.unmount()
    }
  })

  it('keeps the labelled generic row when the meta is absent or does not fit the shape', async () => {
    const cases: Array<[string, string, Record<string, unknown>, unknown]> = [
      ['no meta at all', 'grep', { pattern: 'needle' }, undefined],
      ['wrong shape', 'grep', { pattern: 'needle' }, { ...GREP_META, shape: 'paths' }],
      ['total missing', 'grep', { pattern: 'needle' }, { ...GREP_META, total: undefined }],
      ['files not an array', 'grep', { pattern: 'needle' }, { ...GREP_META, files: 'src/a.ts' }],
      ['a file entry without matches', 'grep', { pattern: 'needle' }, { ...GREP_META, files: [{ path: 'src/a.ts' }] }],
      ['a match whose line number is a string', 'grep', { pattern: 'needle' }, {
        ...GREP_META,
        files: [{ path: 'src/a.ts', matches: [{ lineNumber: '3', line: 'needle found' }] }],
      }],
      ['web sources ill-typed', 'web_search', { query: 'x' }, { truncated: false, sources: [{ title: 'no url' }] }],
      ['fetch status missing', 'web_fetch', { url: 'https://example.com/b' }, { truncated: false, url: 'https://example.com/b' }],
    ]
    for (const [label, name, args, meta] of cases) {
      const rendered = await mountTool(name, args, meta)
      try {
        const row = toolRow(rendered.container, name)
        expect.soft(row.querySelector('[data-search]'), `${label}: no search card`).toBeNull()
        expect.soft(row.querySelector('[data-web]'), `${label}: no web card`).toBeNull()
        // Never blank: the labelled two-section row is still there.
        const text = row.textContent ?? ''
        expect.soft(text, `${label}: the arguments section survives`).toContain(t('sideChatToolArguments'))
        expect.soft(text, `${label}: the raw arguments survive`).toContain(JSON.stringify(args))
      } finally {
        rendered.unmount()
      }
    }
  })

  it('never builds a card for a failed result', async () => {
    const rendered = await mountTool('grep', { pattern: 'needle' }, GREP_META, true)
    try {
      const row = toolRow(rendered.container, 'grep')
      expect(row.querySelector('[data-search]'), 'a failed search renders the generic row').toBeNull()
      expect(row.textContent ?? '', 'and stays readable').toContain(t('sideChatToolArguments'))
    } finally {
      rendered.unmount()
    }
  })
})
