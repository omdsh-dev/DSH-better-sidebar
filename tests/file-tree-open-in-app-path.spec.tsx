/**
 * The path the file tree hands to the Host's "open in app" family.
 *
 * Two independent defects made every gesture under a junction/symlink fail
 * with a bare "Could not open: <path>":
 *
 *   1. Tree rows carry SESSION-RELATIVE paths (fs-tree.ts composes them as
 *      `${prefix}${dirent.name}`), and the Host resolves whatever it is given
 *      against ITS OWN process cwd — so a relative path names nothing there.
 *   2. The Host's verifier requires `path.resolve()` of the string it is
 *      handed to equal the filesystem backend's realpath, which differs for any
 *      path whose spelling reaches through a junction or symlink.
 *
 * The tree therefore hands over `fsRealpath(resolveSidebarPath(cwd, row))`.
 * This spec pins that contract for all three call sites (the handler listing,
 * open, reveal) with a fake Host that reports a canonical path different from
 * the requested one — exactly what a junction looks like from the client.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import type { OpenInApp, OpenInAppEntry } from '../src/client/open-in-app.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

/** The session cwd every mount uses. Rows below are relative to it. */
const CWD = '/tmp'

/** What the fake Host canonicalizes `<cwd>/<row>` into (a junction target). */
const CANONICAL_CWD = '/real/tmp'

/** Every `fsRealpath` request this spec observed. */
const realpathCalls: { sessionId: string; path: string }[] = []

vi.mock('../src/client/api.ts', () => ({
  api: {
    // Row paths are RELATIVE — the shape the real explorer carries.
    fsTrees: async (_scope: unknown, paths: readonly string[]) => ({
      levels: paths.map(path => ({ path, entries: [
        { name: 'a.ts', path: 'a.ts', isDir: false },
      ], truncated: false })),
    }),
    gitStatus: async () => ({ isRepo: false, entries: [] }),
    fsRealpath: async (scope: { sessionId: string }, path: string) => {
      realpathCalls.push({ sessionId: scope.sessionId, path })
      // Stand in for realpath.native: the canonical spelling of anything under
      // the junctioned workspace differs from the requested spelling.
      return path.startsWith(CWD + '/') ? CANONICAL_CWD + path.slice(CWD.length) : path
    },
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

const FILE_APPS: readonly OpenInAppEntry[] = [
  { id: 'textedit', name: 'TextEdit', icon: null, isDefault: true },
]

function makeHandle(): { openInApp: OpenInApp, open: ReturnType<typeof vi.fn>, reveal: ReturnType<typeof vi.fn>, fileApps: ReturnType<typeof vi.fn> } {
  const open = vi.fn(async () => true)
  const reveal = vi.fn(async () => true)
  const fileApps = vi.fn(async (_path: string) => FILE_APPS)
  const openInApp: OpenInApp = {
    available: () => true,
    probe: async () => true,
    directoryApps: async () => [],
    fileApps,
    open,
    reveal,
  }
  return { openInApp, open, reveal, fileApps }
}

let root: Root
let container: HTMLDivElement

async function mountTree(handle: ReturnType<typeof makeHandle>): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: CWD,
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onOpenFileNewTab: () => {},
      onOpenFileSide: () => {},
      openInApp: handle.openInApp,
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

function clickMenuitem(label: string): void {
  const item = menuItems().find(el => el.textContent === label)
  if (item === undefined) throw new Error('menuitem not found: ' + label)
  act(() => { item.click() })
}

async function openMenu(): Promise<void> {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === 'a.ts')
  if (row === undefined) throw new Error('row not found')
  await act(async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  realpathCalls.length = 0
})

describe('the path handed to the Host open-in-app family', () => {
  it('asks the Host to canonicalize the SESSION-ABSOLUTE row path, not the raw row', async () => {
    const handle = makeHandle()
    await mountTree(handle)
    await openMenu()
    // The row says 'a.ts'; the Host must be asked about <cwd>/a.ts.
    expect(realpathCalls).toEqual([{ sessionId: 's1', path: CWD + '/a.ts' }])
  })

  it('lists handlers for the canonical path (a junction spelling is what the Host verifies)', async () => {
    const handle = makeHandle()
    await mountTree(handle)
    await openMenu()
    expect(handle.fileApps).toHaveBeenCalledWith(CANONICAL_CWD + '/a.ts')
  })

  it('opens with the canonical path', async () => {
    const handle = makeHandle()
    await mountTree(handle)
    await openMenu()
    await act(async () => { clickMenuitem('Open with default app'); await Promise.resolve(); await Promise.resolve() })
    expect(handle.open).toHaveBeenCalledWith(CANONICAL_CWD + '/a.ts')
  })

  it('reveals with the canonical path', async () => {
    const handle = makeHandle()
    await mountTree(handle)
    await openMenu()
    await act(async () => { clickMenuitem('Reveal in File Manager'); await Promise.resolve(); await Promise.resolve() })
    expect(handle.reveal).toHaveBeenCalledWith(CANONICAL_CWD + '/a.ts')
  })

  it('keeps reporting the row path (not the canonical one) in the failure strip', async () => {
    const handle = makeHandle()
    handle.open.mockResolvedValue(false)
    await mountTree(handle)
    await openMenu()
    await act(async () => { clickMenuitem('Open with default app'); await Promise.resolve(); await Promise.resolve() })
    // The reader sees the path they right-clicked, not the Host's spelling.
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not open: a.ts')
  })
})
