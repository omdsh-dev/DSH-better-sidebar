/**
 * Memory overview: a Side-card-style grid of memory stats (current project /
 * all projects / global / last cleanup / active runs / model config) plus the
 * Pi-migration banner. Polls every 5s while visible.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { memoryApi, formatTime, type MemoryOverview } from './api.ts'
import { isZh, t } from '../locales.ts'
import css from '../sidebar.module.css'

function Card(props: { icon: string; label: string; value: ReactNode; sub?: string; hot?: boolean }) {
  const { icon, label, value, sub, hot } = props
  return (
    <div className={css.memCard + (hot === true ? ' ' + css.memCardHot : '')}>
      <div className={css.memCardK}><span className={css.memCardIcon}>{icon}</span><span>{label}</span></div>
      <div className={css.memCardV}>{value}</div>
      {sub !== undefined && <div className={css.memCardS}>{sub}</div>}
    </div>
  )
}

function filesLabel(n: number): string { return `${n} ${t('memUnitFiles')}` }
function entriesLabel(n: number): string { return `${n} ${t('memUnitEntries')}` }
function skillLabel(n: number): string { return `+ ${n} ${t('memUnitSkills')}` }

export function Overview(props: { visible: boolean }) {
  const { visible } = props
  const [data, setData] = useState<MemoryOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [migrating, setMigrating] = useState(false)

  const load = (): void => {
    memoryApi.overview().then((d) => { setData(d); setError(null) }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
    })
  }

  useEffect(() => {
    load()
    if (!visible) return
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  if (error !== null && data === null) {
    return <div className={css.memError}>{t('memOverviewFailed')}: {error}</div>
  }
  if (data === null) return <div className={css.memHint}>{t('memLoading')}</div>

  const d = data
  const ps = d.projectSummary
  const pm = ps && ps.count > 0
    ? `${ps.count} ${t('memUnitProjects')} / ${filesLabel(ps.files)} / ${entriesLabel(ps.entries)}${ps.skillFiles ? ' ' + skillLabel(ps.skillFiles) : ''}`
    : t('memNoProject')
  const cur = d.projects.find((p) => p.current)
  const cm = cur
    ? `${filesLabel(cur.files)} / ${entriesLabel(cur.entries)}${cur.skillFiles ? ' ' + skillLabel(cur.skillFiles) : ''}`
    : t('memNoSession')
  const gm = `${filesLabel(d.globalMem.files)} / ${entriesLabel(d.globalMem.entries)}${d.globalMem.skillFiles ? ' ' + skillLabel(d.globalMem.skillFiles) : ''}`
  const lm = d.lastMaintenance
    ? formatTime(d.lastMaintenance.lastRun, isZh()) + (d.lastMaintenance.project ? `（${d.lastMaintenance.project}）` : '')
    : t('memNeverCleaned')

  const runValue = d.activeRuns > 0
    ? <span className={css.memBadgeRun}><span className={css.memDot} />{d.activeRuns} {t('memUnitCount')} {t('memRunning')}</span>
    : `0 ${t('memUnitCount')}`

  return (
    <div className={css.memScroll}>
      {d.legacy && (
        <div className={css.memBanner}>
          <span className={css.memBannerText}>
            {t('memMigDetected', { n: d.legacy })}
          </span>
          <button
            type="button"
            className={css.memBtnPrimary}
            disabled={migrating}
            onClick={() => {
              setMigrating(true)
              memoryApi.migrate().then(() => { load() }).catch((e: unknown) => {
                setError(e instanceof Error ? e.message : String(e))
              }).finally(() => setMigrating(false))
            }}
          >
            {t('memMigrateNow')}
          </button>
        </div>
      )}
      {d.migrated && (
        <div className={css.memBannerMuted}>
          {t('memMigrated', { from: d.migrated.from, n: d.migrated.copiedItems, at: formatTime(d.migrated.at, isZh()) })}
        </div>
      )}
      <div className={css.memCards}>
        <Card
          icon="📁" label={t('memCardCurProject')} value={cm}
          sub={cur ? `${cur.name} → ${t('memCardCurSub')}` : t('memCardCurSub')}
        />
        <Card icon="🗂️" label={t('memCardAllProjects')} value={pm} sub={t('memCardAllSub')} />
        <Card icon="🌐" label={t('memCardGlobal')} value={gm} sub={t('memCardPersonalDir')} />
        <Card icon="🧹" label={t('memCardMaintenance')} value={lm} sub={t('memCardMaintenanceDir')} />
        <Card icon="🔄" label={t('memCardActiveRuns')} value={runValue} hot={d.activeRuns > 0} />
        <Card icon="🧠" label={t('memCardExtractor')} value={d.configured.extractor} sub={t('memCardExtractorSub')} />
        <Card icon="🐙" label={t('memCardCleaner')} value={d.configured.cleaner} sub={t('memCardCleanerSub')} />
      </div>
      <div className={css.memHint} style={{ marginTop: 10 }}>{d.root}</div>
    </div>
  )
}
