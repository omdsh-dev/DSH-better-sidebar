// @vitest-environment jsdom
/**
 * D12 — inline-code file mentions open the file, but ONLY when the token names
 * something this thread actually produced. Design basis: `/tmp/bsb-parity/spec.md`
 * §D12 and the host's own vocabulary in
 * `/root/dsh-web/app/packages/client/ui-deliverables/src/client/turn-deliverables.ts:283-300`.
 *
 * Why this spec exists: a side answer is full of `` `src/client/api.ts` `` style
 * inline code, and in the main conversation those tokens are clickable because
 * the chat view hands `MarkdownText` a `fileMentions` resolver. The side chat
 * never does (`markdownTextProps` returns `{ text, labels }` only), so the same
 * answer is dead text here. The host's resolver deliberately does NOT stat the
 * filesystem: it matches the thread's PRODUCED/DELIVERED paths and declines
 * ambiguous basenames — which is exactly the vocabulary a compact transcript can
 * rebuild from its own rows without an RPC per token.
 *
 * ============================ CONTRACT ============================
 * The transcript hands `MarkdownText` a `fileMentions` resolver built from the
 * thread's own rows, shaped like the host's `producedFileMentions`:
 * 1. SOURCE SET: the paths this thread produced — `tool/call` arguments
 *    (`file_path` / `path`) and `deliverables` rows (`files[].path`).
 * 2. MATCH: a token resolves when it equals a produced path OR its basename,
 *    and EXACTLY ONE produced path matches. Ambiguous basenames (two `dup.ts`)
 *    stay inert, and so does any token outside the set.
 * 3. RESOLVED: the inline code renders as the host's mention control — a
 *    `<button>` inside the `<code>` whose `title` is the resolved path and whose
 *    accessible name is `t('sideChatMentionOpen', { path })` (the plugin-side
 *    mirror of the host's `presented.previewButton`).
 * 4. OPEN: activating it goes through `openSidebarFile` — the plugin's editor
 *    claim path — i.e. `betterSidebar.openTab({ type: 'editor', path })` with the
 *    session-resolved absolute path.
 * 5. NO LOOKUP COST: resolving a token issues no request (no `fs.search`/stat):
 *    the vocabulary is the thread's own rows.
 * 6. INERT CASES stay exactly as they were: a plain `<code>` with the authored
 *    text, never a link, never an error.
 * ==================================================================
 *
 * The new locale key this contract needs: `sideChatMentionOpen` with `{ path }`
 * (added to every shipped dictionary like all others).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { t } from '../src/client/locales.ts'

/** The locale key behind a mention's accessible name. */
const MENTION_KEY = 'sideChatMentionOpen'

/** Every route the view asked for, in order. */
let routes: string[] = []

/** Translate a key this spec names but the build may not have yet. */
function copy(key: string, params?: Record<string, string | number>): string {
  return (t as unknown as (key: string, params?: Record<string, string | number>) => string)(key, params)
}

/** One produced file, named by a write call's arguments. */
function writeCall(seq: number, path: string): unknown[] {
  const callId = `w${String(seq)}`
  return [
    { type: 'tool/call', seq, time: seq * 1_000, data: { turn: 1, step: 1, callId, name: 'write', arguments: JSON.stringify({ file_path: path, content: 'x' }) } },
    {
      type: 'tool/result',
      seq: seq + 1,
      time: (seq + 1) * 1_000,
      data: {
        turn: 1,
        step: 1,
        message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }] },
      },
    },
  ]
}

/** A turn whose answer mentions five tokens, two of which must stay inert. */
function events(): unknown[] {
  return [
    { type: 'session/end-seed', seq: 0, time: 0, data: {} },
    { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'which files?' }], source: { kind: 'user' } } },
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
    ...writeCall(3, 'src/produced.ts'),
    ...writeCall(5, 'a/dup.ts'),
    ...writeCall(7, 'b/dup.ts'),
    // A delivered file: the other half of the produced vocabulary.
    { type: 'deliverables/presented', seq: 9, time: 9_000, data: { turn: 1, files: [{ path: 'src/presented.ts' }] } },
    {
      type: 'assistant/message',
      seq: 10,
      time: 10_000,
      data: {
        turn: 1,
        step: 2,
        message: {
          content: [{
            type: 'text',
            text: 'I touched `produced.ts`, `src/produced.ts` and `presented.ts`; not `unrelated.ts`, and `dup.ts` is ambiguous.',
          }],
        },
      },
    },
  ]
}

/** The `<code>` element whose own text is exactly `token`. */
function codeOf(container: HTMLElement, token: string): HTMLElement {
  const codes = [...container.querySelectorAll<HTMLElement>('code')]
  const code = codes.find(element => element.textContent?.trim() === token)
  expect(code, `the token "${token}" renders as inline code`).toBeDefined()
  return code as HTMLElement
}

/** The mention control inside one token's inline code, when it has one. */
function mentionOf(container: HTMLElement, token: string): HTMLButtonElement | undefined {
  return codeOf(container, token).querySelector<HTMLButtonElement>('button') ?? undefined
}

let harness: SidechatHarness

beforeEach(() => {
  routes = []
  harness = installSidechatHarness()
  harness.wire.events = events()
  // Record every route the view asks for (the mention vocabulary must need none).
  const stubbed = globalThis.fetch
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    routes.push(String(input).split('/').pop() ?? '')
    return stubbed(input as string, init)
  })
})

afterEach(() => {
  harness.cleanup()
})

/** Mount the transcript and let the first pull settle. */
async function mountTranscript() {
  const rendered = harness.mount()
  await harness.flush(4)
  return rendered
}

describe('production-scoped file mentions (D12)', () => {
  it('links a produced basename and its full path, and leaves everything else inert', async () => {
    const rendered = await mountTranscript()
    try {
      // Produced by a tool call argument, matched by basename and by full path.
      expect(mentionOf(rendered.container, 'produced.ts'), 'a produced basename is a mention').toBeDefined()
      expect(mentionOf(rendered.container, 'src/produced.ts'), 'the produced path itself is a mention').toBeDefined()
      // Produced by a deliverables row.
      expect(mentionOf(rendered.container, 'presented.ts'), 'a delivered file is a mention').toBeDefined()

      // Not produced at all.
      expect(mentionOf(rendered.container, 'unrelated.ts'), 'an unknown token stays inert').toBeUndefined()
      // Two produced files share the basename: the resolver declines.
      expect(mentionOf(rendered.container, 'dup.ts'), 'an ambiguous basename stays inert').toBeUndefined()

      // The inert ones are still code, never an error or an empty row.
      expect(codeOf(rendered.container, 'unrelated.ts').textContent?.trim()).toBe('unrelated.ts')
      expect(codeOf(rendered.container, 'dup.ts').textContent?.trim()).toBe('dup.ts')
    } finally {
      rendered.unmount()
    }
  })

  it('opens the resolved file through the editor path when the mention is activated', async () => {
    const rendered = await mountTranscript()
    try {
      const produced = mentionOf(rendered.container, 'produced.ts')
      expect(produced, 'the mention control exists').toBeDefined()
      // The accessible name is localized and names the RESOLVED path. The path
      // may be spelled session-relative (as the producing argument wrote it) or
      // absolute — what matters is that it names this file.
      const title = produced?.title ?? ''
      expect(title.endsWith('src/produced.ts'), `the title names the resolved path (got "${title}")`).toBe(true)
      const expectedLabel = copy(MENTION_KEY, { path: title })
      expect(expectedLabel, `the ${MENTION_KEY} key must exist in the locale dictionary`).not.toBe(MENTION_KEY)
      expect(produced?.getAttribute('aria-label'), 'the open label is localized').toBe(expectedLabel)

      act(() => { (produced as HTMLButtonElement).click() })
      expect(harness.host.openTab).toHaveBeenCalledWith(expect.objectContaining({
        type: 'editor',
        path: '/p/src/produced.ts',
      }))
    } finally {
      rendered.unmount()
    }
  })

  it('resolves the vocabulary without a single lookup request', async () => {
    const rendered = await mountTranscript()
    try {
      const before = [...routes]
      const mention = mentionOf(rendered.container, 'presented.ts')
      expect(mention, 'the delivered-file mention exists').toBeDefined()
      act(() => { (mention as HTMLButtonElement).click() })
      await harness.flush(2)
      expect(routes, 'opening a mention adds no request').toEqual(before)
      expect(routes, 'no filesystem search backs the vocabulary').not.toContain('fs.search')
    } finally {
      rendered.unmount()
    }
  })
})
