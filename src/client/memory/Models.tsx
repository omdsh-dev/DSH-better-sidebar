/**
 * Memory models: extractor / hippocampus subagent model pickers fed by the
 * DSH configured providers (hpptools-memory models route). Rows follow the
 * DSH settings-row recipe (label + control + hint).
 */
import { useEffect, useState } from 'react'
import { IconCheckOutline16, IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { memoryApi, type MemoryModelProvider } from './api.ts'
import { t } from '../locales.ts'
import shellCss from '../sidebar.module.css'
import css from '../memory.module.css'

export function Models() {
  const [providers, setProviders] = useState<MemoryModelProvider[]>([])
  const [extractor, setExtractor] = useState('(default)')
  const [cleaner, setCleaner] = useState('(default)')
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    memoryApi.models().then((d) => {
      if (cancelled) return
      setProviders(d.providers)
      setExtractor(d.configured.extractor)
      setCleaner(d.configured.cleaner)
      setResult(t('memModelsLoaded', { n: d.providers.length }))
    }).catch((e: unknown) => {
      if (!cancelled) setResult(`❌ ${e instanceof Error ? e.message : String(e)}`)
    })
    return () => { cancelled = true }
  }, [])

  const options = (): React.ReactNode[] => {
    const out: React.ReactNode[] = [<option key="(default)" value="(default)">(default)</option>]
    for (const p of providers) {
      for (const m of p.models) {
        const v = `${p.id}/${m.id}`
        out.push(<option key={v} value={v}>{m.name || m.id} · {p.name}</option>)
      }
    }
    return out
  }

  const save = (): void => {
    setBusy(true)
    Promise.all([
      memoryApi.setModel('extractor', extractor),
      memoryApi.setModel('cleaner', cleaner),
    ]).then(([r1, r2]) => {
      setResult(t('memModelsSaved', { a: r1.value, b: r2.value }))
    }).catch((e: unknown) => {
      setResult(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }).finally(() => setBusy(false))
  }

  return (
    <div className={css.memRoot}>
      <div className={css.memHeader}>
        <span className={css.memTitle}>{t('memSubagentModels')}</span>
        <span className={css.memCount}><IconSparkle16 /></span>
      </div>
      <div className={css.memBody}>
        <div className={css.memGroup}>
          <div className={css.memRow}>
            <span className={css.memLabel}>{t('memExtractorModel')}</span>
            <select className={css.memSelect} value={extractor} onChange={(e) => setExtractor(e.target.value)}>
              {options()}
            </select>
          </div>
          <div className={css.memRow}>
            <span className={css.memLabel}>{t('memCleanerModel')}</span>
            <select className={css.memSelect} value={cleaner} onChange={(e) => setCleaner(e.target.value)}>
              {options()}
            </select>
          </div>
          <div className={css.memRow}>
            <button type="button" className={shellCss.iconButton} disabled={busy} onClick={save} title={t('memSaveModels')}><IconCheckOutline16 /></button>
            <span className={css.memHint}>{result}</span>
          </div>
          <div className={css.memRow}>
            <span className={css.memHint}>{t('memModelSourceHint')}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
