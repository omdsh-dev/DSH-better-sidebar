/**
 * Memory models: extractor / hippocampus subagent model pickers fed by the
 * DSH configured providers (hpptools-memory models route).
 */
import { useEffect, useState } from 'react'
import { memoryApi, type MemoryModelProvider } from './api.ts'
import { t } from '../locales.ts'
import css from '../sidebar.module.css'

export function Models() {
  const [providers, setProviders] = useState<MemoryModelProvider[]>([])
  const [configured, setConfigured] = useState<{ extractor: string; cleaner: string }>({ extractor: '(default)', cleaner: '(default)' })
  const [extractor, setExtractor] = useState('(default)')
  const [cleaner, setCleaner] = useState('(default)')
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    memoryApi.models().then((d) => {
      if (cancelled) return
      setProviders(d.providers)
      setConfigured(d.configured)
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
        out.push(<option key={v} value={v}>{m.name || m.id}（{p.name}）</option>)
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
      setConfigured({ extractor: r1.value, cleaner: r2.value })
      setResult(t('memModelsSaved', { a: r1.value, b: r2.value }))
    }).catch((e: unknown) => {
      setResult(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }).finally(() => setBusy(false))
  }

  return (
    <div className={css.memScroll}>
      <div className={css.memGroup}>
        <h2 className={css.memGroupHead}>{t('memSubagentModels')}</h2>
        <div className={css.memSetRow}>
          <label className={css.memLabel}>{t('memExtractorModel')}</label>
          <select className={css.memSelect} value={extractor} onChange={(e) => setExtractor(e.target.value)}>
            {options()}
          </select>
        </div>
        <div className={css.memSetRow}>
          <label className={css.memLabel}>{t('memCleanerModel')}</label>
          <select className={css.memSelect} value={cleaner} onChange={(e) => setCleaner(e.target.value)}>
            {options()}
          </select>
        </div>
        <div className={css.memSetRow}>
          <button type="button" className={css.memBtnPrimary} disabled={busy} onClick={save}>
            {t('memSaveModels')}
          </button>
          <span className={css.memHint}>{result}</span>
        </div>
        <div className={css.memHint}>{t('memModelSourceHint')}</div>
      </div>
    </div>
  )
}
