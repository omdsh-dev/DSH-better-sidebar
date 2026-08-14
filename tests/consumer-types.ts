/**
 * Consumer-facing type surface compile gate (v0.12.0+): this file exercises
 * EVERY public type and descriptor field exactly the way an external plugin
 * would, so `pnpm typecheck` fails the moment the shipped declaration
 * surface (service.ts re-exports / descriptor fields / service methods)
 * drifts from what consumers can name. Type-only — erased at runtime, never
 * executed by vitest (no `*.spec` suffix).
 *
 * Mirrors the "external consumer" fixture: what is importable here from
 * `../src/client/service.ts` must also be importable from
 * `dsh-better-sidebar/client/service` in the built package.
 */
import type {} from '../src/client/service.ts'
import {
  SIDEBAR_FEATURES,
  SIDEBAR_SERVICE_VERSION,
} from '../src/client/service.ts'
import type {
  BetterSidebarService,
  FileFetchStrategy,
  FileViewerDescriptor,
  FileViewerProps,
  OpenTabSeed,
  SidebarSettingsDeclaration,
  SidebarSettingsRenderProps,
  SidebarSettingToggle,
  SidebarSettingToggleType,
  TabComponentProps,
  TabDescriptor,
} from '../src/client/service.ts'
import type {
  SessionScope,
  SidebarDiffRef,
  SidebarPrefs,
  SidebarSnapshot,
  SidebarState,
  SidebarStore,
  SidebarTab,
  TabType,
} from '../src/client/service.ts'

/** A full-featured external tab descriptor using every v0.12.0 field. */
const tab: TabDescriptor = {
  id: 'my-plugin:db',
  title: () => 'Database',
  icon: (size: number) => null,
  order: 50,
  hidden: false,
  available: (ctx, scope, state) => scope.sessionId !== '' && state.panelOpen && ctx !== null,
  single: false,
  dedupeKey: (t: SidebarTab) => t.id,
  createTab: (state: SidebarState) => ({
    tab: { id: `my-plugin:db:${state.nextTerminal}`, type: 'my-plugin:db', title: 'DB', meta: { n: state.nextTerminal } },
    patch: { nextTerminal: state.nextTerminal + 1 },
  }),
  badge: (ctx, scope, state) => (state.expanded.length > 0 ? state.expanded.length : null),
  onOpen: (tab: SidebarTab, scope: SessionScope) => { void tab; void scope },
  onActivate: (tab: SidebarTab, scope: SessionScope) => { void tab; void scope },
  onClose: (tab: SidebarTab, scope: SessionScope) => { void tab; void scope },
  settings: {
    toggles: [{ key: 'autoOpenSubagent', title: 'Auto-open', type: 'switch' }],
    pluginToggles: [{
      key: 'pageSize',
      title: 'Page size',
      type: 'number',
      min: 1,
      max: 100,
      unit: 'rows',
    }],
    render: (props: SidebarSettingsRenderProps) => {
      props.updatePluginSetting('refresh', true)
      props.close()
      return null
    },
  },
  component: (props: TabComponentProps) => {
    const { ctx, store, scope, tab, visible } = props
    void ctx; void store; void scope; void tab; void visible
    return null
  },
}

/** A full-featured external viewer using the v0.12.0 load signal. */
const viewer: FileViewerDescriptor = {
  id: 'my-plugin:csv',
  title: 'CSV',
  exts: ['csv'],
  priority: 10,
  fetchStrategy: 'custom',
  detect: (_path, head: Uint8Array) => head.length > 0,
  load: async (path: string, scope: SessionScope, signal?: AbortSignal) => {
    void path; void scope; void signal
    return { rows: [] }
  },
  settings: { pluginToggles: [{ key: 'delimiter', title: 'Delimiter', type: 'text', placeholder: ',' }] },
  component: (props: FileViewerProps) => {
    const { customData, content, truncated, mediaUrl, viewerId, path, title } = props
    void customData; void content; void truncated; void mediaUrl; void viewerId; void path; void title
    return null
  },
}

/** The full service surface, exercised exactly as consumers call it. */
declare const ctx: { betterSidebar: BetterSidebarService }
const service: BetterSidebarService = ctx.betterSidebar
service.registerTab(tab)
service.registerFileViewer(viewer)
service.getTabs()
service.getFileViewers()
service.getTab('my-plugin:db')
service.isTabEnabled('my-plugin:db')
service.isViewerEnabled('my-plugin:csv')
service.matchFileViewer('a.csv', new Uint8Array([1]))
service.closeTab('tab:1')
service.subscribe(() => {})
const seed: OpenTabSeed = { type: 'my-plugin:db', title: 'DB', path: '/p', id: 'x', meta: { a: 1 } }
service.openTab(seed)
service.openTab(seed, { sessionId: 's1', cwd: '/p' })
service.version
service.features.includes('badge')
const snapshot: SidebarSnapshot | undefined = service.getSnapshot()
void snapshot
service.subscribeState(() => {})
service.updateTab('tab:1', { title: 'T', path: '/p', meta: 1 })
service.activateTab('tab:1')
service.openFile({ sessionId: 's1', cwd: '/p' }, '/p/a.csv', 'Data')

/** Named state vocabulary stays importable (the pre-0.12 gap). */
const diff: SidebarDiffRef = { kind: 'worktree', path: '/p/a.ts', staged: false }
const prefs: SidebarPrefs = { ...({} as SidebarPrefs) }
const store: SidebarStore = null as unknown as SidebarStore
const toggleType: SidebarSettingToggleType = 'number'
const toggle: SidebarSettingToggle = { key: 'k', title: 'K', type: toggleType }
const declaration: SidebarSettingsDeclaration = { toggles: [toggle], pluginToggles: [toggle] }
const typeName: TabType = 'my-plugin:db'
const version: string = SIDEBAR_SERVICE_VERSION
const features: readonly string[] = SIDEBAR_FEATURES
void version; void features
const strategy: FileFetchStrategy = 'mediaUrl'
void diff; void prefs; void store; void declaration; void typeName; void strategy
