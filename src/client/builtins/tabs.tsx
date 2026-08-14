/**
 * The 8 built-in tab descriptors: the plugin registers its own pages
 * (explorer / git / github / terminal / browser / subagent / editor / diff)
 * through the same {@link BetterSidebarService} external plugins use —
 * eating its own dogfood. The terminal descriptor owns its quota
 * (`TERMINAL_LIMIT`) and mints `terminal:<n>` ids through `createTab`; the
 * browser mints `browser:<n>` the same way (no quota). The GitHub
 * descriptor shares the inbox store with its badge hook — the store is
 * created once by the builtins aggregator and passed in.
 */
import { IconBranchOutline16, IconCodeOutline16, IconFolderOpen16, IconThinkOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import { allLeaves, isAgentTabId, type SidebarState } from '../state.ts'
import { t } from '../locales.ts'
import { openSidebarFile } from '../intercept.tsx'
import { ExplorerView } from '../ExplorerView.tsx'
import { EditorHost } from '../EditorHost.tsx'
import { lazyChunkComponent } from '../lazy-chunk.tsx'
import { GitView } from '../GitView.tsx'
import { DiffTab } from '../DiffTab.tsx'
import { SubagentView } from '../SubagentView.tsx'
import { BrowserView } from '../BrowserView.tsx'
import { IconTerminalOutline16, IconDiffOutline16, IconGlobeOutline16, IconInboxOutline16 } from '../icons.tsx'
import { GitHubInboxView } from '../GitHubInboxView.tsx'
import type { GithubInboxStore } from '../github-inbox.ts'
import { GITHUB_POLL_SECONDS_MAX, GITHUB_POLL_SECONDS_MIN, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '../../prefs-shared.ts'
import type { ComponentType } from 'react'
import type { SessionScope } from '../api.ts'
import type { SidebarStore } from '../state.ts'
import type { TabDescriptor } from '../service.ts'

/**
 * Lazy wrapper over the terminal view: xterm (and its stylesheet) is fetched
 * only when a terminal tab is first opened (see chunk-loader.ts). The
 * wrapper keeps the descriptor contract `(props) => ReactNode` — Sidebar
 * calls it as a plain function.
 *
 * TerminalView's props are { scope, tabId, store } — `tabId` is NOT part of
 * TabComponentProps (it carries `tab: SidebarTab` instead), so the
 * descriptor maps it explicitly; a bare pass-through would leave tabId
 * undefined and TerminalView's isAgentTabId(tabId) would crash on
 * `undefined.startsWith` (regression-pinned in tests/lazy-chunk.spec.tsx).
 */
const LazyTerminal = lazyChunkComponent<TerminalViewProps>(
  'terminal',
  (mod) => mod.TerminalView as ComponentType<TerminalViewProps> | undefined,
)

/** The terminal view's props (mirror of TerminalView's own signature). */
interface TerminalViewProps {
  scope: SessionScope
  tabId: string
  store: SidebarStore
}

/** How many UI-owned terminals may be open at once (agent-owned ones are uncapped). */
export const TERMINAL_LIMIT = 3

/** Count UI-owned terminals (agent:` tabs excluded — they are the model's). */
function uiTerminalCount(state: SidebarState): number {
  return allLeaves(state.splits)
    .flatMap(leaf => leaf.tabs)
    .filter(tab => tab.type === 'terminal' && !isAgentTabId(tab.id)).length
}

/** The 8 built-in tab descriptors. */
export function builtinTabs(ctx: Context, githubStore: GithubInboxStore): readonly TabDescriptor[] {
  return [
    {
      id: 'editor',
      title: () => t('editor'),
      icon: (size: number) => <IconCodeOutline16 size={size} />,
      order: -1,
      hidden: true,
      dedupeKey: (tab) => tab.path,
      component: ({ ctx, store, scope, tab }) => (
        <EditorHost ctx={ctx} store={store} scope={scope} path={tab.path ?? ''} title={tab.title} />
      ),
    },
    {
      id: 'explorer',
      title: () => t('explorer'),
      icon: (size: number) => <IconFolderOpen16 size={size} />,
      order: 10,
      single: true,
      component: ({ ctx, store, scope, expanded, onToggleDir, onReferenceFile }) => (
        <ExplorerView
          sessionId={scope.sessionId}
          cwd={scope.cwd}
          expanded={expanded ?? []}
          onToggle={onToggleDir ?? (() => { /* no-op */ })}
          onOpenFile={(path) => { openSidebarFile(ctx, store, scope.sessionId, path) }}
          onReferenceFile={onReferenceFile ?? (() => { /* no-op */ })}
        />
      ),
    },
    {
      id: 'git',
      title: () => t('git'),
      icon: (size: number) => <IconBranchOutline16 size={size} />,
      order: 20,
      single: true,
      component: ({ ctx, store, scope, onOpenDiff }) => (
        <GitView
          scope={scope}
          onOpenFile={(path) => { openSidebarFile(ctx, store, scope.sessionId, path) }}
          onOpenDiff={onOpenDiff ?? (() => { /* no-op */ })}
        />
      ),
    },
    {
      id: 'github',
      title: () => t('github'),
      icon: (size: number) => <IconInboxOutline16 size={size} />,
      order: 25,
      single: true,
      // The badge pill arms the store's polling on its first render, so the
      // unread count stays live while the tab is open but inactive (the
      // badge only renders on open tabs — a never-opened tab has no pill).
      badge: () => {
        githubStore.ensurePolling()
        return githubStore.badgeValue()
      },
      // Declarative settings: the five category filters plus the poll
      // interval render under this card in the Side card settings page.
      // The same prefs keys drive the tab's filter chips.
      settings: {
        toggles: [{
          key: 'githubShowReviewRequested',
          title: () => t('githubChipReviewRequested'),
          desc: () => t('githubChipReviewRequestedDesc'),
        }, {
          key: 'githubShowPrActivity',
          title: () => t('githubChipPrActivity'),
          desc: () => t('githubChipPrActivityDesc'),
        }, {
          key: 'githubShowComments',
          title: () => t('githubChipComments'),
          desc: () => t('githubChipCommentsDesc'),
        }, {
          key: 'githubShowCi',
          title: () => t('githubChipCi'),
          desc: () => t('githubChipCiDesc'),
        }, {
          key: 'githubShowOther',
          title: () => t('githubChipOther'),
          desc: () => t('githubChipOtherDesc'),
        }, {
          key: 'githubPollSeconds',
          type: 'number',
          title: () => t('githubPollSecondsTitle'),
          desc: () => t('githubPollSecondsDesc'),
          min: GITHUB_POLL_SECONDS_MIN,
          max: GITHUB_POLL_SECONDS_MAX,
          unit: t('githubPollSecondsSuffix'),
        }],
      },
      component: ({ ctx, store, scope }) => (
        <GitHubInboxView githubStore={githubStore} sidebarStore={store} ctx={ctx} scope={scope} />
      ),
    },
    {
      id: 'subagent',
      title: () => t('subagent'),
      icon: (size: number) => <IconThinkOutline16 size={size} />,
      order: 30,
      single: true,
      // Declarative settings: the auto-open switches render under this row in
      // the Side card settings page (the Jobs page's own related settings).
      settings: {
        toggles: [{
          key: 'autoOpenSubagent',
          title: () => t('settingsSubagentTitle'),
          desc: () => t('settingsSubagentDesc'),
        }, {
          key: 'autoOpenJobs',
          title: () => t('settingsJobsTitle'),
          desc: () => t('settingsJobsDesc'),
        }],
      },
      component: ({ ctx, scope, visible, onSubagentJump }) => (
        <SubagentView
          sessionId={scope.sessionId}
          ctx={ctx}
          active={visible}
          onOpenChild={(address) => { onSubagentJump?.(address.childSessionId) }}
        />
      ),
    },
    {
      id: 'terminal',
      title: () => t('terminal'),
      icon: (size: number) => <IconTerminalOutline16 size={size} />,
      order: 40,
      available: (_ctx, _scope, state) => uiTerminalCount(state) < TERMINAL_LIMIT,
      // Declarative settings: the model-facing terminal tools switch, the
      // bottom-panel first-expansion auto-terminal switch, and the custom
      // font family/size rows render under this card in the Side card
      // settings page (the host gates the toolset on the tools one
      // independently; the font rows apply live to every terminal).
      settings: {
        toggles: [{
          key: 'agentTerminalTools',
          title: () => t('settingsToolsTitle'),
          desc: () => t('settingsToolsDesc'),
        }, {
          key: 'bottomPanelAutoTerminal',
          title: () => t('settingsBottomTerminalTitle'),
          desc: () => t('settingsBottomTerminalDesc'),
        }, {
          key: 'terminalFontFamily',
          type: 'text',
          title: () => t('settingsFontFamilyTitle'),
          desc: () => t('settingsFontFamilyDesc'),
          placeholder: t('settingsFontFamilyPlaceholder'),
        }, {
          key: 'terminalFontSize',
          type: 'number',
          title: () => t('settingsFontSizeTitle'),
          desc: () => t('settingsFontSizeDesc'),
          min: TERMINAL_FONT_SIZE_MIN,
          max: TERMINAL_FONT_SIZE_MAX,
          unit: 'px',
        }],
      },
      createTab: (state) => {
        const count = uiTerminalCount(state)
        if (count >= TERMINAL_LIMIT) return null
        return {
          tab: {
            id: `terminal:${state.nextTerminal}`,
            type: 'terminal',
            title: `${t('terminal')} ${state.nextTerminal}`,
          },
          patch: { nextTerminal: state.nextTerminal + 1 },
        }
      },
      component: ({ tab, scope, store }) => <LazyTerminal scope={scope} store={store} tabId={tab.id} />,
    },
    {
      id: 'browser',
      title: () => t('browser'),
      icon: (size: number) => <IconGlobeOutline16 size={size} />,
      order: 50,
      // Declarative settings: the sandbox escape hatch and the link
      // takeover render under this tab's row in the Side card settings
      // page (the sandbox one is warned on).
      settings: {
        toggles: [{
          key: 'browserNoSandbox',
          title: () => t('settingsBrowserSandboxTitle'),
          desc: () => t('settingsBrowserSandboxDesc'),
        }, {
          key: 'browserInterceptLinks',
          title: () => t('settingsBrowserLinksTitle'),
          desc: () => t('settingsBrowserLinksDesc'),
        }],
      },
      createTab: (state) => ({
        tab: {
          id: `browser:${state.nextBrowser}`,
          type: 'browser',
          title: t('browser'),
        },
        patch: { nextBrowser: state.nextBrowser + 1 },
      }),
      component: (props) => <BrowserView {...props} />,
    },
    {
      id: 'diff',
      title: () => t('git'),
      icon: (size: number) => <IconDiffOutline16 size={size} />,
      order: -1,
      hidden: true,
      dedupeKey: (tab) => tab.id,
      component: ({ scope, tab }) => (
        tab.diff === undefined ? null
          : <DiffTab sessionId={scope.sessionId} cwd={scope.cwd} diff={tab.diff} />
      ),
    },
  ]
}
