/**
 * The Git lens's commit-graph area: read-only history, lazily paged, never
 * checking anything out. No status subscription and no timer — the section
 * unfolds, becomes visible, changes branch or takes a refresh tick, and those
 * are the only request triggers.
 *
 * Mounted by {@link GitLens} on the repo/worktree target the lens has already
 * selected; it owns its own bounded page (`git.graph`) and reports the
 * selected commit upward for the tab's bottom pane (`details` tab). */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import {
  Button, IconBranchOutlineRegular, IconCheckOutlineRegular, IconGlobeOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, SidebarApiError, type SessionScope } from '../api.ts'
import type { SidebarDiffRef } from '../state.ts'
import { relativeTime, t } from '../locales.ts'
import { Notice } from '../ui/index.ts'
import { AnchoredPopover } from '../AnchoredPopover.tsx'
import { edgePath, layoutGraph } from './graph-layout.ts'
import css from './graph.module.css'

type GraphPage = Awaited<ReturnType<typeof api.gitGraph>>
/** One commit row of the graph page. */
export type GraphEntry = GraphPage['entries'][number]
type Branch = GraphPage['branches'][number]

/** The selected graph commit plus the render context only the lens owns: the
 *  remote ref names that tone the details card's ref pills, and the palette
 *  slot of the selected row's lane so the card's pills match the graph. */
export interface GraphDetailsSelection {
  readonly entry: GraphEntry
  readonly remotes: ReadonlySet<string>
  readonly slot: number
}

export interface GitGraphSectionProps {
  scope: SessionScope
  worktree?: string
  visible: boolean
  refreshTick?: number
  onPreview: (ref: SidebarDiffRef) => void
  selectedRef: SidebarDiffRef | null
  onClearPreview?: () => void
  /** The selected commit, reported upward for the changes tab's bottom pane
   *  (`details` tab). Fires on every selection change — a refresh that drops
   *  the entry included — and unmounting ends it at `null`. HIDING the lens
   *  deliberately does not clear it: the bottom pane is one region shared by
   *  all three lenses, independent of which lens is on top. */
  onDetailsChange?: (selection: GraphDetailsSelection | null) => void
  /** Row context menu: the Git lens's advanced commit actions (view / copy /
   *  revert / cherry-pick). Absent, the rows simply carry no menu. */
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>, entry: GraphEntry) => void
}

/** One-line rows: the GitLens-style picture is rail + ref pills + subject on
 *  a single 28px line; author, date and hash live in the details card (and
 *  the row's tooltip). */
const ROW_HEIGHT = 28
/** The lane palette is five theme slots. Every painter — lane paths, the node
 *  dot and the ref pills — resolves through this ONE mapping; the colors
 *  themselves live in `graph.module.css` (`[data-color]`). */
const PALETTE_SIZE = 5
const colorSlot = (colorIndex: number): number => colorIndex % PALETTE_SIZE
const laneX = (lane: number): number => 10 + lane * 12

/** The `origin/main`-style refs of the loaded page, told apart from local
 *  branches by the inventory's own full refs (a local branch may contain `/`). */
function remoteRefNames(branches: readonly Branch[]): ReadonlySet<string> {
  return new Set(branches.filter(item => item.ref.startsWith('refs/remotes/')).map(item => item.name))
}

/** HEAD is the local-current marker; remote refs read muted, local ones brand.
 *  Exported for {@link CommitDetails}, which renders the same pills. */
export function refTone(ref: string, remotes: ReadonlySet<string>): 'head' | 'remote' | 'local' {
  if (ref === 'HEAD') return 'head'
  return remotes.has(ref) ? 'remote' : 'local'
}

/** One ref pill's paint model: the display name, the tone rung and whether it
 *  carries the "currently checked out" check. */
export interface RefPillModel {
  readonly name: string
  readonly tone: 'head' | 'remote' | 'local'
  readonly current: boolean
}

/** The pills one entry's refs render as, in the refs' own order. A literal
 *  `HEAD` never becomes a pill of its own — it folds into the current local
 *  branch's pill as a leading check, the convention every graph tool shares
 *  (GitLens, GitKraken, …); only a DETACHED head renders it standalone. The
 *  current branch's pill takes the emphasised `head` tone. */
export function refPills(refs: readonly string[], remotes: ReadonlySet<string>): RefPillModel[] {
  const atHead = refs.includes('HEAD')
  const named = refs.filter(ref => ref !== 'HEAD')
  const current = atHead ? named.find(ref => !remotes.has(ref)) : undefined
  const pills = named.map(name => ({
    name,
    tone: (name === current ? 'head' : refTone(name, remotes)) as RefPillModel['tone'],
    current: name === current,
  }))
  if (atHead && current === undefined) pills.unshift({ name: 'HEAD', tone: 'head', current: true })
  return pills
}

/** One pill: the ref-kind icon (branch / remote globe) plus the name, with a
 *  leading check when this is the branch the worktree stands on. `slot` paints
 *  the pill in the commit's LANE colour (the same palette mapping the edges
 *  and the node dot resolve through), so a branch head is recognisable by
 *  colour alone. Shared by the graph rows, the hover card and the details
 *  card so a ref reads the same everywhere. */
export function RefPill({ pill, slot }: { pill: RefPillModel; slot?: number }) {
  return <span className={css.ref} data-tone={pill.tone} data-color={slot} data-current={pill.current || undefined}>
    {pill.current && <IconCheckOutlineRegular size={11} />}
    {pill.tone === 'remote' ? <IconGlobeOutlineRegular size={11} /> : <IconBranchOutlineRegular size={11} />}
    <span className={css.refName}>{pill.name}</span>
  </span>
}

export function GitGraphSection({ scope, worktree, visible, refreshTick = 0, onPreview, selectedRef, onClearPreview, onDetailsChange, onContextMenu }: GitGraphSectionProps) {
  const [branch, setBranch] = useState('')
  const [page, setPage] = useState<GraphPage | null>(null)
  const [branches, setBranches] = useState<GraphPage['branches']>([])
  const selectionRef = useRef(selectedRef)
  selectionRef.current = selectedRef
  const clearPreviewRef = useRef(onClearPreview)
  clearPreviewRef.current = onClearPreview
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const active = useRef<AbortController | null>(null)
  const pageRef = useRef<GraphPage | null>(null)
  const failedAppend = useRef(false)
  /** One append in flight at a time: the end sentinel can re-intersect while a
   *  page is still arriving, and two appends over one cursor would ask for the
   *  same rows twice. */
  const appending = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  /** Row hover preview: the middle information rung between the one-line row
   *  (pills + subject) and the details card (everything). It opens only after
   *  a short dwell so scrolling past rows never flashes cards; the pointer
   *  leaving the row closes it (Escape / off-screen are AnchoredPopover's). */
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [hover, setHover] = useState<{ entry: GraphEntry; anchor: HTMLElement; slot: number } | null>(null)
  const cancelHover = (): void => {
    if (hoverTimer.current !== null) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
    setHover(null)
  }
  useEffect(() => cancelHover, [])
  const request = async (append: boolean): Promise<void> => {
    if (!visible) return
    if (append && appending.current) return
    if (append) appending.current = true
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    const gen = ++generation.current
    const previous = pageRef.current
    setLoading(true)
    setError(null)
    setStale(false)
    try {
      const result = await api.gitGraph(scope, {
        branch: branch || undefined, count: 50,
        cursor: append ? previous?.nextCursor : undefined,
      }, worktree, controller.signal)
      if (controller.signal.aborted || gen !== generation.current) return
      const next = append && previous ? {
        ...result,
        entries: [...previous.entries, ...result.entries.filter(entry => !previous.entries.some(old => old.hashFull === entry.hashFull))],
      } : result
      pageRef.current = next
      setPage(next)
      setBranches(next.branches)
      const selection = selectionRef.current
      if (!append && selection?.kind === 'commit'
        && selection.worktree === worktree
        && (selection.repoRoot ?? '') === (scope.repoRoot ?? next.root ?? '')
        && !next.entries.some(entry => entry.hashFull === selection.hashFull)) {
        clearPreviewRef.current?.()
      }
    } catch (reason) {
      if (controller.signal.aborted || gen !== generation.current) return
      failedAppend.current = append
      setStale(reason instanceof SidebarApiError && reason.code === 'graph-stale')
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (!controller.signal.aborted && gen === generation.current) {
        setLoading(false)
        appending.current = false
      }
    }
  }
  useEffect(() => {
    // Clear history on real target/filter changes, never show another repo's rows.
    pageRef.current = null
    setPage(null)
    setBranch('')
    setBranches([])
  }, [scope.sessionId, scope.cwd, scope.repoRoot, worktree])
  useEffect(() => {
    if (visible) void request(false)
    return () => { generation.current += 1; active.current?.abort() }
    // Scope identity is deliberately excluded: its scalar fields are the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, scope.sessionId, scope.cwd, scope.repoRoot, worktree, branch, refreshTick, retry])

  /** Infinite scroll: the next page is requested as soon as the end sentinel
   *  scrolls into view. The button below the rows stays as the fallback path
   *  (and the only path where IntersectionObserver is unavailable). */
  const requestRef = useRef(request)
  requestRef.current = request
  useEffect(() => {
    const node = sentinelRef.current
    if (node === null || !visible || !(page?.hasMore ?? false) || stale) return
    if (typeof IntersectionObserver !== 'function') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) void requestRef.current(true)
    }, { root: scrollRef.current ?? undefined, rootMargin: '200px' })
    observer.observe(node)
    return () => { observer.disconnect() }
    // entries.length re-arms the observer after each appended page so a list
    // still shorter than the viewport keeps filling; appending guards the race.
  }, [visible, page?.hasMore, page?.entries.length, page?.nextCursor, stale])

  const rows = useMemo(() => layoutGraph(page?.entries ?? []), [page?.entries])
  const width = Math.max(28, ...rows.map(row => laneX(row.laneCount) + 2))
  const remotes = useMemo(() => remoteRefNames(branches), [branches])
  const selectedIndex = selectedRef?.kind === 'commit'
    && selectedRef.worktree === worktree
    && (selectedRef.repoRoot ?? '') === (scope.repoRoot ?? page?.root ?? '')
    ? page?.entries.findIndex(entry => entry.hashFull === selectedRef.hashFull) ?? -1 : -1
  const selected = selectedIndex >= 0 ? page?.entries[selectedIndex] : undefined
  /** The selected row's palette slot: the details card's pills wear the same
   *  lane colour as the graph row the commit sits on. */
  const selectedSlot = selectedIndex >= 0 ? colorSlot(rows[selectedIndex]!.colorIndex) : 0
  /** Report the selection upward for the changes tab's bottom pane. The
   *  callback rides a ref so a fresh parent closure cannot re-fire the effect;
   *  its deps are the selection itself. A HIDDEN lens keeps its report — the
   *  pane below is shared by all lenses and stays put when the view above
   *  switches; unmounting (tab close, scope change) is what clears it. */
  const detailsRef = useRef(onDetailsChange)
  detailsRef.current = onDetailsChange
  useEffect(() => {
    if (!visible) return
    detailsRef.current?.(selected === undefined ? null : { entry: selected, remotes, slot: selectedSlot })
  }, [visible, selected, remotes, selectedSlot])
  useEffect(() => () => { detailsRef.current?.(null) }, [])
  const select = (entry: GraphEntry): void => onPreview({
    kind: 'commit', hash: entry.hash, hashFull: entry.hashFull, subject: entry.subject,
    worktree, repoRoot: scope.repoRoot ?? page?.root,
  })
  const chooseBranch = (value: string): void => {
    onClearPreview?.()
    active.current?.abort()
    generation.current += 1
    cancelHover()
    setBranch(value)
    pageRef.current = null
    setPage(null)
  }

  return <section className={css.root} aria-label={t('gitGraph')} data-git-graph>
    <div className={css.toolbar}>
      <select className={css.select} aria-label={t('graphBranchFilter')}
        value={branch} onChange={event => { chooseBranch(event.target.value) }}>
        <option value="">{t('graphAllBranches')}</option>
        {branches.map(item => <option key={item.ref} value={item.ref}>{item.name}</option>)}
        {branch && !branches.some(item => item.ref === branch) && <option value={branch}>{branch}</option>}
      </select>
    </div>
    <div className={css.scroll} aria-busy={loading} ref={scrollRef}>
      {error !== null && <div className={css.notice} role="alert">
        <Notice kind="warn">{stale ? t('graphStale') : t('graphLoadError')}{!stale && `: ${error}`}</Notice>
        <Button onClick={() => { if (stale || !failedAppend.current) setRetry(value => value + 1); else void request(true) }}>{t('retry')}</Button>
      </div>}
      {loading && <div className={css.notice} role="status">{t('loading')}</div>}
      {!loading && !error && page !== null && page.entries.length === 0 && <div className={css.notice}>{t(page.isRepo ? 'graphEmpty' : 'notRepo')}</div>}
      {page?.entries.map((entry, index) => {
        const row = rows[index]!
        const slot = colorSlot(row.colorIndex)
        return <button key={entry.hashFull} type="button" className={css.row}
          data-graph-commit={entry.hashFull} aria-pressed={selected?.hashFull === entry.hashFull}
          onMouseEnter={(event) => {
            const anchor = event.currentTarget
            if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
            hoverTimer.current = setTimeout(() => { hoverTimer.current = null; setHover({ entry, anchor, slot }) }, 350)
          }}
          onMouseLeave={cancelHover}
          onClick={() => { cancelHover(); select(entry) }}
          onContextMenu={onContextMenu === undefined ? undefined : (event) => { onContextMenu(event, entry) }}>
          <svg width={width} height={ROW_HEIGHT} viewBox={`0 0 ${width} ${ROW_HEIGHT}`} preserveAspectRatio="none" className={css.graph} aria-hidden="true">
            {row.segments.map((edge, i) => <path key={i} data-color={colorSlot(edge.colorIndex)}
              d={edgePath(edge, laneX, ROW_HEIGHT)} />)}
            <circle cx={laneX(row.lane)} cy={ROW_HEIGHT / 2} r={3} data-color={slot} />
          </svg>
          {entry.refs.length > 0 && <span className={css.refs}>
            {refPills(entry.refs, remotes).map(pill => <RefPill key={pill.name} pill={pill} slot={slot} />)}
          </span>}
          <span className={css.subject}>{entry.subject}</span>
        </button>
      })}
      {page?.hasMore && !stale && <div className={css.notice} ref={sentinelRef} data-graph-sentinel>
        <Button disabled={loading} onClick={() => { void request(true) }}>{t('graphLoadMore')}</Button>
      </div>}
    </div>
    {/* The middle information rung: more than the one-line row (author, both
     *  times, short hash), less than the details card (full hash, parents,
     *  the message). Replaces the native tooltip entirely. */}
    <AnchoredPopover anchor={hover?.anchor ?? null} onClose={cancelHover} width={280}>
      {hover !== null && <div className={css.card}>
        <div className={css.hoverSubject}>{hover.entry.subject}</div>
        {hover.entry.refs.length > 0 && <div className={css.detailRefs}>
          {refPills(hover.entry.refs, remotes).map(pill => <RefPill key={pill.name} pill={pill} slot={hover.slot} />)}
        </div>}
        <div className={css.hoverMeta}>{hover.entry.author} · {relativeTime(hover.entry.date)}</div>
        <div className={css.hoverMeta}><code className={css.hashChip}>{hover.entry.hash}</code> {hover.entry.date}</div>
      </div>}
    </AnchoredPopover>
  </section>
}