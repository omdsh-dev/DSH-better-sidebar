/** Session-header utility for opening the session cwd in a host IDE. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconCodeOutline16,
  IconLoadingOutline16,
  Menu,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { IdeId, InstalledIde } from '../ide-catalog.ts'
import type { SidebarSessionList } from '../context-types.ts'
import type { SessionScope } from './api.ts'
import { IdeIcon } from './IdeIcon.tsx'
import css from './IdeLauncherAction.module.css'

type Translate = (key: string, params?: Record<string, string | number>) => string

export interface IdeLauncherActionProps {
  sessionId: string
  useSessions<T>(selector: (state: SidebarSessionList) => T): T
  t: Translate
  listIdes(): Promise<InstalledIde[]>
  openIde(scope: SessionScope, id: IdeId): Promise<void>
}

/**
 * DSH-native split capsule ordered immediately before Session Log:
 * the primary icon opens the first detected IDE, while the chevron alone
 * owns the full chooser menu.
 */
export function IdeLauncherAction({
  sessionId,
  useSessions,
  t,
  listIdes,
  openIde,
}: IdeLauncherActionProps): ReactNode {
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const [open, setOpen] = useState(false)
  const [ides, setIdes] = useState<InstalledIde[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [openingId, setOpeningId] = useState<IdeId | null>(null)
  const [error, setError] = useState<string | null>(null)

  const detect = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setIdes(await listIdes())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [listIdes])

  // The primary affordance must show the first installed IDE before the user
  // interacts, so detection starts when this Session header entry mounts.
  useEffect(() => { void detect() }, [detect])

  const firstIde = ides?.[0]

  const launch = useCallback((ide: InstalledIde) => {
    setOpeningId(ide.id)
    setError(null)
    const scope: SessionScope = { sessionId, ...(cwd ? { cwd } : {}) }
    void openIde(scope, ide.id).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      setOpen(true)
    }).finally(() => { setOpeningId(null) })
  }, [cwd, openIde, sessionId])

  const entries = useMemo<MenuEntry[]>(() => {
    const items: MenuEntry[] = [{ type: 'label', id: 'installed', text: t('ideInstalled') }]
    if (ides !== null) {
      for (const ide of ides) {
        items.push({
          id: ide.id,
          label: ide.name,
          icon: <IdeIcon id={ide.id} />,
          disabled: openingId !== null,
        })
      }
    }
    if (loading && ides === null) {
      items.push({ id: 'detecting', label: t('ideDetecting'), icon: <IconLoadingOutline16 className={css.spinner} />, disabled: true })
    } else if (!loading && error === null && ides?.length === 0) {
      items.push({ id: 'empty', label: t('ideNone'), disabled: true })
    }
    return items
  }, [error, ides, loading, openingId, t])

  const footer = useMemo<MenuEntry[]>(() => (
    error === null ? [] : [{ id: 'error', label: t('ideError', { message: error }), disabled: true }]
  ), [error, t])

  const select = useCallback((raw: string) => {
    const ide = ides?.find(candidate => candidate.id === raw)
    if (ide === undefined) return
    setOpen(false)
    launch(ide)
  }, [ides, launch])

  const toggleMenu = useCallback(() => {
    setOpen(value => {
      const next = !value
      if (next && !loading) void detect()
      return next
    })
  }, [detect, loading])

  const busy = openingId !== null
  const primaryLabel = firstIde === undefined
    ? t('ideOpen')
    : t('ideOpenWith', { name: firstIde.name })

  return (
    <span className={css.splitTrigger}>
      <button
        type="button"
        className={css.primaryButton}
        aria-label={primaryLabel}
        title={primaryLabel}
        disabled={firstIde === undefined || busy}
        aria-busy={busy || loading}
        onClick={() => { if (firstIde !== undefined) launch(firstIde) }}
      >
        {busy || (loading && firstIde === undefined)
          ? <IconLoadingOutline16 size={16} className={css.spinner} />
          : firstIde === undefined
            ? <IconCodeOutline16 size={16} />
            : <IdeIcon id={firstIde.id} />}
      </button>
      <Menu
        open={open}
        className={css.menuSeat}
        anchor={(
          <button
            type="button"
            className={css.menuButton}
            aria-label={t('ideChoose')}
            title={t('ideChoose')}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggleMenu}
          >
            <span className={css.menuGlyph} aria-hidden="true">
              <IconChevronUpOutline14 size={9} />
              <IconChevronDownOutline14 size={9} />
            </span>
          </button>
        )}
        items={entries}
        footer={footer}
        selectedId={firstIde?.id}
        onSelect={select}
        onClose={() => { setOpen(false) }}
        align="end"
        side="bottom"
        portal
        dense
      />
    </span>
  )
}
