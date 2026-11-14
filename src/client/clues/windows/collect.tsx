/**
 * The one clue-collection window (S9).
 *
 * A pack is a local set of clue ids. This window is the SINGLE writer for
 * "add resources to a pack": the browser tray, the row context menu, a detail
 * window (including one opened from a composer chip) and the pack window all
 * open this surface with their target set. It owns the explicit destination
 * choice, the ensure/add-member CAS loop and the create-pack path; callers
 * never run a second write loop of their own.
 *
 * Lifecycle: this is a hosted S6 window, not content inside the clues Tab. It
 * remains mounted when the Tab is hidden or unmounted, so a composer-opened
 * detail can still add a resource to a pack. The window id is prefixed with
 * `clue-collect:` and includes the workspace plus the candidate set, so
 * reopening the same set focuses the live instance while a different set gets
 * its own surface.
 *
 * Write semantics:
 * - typing/filtering/choosing a destination writes nothing;
 * - only the footer submit ensures and writes, one member at a time, feeding
 *   each successful revision into the next CAS call;
 * - success closes the window (after releasing the close guard), clears the
 *   caller's pending set through `onPendingChange`, and reports the changed
 *   shelf through `onAdded`;
 * - a failure keeps the window, destination, new-pack name and every target
 *   that was not committed; a partially committed batch reports `onCommitted`
 *   so the shelf reflects the writes that did land;
 * - Cancel (button, Escape or title bar) writes nothing and leaves the
 *   caller's selection untouched.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClueCandidate, CluePack, CluesPacksResult } from '../../../clues/types.ts'
import type { BetterSidebarCluesClientFace } from '../registry.ts'
import type { BetterSidebarWindowsClientFace, WindowHandle } from '../../windows/types.ts'
import type { ClueDetailTarget } from './detail.tsx'
import { candidateKey } from '../tab/browser-shared.tsx'
import { cluesApi, peekClueRequest } from '../api.ts'
import { clueErrorMessage } from '../copy.ts'
import { CluePackArtwork } from '../artwork.tsx'
import { LoadingIndicator } from '../../ui/LoadingIndicator.tsx'
import { ActionButton, ActionFooter, ErrorBlock, Field, TextInput } from '../../ui/index.ts'
import { t } from '../../locales.ts'
import css from './collect.module.css'

/** Destination/name/pending draft kept across a close, keyed by window id. */
interface CollectDraft {
  readonly pending: readonly ClueCandidate[]
  readonly destination: string
  readonly query: string
  readonly newPackName: string
}

/**
 * Closing a collection surface is not cancellation: the accepted UX keeps the
 * chosen destination, the New name and any unfinished targets for the next
 * open of the SAME workspace+target set. A successful batch deletes its draft.
 * The map is bounded; it is state, not a second write path or a scheduler.
 */
const DRAFT_CAP = 30
const drafts = new Map<string, CollectDraft>()

/**
 * Read AND remove the closed-window draft for one identity. An active window
 * never lives in the map, so the cap can only evict already-closed surfaces.
 */
function takeDraft(id: string, targets: readonly ClueCandidate[]): CollectDraft {
  const stored = drafts.get(id)
  if (stored === undefined) return { pending: targets, destination: '', query: '', newPackName: '' }
  drafts.delete(id)
  return stored
}

function rememberDraft(id: string, draft: CollectDraft): void {
  drafts.delete(id)
  drafts.set(id, draft)
  if (drafts.size <= DRAFT_CAP) return
  const oldest = drafts.keys().next().value
  if (oldest !== undefined) drafts.delete(oldest)
}

/** Drop retained drafts (tests start from a clean browser). */
export function clearClueCollectionDrafts(): void {
  drafts.clear()
}

/** The mutable close guard the hosted window reads. */
interface ClueCollectGuard {
  busy: boolean
  handle?: WindowHandle
}

/** Options of {@link openClueCollectionWindow}. */
interface OpenClueCollectionWindowOptions {
  readonly windows: BetterSidebarWindowsClientFace
  readonly face: BetterSidebarCluesClientFace
  readonly workspaceId: string
  /** The snapshot this instance collects; never mutated by the caller. */
  readonly targets: readonly ClueCandidate[]
  onNotice(message: string): void
  /** The still-uncommitted targets, after every landed write. */
  onPendingChange?(pending: readonly ClueCandidate[]): void
  /** At least one write landed, but the batch did not fully finish. */
  onCommitted?(): void
  /** The whole batch landed and the window is closing. */
  onAdded?(): void
  /** The control that opened the window (initial placement only). */
  readonly anchor?: HTMLElement | null
}

/** Options of {@link openClueCollectionForTarget}. */
interface OpenClueCollectionForTargetOptions {
  readonly windows: BetterSidebarWindowsClientFace
  readonly face: BetterSidebarCluesClientFace
  readonly workspaceId: string
  readonly target: ClueDetailTarget
  onNotice(message: string): void
  onPendingChange?(pending: readonly ClueCandidate[]): void
  onCommitted?(): void
  onAdded?(): void
  readonly anchor?: HTMLElement | null
}

/** Stable hash of one target set (window identity, not a cache key). */
function targetSetHash(targets: readonly ClueCandidate[]): string {
  const text = targets.map(candidateKey).sort().join('\u0000')
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * The stable window id of one workspace + target set. Two `Add to pack`
 * gestures for the same resources focus the same surface; a different set is
 * a distinct instance under the same `clue-collect:` prefix.
 */
export function collectWindowId(workspaceId: string, targets: readonly ClueCandidate[]): string {
  return `clue-collect:${workspaceId}:${targetSetHash(targets)}`
}

/**
 * Open (or focus) the collection window for a snapshot of resources.
 * @param options - host, clue face, workspace, targets and result callbacks.
 * @returns the window handle, or undefined for an empty target set.
 */
export function openClueCollectionWindow(
  options: OpenClueCollectionWindowOptions,
): WindowHandle | undefined {
  if (options.targets.length === 0) return undefined
  const guard: ClueCollectGuard = { busy: false }
  const handle = options.windows.open({
    id: collectWindowId(options.workspaceId, options.targets),
    surface: 'sidebar',
    title: t('clueBrowserAddToPack'),
    size: 'compact',
    bodyLayout: 'fill',
    ...(options.anchor === undefined || options.anchor === null ? {} : { anchor: options.anchor }),
    content: <ClueCollectPage {...options} guard={guard} />,
    // A write in flight must retain its result and unfinished targets.
    onBeforeClose: () => !guard.busy,
  })
  guard.handle = handle
  return handle
}

/**
 * Resolve one detail target into a collectable candidate, then open the SAME
 * collection window. This is the bridge used by composer chips, pack windows
 * and the Tab; none of them needs a mounted clues browser.
 */
export async function openClueCollectionForTarget(
  options: OpenClueCollectionForTargetOptions,
): Promise<WindowHandle | undefined> {
  let candidate: ClueCandidate | undefined
  if (options.target.clueId !== undefined) {
    try {
      const library = await options.face.api.clues(options.workspaceId)
      const clue = library.clues.find(item => item.id === options.target.clueId)
      if (clue !== undefined) {
        candidate = {
          sourceId: clue.sourceId,
          typeId: clue.typeId,
          locator: clue.locator,
          title: options.target.title,
          info: options.target.info ?? clue.info, subtitle: options.target.subtitle ?? clue.subtitle,
          clueId: clue.id,
        }
      }
    } catch (failure) {
      options.onNotice(clueErrorMessage(failure, t('clueStateRequestFailed')))
      return undefined
    }
  }
  if (candidate === undefined && options.target.locator !== undefined) {
    candidate = {
      sourceId: options.target.sourceId,
      typeId: options.target.typeId,
      locator: options.target.locator,
      title: options.target.title,
      info: options.target.info, subtitle: options.target.subtitle,
    }
  }
  if (candidate === undefined) {
    options.onNotice(t('clueStateRequestFailed'))
    return undefined
  }
  return openClueCollectionWindow({
    windows: options.windows,
    face: options.face,
    workspaceId: options.workspaceId,
    targets: [candidate],
    onNotice: options.onNotice,
    ...(options.onPendingChange === undefined ? {} : { onPendingChange: options.onPendingChange }),
    ...(options.onCommitted === undefined ? {} : { onCommitted: options.onCommitted }),
    ...(options.onAdded === undefined ? {} : { onAdded: options.onAdded }),
    ...(options.anchor === undefined ? {} : { anchor: options.anchor }),
  })
}

/** Remove one candidate by its stable resource key. */
function withoutTarget(
  targets: readonly ClueCandidate[],
  target: ClueCandidate,
): readonly ClueCandidate[] {
  const key = candidateKey(target)
  return targets.filter(candidate => candidateKey(candidate) !== key)
}

/** The interactive collection surface. */
export function ClueCollectPage(
  props: OpenClueCollectionWindowOptions & { readonly guard: ClueCollectGuard },
): ReactNode {
  const { face, workspaceId, guard, onNotice, onPendingChange, onCommitted, onAdded } = props
  const name = useId()
  const windowId = collectWindowId(workspaceId, props.targets)
  const [initialDraft] = useState(() => takeDraft(windowId, props.targets))
  const [pending, setPending] = useState<readonly ClueCandidate[]>(() => [...initialDraft.pending])
  /** A warm pack shelf paints the destination list without a loader. */
  const [initialPacks] = useState(() => face.api === cluesApi
    ? peekClueRequest<CluesPacksResult>('clues.packs.list', workspaceId, { workspaceId })
    : undefined)
  const [packs, setPacks] = useState<readonly CluePack[]>(() => initialPacks?.packs ?? [])
  const [packsPhase, setPacksPhase] = useState<'loading' | 'ready' | 'error'>(() =>
    initialPacks === undefined ? 'loading' : 'ready')
  const [packsError, setPacksError] = useState<string | null>(null)
  const [query, setQuery] = useState(initialDraft.query)
  const [destination, setDestination] = useState(initialDraft.destination)
  const [newPackName, setNewPackName] = useState(initialDraft.newPackName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(0)
  /** Set once the batch landed; a successful close must not cache a draft. */
  const settled = useRef(false)
  /** The latest values are cached only when this surface unmounts un-settled. */
  const latestDraft = useRef<CollectDraft>({ pending, destination, query, newPackName })
  latestDraft.current = { pending, destination, query, newPackName }

  useEffect(() => () => {
    if (settled.current) return
    rememberDraft(windowId, latestDraft.current)
  }, [windowId])

  const commitPending = useCallback((next: readonly ClueCandidate[]): void => {
    setPending(next)
    onPendingChange?.(next)
  }, [onPendingChange])

  const loadPacks = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current
    setPacksPhase('loading')
    setPacksError(null)
    try {
      const result = await face.api.packsList(workspaceId)
      if (request !== requestRef.current) return
      setPacks(result.packs)
      setPacksPhase('ready')
    } catch (failure) {
      if (request !== requestRef.current) return
      // A failed read is not an empty library: keep the target list and the
      // New path, and offer Retry in the same fieldset.
      setPacks([])
      setPacksPhase('error')
      setPacksError(clueErrorMessage(failure, t('error')))
    }
  }, [face, workspaceId])

  useEffect(() => {
    // Remounting the same workspace's collection window reuses the activation
    // read; a mutation invalidated it, so a cold mount still reads.
    if (initialPacks !== undefined) return
    void loadPacks()
  }, [loadPacks, initialPacks])

  const matchingPacks = useMemo(() => {
    const text = query.trim().toLowerCase()
    return text === '' ? packs : packs.filter(pack => pack.name.toLowerCase().includes(text))
  }, [packs, query])

  const submit = useCallback(async (): Promise<void> => {
    if (guard.busy || pending.length === 0 || destination === '') return
    guard.busy = true
    setBusy(true)
    setError(null)
    let changed = false
    let current = pending
    try {
      if (destination === '__new') {
        const members: string[] = []
        for (const target of current) {
          members.push(target.clueId ?? (await face.api.ensure(workspaceId, {
            sourceId: target.sourceId,
            typeId: target.typeId,
            locator: target.locator,
            title: target.title,
            info: target.info, subtitle: target.subtitle,
          })).clue.id)
        }
        const created = await face.api.packsCreate(workspaceId, {
          name: newPackName.trim() === '' ? t('cluePacksUntitled') : newPackName.trim(),
          members,
        })
        changed = true
        settled.current = true
        guard.busy = false
        setBusy(false)
        commitPending([])
        // Release the close guard BEFORE asking the host to close.
        await guard.handle?.close()
        onNotice(t('cluePackMembersAdded', { name: created.pack.name }))
        onAdded?.()
        return
      }

      // Each successful mutation supplies the next member's CAS baseline. The
      // failed member and everything after it stay in `current` for retry.
      let revision: number | undefined
      let packName = ''
      for (const target of current) {
        const clueId = target.clueId ?? (await face.api.ensure(workspaceId, {
          sourceId: target.sourceId,
          typeId: target.typeId,
          locator: target.locator,
          title: target.title,
            info: target.info, subtitle: target.subtitle,
        })).clue.id
        const result = await face.api.packsAddMember(workspaceId, {
          packId: destination,
          clueId,
          ...(revision === undefined ? {} : { expectedRevision: revision }),
        })
        revision = result.packRevision
        packName = result.pack.name
        changed = true
        current = withoutTarget(current, target)
        commitPending(current)
      }
      settled.current = true
      guard.busy = false
      setBusy(false)
      await guard.handle?.close()
      onNotice(t('cluePackMembersAdded', { name: packName }))
      onAdded?.()
    } catch (failure) {
      guard.busy = false
      setBusy(false)
      setError(clueErrorMessage(failure, t('cluePackSaveFailed')))
      onNotice(clueErrorMessage(failure, t('cluePackSaveFailed')))
      // Keep the failed/later targets and any new-pack name; a successful
      // prefix must still refresh the shelf that now shows those members.
      if (changed) onCommitted?.()
    }
  }, [commitPending, destination, face, guard, newPackName, onAdded, onCommitted, onNotice, pending, workspaceId])

  const cancel = useCallback((): void => {
    if (guard.busy) return
    void guard.handle?.close()
  }, [guard])

  const submitLabel = destination === '__new' ? t('cluePacksCreate') : t('clueBrowserAddToPack')
  const destinationName = destination === '__new'
    ? newPackName.trim() || t('cluePacksUntitled')
    : packs.find(pack => pack.id === destination)?.name

  return (
    <div className={css.root}>
      <details className={css.selection} data-clue-collection-selection>
        <summary className={css.count}>
          <span aria-live="polite">{t('clueBrowserSelected', { n: pending.length })}</span>
          {pending.length === 1 && <span className={css.selectionTitle}>{pending[0]!.title}</span>}
        </summary>
        <ul className={css.selectionList}>
          {pending.map(target => <li key={candidateKey(target)}>{target.title}</li>)}
        </ul>
      </details>
      <form
        className={css.form}
        data-clue-collection
        aria-busy={busy}
        onSubmit={(event) => { event.preventDefault(); void submit() }}
      >
        <div className={css.fields}>
          <label className={css.searchBox}>
            <IconSearchOutlineRegular size={14} />
            <TextInput
              autoFocus
              type="search"
              className={css.searchInput}
              aria-label={t('cluePacksSearchPlaceholder')}
              placeholder={t('cluePacksSearchPlaceholder')}
              value={query}
              disabled={busy}
              onChange={(event) => { setQuery(event.target.value) }}
            />
          </label>
          <fieldset className={css.destinationList} disabled={busy} aria-label={t('clueBrowserAddToPack')}>
            {packsPhase === 'loading' && <LoadingIndicator className={css.hint} inline />}
            {packsPhase === 'error' && (
              <ErrorBlock
                message={packsError ?? t('error')}
                retryLabel={t('retry')}
                onRetry={() => { void loadPacks() }}
              />
            )}
            {error !== null && <ErrorBlock message={error} />}
            {matchingPacks.map(pack => (
              <label key={pack.id} className={css.destinationRow} title={pack.name}>
                <input
                  type="radio"
                  name={name}
                  value={pack.id}
                  checked={destination === pack.id}
                  onChange={() => { setDestination(pack.id) }}
                />
                <CluePackArtwork size={16} />
                <span>{pack.name}</span>
                <small>{t('cluePacksMembers', { n: pack.members.length })}</small>
              </label>
            ))}
            {packsPhase === 'ready' && matchingPacks.length === 0 && (
              <span className={css.hint}>
                {query.trim() === '' ? t('clueBrowserNoPacks') : t('cluePacksNoMatch')}
              </span>
            )}
            <label className={css.destinationRow}>
              <input
                type="radio"
                name={name}
                value="__new"
                checked={destination === '__new'}
                onChange={() => { setDestination('__new') }}
              />
              <IconPlusOutlineRegular size={16} />
              <span>{t('cluePacksNew')}</span>
            </label>
          </fieldset>
          {destination === '__new' && (
            <Field label={t('cluePacksNamePlaceholder')}>
              <TextInput
                autoFocus
                aria-label={t('cluePacksNamePlaceholder')}
                placeholder={t('cluePacksNamePlaceholder')}
                value={newPackName}
                disabled={busy}
                onChange={(event) => { setNewPackName(event.target.value) }}
              />
            </Field>
          )}
        </div>
        <ActionFooter
          bleed
          start={<span data-clue-collection-destination>{destinationName ?? t('clueSharePacks')}</span>}
          end={<>
            <ActionButton disabled={busy} onClick={cancel}>{t('cancel')}</ActionButton>
            <ActionButton type="submit" variant="primary" busy={busy} disabled={pending.length === 0 || destination === ''}>
              {submitLabel}
            </ActionButton>
          </>}
        />
      </form>
    </div>
  )
}
