/**
 * Memory settings: storage root (restart-required), Pi migration status, and
 * opening the store folder in the system file manager.
 */
import { useEffect, useState } from 'react'
import { memoryApi, formatTime, type MemoryOverview } from './api.ts'
import { isZh, t } from '../locales.ts'
import css from '../sidebar.module.css'

export function Settings() {
  const [root, setRoot] = useState<string | null>(null)
  const [legacy, setLegacy] = useState<string | null>(null)
  const [migrated, setMigrated] = useState<{ from: string; copiedItems: number; at: string } | null>(null)
  const [newRoot, setNewRoot] = useState('')
  const [copyData, setCopyData] = useState(true)
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = (): void => {
    memoryApi.overview().then((d: MemoryOverview) => {
      setRoot(d.root)
      setLegacy(d.legacy)
      setMigrated(d.migrated)
    }).catch((e: unknown) => {
      setResult(`❌ ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  useEffect(() => { load() }, [])

  const saveRoot = (): void => {
    const val = newRoot.trim()
    if (!val) { setResult(t('memRootEmpty')); return }
    setBusy(true)
    memoryApi.saveRoot(val, copyData).then((r) => {
      setResult(r.copied > 0
        ? t('memRootSavedCopied', { n: r.copied, root: r.root })
        : t('memRootSaved', { root: r.root }))
    }).catch((e: unknown) => {
      setResult(`❌ ${e instanceof Error ? e.message : String(e)}`)
    }).finally(() => setBusy(false))
  }

  const migrateNow = (): void => {
    setBusy(true)
    memoryApi.migrate().then(() => { load(); setResult(t('memMigrateDone')) })
      .catch((e: unknown) => setResult(`❌ ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setBusy(false))
  }

  const openFolder = (): void => {
    memoryApi.openFolder('.').catch((e: unknown) => {
      setResult(`❌ ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  const zh = isZh()

  return (
    <div className={css.memScroll}>
      <div className={css.memGroup}>
        <h2 className={css.memGroupHead}>{t('memStorageTitle')}</h2>
        <div className={css.memSetRow}>
          <label className={css.memLabel}>{t('memCurrentPath')}</label>
          <span className={css.memMono}>{root ?? '—'}</span>
        </div>
        <div className={css.memSetRow}>
          <label className={css.memLabel}>{t('memNewPath')}</label>
          <input
            className={css.memInput}
            value={newRoot}
            onChange={(e) => setNewRoot(e.target.value)}
            placeholder={t('memRootPlaceholder')}
          />
          <button type="button" className={css.memBtnPrimary} disabled={busy} onClick={saveRoot}>
            {t('memSaveRoot')}
          </button>
        </div>
        <label className={css.memCheckRow}>
          <input type="checkbox" checked={copyData} onChange={(e) => setCopyData(e.target.checked)} />
          <span>{t('memCopyData')}</span>
        </label>
        <div className={css.memHint}>{t('memRootHint')}</div>
        {result !== null && <div className={css.memHint} style={{ marginTop: 8 }}>{result}</div>}
      </div>

      <div className={css.memGroup}>
        <h2 className={css.memGroupHead}>{t('memMigrationTitle')}</h2>
        {migrated !== null
          ? <div className={css.memHint}>{t('memMigrated', { from: migrated.from, n: migrated.copiedItems, at: formatTime(migrated.at, zh) })}</div>
          : legacy !== null
            ? (
              <div className={css.memRow}>
                <span className={css.memHint}>{t('memMigDetected', { n: legacy })}</span>
                <button type="button" className={css.memBtnPrimary} disabled={busy} onClick={migrateNow}>
                  {t('memMigrateNow')}
                </button>
              </div>
            )
            : <div className={css.memHint}>{t('memMigrateNone')}</div>}
      </div>

      <div className={css.memGroup}>
        <h2 className={css.memGroupHead}>{t('memObsidianTitle')}</h2>
        <div className={css.memHint} style={{ marginBottom: 8 }}>{t('memObsidianHintText')}</div>
        <div className={css.memRow}>
          <button type="button" className={css.memBtnPrimary} onClick={openFolder}>
            📂 {t('memOpenFolder')}
          </button>
          {root !== null && <span className={css.memMono}>{root}</span>}
        </div>
      </div>
    </div>
  )
}
