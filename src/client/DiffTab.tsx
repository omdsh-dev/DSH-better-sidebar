/**
 * The diff tab: one change opened from the changes tab, like VSCode's diff
 * editor. A worktree ref loads the file's unified diff (`git diff`, staged or
 * not; untracked files — which git diff never covers — render as a full-file
 * addition from their content), a commit ref loads the commit's full patch
 * (`git.show`-style). The header carries a refresh button because the tab
 * stays mounted while the changes tab's staging/discard operations change the
 * very content it shows. Loading IS the shared `useGitDiffTarget` hook (the
 * changes tab's inline preview runs the same one, so the staged-side and
 * untracked fallbacks and the per-file fold cache cannot drift apart);
 * rendering goes through the shared {@link DiffFiles} renderer.
 */
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { SessionScope } from './api.ts'
import type { SidebarDiffRef } from './state.ts'
import { DiffFiles } from './diff/DiffFiles.tsx'
import { useGitDiffTarget } from './diff/use-git-diff.ts'
import { t } from './locales.ts'
import { IconButton, Notice } from './ui/index.ts'
import css from './diff/diff.module.css'

export function DiffTab(props: { scope: SessionScope; diff: SidebarDiffRef }) {
  const { scope, diff } = props
  const { loading, error, diffText, untracked, refresh, resolveFold } = useGitDiffTarget(diff, scope)

  return (
    <div className={css.tab}>
      <div className={css.tabHeader}>
        <span className={css.tabTitle} title={diff.kind === 'worktree' ? diff.path : `${diff.hash} ${diff.subject}`}>
          {diff.kind === 'worktree' ? diff.path : `${diff.hash} ${diff.subject}`}
        </span>
        <IconButton size="sm" icon={<IconRefreshOutlineRegular size={14} />}
          label={t('refresh')} disabled={loading} onClick={refresh} />
      </div>
      <div className={css.tabBody} aria-busy={loading}>
      {loading && <Notice kind="loading" tone="page">{t('loading')}</Notice>}
      {!loading && error !== null && <Notice kind="error" tone="page" role="alert">{t('diffLoadError')}: {error}</Notice>}
      {!loading && error === null && diffText !== null && (
        <>
          {untracked !== undefined
            ? <DiffFiles diff="" untrackedPath={diff.kind === 'worktree' ? diff.path : ''} untrackedContent={untracked} />
            : <DiffFiles diff={diffText} resolveFold={resolveFold} />}
          {diffText === '' && untracked === undefined && (
            <Notice kind="empty" tone="page">{t('diffEmpty')}</Notice>
          )}
        </>
      )}
      </div>
    </div>
  )
}
