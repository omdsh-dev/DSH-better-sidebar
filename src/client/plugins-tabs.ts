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
    id: 'dsh-better-overleaf',
    name: () => t('pluginBetterOverleafName'),
    url: 'https://github.com/Hoemr/dsh-better-overleaf',
    description: () => t('pluginBetterOverleafDesc'),
    // Published on npm; peer-depends on dsh-better-sidebar (Overleaf tab),
    // so the install line installs the prerequisite first.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add dsh-better-overleaf',
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
    url: 'https://github.com/thirsty5034/dsh-git-forge',
    description: () => t('pluginGitForgeDesc'),
    // Peer-depends on dsh-better-sidebar (Git Forge tab). Install the
    // prerequisite first; package is GitHub-sourced until npm publish.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add "dsh-git-forge@github:thirsty5034/dsh-git-forge"',
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
    url: 'https://github.com/thirsty5034/dsh-ssh-tunnel',
    description: () => t('pluginSshTunnelDesc'),
    // Peer-depends on dsh-better-sidebar (SSH Tunnel tab + center terminal/SFTP).
    // Install the prerequisite first; package is GitHub-sourced until npm publish.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar && dsh plugin --profile web add "dsh-ssh-tunnel@github:thirsty5034/dsh-ssh-tunnel"',
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
    // peer of better-sidebar, published on npm. Stable-line policy: the
    // plugin validates against better-sidebar 0.17.x + DSH 0.1.1-rc.x; npm
    // latest (0.18.0) targets DSH 0.1.2-rc.1+ and is not co-tested yet, so
    // the prerequisite is pinned to 0.17.1.
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar@0.17.1 && dsh plugin --profile web add dsh-turn-outline',
  },
]
