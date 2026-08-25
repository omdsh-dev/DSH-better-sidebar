// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createSidebarStore, floatTab } from '../src/client/state.ts'

beforeEach(() => {
  localStorage.clear()
})

describe('restored free-window ids', () => {
  it('seeds the shared uid counter past persisted float ids before minting another window', () => {
    localStorage.setItem('dsh-sidebar:v1:s1', JSON.stringify({
      panelOpen: true,
      width: 400,
      activePane: 'pane:1',
      nextTerminal: 1,
      nextBrowser: 1,
      expanded: [],
      splits: {
        kind: 'leaf',
        id: 'pane:1',
        active: 'tab:2',
        tabs: [{ id: 'tab:2', type: 'browser', title: 'Docked' }],
      },
      bottomOpen: false,
      bottomHeight: 220,
      bottomOpenedOnce: false,
      bottomSplits: {
        kind: 'leaf',
        id: 'pane:3',
        active: null,
        tabs: [],
      },
      floats: [{
        id: 'float:5',
        tab: { id: 'tab:4', type: 'browser', title: 'Existing float' },
        x: 0,
        y: 0,
        w: 390,
        h: 500,
      }],
    }))

    const store = createSidebarStore()
    store.setSession('s1')
    store.reduce(state => floatTab(state, 'tab:2', 400, 300))

    const ids = store.getSnapshot().state!.floats.map(float => float.id)
    expect(ids).toEqual(['float:5', 'float:6'])
    expect(new Set(ids).size).toBe(ids.length)
  })
})
