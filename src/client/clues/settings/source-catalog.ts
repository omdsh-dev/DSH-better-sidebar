/**
 * S8 source-plugin catalogue — the data behind "Add source plugin".
 *
 * The repository's generic AddPluginModal (`src/client/add-plugin-modal.tsx`,
 * with `plugins-tabs.ts` / `plugins-viewers.ts`) is outside this Spec's write
 * scope, so this module MIRRORS its `PluginEntry` shape instead of importing
 * the tab/viewer catalogues and dressing them up as source recommendations
 * (S8 §5: a normal tab plugin must never be presented as a source plugin).
 * The matching UI (`source-catalog-modal.tsx`) mirrors the same body: GitHub
 * topic button, search, category-grouped rows, jump-to-repo and
 * copy-install-command. Nothing here claims an installation succeeded.
 *
 * Today's seed entries are the source families the CORE plugin ships (GitHub
 * and Feishu); clue sources are registered by DSH plugins, and these two
 * currently ride `dsh-better-sidebar` itself. Their description says so and
 * their install command installs/updates the core plugin — installing a
 * source PLUGIN stays a different action from installing the CLI a source
 * needs (S2 owns that one; never substitute the profile command for it).
 *
 * S9 replacement path (recorded here so the mirror does not ossify): once S9
 * owns `add-plugin-modal.tsx`, extend `PluginKind` with `'source'`, point its
 * `catalogOf` at this array, and delete both this module and
 * `source-catalog-modal.tsx`; `SideCardSection` then renders the one generic
 * `AddPluginModal`. No other S8 surface depends on the catalogue internals.
 *
 * An external source plugin appends ONE entry here with its own npm/git
 * install command; the data integrity test (`tests/clues-settings-source-
 * catalog.spec.tsx`) pins unique ids, https repository URLs and the
 * `cd ~/.dsh && dsh plugin --profile web add …` install shape.
 */
import type { PluginEntry } from '../../plugins-shared.ts'

/** One curated source-plugin entry (same shape as the tab/viewer catalogs). */
export interface ClueSourceCatalogEntry extends PluginEntry {
  /** Source category heading (GitHub, Feishu, …), always present here. */
  readonly category: string | (() => string)
}

/**
 * The curated source-plugin catalogue, in display order.
 *
 * `id` is a stable CATALOG identity (not necessarily an npm package name: the
 * two built-in source families share the `dsh-better-sidebar` package). The
 * UI uses it as the React row key and as the copy-feedback key.
 */
export const builtinClueSourcePlugins: readonly ClueSourceCatalogEntry[] = [
  {
    id: 'builtin.github',
    name: 'GitHub Issues & PRs',
    url: 'https://github.com/omdsh-dev/DSH-better-sidebar',
    description: 'Issues and pull requests as clues, read through the shared gh CLI. Ships with dsh-better-sidebar as a built-in source: no separate source plugin is needed and the command installs or updates the core plugin. Installing this plugin does not install the gh CLI.',
    category: 'GitHub',
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar',
  },
  {
    id: 'builtin.feishu',
    name: 'Feishu Docs & Tasks',
    url: 'https://github.com/omdsh-dev/DSH-better-sidebar',
    description: 'Feishu documents, wiki pages and tasks as clues, read through the shared lark-cli connection. Ships with dsh-better-sidebar as a built-in source: no separate source plugin is needed and the command installs or updates the core plugin. Installing this plugin does not install lark-cli or authorize an account.',
    category: 'Feishu',
    install: 'cd ~/.dsh && dsh plugin --profile web add dsh-better-sidebar',
  },
]
