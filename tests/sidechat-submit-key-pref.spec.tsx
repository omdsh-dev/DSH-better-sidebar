// @vitest-environment jsdom
/**
 * The side-chat composer's submit key as a USER PREFERENCE.
 *
 * CONTRACT PINNED HERE (the whole configuration chain, in one file):
 *
 * 1. Default — a document that never chose one reads `'enter'`, and so does a
 *    side-chat blob that carries no `submitKey`.
 * 2. Validation — `parsePrefs` (the client's typed face over the settings
 *    wire) normalizes the stored value to a known mode: `'mod-enter'` survives
 *    verbatim, anything else (an unknown string, a number, null) falls back to
 *    `'enter'`. The open plugin-settings map is otherwise untouched, and a
 *    malformed map still parses to the defaults.
 * 3. The feed — the value reaches `SideChatView` through the side-chat tab
 *    descriptor's own component (`SideChatTab`): mounting it with a store
 *    whose prefs say `'mod-enter'` makes a bare Enter insert a newline and
 *    Cmd+Enter send, and a live prefs write flips an ALREADY MOUNTED tab back
 *    to Enter-submits. The write side is the descriptor's settings row, which
 *    must target the same key the reader uses.
 *
 * The stored preference is feature-scoped (`pluginSettings.sidechat.submitKey`)
 * — the repository's seam for a tab's own settings, rendered by the settings
 * page from `settings.pluginToggles` and persisted through the same settings
 * route. It deliberately adds no top-level `SidebarPrefs` field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'
import { loadPrefs, sidechatSubmitKeyOf, type SidebarSettingsClient } from '../src/client/prefs.ts'
import {
  SIDEBAR_PREFS_DEFAULTS,
  SIDECHAT_PREFS_ID,
  SIDECHAT_SUBMIT_KEY_SETTING,
  parseSidechatSubmitKey,
  type SidebarPrefs,
} from '../src/prefs-shared.ts'
import { builtinTabs } from '../src/client/builtins/tabs.tsx'
import { FeatureSettingsRows, SettingsBody } from '../src/client/SideCardSection.tsx'
import { t } from '../src/client/locales.ts'
import type { Context, SidebarSessionList } from '../src/context-types.ts'
import type { SidebarStore } from '../src/client/state.ts'
import type { BetterSidebarService } from '../src/client/service.ts'

setupReactAct()

/** A fake settings wire face whose settingsGet resolves to one raw value. */
const wire = (value: unknown): SidebarSettingsClient => ({
  settingsGet: async () => ({ value, revision: 1 }),
  settingsUpdate: async () => ({ value, revision: 2 }),
})

/** The side-chat descriptor as the service would register it. */
function sidechatDescriptor() {
  const descriptor = builtinTabs({} as Context).find(tab => tab.id === SIDECHAT_PREFS_ID)
  if (descriptor === undefined) throw new Error('the side-chat tab descriptor is missing')
  return descriptor
}

describe('side-chat submit key — defaults and validation (prefs layer)', () => {
  it('defaults to Enter when the document never chose a submit key', async () => {
    expect(SIDECHAT_SUBMIT_KEY_SETTING).toBe('submitKey')
    expect(sidechatSubmitKeyOf(await loadPrefs(wire({})))).toBe('enter')
    // A blob that exists but carries no mode materializes the default.
    const prefs = await loadPrefs(wire({ pluginSettings: { sidechat: {} } }))
    expect(prefs.pluginSettings.sidechat).toEqual({ submitKey: 'enter' })
    expect(sidechatSubmitKeyOf(prefs)).toBe('enter')
  })

  it('keeps a stored mode and normalizes every other value to Enter', async () => {
    expect(sidechatSubmitKeyOf(await loadPrefs(wire({
      pluginSettings: { sidechat: { submitKey: 'mod-enter' } },
    })))).toBe('mod-enter')
    expect(sidechatSubmitKeyOf(await loadPrefs(wire({
      pluginSettings: { sidechat: { submitKey: 'enter' } },
    })))).toBe('enter')
    // Unknown / malformed values fall back instead of reaching the composer.
    for (const stored of ['cmd-enter', 'Enter', 42, null, { mode: 'mod-enter' }, ['mod-enter']]) {
      const prefs = await loadPrefs(wire({ pluginSettings: { sidechat: { submitKey: stored } } }))
      expect(prefs.pluginSettings.sidechat?.submitKey, JSON.stringify(stored)).toBe('enter')
      expect(sidechatSubmitKeyOf(prefs), JSON.stringify(stored)).toBe('enter')
    }
    // The pure parser answers the same way.
    expect(parseSidechatSubmitKey('mod-enter')).toBe('mod-enter')
    expect(parseSidechatSubmitKey(undefined)).toBe('enter')
    expect(parseSidechatSubmitKey('bogus')).toBe('enter')
  })

  it('leaves other features\' plugin settings alone and still tolerates a malformed map', async () => {
    const prefs = await loadPrefs(wire({
      pluginSettings: { git: { commitModel: 'deepseek/x' } },
    }))
    expect(prefs.pluginSettings).toEqual({ git: { commitModel: 'deepseek/x' } })
    expect(sidechatSubmitKeyOf(prefs)).toBe('enter')
    // A non-object map is the existing fallback: defaults, no invention.
    expect((await loadPrefs(wire({ pluginSettings: 'nope' }))).pluginSettings).toEqual({})
    expect(sidechatSubmitKeyOf(SIDEBAR_PREFS_DEFAULTS)).toBe('enter')
  })

  it('the settings page writes the same key the composer reads', () => {
    const rows = sidechatDescriptor().settings?.pluginToggles ?? []
    expect(rows.map(row => row.key)).toEqual([SIDECHAT_SUBMIT_KEY_SETTING])
    const row = rows[0]
    if (row === undefined) throw new Error('the submit-key settings row is missing')
    expect(row.type).toBe('select')
    expect((row.options ?? []).map(option => option.value)).toEqual(['enter', 'mod-enter'])
  })

  it('renders the row as a working dropdown over the stored mode', async () => {
    // The settings page's own renderer over the side-chat descriptor's rows, fed
    // the descriptor's blob exactly the way SettingsBody feeds a plugin row.
    const prefs = await loadPrefs(wire({ pluginSettings: { sidechat: { submitKey: 'mod-enter' } } }))
    const committed: unknown[] = []
    const view = renderRoot(createElement(FeatureSettingsRows, {
      toggles: sidechatDescriptor().settings?.pluginToggles ?? [],
      prefs,
      onToggle: () => {},
      onSelectValue: (_toggle, next) => { committed.push(next) },
      valueSource: (key: string) => prefs.pluginSettings[SIDECHAT_PREFS_ID]?.[key],
    }))

    // The closed control shows the STORED mode (not a hard-coded default) and
    // advertises itself as a listbox the user can open.
    const anchor = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')
    if (anchor === null) throw new Error('the submit-key dropdown is missing')
    expect(anchor.textContent).toContain(t('settingsSidechatSubmitModEnter'))

    // Opening it offers both modes; picking Enter commits the value the reader
    // (sidechatSubmitKeyOf) consumes.
    act(() => { anchor.click() })
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const enterItem = items.find(item => item.textContent?.includes(t('settingsSidechatSubmitEnter')))
    if (enterItem === undefined) throw new Error('the Enter option is missing from the dropdown')
    act(() => { enterItem.click() })
    expect(committed).toEqual(['enter'])

    view.unmount()
  })

  it('shows the effective default in the settings page before anything was stored', async () => {
    // The reviewed gap: a fresh document carries no `pluginSettings.sidechat`
    // blob, so a plugin row that reads only the blob renders its "no value"
    // placeholder — even though the composer really sends on Enter. The row
    // must SHOW the effective mode, and follow a stored one afterwards.
    const anchorText = (prefs: SidebarPrefs): string => {
      const view = renderRoot(createElement(SettingsBody, {
        feature: sidechatDescriptor(),
        prefs,
        store: {} as SidebarStore,
        service: {} as BetterSidebarService,
        onToggle: () => {},
        onCommit: () => '',
        onSelectValue: () => {},
        onPatterns: () => {},
        onPluginToggle: () => {},
        onPluginCommit: () => '',
        onPluginSelectValue: () => {},
        onPluginPatterns: () => {},
        onPluginWrite: () => {},
        onClose: () => {},
      }))
      const anchor = view.container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')
      if (anchor === null) throw new Error('the submit-key dropdown is missing')
      const text = (anchor.textContent ?? '').trim()
      view.unmount()
      return text
    }

    expect(anchorText(await loadPrefs(wire({})))).toBe(t('settingsSidechatSubmitEnter'))
    expect(anchorText(await loadPrefs(wire({
      pluginSettings: { sidechat: { submitKey: 'mod-enter' } },
    })))).toBe(t('settingsSidechatSubmitModEnter'))
  })
})

/** The thread rows the mounted view needs from the host's session list. */
function listSnapshot(): SidebarSessionList {
  return {
    byId: {
      root: { id: 'root', cwd: '/p', displayTitle: '主会话', running: false },
      t1: { id: 't1', cwd: '/p', displayTitle: 'Side: 线程一', origin: 'subagent', parentId: 'root', running: false },
    },
    projectionsBySession: {
      root: {
        values: {
          subagentCatalog: [{ id: 't1', createdAt: 1_000, mode: 'continuable', label: 'Side: 线程一' }],
        },
        state: 'ready',
        error: null,
      },
    },
  }
}

/** The smallest sidebar store `SideChatTab` consumes: its live prefs snapshot. */
function prefsStore(initial: SidebarPrefs): { store: SidebarStore, set: (next: SidebarPrefs) => void } {
  const listeners = new Set<() => void>()
  let snapshot = { prefs: initial }
  return {
    store: {
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getSnapshot: () => snapshot,
    } as unknown as SidebarStore,
    set: (next: SidebarPrefs) => {
      snapshot = { prefs: next }
      for (const listener of listeners) listener()
    },
  }
}

let harness: SidechatHarness

beforeEach(() => {
  // The harness installs the fetch / WebSocket / locale globals the view needs;
  // this spec mounts the DESCRIPTOR's component against its own ctx + store.
  harness = installSidechatHarness({
    events: [
      { type: 'session/end-seed', seq: 0, time: 0, data: {} },
      { type: 'user/message', seq: 1, time: 1_000, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    ],
  })
})

afterEach(() => {
  harness.cleanup()
})

/** Mount the side-chat tab body the service would render. */
function mountSidechatTab(store: SidebarStore): RenderedRoot {
  // A STABLE snapshot: useSyncExternalStore re-renders forever when the getter
  // mints a new object on every read.
  const list = listSnapshot()
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => list,
        subscribe: (_fn: () => void) => () => {},
      },
    },
    get: (key: string) => (key === 'betterSidebar' ? { openTab: vi.fn(), updateTab: vi.fn() } : undefined),
  } as unknown as Context
  const component = sidechatDescriptor().component
  return renderRoot(createElement(component, {
    ctx,
    store,
    scope: { sessionId: 'root', cwd: '/p' },
    tab: { id: 'tab1', type: 'sidechat', title: '线程一', meta: { threadId: 't1' } },
    visible: true,
  }))
}

/** The composer's textarea in a mounted tab body. */
function composerField(view: RenderedRoot): HTMLTextAreaElement {
  const field = view.container.querySelector('textarea')
  if (field === null) throw new Error('the composer textarea is missing')
  return field
}

/** Type into the composer the way a user does (bypass React's value tracker). */
function typeComposer(view: RenderedRoot, text: string): void {
  const field = composerField(view)
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Dispatch one Enter (with modifiers) at the composer. */
function pressEnter(field: HTMLTextAreaElement, init: { meta?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    metaKey: init.meta === true,
  })
  act(() => { field.dispatchEvent(event) })
  return event
}

describe('side-chat submit key — the pref feeds the mounted view', () => {
  it('mounts in mod-enter mode from the stored preference and follows a live change', async () => {
    const initial = await loadPrefs(wire({ pluginSettings: { sidechat: { submitKey: 'mod-enter' } } }))
    const { store, set } = prefsStore(initial)
    const view = mountSidechatTab(store)
    for (let round = 0; round < 2; round += 1) await act(async () => {})

    // mod-enter: a bare Enter is a newline, never a send.
    typeComposer(view, 'from prefs')
    const bare = pressEnter(composerField(view))
    await act(async () => {})
    expect(harness.promptCalls, 'a bare Enter must not send in mod-enter mode').toEqual([])
    expect(bare.defaultPrevented, 'a bare Enter keeps its newline').toBe(false)
    expect(composerField(view).value).toBe('from prefs')

    // The chord sends, through the real sidechat.prompt route.
    pressEnter(composerField(view), { meta: true })
    for (let round = 0; round < 2; round += 1) await act(async () => {})
    expect(harness.promptCalls.map(call => call.text)).toEqual(['from prefs'])

    // A settings write reaches the ALREADY MOUNTED tab: Enter sends again.
    typeComposer(view, 'after switch')
    act(() => { set({ ...initial, pluginSettings: { sidechat: { submitKey: 'enter' } } }) })
    const plain = pressEnter(composerField(view))
    for (let round = 0; round < 2; round += 1) await act(async () => {})
    expect(harness.promptCalls.map(call => call.text)).toEqual(['from prefs', 'after switch'])
    expect(plain.defaultPrevented, 'the submitting Enter is consumed').toBe(true)

    view.unmount()
  })
})
