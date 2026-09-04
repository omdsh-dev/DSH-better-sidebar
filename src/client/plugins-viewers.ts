/**
 * The built-in catalog of FILE-PREVIEWER plugins (file-type previewers),
 * shown in the "add preview plugin" modal (Side card settings → 文件预览
 * grid → the dashed card). Adding an entry: append one object here (unique
 * `id` = npm package name, `name` / `description` = i18n-friendly (add a
 * `pluginXxxName` / `pluginXxxDesc` key in locales.ts), `url` = GitHub repo,
 * `install` = the full shell command pre-filled into the
 * install terminal — it starts with `cd ~/.dsh` so the install runs with
 * the DSH home as the working directory). Data integrity is guarded by
 * `tests/plugin-list.spec.ts`.
 */
import { t } from './locales.ts'
import type { PluginEntry } from './plugins-shared.ts'

/** File-previewer plugins (alphabetical order). */
export const builtinViewerPlugins: readonly PluginEntry[] = [
  {
    id: '@huanlin/dsh-plugin-better-sidebar-plugin-office',
    name: () => t('pluginOfficeName'),
    url: 'https://github.com/HuanLinOTO/dsh-plugin-better-sidebar-plugin-office',
    description: () => t('pluginOfficeDesc'),
    install: 'cd ~/.dsh && dsh plugin --profile web add @huanlin/dsh-plugin-better-sidebar-plugin-office',
  },
  {
    id: 'dsh-md-export',
    name: () => t('pluginMdExportName'),
    url: 'https://github.com/AnakinCao/dsh-md-export',
    description: () => t('pluginMdExportDesc'),
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-md-export',
  },
  {
    id: 'dsh-code-nav',
    name: () => t('pluginCodeNavName'),
    url: 'https://github.com/AnakinCao/dsh-code-nav',
    description: () => t('pluginCodeNavDesc'),
    install: 'cd ~/.dsh && dsh plugin --profile web add https://github.com/AnakinCao/dsh-code-nav.git',
  },
  {
    id: 'dsh-video-preview',
    name: () => t('pluginVideoPreviewName'),
    url: 'https://github.com/zemul/dsh-video-preview',
    description: () => t('pluginVideoPreviewDesc'),
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-video-preview',
  },
]
