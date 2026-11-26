/**
 * Placeholder shown when a persisted tab's type is not registered (the
 * contributing plugin is not installed / not yet loaded). The tab is kept
 * in state so it can recover if the plugin loads later; the user can close
 * it through the tab bar's X button as usual. This is the graceful-
 * degradation path for the open tab-type set: {@link Sidebar} renders this
 * instead of crashing on an unknown type.
 *
 * The body is the shared {@link FallbackPane} (a pane-filling centred message
 * with `role="status"`), so the sentence and the type chip are the only parts
 * this file owns.
 */
import type { ReactNode } from 'react'
import { t } from './locales.ts'
import css from './sidebar.module.css'
import type { TabComponentProps } from './service.ts'
import { FallbackPane } from './ui/index.ts'

export function OrphanedTab(props: TabComponentProps): ReactNode {
  const { tab } = props
  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <span className={css.editorTitle} title={tab.type}>{tab.title}</span>
      </div>
      <FallbackPane
        role="status"
        title={t('pluginNotLoaded')}
        description={<code className={css.orphanedType}>{tab.type}</code>}
      />
    </div>
  )
}
