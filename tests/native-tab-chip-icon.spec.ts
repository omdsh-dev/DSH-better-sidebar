// @vitest-environment jsdom
/**
 * The native tab CHIP's file glyph (`NativeTabTitle`): a file tab must draw
 * the FILE's own icon from its very first frame — including while the
 * plugin-side record does not exist yet.
 *
 * That record is minted by the tab BODY's render (one commit after the chip
 * first draws) and dropped again when the body unmounts, so a chip that
 * derived the glyph from the record alone fell back to its descriptor's
 * generic glyph every time a file tab was activated: the selected tab showed
 * the folder artwork while the inactive ones (rendered later, with the record
 * in place) showed the right file icon.
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  NativeTabTitle,
  createNativeTabRecords,
  type NativeTabInfo,
  type NativeTabParams,
} from '../src/client/native/tab-adapter.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { createSidebarStore } from '../src/client/state.ts'

const scope = { sessionId: 's1', cwd: '/work' }

/** One native tab record, as the host hands it to a title registration. */
function nativeInfo(id: string, kind: string, title: string, contentId: string): NativeTabInfo {
  return {
    tab: {
      id,
      kind,
      title,
      contentId,
      visible: true,
      navigation: { address: contentId, params: undefined, revision: 0 },
      signal: new AbortController().signal,
    },
  }
}

/** A service whose editor descriptor has a marker glyph, plus two file icons. */
function createService(): ReturnType<typeof createBetterSidebarService> {
  const service = createBetterSidebarService(createSidebarStore())
  service.registerTab({
    id: 'editor',
    title: () => 'Files',
    icon: (size: number) => createElement('i', { 'data-type-icon': size }),
    component: () => createElement('div'),
  })
  service.registerFileIcon({
    id: 'test:md',
    exts: ['md'],
    icon: () => createElement('i', { 'data-file-glyph': 'md' }),
  })
  service.registerFileIcon({
    id: 'test:txt',
    exts: ['txt'],
    icon: () => createElement('i', { 'data-file-glyph': 'txt' }),
  })
  return service
}

/** Render one chip title and hand back its host element. */
function renderTitle(props: {
  records: ReturnType<typeof createNativeTabRecords>
  service: ReturnType<typeof createBetterSidebarService>
  info: NativeTabInfo
  descriptorId: string
  paramsOf?: (info: NativeTabInfo) => NativeTabParams | undefined
}): { host: HTMLDivElement; unmount: () => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(createElement(NativeTabTitle, {
      records: props.records,
      service: props.service,
      descriptorId: props.descriptorId,
      paramsOf: props.paramsOf,
      useTabInfo: () => props.info,
      // The registration's injected face is validated by the adapter, not by
      // this fixture.
    } as never))
  })
  return {
    host,
    unmount: () => {
      act(() => { root?.unmount() })
      host.remove()
    },
  }
}

describe('NativeTabTitle file glyph', () => {
  it('draws the file glyph from the tab ADDRESS while no record exists yet', () => {
    const records = createNativeTabRecords()
    const service = createService()
    const info = nativeInfo('tab1', 'editor', 'notes.md', 'dsh-resource://file/session/s1/work/notes.md')

    const { host, unmount } = renderTitle({
      records,
      service,
      info,
      descriptorId: 'editor',
      paramsOf: () => ({ path: '/work/notes.md' }),
    })
    expect(
      host.querySelector('[data-file-glyph="md"]'),
      'the file glyph must come from the address, not from the record',
    ).not.toBeNull()
    expect(
      host.querySelector('[data-type-icon]'),
      'the descriptor glyph must not stand in for a file tab',
    ).toBeNull()
    unmount()
  })

  it('keeps the record’s own path when an in-place switch put it there', () => {
    const records = createNativeTabRecords()
    const service = createService()
    // An in-place switch (the merged files window) lives in the record only:
    // the tab's native kind is the `files` page, whose address carries no path.
    records.ensure({
      id: 'tab2',
      kind: 'files',
      title: 'notes.md',
      params: { path: '/work/notes.md' },
      scope,
    } as never)
    const info = nativeInfo('tab2', 'files', 'notes.md', 'sidebar://files')

    const { host, unmount } = renderTitle({
      records,
      service,
      info,
      descriptorId: 'editor',
      paramsOf: () => undefined,
    })
    expect(
      host.querySelector('[data-file-glyph="md"]'),
      'the record’s in-place path still titles the chip',
    ).not.toBeNull()
    unmount()
  })

  it('keeps the descriptor glyph for a path-less page tab', () => {
    const records = createNativeTabRecords()
    const service = createService()
    const info = nativeInfo('tab3', 'files', 'Files', 'sidebar://files')

    const { host, unmount } = renderTitle({
      records,
      service,
      info,
      descriptorId: 'editor',
      paramsOf: () => undefined,
    })
    expect(host.querySelector('[data-type-icon]'), 'a path-less page keeps its type glyph').not.toBeNull()
    expect(host.querySelector('[data-file-glyph]'), 'no file glyph without a file').toBeNull()
    unmount()
  })
})
