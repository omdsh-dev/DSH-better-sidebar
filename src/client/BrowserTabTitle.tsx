/** Persisted site identity and the native tab's site switch control. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { IconChevronDownOutlineRegular, IconGlobeOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { VscEdit, VscHistory, VscOrganization, VscSettingsGear } from 'react-icons/vsc'
import { SiJoomla, SiWordpress } from 'react-icons/si'
import type { NativeTabParams } from './native/tab-adapter.tsx'
import type { SidebarTab } from './state.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'
import { siteDeepLink } from './browser-mode.ts'
import { lastVisit, VISIT_PREFIX, VISITS_CHANGED, workspaceSiteKey } from './site-visits.ts'

interface Site {
  siteKey: string
  platform?: string | null
  copyUrl?: string | null
  agent?: string | null
}

/** A fresh workspace URL deliberately carries no session from the previous site. */
function workspaceUrl(site: Site, kind: string): string {
  if (kind === 'tracy:browser' && site.copyUrl) {
    const link = siteDeepLink(window.location.origin, site.siteKey, site.copyUrl, 'interactive')
    if (link !== null) return link
  }
  return `/${encodeURIComponent(site.siteKey)}/?${new URLSearchParams({ tab: kind, site: site.siteKey })}`
}

/** Read a favicon only from a site on the viewer's accepted site list. */
function SiteIcon({ site, readIcon }: { site: Site | undefined; readIcon: (siteKey: string) => Promise<string | undefined> }) {
  const [icon, setIcon] = useState<string>()
  useEffect(() => {
    setIcon(undefined)
    if (!site?.siteKey) return
    let active = true
    void readIcon(site.siteKey).then(icon => { if (active) setIcon(icon) })
    return () => { active = false }
  }, [site?.siteKey, readIcon])
  return <span className={css.browserSiteIcon} data-site-icon={site?.platform ?? 'unknown'} aria-hidden="true">
    {icon !== undefined ? <img src={icon} alt="" referrerPolicy="no-referrer" onError={() => { setIcon(undefined) }} />
      : site?.platform === 'wordpress' ? <SiWordpress size={14} />
      : site?.platform === 'joomla' ? <SiJoomla size={14} />
      : site?.platform === 'emdash' ? <svg width="14" height="14" viewBox="0 0 16 16"><path d="M2 8h12" stroke="currentColor" strokeWidth="2" /></svg>
      : <IconGlobeOutlineRegular size={14} />}
  </span>
}

/** The stored identity wins even before the Browser body has mounted. */
export function BrowserTabTitle({ tab, params, title, active, isActiveDestination, rememberSite, openLocal, openOtherSite = url => { window.open(url, '_blank', 'noopener,noreferrer') } }: {
  tab: SidebarTab | undefined
  params: NativeTabParams | undefined
  title: string
  active?: boolean
  isActiveDestination?: (kind: string, siteKey: string) => boolean
  rememberSite?: (siteKey: string) => void
  openLocal?: (kind: string, siteKey: string) => void
  openOtherSite?: (url: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [sites, setSites] = useState<Site[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  // Cache only within this title's lifetime: tab and menu share one homepage
  // read, and neither a disposed tab nor a different account inherits it.
  const icons = useRef(new Map<string, { controller: AbortController; result: Promise<string | undefined> }>())
  const readIcon = useCallback((siteKey: string): Promise<string | undefined> => {
    const cached = icons.current.get(siteKey)
    if (cached !== undefined) return cached.result
    const controller = new AbortController()
    const result = fetch(`/api/sites/${encodeURIComponent(siteKey)}/favicon`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) return undefined
      const body = await response.json() as { url?: unknown }
      if (controller.signal.aborted) return undefined
      return typeof body.url === 'string' && /^https?:\/\//.test(body.url) ? body.url : undefined
    }).catch(() => undefined)
    icons.current.set(siteKey, { controller, result })
    return result
  }, [])
  useEffect(() => () => {
    for (const read of icons.current.values()) read.controller.abort()
    icons.current.clear()
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    fetch('/api/sites', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('sites unavailable')
        return await response.json() as { sites?: Array<Site & { status?: string }> }
      })
      .then(body => {
        if (controller.signal.aborted) return
        setSites((Array.isArray(body.sites) ? body.sites : []).filter(site =>
          typeof site?.siteKey === 'string' && site.status === 'accepted'))
        setStatus('ready')
      })
      .catch(() => { if (!controller.signal.aborted) { setSites([]); setStatus('error') } })
    return () => { controller.abort() }
  }, [attempt])
  const meta = (tab?.meta ?? params?.meta) as { siteKey?: unknown; url?: unknown } | undefined
  let siteKey = typeof meta?.siteKey === 'string' ? meta.siteKey : undefined
  const address = typeof meta?.url === 'string' ? meta.url : params?.url ?? tab?.path
  if (siteKey === undefined && address !== undefined) {
    try {
      const current = new URL(address)
      const match = sites.filter(site => {
        if (!site.copyUrl) return false
        try {
          const base = new URL(site.copyUrl)
          const prefix = base.pathname.replace(/\/$/, '')
          return current.origin === base.origin && (current.pathname === prefix || current.pathname.startsWith(`${prefix}/`))
        } catch { return false }
      }).sort((a, b) => (b.copyUrl?.length ?? 0) - (a.copyUrl?.length ?? 0))[0]
      siteKey = match?.siteKey
    } catch { /* Keep the last persisted label until identity is known. */ }
  }
  useEffect(() => {
    if (siteKey !== undefined) rememberSite?.(siteKey)
  }, [siteKey, meta?.siteKey, rememberSite])
  const currentSite = workspaceSiteKey() ?? siteKey
  const [, refreshVisits] = useState(0)
  useEffect(() => {
    const refresh = () => { refreshVisits(value => value + 1) }
    const readOtherTab = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(VISIT_PREFIX)) refresh()
    }
    window.addEventListener(VISITS_CHANGED, refresh)
    window.addEventListener('storage', readOtherTab)
    return () => {
      window.removeEventListener(VISITS_CHANGED, refresh)
      window.removeEventListener('storage', readOtherTab)
    }
  }, [])
  const orderedSites = sites.map(site => ({ site, visited: lastVisit(site.siteKey) }))
    .sort((a, b) => Number(b.site.siteKey === currentSite) - Number(a.site.siteKey === currentSite)
      || b.visited - a.visited)
    .map(({ site }) => site)
  return <>
    {/* Portaled menu presses still bubble through the tab chip's React tree. Stop the chip's drag
        handler on pointerdown so the row receives its click and can switch workspaces. */}
    <span className={css.browserSiteMenuHost} onPointerDown={event => { event.stopPropagation() }}>
    <Menu open={open} portal compact autoFocus collisionAvoidance listClassName={css.browserSiteMenu} onClose={() => { setOpen(false) }}
      selectedId={siteKey}
      items={status === 'loading' ? [{ id: 'loading', label: t('browserSitesLoading'), disabled: true }]
        : status === 'error' ? [{ id: 'retry', label: t('browserSitesRetry') }]
        : sites.length === 0 ? [{ id: 'empty', label: t('browserSitesEmpty'), disabled: true }]
        : orderedSites.map(site => ({ id: site.siteKey, label: site.siteKey, selectable: true, icon: <SiteIcon site={site} readIcon={readIcon} />,
          disabled: !site.agent,
          submenu: [
            { id: `live:${site.siteKey}`, label: t('browserLiveEdit'), icon: <VscEdit />, disabled: !site.agent },
            { id: `settings:${site.siteKey}`, label: t('browserSiteSettings'), icon: <VscSettingsGear />, disabled: !site.agent },
            { id: `team:${site.siteKey}`, label: t('browserSiteTeam'), icon: <VscOrganization />, disabled: !site.agent },
            { id: `history:${site.siteKey}`, label: t('browserSiteHistory'), icon: <VscHistory />, disabled: !site.agent },
          ] }))}
      onSelect={id => {
        if (id === 'retry') { setAttempt(value => value + 1); return }
        const destination = ['live', 'team', 'settings', 'history'].find(prefix => id.startsWith(`${prefix}:`))
        const key = destination ? id.slice(destination.length + 1) : id
        const site = sites.find(candidate => candidate.siteKey === key)
        if (site === undefined || !site.agent) return
        setOpen(false)
        const kind = destination === 'settings' ? 'tracy:site-settings'
          : destination === 'history' ? 'tracy:history'
          : destination === 'team' ? 'tracy:team' : 'tracy:browser'
        if (key !== workspaceSiteKey()) {
          openOtherSite(workspaceUrl(site, kind))
          return
        }
        // Selecting the page already in sight should only dismiss the menu. A different page
        // on this site belongs to the current session and opens in the native sidebar.
        const query = new URLSearchParams(window.location.search)
        if (isActiveDestination !== undefined ? isActiveDestination(kind, key)
          : kind === 'tracy:browser' ? active
            : query.get('tab') === kind && (query.get('site') === null || query.get('site') === key)) return
        openLocal?.(kind, key)
      }}
      anchor={<button type="button" className={css.browserSiteTrigger}
        aria-label={t('browserSites')} aria-haspopup="menu" aria-expanded={open}
        onPointerDown={event => { event.stopPropagation() }}
        onClick={event => {
          event.stopPropagation()
          if (!open) { setStatus('loading'); setAttempt(value => value + 1) }
          setOpen(value => !value)
        }}
      ><IconChevronDownOutlineRegular size={14} /></button>} />
    </span>
    <SiteIcon site={sites.find(site => site.siteKey === siteKey)} readIcon={readIcon} />{siteKey ?? title}
  </>
}
