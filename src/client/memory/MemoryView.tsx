/**
 * The memory console tab: five internal views (Overview / Files / Models /
 * Runs / Settings) behind a compact tab strip reusing the sidebar's own
 * tabBar chrome. Registered as the built-in `memory` tab — the sidebar shell
 * (drag tabs, split panes, width, layout persistence) is provided by
 * dsh-better-sidebar itself.
 */
import { useState, type ReactNode } from 'react'
import {
  IconDataOutline16, IconFolderOpenOutline16, IconSettingsOutline16,
  IconSparkle16, IconThinkOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabComponentProps } from '../service.ts'
import { t, type CopyKey } from '../locales.ts'
import css from '../memory.module.css'
import { Overview } from './Overview.tsx'
import { Files } from './Files.tsx'
import { Models } from './Models.tsx'
import { Runs } from './Runs.tsx'
import { Settings } from './Settings.tsx'

type MemView = 'overview' | 'files' | 'models' | 'runs' | 'settings'

const NAV: { id: MemView; icon: ReactNode; key: CopyKey }[] = [
  { id: 'overview', icon: <IconDataOutline16 />, key: 'memNavOverview' },
  { id: 'files', icon: <IconFolderOpenOutline16 />, key: 'memNavFiles' },
  { id: 'models', icon: <IconSparkle16 />, key: 'memNavModels' },
  { id: 'runs', icon: <IconThinkOutline16 />, key: 'memNavRuns' },
  { id: 'settings', icon: <IconSettingsOutline16 />, key: 'memNavSettings' },
]

export function MemoryView(props: TabComponentProps) {
  const { visible, scope } = props
  const [view, setView] = useState<MemView>('overview')

  return (
    <div className={css.memRoot}>
      <div className={css.memNav}>
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            className={css.memNavTab + (view === n.id ? ' ' + css.memNavTabActive : '')}
            onClick={() => setView(n.id)}
            title={t(n.key)}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center' }}>{n.icon}</span>
            <span>{t(n.key)}</span>
          </button>
        ))}
      </div>
      {view === 'overview' && <Overview visible={visible} scope={scope} />}
      {view === 'files' && <Files visible={visible} scope={scope} />}
      {view === 'models' && <Models />}
      {view === 'runs' && <Runs visible={visible} scope={scope} />}
      {view === 'settings' && <Settings />}
    </div>
  )
}
