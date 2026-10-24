/**
 * reference-in-chat spec — the explorer's `@`-reference button (issue #479).
 *
 * The draft spelling itself is `mentionFor`'s job (tests/reference-mention.spec.ts);
 * what this spec pins is that the folder branch really goes through it and
 * produces a token the host's two readers recognise. Both only see a quoted
 * folder once the quote *closes*:
 *
 * - the composer's plain-text trigger scan (`FOLDER_REF_RE`) decorates
 *   `@dir/` and `@"my dir/"`, but reads nothing at all out of `@my dir/`;
 * - the message bubble's tokenizer classifies a closed quoted token as a
 *   folder (`@"[^"\n]+"` → kind `folder`) while `@my dir/` falls into
 *   `@[^\s]+` → a *file* chip displaying just `my`.
 *
 * The two host regexes below are re-stated verbatim from the pinned DSH
 * bundles (`@deepseek-ai/dsh-client-ui-conversation/lib/client.js` and
 * `@deepseek-ai/dsh-client-ui-primitives/lib/index.js`), so a spelling the
 * host cannot read fails here instead of silently mis-rendering.
 *
 * No composer DOM is mounted: `appendToDraft` then takes its documented
 * unknown-caret path (append), which keeps the captured draft exactly the
 * inserted token — plus, for a folder, the separating space a *complete*
 * directory insert carries (#574) so the next `@` click cannot glue two
 * tokens together.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/context-types.ts'
import { referenceInChat } from '../src/client/reference-in-chat.ts'

/** `FOLDER_REF_RE` — the composer's folder token scan. */
const HOST_FOLDER_REF_RE = /(^|\s)(@(?:"[^"\n]*\/|[^\s"]+\/))/g
/** The message bubble's reference tokenizer. */
const HOST_BUBBLE_REF_RE = /(^|\s)(\/[\w-]+(?=\s|$)|@"[^"\n]+"|@[^\s]+)/gu

/** The host folder token inside `text`, or undefined when it reads none. */
function hostFolderToken(text: string): string | undefined {
  HOST_FOLDER_REF_RE.lastIndex = 0
  return HOST_FOLDER_REF_RE.exec(text)?.[2]
}

/** The message bubble's `referenceKind` for the first token of `text`. */
function hostBubbleKind(text: string): 'folder' | 'file' | undefined {
  HOST_BUBBLE_REF_RE.lastIndex = 0
  const label = HOST_BUBBLE_REF_RE.exec(text)?.[2]
  if (label === undefined || !label.startsWith('@')) return undefined
  return label.replace(/^@"|"$/gu, '').endsWith('/') ? 'folder' : 'file'
}

/** One reference the plugin handed to the host as a structured chip. */
interface EmittedReference {
  ref: string
  label: string
  appearance: string
}

/**
 * A fake ctx exposing the three faces `referenceInChat` uses: the host's
 * `workspaces` snapshot (the token is projected against `WorkspaceView.path`,
 * matched by session membership — issue #479's base-path gap), the plain
 * `setDraft` path (folders and file fallback) and the host's
 * `slash/input-insert-reference` event. The fake models the host's chip
 * faithfully enough for the draft to be readable — the chip's plain-text
 * projection is the mention itself (`ReferenceChipNode.getTextContent()`
 * returns the chip's `clipboardText`, which the plugin sets to the mention);
 * the separating space the composer adds next to a chip is not part of the
 * reference, so it is left out.
 */
function fakeComposer(initial = ''): {
  ctx: Context
  drafts: string[]
  emitted: EmittedReference[]
  read: () => string
} {
  const drafts: string[] = []
  const emitted: EmittedReference[] = []
  let text = initial
  let draftRev = 0
  const input = {
    state: { getSnapshot: (): { draft: string; draftRev: number } => ({ draft: text, draftRev }) },
    setDraft: (next: string): void => {
      text = next
      drafts.push(next)
    },
  }
  const scope = {
    emit: (name: string, payload: unknown): void => {
      if (name !== 'slash/input-insert-reference') return
      const { reference } = payload as { reference: EmittedReference }
      emitted.push(reference)
      text += reference.ref
      draftRev += 1
    },
  }
  const workspaces = {
    list: {
      getSnapshot: (): unknown => ({ phase: 'ready', state: 'idle', items: [{ path: '/w', sessionIds: ['s1'] }] }),
    },
  }
  const ctx = {
    sessions: { scope: (): unknown => scope },
    get: (name: string): unknown => (
      name === 'conversation'
        ? { input: { for: (): unknown => input } }
        : name === 'workspaces' ? workspaces : undefined
    ),
  } as unknown as Context
  return { ctx, drafts, emitted, read: () => text }
}

describe('referenceInChat folder mentions', () => {
  it('quotes a folder whose path contains whitespace so the host reads it as a folder (#479)', () => {
    const composer = fakeComposer()
    referenceInChat(composer.ctx, 's1', '/w/my dir', true)
    // The token itself is unchanged by the separator that follows it (#574).
    expect(composer.drafts).toEqual(['@"my dir/" '])
    const draft = composer.read()
    expect(hostFolderToken(draft)).toBe('@"my dir/')
    expect(hostBubbleKind(draft)).toBe('folder')
  })

  it('pins why the quoting is required: the unquoted spelling is read as a file', () => {
    // The pre-fix spelling (`@my dir/`) is a folder token to neither reader —
    // the bubble tokenizes `@my` as a file chip labelled `my`.
    expect(hostFolderToken('@my dir/')).toBeUndefined()
    expect(hostBubbleKind('@my dir/')).toBe('file')
    expect(hostFolderToken('@"my dir/')).toBe('@"my dir/')
    expect(hostBubbleKind('@"my dir/')).toBe('file')
  })

  it('keeps a folder without whitespace plain', () => {
    const composer = fakeComposer()
    referenceInChat(composer.ctx, 's1', '/w/docs', true)
    expect(composer.drafts).toEqual(['@docs/ '])
    expect(hostFolderToken(composer.read())).toBe('@docs/')
    expect(hostBubbleKind(composer.read())).toBe('folder')
  })

  it('keeps the relative-root spelling for the cwd itself', () => {
    const composer = fakeComposer()
    referenceInChat(composer.ctx, 's1', '/w', true)
    expect(composer.drafts).toEqual(['@./ '])
  })

  it('skips a folder path the mention grammar cannot represent (same guard as files)', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const composer = fakeComposer()
    referenceInChat(composer.ctx, 's1', '/we"ird dir', true)
    expect(composer.drafts).toEqual([])
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    consoleWarn.mockRestore()
  })
})

describe('referenceInChat file mentions (unchanged)', () => {
  it('inserts a file with whitespace as one quoted chip reference', () => {
    const composer = fakeComposer()
    referenceInChat(composer.ctx, 's1', '/w/my notes.md', false)
    expect(composer.emitted.map((reference) => reference.ref)).toEqual(['@"my notes.md"'])
    expect(composer.drafts).toEqual([]) // the chip path, not a plain append
    expect(composer.read()).toBe('@"my notes.md"')
    expect(hostBubbleKind(composer.read())).toBe('file')
  })

  it('inserts a file without whitespace unchanged', () => {
    const composer = fakeComposer()
    referenceInChat(composer.ctx, 's1', '/w/notes.md', false)
    expect(composer.emitted.map((reference) => reference.ref)).toEqual(['@notes.md'])
    expect(composer.read()).toBe('@notes.md')
  })
})
