/**
 * Orphaned-tab tests: a persisted tab whose type is not registered must
 * survive sanitize (title/path kept for recovery) and render the graceful
 * placeholder instead of crashing — the degradation path of the open
 * tab-type set (a contributing plugin not installed / not yet loaded).
 */
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { OrphanedTab } from '../src/client/OrphanedTab.tsx'
import { sanitizeState } from '../src/client/state.ts'

/** Collect every tab type in a sanitized tree (leaf/split recursive). */
function typesOf(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return []
  const record = node as { kind?: unknown; tabs?: unknown; children?: unknown }
  if (record.kind === 'leaf' && Array.isArray(record.tabs)) {
    return (record.tabs as Array<{ type: string }>).map(tab => tab.type)
  }
  if (Array.isArray(record.children)) return record.children.flatMap(typesOf)
  return []
}

describe('sanitize keeps unregistered tab types', () => {
  it('preserves a persisted tab of an unknown type with its title/path', () => {
    const raw = {
      nextTerminal: 1,
      activePane: null,
      expanded: [],
      bottomSplits: {
        kind: 'leaf',
        id: 'pane:1',
        tabs: [
          { id: 'tab:1', type: 'my-plugin:db', title: 'Database', path: '/data.sqlite' },
          { id: 'tab:2', type: 'explorer', title: 'Explorer' },
        ],
        active: 'tab:1',
      },
    }
    const clean = sanitizeState(raw)
    expect(clean).toBeDefined()
    expect(typesOf(clean!.bottomSplits)).toContain('my-plugin:db')
    // The kept tab keeps its payload so a later registration can reuse it.
    const leaf = clean!.bottomSplits as unknown as { kind: 'leaf'; tabs: Array<Record<string, unknown>> }
    const kept = leaf.tabs.find(tab => tab.type === 'my-plugin:db')
    expect(kept).toMatchObject({ title: 'Database', path: '/data.sqlite' })
  })

  it('an unknown type alone in a pane still sanitizes cleanly', () => {
    const raw = {
      nextTerminal: 1,
      activePane: null,
      expanded: [],
      bottomSplits: {
        kind: 'leaf',
        id: 'pane:1',
        tabs: [{ id: 'tab:1', type: 'some-plugin:page', title: 'Page' }],
        active: 'tab:1',
      },
    }
    const clean = sanitizeState(raw)
    expect(clean).toBeDefined()
    expect(typesOf(clean!.bottomSplits)).toEqual(['some-plugin:page'])
  })
})

describe('OrphanedTab placeholder', () => {
  const tab = { id: 'tab:1', type: 'my-plugin:db', title: 'Database' }

  it('renders the unregistered type and keeps the title', () => {
    const html = renderToString((
      <OrphanedTab
        ctx={undefined as never}
        store={undefined as never}
        scope={{ sessionId: 's1', cwd: '/p' }}
        tab={tab}
        visible={false}
      />
    ))
    expect(html).toContain('my-plugin:db')
    expect(html).toContain('Database')
    expect(html).not.toContain('undefined')
  })
})
