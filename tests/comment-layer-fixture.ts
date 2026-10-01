/**
 * A `CommentMode` built by hand, for specs that hold what `CommentLayer.tsx` DRAWS for a given state
 * of the controller (Tracy, 28/09/2026; people-only since 29/09/2026). The controller's own behaviour
 * is held by `comment-people-controller.spec.tsx`; here every callback is a spy and every field is set
 * directly.
 */
import { vi } from 'vitest'
import type { CommentMode, PickedState } from '../src/client/comment-controller.ts'
import type { Comment, CommentAuthor } from '../src/client/comment-store.ts'
import { NO_ATTACHMENTS } from '../src/client/comment-attachments.ts'
import type { PreviewPickRect, PreviewPickTarget } from '../src/client/preview-protocol.generated.ts'

export const PAGE = 'http://northgate.tracy.test:8080/'
export const LEE: CommentAuthor = { accountId: 'a1', email: 'lee@example.com', name: 'Lee', initial: 'L' }
export const MAI: CommentAuthor = { accountId: 'a2', email: 'mai@example.com', name: 'Mai', initial: 'M' }

export function target(selector: string, text: string, rect: PreviewPickRect): PreviewPickTarget {
  return { text, tag: 'h1', image: null, domPath: selector, selector, rect, marks: [], levels: [], level: 0 }
}

export function comment(n: number, text: string, over: Partial<Comment> = {}): Comment {
  return { id: `c${String(n)}`, n, url: PAGE, element: target(`#el-${String(n)}`, `element ${String(n)}`, { x: 0, y: 0, width: 10, height: 10 }), locate: null, text, status: 'open', createdAt: 1, author: LEE, can: { edit: true, delete: true }, ...over }
}

export function picked(rect: PreviewPickRect = { x: 40, y: 400, width: 380, height: 120 }): PickedState {
  return { id: 1, doc: 1, target: target('#news-1', 'news-1.png', rect), url: PAGE }
}

export function fixtureMode(overrides: Partial<CommentMode> = {}): CommentMode {
  return {
    frameSrc: PAGE,
    dropTicket: vi.fn(() => false),
    onFrameLoad: vi.fn(),
    modes: { visible: true, edit: true, unavailable: false, selectEdit: vi.fn(), selectInteractive: vi.fn(), reload: vi.fn() },
    doc: 1,
    picked: null,
    text: '',
    setText: vi.fn(),
    comments: [],
    pageComments: [],
    pageUrl: PAGE,
    rects: new Map(),
    foot: null,
    editing: null,
    sending: false,
    notice: null,
    serverNotice: null,
    serverNoticeKind: 'save',
    serverError: null,
    saveError: null,
    maxChars: 4000,
    addComment: vi.fn(),
    save: vi.fn(),
    sendToTracy: vi.fn(),
    close: vi.fn(),
    deleteComment: vi.fn(),
    deleted: null,
    undoDelete: vi.fn(),
    escape: vi.fn(),
    flash: 0,
    unsaved: false,
    mayLeave: vi.fn(() => true),
    clickedOutside: vi.fn(),
    wheelPage: vi.fn(),
    thread: null,
    threadMessages: [],
    threadFocus: null,
    ownReplies: 0,
    replyText: '',
    setReplyText: vi.fn(),
    openThread: vi.fn(),
    closeThread: vi.fn(),
    reply: vi.fn(),
    sendThread: vi.fn(),
    resolve: vi.fn(),
    editMessage: vi.fn(),
    copyLink: vi.fn(async () => true),
    lost: null,
    sendLost: vi.fn(),
    addLost: vi.fn(),
    discardLost: vi.fn(),
    reveal: vi.fn(),
    addGeneral: vi.fn(() => null),
    clearAll: vi.fn(),
    sendSome: vi.fn(),
    sendPage: vi.fn(),
    siteChangedAt: null,
    typing: false,
    boxOpen: false,
    holdsReload: false,
    holdable: false,
    onPageOutside: vi.fn(() => () => {}),
    attachments: NO_ATTACHMENTS,
    draft: [],
    replyDraft: [],
    draftError: null,
    addFiles: vi.fn(),
    removeDraft: vi.fn(),
    ...overrides,
  }
}
