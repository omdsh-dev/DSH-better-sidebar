/**
 * The built-in catalog of TAB-registration plugins (sidebar pages),
 * shown in the "add tab plugin" modal (Side card settings → 侧边栏内容 grid
 * → the dashed card). Adding an entry: append one object here (unique
 * `id` = npm package name, `name` / `description` = i18n-friendly (add a
 * `pluginXxxName` / `pluginXxxDesc` key in locales.ts), `url` = GitHub repo,
 * `install` = the full one-line install script — it starts with `cd ~/.dsh`
 * so the install runs with the DSH home as the working directory). Data
 * integrity is guarded by `tests/plugin-list.spec.ts`.
 */
import { t } from './locales.ts'
import type { PluginEntry } from './plugins-shared.ts'

/** Tab-registration plugins (alphabetical order). */
export const builtinTabPlugins: readonly PluginEntry[] = [
  {
    id: '@dsh-external/dsh-sentinel',
    name: () => t('pluginSentinelName'),
    url: 'https://github.com/fuhefei/dsh-sentinel',
    description: () => t('pluginSentinelDesc'),
    // The official one-line bundle-channel install (git source, build
    // artifacts committed — no build step needed). The `github:…` form is
    // the upstream's documented command, `cd ~/.dsh` keeps the profile
    // context consistent with the other entries.
    install: 'cd ~/.dsh && dsh plugin --profile web add "github:fuhefei/dsh-sentinel#v0.7.0"',
  },
  {
    id: '@dsh-external/ego-browser',
    name: () => t('pluginEgoBrowserName'),
    url: 'https://github.com/Fisfzy/ego-browser',
    description: () => t('pluginEgoBrowserDesc'),
    // Registers a sidebar tab for the agent browser; optional peer of
    // better-sidebar (auto-tab when present, floating bubble when not).
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add git+https://github.com/Fisfzy/ego-browser.git',
  },
  {
    id: '@modusensus/dsh-mneme',
    name: () => t('pluginMnemeName'),
    url: 'https://github.com/modusensus/dsh-mneme',
    description: () => t('pluginMnemeDesc'),
    // Dual-mount like flowglass — registers a native "Memory Library" tab
    // (memories/entities/status/settings views) when better-sidebar is
    // present and keeps its standalone sidebar sheet as a fallback.
    // Published on npm (scoped); install the prerequisite first.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add @modusensus/dsh-mneme',
  },
  {
    id: 'dsh-agent-persona',
    name: () => t('pluginAgentPersonaName'),
    url: 'https://github.com/Awoodwhale/dsh-agent-persona',
    description: () => t('pluginAgentPersonaDesc'),
    // Scopes system-prompt personas by workspace or session and serves them from a
    // 「人设」tab (with its own settings page). The tab registers through this plugin's
    // service, so better-sidebar is installed first; the package is on npm, so the
    // install line needs no git form.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add dsh-agent-persona',
  },
  {
    id: 'dsh-better-overleaf',
    name: () => t('pluginBetterOverleafName'),
    url: 'https://github.com/Hoemr/dsh-better-overleaf',
    description: () => t('pluginBetterOverleafDesc'),
    // Published on npm; peer-depends on dsh-better-sidebar (Overleaf tab),
    // so the install line installs the prerequisite first.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add dsh-better-overleaf',
  },
  {
    id: 'dsh-dev-git-graph',
    name: 'dsh-dev-git-graph 提交图',
    url: 'https://github.com/kp-z/dsh-dev-git-graph',
    description: () => t('pluginDevGitGraphDesc'),
    // Optional peer of dsh-better-sidebar (native tab + DiffTab reuse when
    // present, overlay fallback when not); published on npm.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add dsh-dev-git-graph',
  },
  {
    id: 'dsh-docs-panel',
    name: () => t('pluginDocsPanelName'),
    url: 'https://github.com/mlosun/dsh-docs-panel',
    description: () => t('pluginDocsPanelDesc'),
    // dsh-docs-panel hard-depends on dsh-better-sidebar (required peer), so
    // the install line installs the prerequisite first, then the plugin.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add dsh-docs-panel',
  },
  {
    id: 'dsh-tylina',
    name: () => t('pluginTylinaName'),
    url: 'https://github.com/tylina/dsh-tylina',
    description: () => t('pluginTylinaDesc'),
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add dsh-tylina',
  },
  {
    id: 'dsh-flowglass',
    name: () => t('pluginFlowglassName'),
    url: 'https://github.com/Iwctwbh/dsh-flowglass',
    description: () => t('pluginFlowglassDesc'),
    // Flowglass keeps its standalone drawer as a fallback and registers the
    // native tab automatically when better-sidebar is present.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add dsh-flowglass',
  },
  {
    id: 'dsh-git-forge',
    name: () => t('pluginGitForgeName'),
    url: 'https://github.com/OMSociety/dsh-git-forge',
    description: () => t('pluginGitForgeDesc'),
    // Peer-depends on dsh-better-sidebar (Git Forge tab). Install the
    // prerequisite first; the package is published on npm as dsh-git-forge.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add dsh-git-forge@1.0.0',
  },
  {
    id: 'dsh-git-remotes',
    name: () => t('pluginGitRemotesName'),
    url: 'https://github.com/yq04/dsh-git-remotes',
    description: () => t('pluginGitRemotesDesc'),
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add git+https://github.com/yq04/dsh-git-remotes.git',
  },
  {
    id: 'dsh-github-workbench',
    name: () => t('pluginGithubWorkbenchName'),
    url: 'https://github.com/meyaomiao/dsh-github-workbench',
    description: () => t('pluginGithubWorkbenchDesc'),
    // Full GitHub workbench tab: remote repo tree + Issues/PRs/Actions tabs
    // with write support (create/comment/merge/re-run). lib/ is committed,
    // so the pinned github:-form install works without a local build.
    install: 'cd ~/.dsh && dsh plugin --profile web add "github:meyaomiao/dsh-github-workbench#v0.1.0"',
  },
  {
    id: 'dsh-ide-git',
    name: () => t('pluginIdeGitName'),
    url: 'https://github.com/KannaKuron/dsh-ide-git',
    description: () => t('pluginIdeGitDesc'),
    // Published on npm. better-sidebar is an OPTIONAL peer: without it the
    // plugin registers into DSH's own right sidebar (ctx.sidebarRightTabs +
    // the keyed sidebar.right.pane.tab seat, with a guide capsule as the
    // entry), so the install line carries no prerequisite. A better-sidebar
    // that loads late takes the native registration down and hosts the tab
    // itself, so the two channels never draw the panel twice.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-ide-git',
  },
  {
    id: 'dsh-memory-delta',
    name: () => t('pluginDshMemoryDeltaName'),
    url: 'https://github.com/lpf20200901/dsh-memory-delta',
    description: () => t('pluginDshMemoryDeltaDesc'),
    // Cross-session memory for DSH: layered Markdown store in the workspace,
    // differential injection (only what changed), review-date reminders,
    // ranked search and a read-only sidebar tab. lib/ ships prebuilt, so the
    // pinned github:-form install needs no local build.
    install: 'cd ~/.dsh && dsh plugin --profile web add "github:lpf20200901/dsh-memory-delta#v1.0.0"',
  },
  {
    id: 'dsh-sidebar-qa',
    name: () => t('pluginSidebarQaName'),
    url: 'https://github.com/ChenRuoT/dsh-sidebar-qa',
    description: () => t('pluginSidebarQaDesc'),
    // dsh-sidebar-qa hard-depends on dsh-better-sidebar (required peer), so
    // the install line installs the prerequisite first, then the plugin.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add git+https://github.com/ChenRuoT/dsh-sidebar-qa.git',
  },
  {
    id: 'dsh-sidenote',
    name: () => t('pluginSidenoteName'),
    url: 'https://github.com/g-yixuan/dsh-sidenote',
    description: () => t('pluginSidenoteDesc'),
    // dsh-sidenote hard-depends on dsh-better-sidebar (required peer), so
    // the install line installs the prerequisite first, then the plugin.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add dsh-sidenote',
  },
  {
    id: 'dsh-server-deck',
    name: () => t('pluginServerDeckName'),
    url: 'https://github.com/meyaomiao/DSH-server-deck',
    description: () => t('pluginServerDeckDesc'),
    // Published on npm; dual-mount like flowglass — registers the native
    // "Servers" tab when better-sidebar is present, standalone drawer
    // otherwise. Install the prerequisite first.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add dsh-server-deck@latest',
  },
  {
    id: 'dsh-side-chat',
    name: 'Side Chat',
    url: 'https://github.com/xlennart/dsh-side-chat',
    description: 'Independent native DSH side conversation with a standalone split view and an optional Better Sidebar page; its own shortcut remains available in both modes.',
    // Better Sidebar is an optional peer: Side Chat remains fully usable on
    // its own, and registers this tab automatically when the peer is present.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add "github:xlennart/dsh-side-chat#v1.2.1"',
  },
  {
    id: 'dsh-suhuang-scroll',
    name: () => t('pluginSuhuangScrollName'),
    url: 'https://github.com/YZDame/dsh-suhuang-scroll',
    description: () => t('pluginSuhuangScrollDesc'),
    // Suhuang Scroll is a DSH Web plugin whose runtime console registers in
    // better-sidebar. Install the sidebar prerequisite before the npm package.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add dsh-suhuang-scroll',
  },
  {
    id: 'dsh-ssh-tunnel',
    name: () => t('pluginSshTunnelName'),
    url: 'https://github.com/OMSociety/dsh-ssh-tunnel',
    description: () => t('pluginSshTunnelDesc'),
    // Peer-depends on dsh-better-sidebar (SSH Tunnel tab + center terminal/SFTP).
    // Install the prerequisite first; the package is published on npm as dsh-ssh-tunnel.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add dsh-ssh-tunnel@1.0.0',
  },
  {
    id: 'dsh-turn-review',
    name: () => t('pluginTurnReviewName'),
    url: 'https://github.com/yq04/dsh-turn-review',
    description: () => t('pluginTurnReviewDesc'),
    // Needs dsh-better-sidebar (optional peer) for the tab; no model tools.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add git+https://github.com/yq04/dsh-turn-review.git',
  },
  {
    id: 'dsh-bilingual-reader',
    name: () => t('pluginBilingualReaderName'),
    url: 'https://github.com/Johnblur/dsh-bilingual-reader',
    description: () => t('pluginBilingualReaderDesc'),
    // Bilingual paper reading: a native-PDF tab with LLM selection translation,
    // isolated from the main conversation context. Hard-depends on the
    // better-sidebar tab service, so install the prerequisite first.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add github:Johnblur/dsh-bilingual-reader',
  },
  {
    id: 'dsh-turn-outline',
    name: () => t('pluginTurnOutlineName'),
    url: 'https://github.com/Andor-Z/dsh-turn-outline',
    description: () => t('pluginTurnOutlineDesc'),
    // Turn-outline tab: folds the session by user turns (input + tool steps
    // + output) with one-click jump-back into the conversation. Optional
    // peer of better-sidebar, published on npm. The plugin declares
    // `dsh-better-sidebar@^0.17.0 || ^0.18.0` and is co-tested on both
    // lines: better-sidebar 0.18.0 + DSH 0.1.2-rc.1 (since plugin 0.2.7)
    // and better-sidebar 0.17.1 + DSH 0.1.1-rc.x (stable).
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add dsh-turn-outline',
  },
]
