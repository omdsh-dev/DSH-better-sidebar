/**
 * Built-in registration tests: the plugin registers 5 tabs and 3 file
 * viewers through the same service external plugins use (dogfooding);
 * the catch-all `code` viewer and the html sandbox settings pin the
 * registry's behavior. The read-only previews (image / pdf /
 * binary-download) were yielded to the host's own document preview
 * (DSH 0.1.7 `ui-sidebar-documentpreview`) and legacy Office
 * doc/xls/ppt now fall through to the host too. (Office previews were
 * already NOT built in — they moved to the recommended office plugin,
 * see src/client/plugins-viewers.ts.) The git tab is the unified changes
 * tab (git lens + session lens, PR #471's file-trace merged in).
 */
import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { VscCommentDiscussion, VscGitCommit, VscLayers } from 'react-icons/vsc'
// First import: browser globals before the xterm-carrying builtin graph loads.
import './browser-globals.ts'

import type { Context } from '../src/context-types.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { planFsReadOutcome } from '../src/client/editor-load.ts'
import { createSidebarStore } from '../src/client/state.ts'
import { registerBuiltins } from '../src/client/builtins/index.ts'
import { parkSidechatReopen } from '../src/client/SideChatView.tsx'

function setup(): { service: ReturnType<typeof createBetterSidebarService>; store: ReturnType<typeof createSidebarStore>; dispose: () => void } {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  const dispose = registerBuiltins({} as Context, service)
  return { service, store, dispose }
}

describe('built-in tab registrations', () => {
  it('registers the 5 built-in tabs (the host owns terminal and browser)', () => {
    const { service } = setup()
    expect(service.getTabs().map(t => t.id).sort()).toEqual(
      ['diff', 'editor', 'git', 'sidechat', 'subagent'],
    )
  })

  it('the git (changes) tab is a single-instance badge-carrying visible tab', () => {
    const { service } = setup()
    const changes = service.getTab('git')
    expect(changes?.single).toBe(true)
    expect(changes?.hidden).not.toBe(true)
    expect(changes?.badge).toBeDefined()
    expect(changes?.component).toBeDefined()
  })

  it('every visible tab declares a non-empty, mutually distinct title', () => {
    // The title is the tab's identity in the native new-tab list (guide
    // page) and the tab strip: it must exist, and no two visible tabs may
    // share one (identical capsules would be indistinguishable).
    const { service } = setup()
    const visible = service.getTabs().filter(descriptor => descriptor.hidden !== true)
    expect(visible.length).toBeGreaterThan(0)
    for (const descriptor of visible) {
      const title = typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title
      expect(title, `${descriptor.id} must declare a title`).toBeTruthy()
    }
    const titles = visible.map(descriptor =>
      typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title)
    expect(new Set(titles).size, 'titles must differ per tab').toBe(visible.length)
  })

  it('every visible tab declares a non-empty, mutually distinct description', () => {
    // DSH 0.1.5-rc.1+ renders `description` under the title while the guide
    // lists at most 4 entries (a longer list drops every description). With
    // the host no longer substituting a generic fallback, a tab without one
    // renders the title alone — so every visible tab declares the real
    // purpose of its page, and no two may read identically.
    const { service } = setup()
    const visible = service.getTabs().filter(descriptor => descriptor.hidden !== true)
    expect(visible.length).toBeGreaterThan(0)
    for (const descriptor of visible) {
      expect(descriptor.description, `${descriptor.id} must declare a description`).toBeDefined()
      const line = typeof descriptor.description === 'function' ? descriptor.description() : descriptor.description
      expect(line, `${descriptor.id} description must be non-empty`).toBeTruthy()
    }
    const lines = visible.map(descriptor =>
      typeof descriptor.description === 'function' ? descriptor.description() : descriptor.description)
    expect(new Set(lines).size, 'descriptions must differ per tab').toBe(visible.length)
  })

  it('the changes tab declares no settings of its own (the diff always docks)', () => {
    const { service } = setup()
    expect(service.getTab('git')?.settings).toBeUndefined()
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

  it('the side chat tab sits between tasks and the removed terminal slot in the + menu', () => {
    const { service } = setup()
    const sidechat = service.getTab('sidechat')
    expect(sidechat?.order).toBe(35)
    expect(sidechat?.hidden).not.toBe(true)
  })

  it('side chat mints one tab per thread (Codex-style multi-instance)', () => {
    const { service } = setup()
    const sidechat = service.getTab('sidechat')
    expect(sidechat?.single).not.toBe(true)
    // A plain open mints a fresh autoCreate tab (the view creates the
    // thread on mount); two opens never collide. (createTab ignores the
    // state argument for sidechat — the cast stands in for it.)
    const first = sidechat?.createTab?.(undefined as never)
    const second = sidechat?.createTab?.(undefined as never)
    expect(first?.tab.meta).toEqual({ autoCreate: true })
    expect(first?.tab.id).not.toBe(second?.tab.id)
    // A parked reopen target mints the deterministic reattach tab, and
    // dedupeKey focuses an already-open thread instead of duplicating it.
    parkSidechatReopen('session-t1')
    const reopen = sidechat?.createTab?.(undefined as never)
    expect(reopen?.tab.id).toBe('sidechat:session-t1')
    expect(reopen?.tab.meta).toEqual({ threadId: 'session-t1' })
    expect(sidechat?.dedupeKey?.(reopen!.tab)).toBe('session-t1')
    expect(sidechat?.dedupeKey?.(first!.tab)).toBeUndefined()
  })

  it('the subagent tab declares its auto-open related settings', () => {
    const { service } = setup()
    const toggles = service.getTab('subagent')?.settings?.toggles ?? []
    expect(toggles.map(t => t.key)).toEqual(['autoOpenSubagent', 'autoOpenJobs', 'tasksViewMode'])
    // The default-view row is a graph/tree select (values are strings).
    const viewMode = toggles[2]
    expect(viewMode?.type).toBe('select')
    expect((viewMode?.options ?? []).map(o => o.value)).toEqual(['graph', 'tree'])
  })

  it('the editor tab declares its merged-mode (embedded file tree) setting', () => {
    const { service } = setup()
    const toggles = service.getTab('editor')?.settings?.toggles ?? []
    expect(toggles.map(t => t.key)).toEqual(['editorExplorer', 'workspaceFence'])
    expect(toggles[0]?.title).toBeDefined()
    expect(toggles[0]?.desc).toBeDefined()
    // The merged mode is an iconed select (merged vs separate), not a switch.
    expect(toggles[0]?.type).toBe('select')
    const options = toggles[0]?.options ?? []
    expect(options.map(o => o.value)).toEqual([true, false])
    expect(options.every(o => o.icon !== undefined && o.title !== undefined)).toBe(true)
    // The workspace fence switch rides the same card as a plain boolean row.
    expect(toggles[1]?.title).toBeDefined()
    expect(toggles[1]?.desc).toBeDefined()
    // The open-with configuration (SSH host + custom editors) is the custom
    // panel rendered below the declarative rows.
    expect(service.getTab('editor')?.settings?.render).toBeDefined()
  })

  it('every built-in tab carries the settings-surface icon', () => {
    const { service } = setup()
    for (const tab of service.getTabs()) {
      expect(tab.icon, tab.id).toBeDefined()
    }
  })

  it('the tab glyphs say what the page shows (colored, token-driven)', () => {
    const { service } = setup()
    const iconOf = (id: string): ReactElement => {
      const icon = service.getTab(id)?.icon
      expect(icon, id).toBeDefined()
      return (typeof icon === 'function' ? icon(14) : icon) as ReactElement
    }
    // Every colored glyph is [wrapper][glyph]; unwrap the themed wrapper.
    const glyphOf = (id: string): unknown => {
      const wrapper = iconOf(id) as ReactElement<{ children?: ReactElement }>
      return (wrapper.props.children as ReactElement | undefined)?.type ?? wrapper.type
    }
    // Tasks lists subagent sessions AND background jobs — layered sheets say
    // "work running in the background"; a checklist glyph would say "to-do
    // list", which this page is not.
    expect(glyphOf('subagent')).toBe(VscLayers)
    expect(glyphOf('git')).toBe(VscGitCommit)
    expect(glyphOf('sidechat')).toBe(VscCommentDiscussion)
  })
})

describe('built-in file viewer registrations', () => {
  it('registers the 3 built-in file viewers (the read-only previews yielded to the host)', () => {
    const { service } = setup()
    expect(service.getFileViewers().map(v => v.id).sort()).toEqual(
      ['code', 'html', 'markdown'],
    )
    // The yielded ids are gone: the host's own document preview
    // (ui-sidebar-documentpreview) owns images, pdf, spreadsheets, office
    // and plain text; the plugin keeps only markdown / html / the editable
    // code catch-all.
    for (const id of ['image', 'pdf', 'binary-download']) {
      expect(service.getFileViewers().map(v => v.id), `${id} must not be built in`).not.toContain(id)
    }
    // Office previews are not built in either: they live in the recommended
    // office plugin (which registers the ids through this service).
    for (const id of ['docx', 'xlsx', 'pptx']) {
      expect(service.getFileViewers().map(v => v.id)).not.toContain(id)
    }
  })

  it('the yielded viewer ids stay registrable by external plugins (public contract)', () => {
    const { service } = setup()
    // Dropping the built-in descriptors must not freeze the ids: the
    // registry API keeps accepting them from third-party plugins.
    const dispose = service.registerFileViewer({
      id: 'image',
      exts: ['png'],
      fetchStrategy: 'mediaUrl',
      component: () => null,
    })
    expect(service.matchFileViewer('photo.png')?.id).toBe('image')
    dispose()
    expect(service.matchFileViewer('photo.png')?.id).toBe('code')
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

  it('no built-in viewer claims the yielded extensions (the host document preview does)', () => {
    const { service } = setup()
    // The spreadsheet / pdf / image / office set yielded to the host: the
    // only plugin-side match left is the catch-all code viewer, so the
    // `editor` type can hand these addresses over (see native/index.ts's
    // canOpen). Legacy doc/xls/ppt were previously claimed by the removed
    // `binary-download` viewer and are now the host's too.
    for (const path of [
      'book.xlsx', 'legacy.xls', 'macro.xlsb', 'sheet.xlt', 'template.xltx', 'macro.xltm',
      'flat.ods', 'flat.ots', 'flat.fods', 'data.csv', 'data.tsv',
      'paper.pdf', 'photo.png', 'photo.jpg', 'anim.gif', 'photo.webp', 'art.svg',
      'tile.bmp', 'favicon.ico', 'next.avif',
      'report.docx', 'report.doc', 'notes.dot', 'notes.dotx',
      'deck.pptx', 'deck.ppt',
    ]) {
      expect(service.matchFileViewer(path)?.id, path).toBe('code')
    }
  })

  it('an unknown-extension binary still downloads (the catch-all + host fallback)', () => {
    const { service } = setup()
    // Without the removed `binary-download` descriptor no built-in viewer
    // carries a `detect` probe, so the catch-all blind-claims everything...
    expect(service.matchFileViewer('blob.zzz')?.id).toBe('code')
    expect(service.getFileViewers().some(v => v.detect !== undefined)).toBe(false)
    // ...and the head re-match (the same call the editor host makes on a
    // binary fsRead result) finds no sniffer either: the fsRead catch-all
    // cannot render binary, so planFsReadOutcome hands the host its
    // `binary` outcome and the editor renders the download pane.
    expect(service.matchFileViewer('blob.zzz', new Uint8Array([0x01, 0x00, 0x02]))?.id).toBe('code')
    const code = service.getFileViewers().find(v => v.id === 'code')
    expect(planFsReadOutcome(code!, {
      binary: true,
      content: '',
      truncated: false,
      head: Buffer.from([0x01, 0x00, 0x02]).toString('base64'),
    }, (head) => service.matchFileViewer('blob.zzz', head), () => '/media')).toEqual({ kind: 'binary' })
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
