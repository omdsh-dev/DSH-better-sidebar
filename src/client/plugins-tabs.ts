/**
 * The built-in catalog of TAB-registration plugins (sidebar pages),
 * shown in the "add tab plugin" modal (Side card settings → 侧边栏内容 grid
 * → the dashed card). Adding an entry: append one object here (unique
 * `id` = npm package name, `url` = GitHub repo, `description` =
 * i18n-friendly (add a `pluginXxxDesc` key in locales.ts), `install` = the
 * full one-line install script — it starts with `cd ~/.dsh` so the install
 * runs with the DSH home as the working directory). Data integrity is
 * guarded by `tests/plugin-list.spec.ts`.
 */
import { t } from './locales.ts'
import type { PluginEntry } from './plugins-shared.ts'

/** Tab-registration plugins (alphabetical order). */
export const builtinTabPlugins: readonly PluginEntry[] = [
  {
    id: '@dsh-external/dsh-sentinel',
    name: 'dsh-sentinel 唤醒系统',
    url: 'https://github.com/fuhefei/dsh-sentinel',
    description: () => t('pluginSentinelDesc'),
    // The official one-line bundle-channel install (git source, build
    // artifacts committed — no build step needed). The `github:…` form is
    // the upstream's documented command, `cd ~/.dsh` keeps the profile
    // context consistent with the other entries.
    install: 'cd ~/.dsh && dsh plugin --profile web add "github:fuhefei/dsh-sentinel#v0.7.0"',
  },
]
