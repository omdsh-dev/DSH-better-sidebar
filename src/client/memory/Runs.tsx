/**
 * Memory runs: recent subagent run rows (StateDot + kind + time + status
 * badge, subagent-row recipe) with an expandable activity log and the
 * one-click hippocampus cleanup trigger. Polls every 3s while visible.
 */
import { useEffect, useState } from 'react'
import {
  IconRefreshOutline16, IconSparkle16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { memoryApi, formatDur, formatTime, type MemoryRun } from './api.ts'
import { isZh, t } from '../locales.ts'
import css from '../memory.module.css'

function badgeOf(status: string): React.ReactNode {
  if (status === 'running') {
    return <span className={css.memBadge + ' ' + css.memBadgeRunning}>{t('memBadgeRunning')}</span>
  }
  if (status === 'done') {
    return <span className={css.memBadge + ' ' + css.memBadgeOk}>{t('memBadgeDone')}</span>
  }
  return <span className={css.memBadge + ' ' + css.memBadgeErr}>{status || t('memBadgeFailed')}</span>
}

function dotOf(status: string): React.ComponentProps<typeof StateDot>['state'] {
  if (status === 'running') return 'ongoing'
  if (status === 'done') return 'done'
  return 'error'
}

export function Runs(props: { visible: boolean }) {
  const { visible } = props
  const [runs, setRuns] = useState<MemoryRun[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [log, setLog] = useState<string[] | null>(null)
  const [hint, setHint] = useState<string>(t('memLoading'))
  const [busy, setBusy] = useState(false)

  const load = (): void => {
    memoryApi.runs().then((d) => {
      setRuns(d.runs)
      const active = d.runs.filter((r) => r.status === 'running').length
      setHint(t('memRunsHint', { total: d.runs.length, active }))
    }).catch((e: unknown) => {
      setHint(`⚠️ ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  useEffect(() => {
    load()
    if (!visible) return
    const timer = setInterval(load, 3000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const openLog = (run: MemoryRun): void => {
    setSelected(run.id)
    setLog(run.log && run.log.length > 0 ? run.log : null)
  }

  const runClean = (): void => {
    setBusy(true)
    memoryApi.clean().then((r) => {
      setHint(t('memCleanStarted', { id: r.runId }))
      load()
    }).catch((e: unknown) => {
      setHint(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }).finally(() => setBusy(false))
  }

  const zh = isZh()

  return (
    <div className={css.memRoot}>
      <div className={css.memHeader}>
        <span className={css.memTitle}>{t('memNavRuns')}</span>
        <span className={css.memCount}>{runs.length} · {runs.filter((r) => r.status === 'running').length} {t('memRunning')}</span>
        <button type="button" className={css.memIconBtn} title={t('memRefresh')} onClick={load}>
          <IconRefreshOutline16 />
        </button>
        <button type="button" className={css.memTextBtn} disabled={busy} onClick={runClean}>
          <IconSparkle16 /> {t('memRunClean')}
        </button>
      </div>
      <div className={css.memBody}>
        {runs.length === 0 && <div className={css.memEmpty}>{t('memNoRuns')}</div>}
        {runs.map((r) => (
          <div
            key={r.id}
            role="button"
            tabIndex={0}
            className={css.memRunRow + (r.id === selected ? ' ' + css.memRunRowActive : '')}
            onClick={() => openLog(r)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openLog(r) }}
          >
            <StateDot state={dotOf(r.status)} className={css.memDot} />
            <span className={css.memRunContent}>
              <span className={css.memRunKind}>{r.kind}</span>
              <span className={css.memRunSecondary}>
                {formatTime(r.startedAt, zh)} · {formatDur(r.startedAt, r.endedAt)}{r.stopReason ? ` · ${r.stopReason}` : ''}
              </span>
            </span>
            {badgeOf(r.status)}
          </div>
        ))}
        <div className={css.memHint} style={{ padding: '4px 12px' }}>{hint}</div>
        {log !== null && <pre className={css.memLog}>{log.join('\n')}</pre>}
      </div>
    </div>
  )
}
