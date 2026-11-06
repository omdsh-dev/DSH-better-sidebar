// @vitest-environment jsdom
/**
 * D13 — `image` / `file` content blocks render in the compact transcript.
 * Design basis: `/tmp/bsb-parity/p2-feasibility.md` §1, the host's block
 * vocabulary (`llm/src/types.ts:70-100`, `attachment/src/types.ts:39-47`), the
 * host's own file chip (`ui-chat/src/client/chat/UserContent.tsx:30-44`) and the
 * attachment-reference authorization the host applies to the read RPC
 * (`session-controller/src/commands.ts:607-641`, `:858-905`).
 *
 * Why this spec exists: a side turn that hands the model a screenshot, or whose
 * tool result carries one, shows NOTHING here. The mapping keeps only `text`
 * blocks (`sidechat-transcript.ts` `blockText` / `resultTextOf` / the assistant
 * `flatMap`), so the image the reader attached and the image a tool produced
 * both vanish — the transcript claims a text-only conversation. A `file` block
 * disappears the same way, leaving no trace that the model was given a
 * document.
 *
 * ============================ CONTRACT ============================
 * 1. SOURCES. An `image` content block renders a thumbnail wherever it can
 *    legally appear in the log OUTSIDE the user bubble: an
 *    `assistant/message` content list, and the inner content list of a
 *    `tool/result` `tool-result` block.
 *    MERGED BEHAVIOUR (v0.30.x): a USER-message image is drawn by the upstream
 *    `SidechatImages` surface — one `/sidebar/sidechat-image` read addressed by
 *    `{childId, messageId, blockIndex}` — so this view does NOT draw it a second
 *    time here; the user bubble keeps only its `file` blocks on this path. The
 *    first test's `att-user` read is still expected, because the assistant
 *    message in the fixture references that same attachment id.
 * 2. BYTES COME FROM THE HOST REMOTE ONLY:
 *      `ctx.get('remote').session.attachment({ sessionId, attachmentId })`
 *    with `sessionId` = the THREAD's id (the session whose own log references
 *    the attachment — `tab.meta.threadId`), and `attachmentId` =
 *    `block.attachment.attachmentId`.
 *    `ctx.get('uiConversation').imageUrl(...)` is NEVER used: that path rejects
 *    for a side thread the client never retained (it resolves through
 *    `sessions.binding()`, which only exists for retained scopes).
 * 3. DECODING. The answer's `data` (base64) becomes a `Blob` whose `type` is the
 *    ref's `mediaType`, published through `URL.createObjectURL`; the row's
 *    `<img src>` is that object URL, and the URL is revoked on unmount (the
 *    view owns the lifecycle).
 * 4. ONE REQUEST PER ATTACHMENT ID. Two blocks naming the same attachment share
 *    one request and one object URL (both blocks still render their own `<img>`);
 *    the ids requested are EXACTLY the ids the thread's log references, and a
 *    `file` block never triggers a byte read.
 * 5. FAILURE IS A PLACEHOLDER, NOT A CRASH. `{ ok: false }`, a thrown
 *    rejection, or no `remote` namespace in the composition renders the
 *    localized `t('sideChatAttachmentImageFailed')` placeholder instead of a
 *    thumbnail (no `<img>` for that block), and every other row still renders.
 * 6. FILE BLOCKS NEED NO BYTES. A `file` block renders the main conversation's
 *    chip — the ref's `name` plus `fileSizeText(ref.bytes)` (the host
 *    `ui-primitives` formatter, so `2048` reads `2.0KB`) — with no RPC at all.
 * 7. A malformed block (no `attachmentId`, no `name`) is SKIPPED: no request,
 *    no `undefined`/`null` leaking into the copy, no crash.
 * 8. Thumbnails carry an accessible name (never an empty `alt`).
 *
 * Locale keys this contract needs (every shipped dictionary, not just zh/en):
 *   `sideChatAttachmentImage`        — the thumbnail's fallback accessible name
 *   `sideChatAttachmentImageFailed`  — the failed-read placeholder copy
 * ==================================================================
 *
 * The shared view harness owns no `remote` face, and this task may not change
 * it, so this spec mounts the real view with a spec-local `ctx` (same session
 * fixture the harness installs, plus the Host Remote stub). `harness.extraProps`
 * is the harness's documented seam for exactly this: props it passes win over
 * the defaults.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { t } from '../src/client/locales.ts'

/** The locale keys this contract names. */
const IMAGE_ALT_KEY = 'sideChatAttachmentImage'
const IMAGE_FAILED_KEY = 'sideChatAttachmentImageFailed'

/** The thread under test (the harness binds the tab to it) and its parent. */
const THREAD_ID = 't1'

/** Translate a key this spec names but the build may not have yet. */
function copy(key: string, params?: Record<string, string | number>): string {
  return (t as unknown as (key: string, params?: Record<string, string | number>) => string)(key, params)
}

/** The `file` block's byte count and the host `fileSizeText` rendering of it. */
const FILE_BYTES = 2_048
const FILE_SIZE_TEXT = '2.0KB'
const FILE_NAME = 'report.pdf'

/** One attachment read the view asked the Host Remote for. */
interface AttachmentCall {
  sessionId: string
  attachmentId: string
}

/** Every `session.attachment` request, in call order. */
let calls: AttachmentCall[] = []
/** Every Blob handed to `URL.createObjectURL`. */
let blobs: Blob[] = []
/** Every object URL the stub minted. */
let urls: string[] = []
/** Every object URL the view revoked. */
let revoked: string[] = []

/** One image attachment ref plus the bytes the stub host answers with. */
function imageRef(attachmentId: string, name: string): Record<string, unknown> {
  return {
    attachmentId,
    mediaType: 'image/png',
    bytes: Buffer.byteLength(payloadOf(attachmentId)),
    width: 4,
    height: 4,
    name,
  }
}

/** The literal byte content the stub host serves for one attachment id. */
function payloadOf(attachmentId: string): string {
  switch (attachmentId) {
    case 'att-user': return 'IMG-USER-BYTES'
    case 'att-tool': return 'IMG-TOOL-BYTES'
    default: return 'IMG-ASSIST-BYTES'
  }
}

const USER_IMAGE = imageRef('att-user', 'before.png')
const ASSISTANT_IMAGE = imageRef('att-assist', 'diff.png')
const TOOL_IMAGE = imageRef('att-tool', 'after.png')
/** A file block: no bytes are ever read for it. */
const FILE_ATTACHMENT = { attachmentId: 'att-file', name: FILE_NAME, bytes: FILE_BYTES }

/** The ref a successful answer echoes back for one id. */
function refOf(attachmentId: string): Record<string, unknown> {
  if (attachmentId === 'att-user') return USER_IMAGE
  if (attachmentId === 'att-tool') return TOOL_IMAGE
  return ASSISTANT_IMAGE
}

/** One `session.attachment` answer: the ref plus its base64 bytes. */
function answerOk(call: AttachmentCall): Promise<unknown> {
  const payload = payloadOf(call.attachmentId)
  return Promise.resolve({
    ok: true,
    value: { attachment: refOf(call.attachmentId), data: Buffer.from(payload, 'utf8').toString('base64') },
  })
}

/**
 * The thread's own log: one image in the user message (legacy top-level block),
 * one in a tool result, one in the assistant message — plus the assistant
 * repeating the user's attachment (one request, one URL) and a file block.
 */
function attachmentEvents(): unknown[] {
  return [
    { type: 'session/end-seed', seq: 0, time: 0, data: { inherited: true } },
    {
      type: 'user/message',
      seq: 1,
      time: 1_000,
      surfaceOp: 'append',
      data: {
        id: 'm1',
        role: 'user',
        content: [
          { type: 'text', text: 'compare these' },
          { type: 'image', attachment: USER_IMAGE },
          { type: 'file', attachment: FILE_ATTACHMENT },
        ],
        source: { kind: 'user' },
      },
    },
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
    {
      type: 'tool/call',
      seq: 3,
      time: 3_000,
      data: { turn: 1, step: 1, callId: 'c1', name: 'screenshot', arguments: '{}' },
    },
    {
      type: 'tool/result',
      seq: 4,
      time: 4_000,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'c1' },
          content: [{
            type: 'tool-result',
            toolCallId: 'c1',
            content: [
              { type: 'text', text: 'captured' },
              { type: 'image', attachment: TOOL_IMAGE },
            ],
          }],
        },
      },
    },
    {
      type: 'assistant/message',
      seq: 5,
      time: 5_000,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'text', text: 'Both attached.' },
            { type: 'image', attachment: ASSISTANT_IMAGE },
            { type: 'image', attachment: USER_IMAGE },
          ],
        },
      },
    },
    { type: 'turn/end', seq: 6, time: 6_000, data: { turn: 1, reason: { kind: 'stop' } } },
  ]
}

/** The sessions-list fixture the shared harness installs (same rows): restated
 *  because this spec supplies its own `ctx` (see the file header). */
function listFixture(): unknown {
  return {
    byId: {
      root: { id: 'root', cwd: '/p', displayTitle: '主会话', running: false },
      t1: { id: 't1', cwd: '/p', displayTitle: 'Side: 线程一', origin: 'subagent', parentId: 'root', running: false },
    },
    projectionsBySession: {
      root: {
        values: { subagentCatalog: [{ id: 't1', createdAt: 1_000, mode: 'continuable', label: 'Side: 线程一' }] },
        state: 'ready',
        error: null,
      },
    },
  }
}

/** The host face this spec must NOT see used for images (see contract 2). */
interface UiConversationFace {
  imageUrl: ReturnType<typeof vi.fn>
}

/** A spec-local `ctx`: the harness's session fixture plus the injected faces. */
function fakeCtx(remote: unknown, uiConversation?: unknown): unknown {
  const list = listFixture()
  return {
    sessions: { list: { getSnapshot: () => list, subscribe: () => () => {} } },
    get: (key: string) => {
      if (key === 'betterSidebar') return harness.host
      if (key === 'remote') return remote
      if (key === 'uiConversation') return uiConversation
      return undefined
    },
  }
}

/** The Host Remote stub: records every request, answers with `answer`. */
function remoteStub(answer: (call: AttachmentCall) => Promise<unknown>): unknown {
  return {
    session: {
      attachment: async (request: { sessionId: string; attachmentId: string }) => {
        const call = { sessionId: request.sessionId, attachmentId: request.attachmentId }
        calls.push(call)
        return answer(call)
      },
    },
  }
}

/** The thumbnails the transcript published as object URLs. */
function thumbnails(container: HTMLElement): HTMLImageElement[] {
  return [...container.querySelectorAll<HTMLImageElement>('img')]
    .filter(image => (image.getAttribute('src') ?? '').startsWith('blob:'))
}

let harness: SidechatHarness

beforeEach(() => {
  calls = []
  blobs = []
  urls = []
  revoked = []
  harness = installSidechatHarness()
  // jsdom implements neither: the view must be free to mint and release the
  // object URLs the browser would.
  ;(URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = (blob: Blob) => {
    blobs.push(blob)
    const url = `blob:stub/${String(blobs.length)}`
    urls.push(url)
    return url
  }
  ;(URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = (url: string) => {
    revoked.push(url)
  }
})

afterEach(() => {
  harness.cleanup()
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
})

/** Mount the transcript with `remote` (and the forbidden `uiConversation` face). */
async function mountWith(remote: unknown, uiConversation?: unknown) {
  harness.wire.events = attachmentEvents()
  harness.extraProps.ctx = fakeCtx(remote, uiConversation)
  const rendered = harness.mount()
  await harness.flush(6)
  return rendered
}

describe('image and file content blocks in the transcript (D13)', () => {
  it('defines the copy the attachment rows need in the dictionaries', () => {
    expect(copy(IMAGE_ALT_KEY), `the ${IMAGE_ALT_KEY} key must exist in the locale dictionary`).not.toBe(IMAGE_ALT_KEY)
    expect(copy(IMAGE_FAILED_KEY), `the ${IMAGE_FAILED_KEY} key must exist in the locale dictionary`)
      .not.toBe(IMAGE_FAILED_KEY)
  })

  it('renders a thumbnail for an image block in a tool result and an assistant message', async () => {
    const rendered = await mountWith(remoteStub(answerOk))
    try {
      expect(rendered.container.textContent ?? '', 'the transcript itself renders').toContain('compare these')

      const images = thumbnails(rendered.container)
      // Three: the two assistant-message blocks plus the tool result. The user
      // bubble's own image belongs to upstream's SidechatImages (see the header).
      expect(images, 'every image block this view owns renders a thumbnail').toHaveLength(3)
      expect(
        new Set(images.map(image => image.getAttribute('src'))).size,
        'the repeated attachment shares one object URL',
      ).toBe(3)
      for (const image of images) {
        expect(urls, 'the src is an object URL this view minted').toContain(image.getAttribute('src'))
        expect(image.getAttribute('alt') ?? '', 'a thumbnail is never an unnamed image').not.toBe('')
        expect(image.getAttribute('alt'), 'the accessible name is translated copy, not the raw key')
          .not.toBe(IMAGE_ALT_KEY)
      }

      expect(blobs, 'one Blob per distinct attachment').toHaveLength(3)
      expect(blobs.map(blob => blob.type), 'the Blob carries the attachment media type')
        .toEqual(['image/png', 'image/png', 'image/png'])
      const decoded = await Promise.all(blobs.map(blob => blob.text()))
      expect(new Set(decoded), 'the Blob holds the bytes the host served').toEqual(
        new Set(['IMG-USER-BYTES', 'IMG-TOOL-BYTES', 'IMG-ASSIST-BYTES']),
      )
    } finally {
      rendered.unmount()
    }
  })

  it('asks the host for exactly the attachments this thread references, once each', async () => {
    const rendered = await mountWith(remoteStub(answerOk))
    try {
      expect(rendered.container.textContent ?? '').toContain('compare these')
      expect(
        calls.map(call => call.attachmentId).sort(),
        'the requested ids are exactly the ids in the log, with no duplicate request',
      ).toEqual(['att-assist', 'att-tool', 'att-user'])
      expect(
        calls.map(call => call.sessionId),
        'the read is addressed to the THREAD that owns the referencing log',
      ).toEqual([THREAD_ID, THREAD_ID, THREAD_ID])
      expect(
        calls.some(call => call.attachmentId === FILE_ATTACHMENT.attachmentId),
        'a file block never reads bytes',
      ).toBe(false)
    } finally {
      rendered.unmount()
    }
  })

  it('never routes the read through the retained-session image cache', async () => {
    const uiConversation: UiConversationFace = {
      // The host rejects this for a side thread the client never retained.
      imageUrl: vi.fn(async () => { throw new Error(`ui-conversation: unknown session ${THREAD_ID}`) }),
    }
    const rendered = await mountWith(remoteStub(answerOk), uiConversation)
    try {
      expect(rendered.container.textContent ?? '').toContain('compare these')
      expect(thumbnails(rendered.container), 'the thumbnails still render').toHaveLength(3)
      expect(uiConversation.imageUrl, 'uiConversation.imageUrl is not the source of image bytes').not.toHaveBeenCalled()
    } finally {
      rendered.unmount()
    }
  })

  it('renders the failure placeholder instead of a thumbnail when the read declines', async () => {
    const failed = copy(IMAGE_FAILED_KEY)

    const declines: Array<[string, () => unknown]> = [
      ['the RPC answers a failure branch', () => remoteStub(() => Promise.resolve({
        ok: false,
        error: { code: 'session/attachment-invalid', message: 'attachment not referenced' },
      }))],
      ['the RPC rejects (carrier fault)', () => remoteStub(() => Promise.reject(new Error('gateway/internal')))],
      ['the composition has no Host Remote', () => undefined],
    ]

    for (const [label, remote] of declines) {
      const rendered = await mountWith(remote())
      try {
        const text = rendered.container.textContent ?? ''
        expect.soft(text, `${label}: the transcript still renders`).toContain('compare these')
        expect.soft(text, `${label}: the failure placeholder is visible`).toContain(failed)
        expect.soft(text, `${label}: the placeholder is translated, not the raw key`)
          .not.toContain(IMAGE_FAILED_KEY)
        expect.soft(
          thumbnails(rendered.container),
          `${label}: no thumbnail is published for a failed read`,
        ).toHaveLength(0)
        expect.soft(
          rendered.container.querySelectorAll('img').length,
          `${label}: no <img> is emitted at all`,
        ).toBe(0)
      } finally {
        rendered.unmount()
      }
    }
  })

  it('renders a file block as the name + size chip without reading bytes', async () => {
    const rendered = await mountWith(remoteStub(answerOk))
    try {
      const container = rendered.container
      const chip = [...container.querySelectorAll<HTMLElement>('*')]
        .filter(element => (element.textContent ?? '').includes(FILE_NAME))
        .find(element => (element.textContent ?? '').includes(FILE_SIZE_TEXT))
      expect(
        chip,
        `a single element carries the file name and its size text (${FILE_SIZE_TEXT})`,
      ).toBeDefined()
      expect(
        container.textContent ?? '',
        'the file chip is the host formatter output, not the raw byte count',
      ).not.toContain(String(FILE_BYTES))
      expect(
        calls.some(call => call.attachmentId === FILE_ATTACHMENT.attachmentId),
        'a file block triggers no attachment read',
      ).toBe(false)
    } finally {
      rendered.unmount()
    }
  })

  it('skips a malformed block without a request, a crash or leaked placeholders', async () => {
    const events = attachmentEvents()
    const user = events[1] as { data: { content: unknown[] } }
    user.data.content.push(
      { type: 'image', attachment: {} },
      { type: 'file', attachment: { bytes: 10 } },
    )
    harness.wire.events = events
    harness.extraProps.ctx = fakeCtx(remoteStub(answerOk))
    const rendered = harness.mount()
    await harness.flush(6)
    try {
      const text = rendered.container.textContent ?? ''
      expect(text, 'the rest of the transcript still renders').toContain('compare these')
      expect(text, 'no placeholder copy leaks into the row').not.toContain('undefined')
      expect(text).not.toContain('null')
      expect(thumbnails(rendered.container), 'the well-formed images still render').toHaveLength(3)
      expect(
        calls.map(call => call.attachmentId).sort(),
        'a malformed block asks for nothing and breaks no other read',
      ).toEqual(['att-assist', 'att-tool', 'att-user'])
    } finally {
      rendered.unmount()
    }
  })

  it('revokes every object URL it minted when the view unmounts', async () => {
    const rendered = await mountWith(remoteStub(answerOk))
    const minted = [...urls]
    expect(minted).toHaveLength(3)
    rendered.unmount()
    await harness.flush(2)
    expect([...revoked].sort(), 'the view releases the URLs it owns').toEqual([...minted].sort())
  })
})
