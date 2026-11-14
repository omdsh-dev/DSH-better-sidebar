/**
 * The clue pack creation window (S9).
 *
 * Creating a pack left the tab's inline row: one compact S6 window owns the
 * name field and the two explicit exits, so the shelf itself stays a browsing
 * surface. Contract:
 * - typing never writes; only Submit calls `packsCreate`;
 * - the window is a singleton PER WORKSPACE (`clue-pack-create:<workspaceId>`),
 *   so calling the opener again focuses the live instance and keeps its draft;
 * - the close control and Escape are refused while the one create request is
 *   in flight, and the request is never re-issued by a second click;
 * - success closes the window FIRST and then reports the created pack;
 * - failure keeps the window, the draft and the reader on the same field,
 *   with the reason rendered in the surface (and announced through onNotice).
 *
 * The host owns geometry, z-order and the close guard; this module only
 * supplies the compact content and reads the shared `onBeforeClose` hook.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CluePack } from '../../../clues/types.ts'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import type { BetterSidebarWindowsClientFace, WindowHandle } from '../../windows/types.ts'
import { clueErrorMessage } from '../copy.ts'
import { t } from '../../locales.ts'
import { ActionButton, ActionFooter, Field, Notice, TextInput } from '../../ui/index.ts'
import css from './create-pack.module.css'

/** The stable window id of one workspace's creation surface. */
export function createPackWindowId(workspaceId: string): string {
  return `clue-pack-create:${workspaceId}`
}

/**
 * Mutable state the window's close guard reads. `busy` is the synchronous
 * latch (state alone is one render behind a double click); `handle` is wired
 * after `open()` returns so the page can close its own window.
 */
interface CreatePackGuard {
  busy: boolean
  handle?: WindowHandle
}

/** Options of {@link openCreatePackWindow}. */
interface OpenCreatePackWindowOptions {
  readonly windows: BetterSidebarWindowsClientFace
  readonly face: BetterSidebarCluesClientFace
  readonly workspaceId: string
  /** Called once, AFTER the window has closed, with the created pack. */
  onCreated(pack: CluePack): void
  /** Released exactly once when the window actually closes — including Cancel. */
  onClosed?(): void
  /** The tab's shared notice channel (used for a failed create). */
  onNotice(message: string): void
  /** The control that opened the window (places it; no focus stealing). */
  readonly anchor?: HTMLElement | null
}

/** The creation window's title. */
function title(): string {
  return `${t('cluePacksHeading')} · ${t('cluePacksNew')}`
}

/**
 * Open (or focus) the create-pack window for one workspace.
 * @param options - window host, clue face, workspace and the result callbacks.
 */
export function openCreatePackWindow(options: OpenCreatePackWindowOptions): WindowHandle {
  const guard: CreatePackGuard = { busy: false }
  const handle = options.windows.open({
    id: createPackWindowId(options.workspaceId),
    surface: 'sidebar',
    title: title(),
    size: 'compact',
    bodyLayout: 'fill',
    ...(options.anchor === undefined ? {} : { anchor: options.anchor }),
    content: <CreatePackPage {...options} guard={guard} />,
    // The close control and Escape both land here. A create in flight must
    // never lose its result or its draft, so refuse until it settles.
    onBeforeClose: () => !guard.busy,
    // The host's onClose is a REAL close (Cancel, Escape, success), never the
    // activation teardown: release the owner's workspace/scope pin there.
    ...(options.onClosed === undefined ? {} : { onClose: options.onClosed }),
  })
  guard.handle = handle
  return handle
}

/** The interactive create-pack surface. */
function CreatePackPage(props: OpenCreatePackWindowOptions & { readonly guard: CreatePackGuard }): ReactNode {
  const { face, workspaceId, guard, onCreated, onNotice } = props
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = useCallback(async (): Promise<void> => {
    // Synchronous latch: two clicks in the same tick cannot issue two creates.
    if (guard.busy) return
    const name = draft.trim() === '' ? t('cluePacksUntitled') : draft.trim()
    guard.busy = true
    setBusy(true)
    setError(null)
    try {
      const created = await face.api.packsCreate(workspaceId, { name })
      guard.busy = false
      setBusy(false)
      // Success semantics: close before the caller hears about the pack, so a
      // callback that opens the new collection never races the create window.
      await guard.handle?.close()
      onCreated(created.pack)
    } catch (failure) {
      guard.busy = false
      setBusy(false)
      const message = clueErrorMessage(failure, t('cluePackSaveFailed'))
      setError(message)
      onNotice(message)
    }
  }, [face, workspaceId, guard, draft, onCreated, onNotice])

  const cancel = useCallback((): void => {
    if (guard.busy) return
    void guard.handle?.close()
  }, [guard])

  return (
    <form
      className={css.root}
      aria-busy={busy}
      onSubmit={(event) => { event.preventDefault(); if (!guard.busy) void submit() }}
    >
      <Field label={t('cluePacksNamePlaceholder')}>
        <TextInput
          ref={inputRef}
          value={draft}
          disabled={busy}
          placeholder={t('cluePacksNamePlaceholder')}
          aria-label={t('cluePacksNamePlaceholder')}
          onChange={(event) => { setDraft(event.target.value) }}
        />
      </Field>

      {error !== null && <Notice kind="error">{error}</Notice>}

      <ActionFooter bleed end={<>
        <ActionButton disabled={busy} onClick={cancel}>{t('cancel')}</ActionButton>
        <ActionButton type="submit" variant="primary" busy={busy}>
          {t('cluePacksCreate')}
        </ActionButton>
      </>} />
    </form>
  )
}
