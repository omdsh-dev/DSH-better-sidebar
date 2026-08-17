/**
 * Built-in registration tests: the plugin registers 6 tabs and 6 file
 * viewers through the same service external plugins use (dogfooding);
 * the catch-all `code` viewer, the NUL-sniffing `binary-download` viewer,
 * and the html sandbox settings pin the registry's behavior. (Office
 * previews are NOT built in — they moved to the recommended office plugin,
 * see src/client/plugins-viewers.ts.)
 */
import { describe, expect, it } from 'vitest'
// First import: browser globals before the xterm-carrying builtin graph loads.
import './browser-globals.ts'

import type { Context } from '../src/context-types.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { allLeaves } from '../src/client/state.ts'
import { registerBuiltins } from '../src/client/builtins/index.ts'

function setup(): { service: ReturnType<typeof createBetterSidebarService>; store: ReturnType<typeof createSidebarStore>; dispose: () => void } {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  const dispose = registerBuiltins({} as Context, service)
  return { service, store, dispose }
}

describe('built-in tab registrations', () => {
  it('registers the 6 built-in tabs', () => {
    const { service } = setup()
    expect(service.getTabs().map(t => t.id).sort()).toEqual(
      ['browser', 'diff', 'editor', 'git', 'subagent', 'terminal'],
    )
  })

  it('only diff is hidden from the + menu; editor is the visible files window (order 10)', () => {
    const { service } = setup()
    expect(service.getTabs().filter(t => t.hidden).map(t => t.id)).toEqual(['diff'])
    const editor = service.getTab('editor')
    expect(editor?.hidden).toBe(false)
    expect(editor?.order).toBe(10)
  })

  it('single-instance tabs use the single sugar', () => {
    const { service } = setup()
    for (const id of ['git', 'subagent']) {
      expect(service.getTab(id)?.single).toBe(true)
    }
  })

  it('the subagent tab declares its auto-open related settings', () => {
    const { service } = setup()
    const toggles = service.getTab('subagent')?.settings?.toggles ?? []
    expect(toggles.map(t => t.key)).toEqual(['autoOpenSubagent', 'autoOpenJobs'])
  })

  it('the editor tab declares its merged-mode (embedded file tree) setting', () => {
    const { service } = setup()
    const toggles = service.getTab('editor')?.settings?.toggles ?? []
    expect(toggles.map(t => t.key)).toEqual(['editorExplorer'])
    expect(toggles[0]?.title).toBeDefined()
    expect(toggles[0]?.desc).toBeDefined()
    // The merged mode is an iconed select (merged vs separate), not a switch.
    expect(toggles[0]?.type).toBe('select')
    const options = toggles[0]?.options ?? []
    expect(options.map(o => o.value)).toEqual([true, false])
    expect(options.every(o => o.icon !== undefined && o.title !== undefined)).toBe(true)
  })

  it('the terminal tab declares the model terminal-tools, auto-terminal and custom-font settings', () => {
    const { service } = setup()
    const toggles = service.getTab('terminal')?.settings?.toggles ?? []
    expect(toggles.map(t => t.key)).toEqual(['agentTerminalTools', 'bottomPanelAutoTerminal', 'terminalFontFamily', 'terminalFontSize'])
    // The font rows are text/number inputs (not switches), with the size
    // row bounded by the shared 9–32 contract.
    expect(toggles[2]?.type).toBe('text')
    expect(toggles[2]?.title).toBeDefined()
    expect(toggles[2]?.placeholder).toBeDefined()
    expect(toggles[3]?.type).toBe('number')
    expect(toggles[3]?.min).toBe(9)
    expect(toggles[3]?.max).toBe(32)
    expect(toggles[3]?.unit).toBe('px')
    // The first two rows stay plain boolean switches.
    expect(toggles[0]?.type ?? 'switch').toBe('switch')
    expect(toggles[1]?.type ?? 'switch').toBe('switch')
  })

  it('the browser tab declares its sandbox, link-takeover master and per-protocol settings', () => {
    const { service } = setup()
    const toggles = service.getTab('browser')?.settings?.toggles ?? []
    expect(toggles.map(t => t.key)).toEqual([
      'browserNoSandbox',
      'browserInterceptLinks',
      'browserInterceptHttp',
      'browserInterceptHttps',
    ])
    for (const toggle of toggles) {
      expect(toggle.title).toBeDefined()
      expect(toggle.desc).toBeDefined()
    }
  })

  it('the browser createTab mints browser:<n> ids and bumps nextBrowser', () => {
    const { service, store } = setup()
    store.setSession('s1')
    service.openTab({ type: 'browser' })
    service.openTab({ type: 'browser' })
    const state = store.getSnapshot().state!
    const tabs = allLeaves(state.splits).flatMap(leaf => leaf.tabs).filter(t => t.type === 'browser')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]!.id).toBe('browser:1')
    expect(tabs[1]!.id).toBe('browser:2')
    expect(state.nextBrowser).toBe(3)
  })

  it('every built-in tab carries the settings-surface icon', () => {
    const { service } = setup()
    for (const tab of service.getTabs()) {
      expect(tab.icon, tab.id).toBeDefined()
    }
  })
})

describe('built-in file viewer registrations', () => {
  it('registers the 6 built-in file viewers (office previews live in the recommended office plugin)', () => {
    const { service } = setup()
    expect(service.getFileViewers().map(v => v.id).sort()).toEqual(
      ['binary-download', 'code', 'html', 'image', 'markdown', 'pdf'],
    )
    // Office previews are not built in: docx/xlsx/pptx files fall through to
    // the download-only binary viewer (or a registered office plugin).
    expect(service.getFileViewers().map(v => v.id)).not.toContain('docx')
    expect(service.getFileViewers().map(v => v.id)).not.toContain('xlsx')
    expect(service.getFileViewers().map(v => v.id)).not.toContain('pptx')
  })

  it('code is the catch-all at the lowest priority', () => {
    const { service } = setup()
    const code = service.getFileViewers().find(v => v.id === 'code')
    expect(code?.exts).toEqual([])
    expect(code?.priority).toBe(-100)
    expect(code?.fetchStrategy).toBe('fsRead')
    expect(service.matchFileViewer('anything.zzz')?.id).toBe('code')
  })

  it('markdown claims md/markdown before the catch-all', () => {
    const { service } = setup()
    expect(service.matchFileViewer('readme.md')?.id).toBe('markdown')
    expect(service.matchFileViewer('readme.markdown')?.id).toBe('markdown')
    expect(service.matchFileViewer('readme.md', new Uint8Array([0x61]))?.id).toBe('markdown')
  })

  it('html claims html/htm before the catch-all', () => {
    const { service } = setup()
    expect(service.matchFileViewer('index.html')?.id).toBe('html')
    expect(service.matchFileViewer('page.htm')?.id).toBe('html')
    expect(service.matchFileViewer('index.html', new Uint8Array([0x3c, 0x21]))?.id).toBe('html')
    expect(service.matchFileViewer('index.HTML')?.id).toBe('html')
  })

  it('the html viewer declares its sandbox and default-unsafe related settings', () => {
    const { service } = setup()
    const toggles = service.getFileViewers().find(v => v.id === 'html')?.settings?.toggles ?? []
    expect(toggles.map(t => t.key)).toEqual(['htmlViewerNoSandbox', 'htmlViewerDefaultUnsafe'])
    expect(toggles[0]?.title).toBeDefined()
    expect(toggles[0]?.desc).toBeDefined()
    expect(toggles[1]?.title).toBeDefined()
    expect(toggles[1]?.desc).toBeDefined()
  })

  it('binary-download claims legacy office by extension (office previews are not built in)', () => {
    const { service } = setup()
    expect(service.matchFileViewer('old.doc')?.id).toBe('binary-download')
    expect(service.matchFileViewer('old.xls')?.id).toBe('binary-download')
    expect(service.matchFileViewer('old.ppt')?.id).toBe('binary-download')
    // Modern office files (zip containers, NUL-free) fall through to the
    // catch-all code viewer without an office plugin registered.
    expect(service.matchFileViewer('book.docx', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))?.id).toBe('code')
  })

  it('binary-download NUL detect claims unknown-extension binaries over code', () => {
    const { service } = setup()
    // First match (no head) falls to the catch-all code viewer...
    expect(service.matchFileViewer('blob.zzz')?.id).toBe('code')
    // ...but the head re-match (NUL probe) routes it to binary-download.
    expect(service.matchFileViewer('blob.zzz', new Uint8Array([0x01, 0x00, 0x02]))?.id).toBe('binary-download')
    // A NUL-free blob stays with code.
    expect(service.matchFileViewer('blob.zzz', new Uint8Array([0x61, 0x62]))?.id).toBe('code')
  })

  it('every built-in viewer carries the declarative settings surface (title + icon)', () => {
    const { service } = setup()
    for (const viewer of service.getFileViewers()) {
      expect(viewer.title, viewer.id).toBeDefined()
      expect(viewer.icon, viewer.id).toBeDefined()
    }
  })
})

describe('built-in disposer', () => {
  it('unregisters everything (HMR-safe)', () => {
    const { service, dispose } = setup()
    dispose()
    expect(service.getTabs()).toHaveLength(0)
    expect(service.getFileViewers()).toHaveLength(0)
    // The disposer is idempotent.
    dispose()
  })
})
