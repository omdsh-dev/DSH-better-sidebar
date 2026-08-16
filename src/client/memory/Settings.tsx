/**
 * Memory settings: storage root (restart-required), Pi migration status, and
 * opening the store folder in the system file manager. Rows follow the DSH
 * settings-row recipe.
 */
import { useEffect, useState } from 'react'
import {
  IconFolderOpenOutline16, IconRefreshOutline16, IconSettingsOutline16,
  Button, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { memoryApi, formatTime, type MemoryOverview } from './api.ts'
import { isZh, t } from '../locales.ts'
import shellCss from '../sidebar.module.css'
import css from '../memory.module.css'

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
    <div className={css.memRoot}>
      <div className={css.memHeader}>
        <span className={css.memTitle}>{t('memNavSettings')}</span>
        <button type="button" className={css.memIconBtn} title={t('memRefresh')} onClick={load}>
          <IconRefreshOutline16 />
        </button>
      </div>
      <div className={css.memBody}>
        <div className={css.memGroup}>
          <h4 className={css.memGroupHead}>{t('memStorageTitle')}</h4>
          <div className={css.memRow}>
            <span className={css.memLabel}>{t('memCurrentPath')}</span>
            <span className={css.memMono}>{root ?? '—'}</span>
          </div>
          <div className={css.memRow}>
            <span className={css.memLabel}>{t('memNewPath')}</span>
            <input
              className={css.memInput}
              value={newRoot}
              onChange={(e) => setNewRoot(e.target.value)}
              placeholder={t('memRootPlaceholder')}
            />
            <Button variant="primary" size="sm" disabled={busy} onClick={saveRoot} title={t('memSaveRoot')}>
              {t('memSaveRoot')}
            </Button>
          </div>
          <label className={css.memCheckRow}>
            <input type="checkbox" checked={copyData} onChange={(e) => setCopyData(e.target.checked)} />
            <span>{t('memCopyData')}</span>
          </label>
          <div className={css.memRow}>
            <span className={css.memHint}>{t('memRootHint')}</span>
          </div>
          {result !== null && (
            <div className={css.memRow}>
              <span className={css.memHint}>{result}</span>
            </div>
          )}
        </div>

        <div className={css.memGroup}>
          <h4 className={css.memGroupHead}>{t('memMigrationTitle')}</h4>
          {migrated !== null
            ? (
              <div className={css.memRow}>
                <span className={css.memHint}>
                  {t('memMigrated', { from: migrated.from, n: migrated.copiedItems, at: formatTime(migrated.at, zh) })}
                </span>
              </div>
            )
            : legacy !== null
              ? (
                <div className={css.memRow}>
                  <StateDot state="warning" size={10} className={css.memDot} />
                  <span className={css.memHint} style={{ flex: 1 }}>{t('memMigDetected', { n: legacy })}</span>
                  <Button variant="primary" size="sm" disabled={busy} onClick={migrateNow} title={t('memMigrateNow')}>
                    {t('memMigrateNow')}
                  </Button>
                </div>
              )
              : (
                <div className={css.memRow}>
                  <span className={css.memHint}>{t('memMigrateNone')}</span>
                </div>
              )}
        </div>

        <div className={css.memGroup}>
          <h4 className={css.memGroupHead}>{t('memObsidianTitle')}</h4>
          <div className={css.memRow}>
            <span className={css.memHint}>{t('memObsidianHintText')}</span>
          </div>
          <div className={css.memRow}>
            <button type="button" className={shellCss.iconButton} onClick={openFolder} title={t('memOpenFolder')}><IconFolderOpenOutline16 /></button>
            {root !== null && <span className={css.memMono} style={{ flex: 1 }}>{root}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
