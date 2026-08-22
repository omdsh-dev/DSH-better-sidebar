/**
 * The two subfolder-scoped built-in tabs:
 * - `folder` (「子文件」): a file-tree tab rooted at a subfolder — a view root
 *   only, it never changes the session cwd (terminal/git/search stay at the
 *   workspace root).
 * - `repo-git` (「子源代码管理」): the source-control panel scoped to a
 *   subfolder — it reuses {@link GitView} but runs git against `tab.path`
 *   (the folder may be its own repository even when the workspace root is
 *   not one).
 *
 * Both are opened exclusively by the file tree's directory context menu
 * (they are `hidden` from the + menu) and dedupe per folder path. The folder
 * tab's own tree supports the SAME directory menu again, so folder / repo
 * tabs nest recursively.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { openSidebarFile } from './intercept.tsx'
import { resolveSidebarPath } from './produced-files.ts'
import { baseName } from './FileTree.tsx'
import { TreePanel } from './TreePanel.tsx'
import { GitView } from './GitView.tsx'
import { firstLeaf, insertLeafAt, leafWithTab, mintTabId, treeOf, type SidebarTab } from './state.ts'
import type { SessionScope } from './api.ts'
import type { TabComponentProps } from './service.ts'

/** The no-op fallback for the shell's optional callbacks. */
const noop = (): void => { /* no-op */ }

/** Open a folder-scoped tab of type `type` (folder or repo-git). */
function openFolderTab(ctx: TabComponentProps['ctx'], type: 'folder' | 'repo-git', path: string): void {
  ctx.betterSidebar?.openTab({ type, title: baseName(path), path })
}

/**
 * The folder tab: a file tree rooted at `tab.path`. It keeps its OWN
 * expansion set (isolated from the editor's explorer), opens files through
 * the editor, and offers the same directory context menu for recursion.
 */
export function FolderTab(props: TabComponentProps): ReactNode {
  const { ctx, store, scope, tab } = props
  const root = tab.path ?? scope.cwd ?? ''
  // Per-tab expansion set (independent from the shared editor explorer set).
  const [expanded, setExpanded] = useState<string[]>([])
  const onToggle = useCallback((path: string): void => {
    setExpanded(prev => (prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]))
  }, [])

  const openFile = useCallback((path: string): void => {
    openSidebarFile(ctx, store, scope.sessionId, path)
  }, [ctx, store, scope.sessionId])
  const openFileNewTab = useCallback((path: string): void => {
    openSidebarFile(ctx, store, scope.sessionId, path)
  }, [ctx, store, scope.sessionId])
  const openFileSide = useCallback((path: string): void => {
    store.reduce((state) => {
      const key = treeOf(state, tab.id)
      const pane = leafWithTab(state[key], tab.id) ?? firstLeaf(state[key])
      const fresh: SidebarTab = {
        id: mintTabId(),
        type: 'editor',
        title: baseName(path),
        path,
        meta: { treeOpen: false },
      }
      const { node, leafId } = insertLeafAt(state[key], pane.id, 'row', fresh, false)
      return { ...state, [key]: node, activePane: leafId }
    })
  }, [store, tab.id])
  const openDirFiles = useCallback((path: string): void => { openFolderTab(ctx, 'folder', path) }, [ctx])
  const openDirScm = useCallback((path: string): void => { openFolderTab(ctx, 'repo-git', path) }, [ctx])

  return (
    <TreePanel
      full
      sessionId={scope.sessionId}
      cwd={root}
      expanded={expanded}
      onToggle={onToggle}
      onOpenFile={openFile}
      onOpenFileNewTab={openFileNewTab}
      onOpenFileSide={openFileSide}
      onOpenDirFiles={openDirFiles}
      onOpenDirScm={openDirScm}
      onReferenceFile={props.onReferenceFile ?? noop}
      targetCwd={root !== '' ? root : undefined}
    />
  )
}

/**
 * The repo-git tab: the source-control panel scoped to `tab.path`. Git
 * commands run against the folder (the folder may be its own repository
 * even when the workspace root is not one); the diff targets opened from it
 * carry the same folder cwd so a nested repo's diffs resolve correctly.
 */
export function RepoGitTab(props: TabComponentProps): ReactNode {
  const { ctx, store, scope, tab } = props
  const folderPath = tab.path
  const folderScope: SessionScope = useMemo(() => ({
    sessionId: scope.sessionId,
    cwd: folderPath ?? scope.cwd,
    ...(folderPath !== undefined ? { targetCwd: folderPath } : {}),
  }), [scope.sessionId, scope.cwd, folderPath])

  const openFile = useCallback((path: string): void => {
    // git status/log paths are repo-root-relative: resolve against the
    // folder (its repo root for the primary case).
    openSidebarFile(ctx, store, scope.sessionId, resolveSidebarPath(folderPath ?? scope.cwd, path))
  }, [ctx, store, scope.sessionId, folderPath, scope.cwd])

  return (
    <GitView
      scope={folderScope}
      onOpenFile={openFile}
      onOpenDiff={props.onOpenDiff ?? noop}
    />
  )
}
