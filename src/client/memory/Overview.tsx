/**
 * Memory overview: header + stat cards (subagent-row recipe: icon chip +
 * value + label) for current project / all projects / global / last cleanup /
 * active runs / model config, plus the Pi-migration banner. Polls every 5s
 * while visible.
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  IconAgentPresetOutline16, IconDataOutline16, IconFolderOpenOutline16,
  IconRefreshOutline16, IconSparkle16, IconThinkOutline16,
  Button, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { IconGlobeOutline16 } from '../icons.tsx'
import { memoryApi, formatTime, type MemoryOverview } from './api.ts'
import { isZh, t } from '../locales.ts'
import type { SessionScope } from '../service.ts'
import shellCss from '../sidebar.module.css'
import css from '../memory.module.css'

function Card(props: { icon: ReactNode; value: ReactNode; label: string; hot?: boolean }) {
  const { icon, value, label, hot } = props
  return (
    <div className={css.memCard + (hot === true ? ' ' + css.memCardHot : '')}>
      <span className={css.memCardIcon}>{icon}</span>
      <span className={css.memCardContent}>
        <span className={css.memCardValue}>{value}</span>
        <span className={css.memCardLabel}>{label}</span>
      </span>
    </div>
  )
}

function filesLabel(n: number): string { return `${n} ${t('memUnitFiles')}` }
function entriesLabel(n: number): string { return `${n} ${t('memUnitEntries')}` }
function skillLabel(n: number): string { return `+ ${n} ${t('memUnitSkills')}` }

export function Overview(props: { visible: boolean; scope?: SessionScope }) {
  const { visible, scope } = props
  const sessionId = scope?.sessionId
  const [data, setData] = useState<MemoryOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [migrating, setMigrating] = useState(false)

  const load = (): void => {
    memoryApi.overview(sessionId).then((d) => { setData(d); setError(null) }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
    })
  }

  useEffect(() => {
    load()
    if (!visible) return
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionId])

  if (error !== null && data === null) {
    return <div className={css.memError}>{t('memOverviewFailed')}: {error}</div>
  }
  if (data === null) {
    return (
      <div className={css.memRoot}>
        <div className={css.memHeader}>
          <span className={css.memTitle}>{t('memNavOverview')}</span>
        </div>
        <div className={css.memEmpty}>{t('memLoading')}</div>
      </div>
    )
  }

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

  return (
    <div className={css.memRoot}>
      <div className={css.memHeader}>
        <span className={css.memTitle}>{t('memNavOverview')}</span>
        {d.projects.length > 0 && <span className={css.memCount}>{d.projects.length} · {d.activeRuns} {t('memRunning')}</span>}
        <button type="button" className={css.memIconBtn} title={t('memRefresh')} onClick={load}>
          <IconRefreshOutline16 />
        </button>
      </div>

      {d.legacy && (
        <div className={css.memBanner}>
          <StateDot state="warning" size={10} className={css.memDot} />
          <span className={css.memBannerText}>{t('memMigDetected', { n: d.legacy })}</span>
          <Button
            variant="primary"
            size="sm"
            disabled={migrating}
            onClick={() => {
              setMigrating(true)
              memoryApi.migrate().then(() => { load() }).catch((e: unknown) => {
                setError(e instanceof Error ? e.message : String(e))
              }).finally(() => setMigrating(false))
            }}
            title={t('memMigrateNow')}
          >
            {t('memMigrateNow')}
          </Button>
        </div>
      )}
      {d.migrated && (
        <div className={css.memBanner + ' ' + css.memBannerMuted}>
          <span className={css.memBannerText}>
            {t('memMigrated', { from: d.migrated.from, n: d.migrated.copiedItems, at: formatTime(d.migrated.at, isZh()) })}
          </span>
        </div>
      )}

      <div className={css.memBody}>
        <Card icon={<IconDataOutline16 />} value={cm} label={`${t('memCardCurProject')}${cur ? ` · ${cur.name}` : ''}`} />
        <Card icon={<IconFolderOpenOutline16 />} value={pm} label={t('memCardAllProjects')} />
        <Card icon={<IconGlobeOutline16 />} value={gm} label={t('memCardGlobal')} />
        <Card icon={<IconSparkle16 />} value={lm} label={t('memCardMaintenance')} />
        <Card
          icon={<IconThinkOutline16 />}
          value={d.activeRuns > 0
            ? <><StateDot state="ongoing" size={8} className={css.memDot} /> {d.activeRuns} {t('memUnitCount')} {t('memRunning')}</>
            : `0 ${t('memUnitCount')}`}
          label={t('memCardActiveRuns')}
          hot={d.activeRuns > 0}
        />
        <Card icon={<IconAgentPresetOutline16 />} value={d.configured.extractor} label={t('memCardExtractor')} />
        <Card icon={<IconAgentPresetOutline16 />} value={d.configured.cleaner} label={t('memCardCleaner')} />
        <div className={css.memHint} style={{ padding: '6px 12px' }}>{d.root}</div>
      </div>
    </div>
  )
}
