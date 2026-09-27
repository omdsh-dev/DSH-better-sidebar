/**
 * The built-in tab descriptors: the plugin registers its own pages
 * (editor / git — the unified changes tab / subagent / sidechat / browser /
 * diff) through
 * the same {@link BetterSidebarService} external plugins use — eating its
 * own dogfood. The editor IS the files window (the old standalone explorer
 * merged into it).
 *
 * DSH 0.1.6-alpha.2 ships its own right-Sidebar terminal and browser tab
 * types, so this plugin contributes neither: the host's `terminal` kind owns
 * interactive shells outright, and the host's `browser` kind (delegated to
 * from the chat's http(s) links) owns embedded pages. See
 * docs/plans/2026-09-21-dsh-0.1.6-alpha.2-adaptation.md.
 */
import { IconCodeOutlineRegular, IconPanelLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  changesTabIcon, filesTabIcon, sidechatTabIcon, tasksTabIcon,
} from './tab-icons.tsx'
import { t } from '../locales.ts'
import { openSidebarFile } from '../sidebar-file.ts'
import { EditorHost } from '../EditorHost.tsx'
import { OpenWithSettings } from '../open-with-settings.tsx'
import { ChangesTab, opCountOf } from '../changes/ChangesTab.tsx'
import { DiffTab } from '../DiffTab.tsx'
import { SubagentView } from '../SubagentView.tsx'
import { consumeSidechatSeed, SideChatView, sidechatThreadIdOf } from '../SideChatView.tsx'
import { api } from '../api.ts'
import type { TabDescriptor } from '../service.ts'

/** The 5 built-in tab descriptors (the host owns terminal and browser). */
export function builtinTabs(): readonly TabDescriptor[] {
  return [
    {
      id: 'editor',
      description: () => t('guideDescFiles'),
      // The single files window: an editor tab with no path IS the file
      // explorer (empty hint + docked tree); with a path it previews/edits
      // the file. Visible in the + menu in the explorer's old slot.
      title: () => t('files'),
      icon: filesTabIcon,
      order: 10,
      hidden: false,
      dedupeKey: (tab) => tab.path,
      // Declarative settings: the file-open behavior picker (in-place switch
      // vs per-path windows) renders as an iconed select row under the
      // editor card's gear in the Side card settings page, followed by the
      // workspace fence switch (the host's containment guard over every
      // sidebar filesystem route); the "open with" configuration (SSH host +
      // custom editors) is the custom panel BELOW those rows — the settings
      // seam renders rows first, custom panel after.
      settings: {
        toggles: [{
          key: 'editorExplorer',
          type: 'select',
          title: () => t('editorExplorer'),
          desc: () => t('editorExplorerDesc'),
          options: [
            {
              value: true,
              icon: (size: number) => <IconPanelLeftOutlineRegular size={size} />,
              title: () => t('editorExplorerMerged'),
              desc: () => t('editorExplorerMergedDesc'),
            },
            {
              value: false,
              icon: (size: number) => <IconCodeOutlineRegular size={size} />,
              title: () => t('editorExplorerSplit'),
              desc: () => t('editorExplorerSplitDesc'),
            },
          ],
        }, {
          key: 'workspaceFence',
          title: () => t('settingsFenceTitle'),
          desc: () => t('settingsFenceDesc'),
        }],
        render: ({ pluginSettings, updatePluginSetting }) => (
          <OpenWithSettings pluginSettings={pluginSettings} updatePluginSetting={updatePluginSetting} />
        ),
      },
      component: ({ ctx, store, scope, tab, expanded, revealed, onToggleDir, onReferenceFile }) => (
        <EditorHost
          ctx={ctx}
          store={store}
          scope={scope}
          tab={tab}
          expanded={expanded ?? []}
          revealed={revealed ?? []}
          onToggleDir={onToggleDir ?? (() => { /* no-op */ })}
          onReferenceFile={onReferenceFile ?? (() => { /* no-op */ })}
        />
      ),
    },
    {
      // The unified changes tab (id kept as 'git' so persisted layouts keep
      // resolving): the Git lens is the former source-control panel; the
      // session lens is the former file-trace tab (PR #471). Both preview
      // through one shared diff stack. The badge reads the op-count cache
      // the tab's event poll publishes (the client ctx exposes no event
      // log, and the git status needs a fetch — both stay out of the badge).
      id: 'git',
      title: () => t('changes'),
      description: () => t('guideDescGit'),
      icon: changesTabIcon,
      order: 20,
      single: true,
      badge: (_ctx, scope) => {
        const count = opCountOf(scope.sessionId)
        return count === undefined || count === 0 ? null : count
      },
      component: ({ ctx, store, scope, tab, visible, onOpenDiff }) => (
        <ChangesTab
          ctx={ctx}
          store={store}
          scope={scope}
          tab={tab}
          visible={visible}
          onOpenFile={(path) => { openSidebarFile(ctx, scope.sessionId, path) }}
          onOpenDiff={onOpenDiff}
        />
      ),
    },
    {
      id: 'subagent',
      title: () => t('subagent'),
      description: () => t('guideDescSubagent'),
      icon: tasksTabIcon,
      order: 30,
      single: true,
      // Declarative settings: the auto-open switches render under this row in
      // the Side card settings page (the Tasks page's related settings).
      settings: {
        toggles: [{
          key: 'autoOpenSubagent',
          title: () => t('settingsSubagentTitle'),
          desc: () => t('settingsSubagentDesc'),
        }, {
          key: 'autoOpenJobs',
          title: () => t('settingsJobsTitle'),
          desc: () => t('settingsJobsDesc'),
        }, {
          key: 'tasksViewMode',
          type: 'select',
          title: () => t('settingsViewModeTitle'),
          desc: () => t('settingsViewModeDesc'),
          options: [
            {
              value: 'graph',
              title: () => t('settingsViewModeGraph'),
              desc: () => t('settingsViewModeGraphDesc'),
            },
            {
              value: 'tree',
              title: () => t('settingsViewModeTree'),
              desc: () => t('settingsViewModeTreeDesc'),
            },
          ],
        }],
      },
      component: ({ ctx, store, scope, visible, onSubagentJump }) => (
        <SubagentView
          sessionId={scope.sessionId}
          ctx={ctx}
          store={store}
          active={visible}
          onOpenChild={(address) => { onSubagentJump?.(address.childSessionId) }}
        />
      ),
    },
    {
      id: 'sidechat',
      title: () => t('sideChat'),
      description: () => t('guideDescSidechat'),
      icon: sidechatTabIcon,
      order: 35,
      // Codex-style: EVERY side conversation is its own tab. A plain open
      // mints a fresh tab flagged `autoCreate` (the view creates the EMPTY
      // thread on mount); a thread switch from the header menu parks the
      // target id for a deterministic `sidechat:<threadId>` reattach tab.
      createTab: () => {
        const threadId = consumeSidechatSeed()
        if (threadId !== undefined) {
          return {
            tab: {
              id: `sidechat:${threadId}`,
              type: 'sidechat',
              title: t('sideChat'),
              meta: { threadId },
            },
          }
        }
        return {
          tab: {
            id: `sidechat:new-${crypto.randomUUID()}`,
            type: 'sidechat',
            title: t('sideChatUntitled'),
            meta: { autoCreate: true },
          },
        }
      },
      // One tab per thread: an already-open thread focuses instead of
      // duplicating; unbound fresh tabs never dedupe (each mints its own).
      dedupeKey: (tab) => sidechatThreadIdOf(tab),
      // Closing the tab releases the thread's live agent; the session and
      // its history stay persisted (reopen from any thread's header menu).
      onClose: (tab) => {
        const threadId = sidechatThreadIdOf(tab)
        if (threadId !== undefined) {
          void api.sidechatDispose(threadId).catch(() => {})
        }
      },
      component: ({ ctx, scope, tab, visible }) => (
        <SideChatView ctx={ctx} scope={scope} tab={tab} visible={visible} />
      ),
    },
    {
      id: 'diff',
      title: () => t('changes'),
      icon: changesTabIcon,
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
