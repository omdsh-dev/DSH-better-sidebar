/**
 * The 6 built-in tab descriptors: the plugin registers its own pages
 * (editor / git / terminal / browser / subagent / diff) through
 * the same {@link BetterSidebarService} external plugins use — eating its
 * own dogfood. The terminal descriptor owns its quota (`TERMINAL_LIMIT`)
 * and mints `terminal:<uuid>` ids through `createTab`; the browser mints
 * `browser:<n>` the same way (no quota). The editor IS the files window
 * (the old standalone explorer merged into it).
 */
import { IconBranchOutline16, IconCodeOutline16, IconFolderOpen16, IconPanelLeftOutline16, IconThinkOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import { allLeaves, isAgentTabId, type SidebarState } from '../state.ts'
import { t } from '../locales.ts'
import { openSidebarFile } from '../intercept.tsx'
import { EditorHost } from '../EditorHost.tsx'
import { lazyChunkComponent } from '../lazy-chunk.tsx'
import { GitView } from '../GitView.tsx'
import { DiffTab } from '../DiffTab.tsx'
import { SubagentView } from '../SubagentView.tsx'
import { BrowserView } from '../BrowserView.tsx'
import { IconTerminalOutline16, IconDiffOutline16, IconGlobeOutline16 } from '../icons.tsx'
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from '../../prefs-shared.ts'
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

/** Optional per-registration builtin behavior (currently terminal title). */
export interface BuiltinTabOptions {
  /** Returns the display title for newly opened terminal tabs. */
  terminalTitle?: () => string
}

/** A client-side uuid for terminal tab identity (not shown in the UI). */
function terminalUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

/** Count UI-owned terminals (agent:` tabs excluded — they are the model's). */
function uiTerminalCount(state: SidebarState): number {
  return allLeaves(state.splits)
    .flatMap(leaf => leaf.tabs)
    .filter(tab => tab.type === 'terminal' && !isAgentTabId(tab.id)).length
}

/** The 6 built-in tab descriptors. */
export function builtinTabs(ctx: Context, options: BuiltinTabOptions = {}): readonly TabDescriptor[] {
  return [
    {
      id: 'editor',
      // The single files window: an editor tab with no path IS the file
      // explorer (empty hint + docked tree); with a path it previews/edits
      // the file. Visible in the + menu in the explorer's old slot.
      title: () => t('files'),
      icon: (size: number) => <IconFolderOpen16 size={size} />,
      order: 10,
      hidden: false,
      dedupeKey: (tab) => tab.path,
      // Declarative settings: the file-open behavior picker (in-place switch
      // vs per-path windows) renders as an iconed select row under the
      // editor card's gear in the Side card settings page.
      settings: {
        toggles: [{
          key: 'editorExplorer',
          type: 'select',
          title: () => t('editorExplorer'),
          desc: () => t('editorExplorerDesc'),
          options: [
            {
              value: true,
              icon: (size: number) => <IconPanelLeftOutline16 size={size} />,
              title: () => t('editorExplorerMerged'),
              desc: () => t('editorExplorerMergedDesc'),
            },
            {
              value: false,
              icon: (size: number) => <IconCodeOutline16 size={size} />,
              title: () => t('editorExplorerSplit'),
              desc: () => t('editorExplorerSplitDesc'),
            },
          ],
        }],
      },
      component: ({ ctx, store, scope, tab, expanded, onToggleDir, onReferenceFile }) => (
        <EditorHost
          ctx={ctx}
          store={store}
          scope={scope}
          tab={tab}
          expanded={expanded ?? []}
          onToggleDir={onToggleDir ?? (() => { /* no-op */ })}
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
          key: 'terminalShell',
          type: 'text',
          title: () => t('settingsShellTitle'),
          desc: () => t('settingsShellDesc'),
          placeholder: t('settingsShellPlaceholder'),
        }, {
          key: 'terminalShellArgs',
          type: 'text',
          title: () => t('settingsShellArgsTitle'),
          desc: () => t('settingsShellArgsDesc'),
          placeholder: t('settingsShellArgsPlaceholder'),
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
            id: `terminal:${terminalUuid()}`,
            type: 'terminal',
            title: options.terminalTitle?.() ?? t('terminal'),
          },
          // Keep the legacy counter advancing for compatibility with older
          // persisted states; new ids no longer use it.
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
      // Declarative settings: the sandbox escape hatch, the link-takeover
      // MASTER switch, and the per-protocol takeover switches (http on /
      // https off by default) render under this tab's row in the Side card
      // settings page (the sandbox one is warned on).
      settings: {
        toggles: [{
          key: 'browserNoSandbox',
          title: () => t('settingsBrowserSandboxTitle'),
          desc: () => t('settingsBrowserSandboxDesc'),
        }, {
          key: 'browserInterceptLinks',
          title: () => t('settingsBrowserLinksTitle'),
          desc: () => t('settingsBrowserLinksDesc'),
        }, {
          key: 'browserInterceptHttp',
          title: () => t('settingsBrowserHttpTitle'),
          desc: () => t('settingsBrowserHttpDesc'),
        }, {
          key: 'browserInterceptHttps',
          title: () => t('settingsBrowserHttpsTitle'),
          desc: () => t('settingsBrowserHttpsDesc'),
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
