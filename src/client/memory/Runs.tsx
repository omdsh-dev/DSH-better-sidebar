/**
 * Memory runs: recent subagent run table with live activity log and the
 * one-click hippocampus cleanup trigger. Polls every 3s while visible.
 */
import { useEffect, useState } from 'react'
import { memoryApi, formatDur, formatTime, type MemoryRun } from './api.ts'
import { isZh, t } from '../locales.ts'
import css from '../sidebar.module.css'

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
    <div className={css.memScroll}>
      <div className={css.memRow}>
        <span className={css.memHint}>{hint}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className={css.memBtn} disabled={busy} onClick={runClean}>
          🧹 {t('memRunClean')}
        </button>
      </div>
      <table className={css.memTable}>
        <thead>
          <tr>
            <th>{t('memColStarted')}</th><th>{t('memColKind')}</th>
            <th>{t('memColStatus')}</th><th>{t('memColDur')}</th><th>{t('memColReason')}</th>
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 && (
            <tr><td colSpan={5} className={css.memEmptyRow}>{t('memNoRuns')}</td></tr>
          )}
          {runs.map((r) => {
            const badge = r.status === 'running'
              ? <span className={css.memBadgeRun}><span className={css.memDot} />{t('memBadgeRunning')}</span>
              : r.status === 'done'
                ? <span className={css.memBadgeOk}>✅ {t('memBadgeDone')}</span>
                : <span className={css.memBadgeErr}>❌ {r.status || t('memBadgeFailed')}</span>
            return (
              <tr
                key={r.id}
                className={css.memRunRow + (r.id === selected ? ' ' + css.memRunRowActive : '')}
                onClick={() => openLog(r)}
              >
                <td>{formatTime(r.startedAt, zh)}</td>
                <td>{r.kind}</td>
                <td>{badge}</td>
                <td>{formatDur(r.startedAt, r.endedAt)}</td>
                <td>{r.stopReason ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {log !== null && (
        <pre className={css.memLog}>{log.join('\n')}</pre>
      )}
    </div>
  )
}
