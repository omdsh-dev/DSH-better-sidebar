/**
 * The memory console tab: five internal views (Overview / Files / Models /
 * Runs / Settings) behind a compact tab strip. Registered as the built-in
 * `memory` tab — the sidebar shell (drag tabs, split panes, width, layout
 * persistence) is provided by dsh-better-sidebar itself.
 */
import { useState } from 'react'
import type { TabComponentProps } from '../service.ts'
import { t, type CopyKey } from '../locales.ts'
import css from '../sidebar.module.css'
import { Overview } from './Overview.tsx'
import { Files } from './Files.tsx'
import { Models } from './Models.tsx'
import { Runs } from './Runs.tsx'
import { Settings } from './Settings.tsx'

type MemView = 'overview' | 'files' | 'models' | 'runs' | 'settings'

const NAV: { id: MemView; icon: string; key: CopyKey }[] = [
  { id: 'overview', icon: '📊', key: 'memNavOverview' },
  { id: 'files', icon: '📄', key: 'memNavFiles' },
  { id: 'models', icon: '⚙️', key: 'memNavModels' },
  { id: 'runs', icon: '🔄', key: 'memNavRuns' },
  { id: 'settings', icon: '🛠️', key: 'memNavSettings' },
]

export function MemoryView(props: TabComponentProps) {
  const { visible } = props
  const [view, setView] = useState<MemView>('overview')

  return (
    <div className={css.memRoot}>
      <div className={css.tabBar}>
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            className={css.tab + (view === n.id ? ' ' + css.tabActive : '')}
            onClick={() => setView(n.id)}
          >
            <span className={css.memNavIcon}>{n.icon}</span>
            <span className={css.tabTitle}>{t(n.key)}</span>
          </button>
        ))}
      </div>
      {view === 'overview' && <Overview visible={visible} />}
      {view === 'files' && <Files />}
      {view === 'models' && <Models />}
      {view === 'runs' && <Runs visible={visible} />}
      {view === 'settings' && <Settings />}
    </div>
  )
}
