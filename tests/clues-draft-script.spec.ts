/** Packaged helper -> real local HTTP -> durable manager, with a fake provider and no external writes. */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { createClueDraftManager } from '../src/clues/drafts.ts'
import { createClueAgentDraftRoute } from '../src/clues/agent-drafts.ts'
import type { SidebarHttpRequest, SidebarHttpResponse } from '../src/context-types.ts'
import { removeTree } from './temp-tree.ts'
const script = await import(new URL('../src/clues/skills/clue-selection-edit/scripts/commit-draft.mjs', import.meta.url).href) as {
  commitTarget(url: string, id: string): { url: string; body: string }
  commitDraft(url: string, id: string): Promise<{ ok: boolean; value: { status: string } }>
}
const ID = 'a'.repeat(48)
describe('packaged fixed commit helper', () => {
  it.each(['https://localhost:1234/sidebar/agent/clues/commit', 'http://example.com:1234/sidebar/agent/clues/commit', 'http://127.0.0.1:1234/sidebar/api', 'http://127.0.0.1:1234/sidebar/agent/clues/commit?path=anything', 'http://user:pass@127.0.0.1:1234/sidebar/agent/clues/commit'])('refuses arbitrary targets and credentials', url => {
    expect(() => script.commitTarget(url, ID)).toThrow()
  })
  it('commits an agent-edited complete body exactly once through the real fixed POST', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clue-script-'))
    const saveEdit = vi.fn(async () => ({ savedAt: 'now', revision: 'new' }))
    const drafts = createClueDraftManager({ root, clues: { loadEdit: async () => ({ format: 'text/markdown', data: { text: 'Whole\noriginal\nbody' }, baseRevision: 'base' }), saveEdit } })
    const prepared = await drafts.prepare({ workspaceId: 'w', sessionId: 's', clueId: 'c' })
    await writeFile(prepared.bodyPath, 'Whole\nedited\nbody')
    let port = 0
    const route = createClueAgentDraftRoute({ drafts, getWebServer: () => ({ port }) })
    const server = createServer((req, res) => { void route.handler(req as unknown as SidebarHttpRequest, res as unknown as SidebarHttpResponse) })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as AddressInfo).port
      const url = `http://127.0.0.1:${port}/sidebar/agent/clues/commit`
      expect((await script.commitDraft(url, prepared.draftId)).value.status).toBe('committed')
      expect((await script.commitDraft(url, prepared.draftId)).value.status).toBe('committed')
      expect(saveEdit).toHaveBeenCalledTimes(1)
      expect(saveEdit).toHaveBeenCalledWith({ workspaceId: 'w', sessionId: 's', clueId: 'c', document: { format: 'text/markdown', data: { text: 'Whole\nedited\nbody' }, baseRevision: 'base' } }, { caller: 'agent-edit', sessionId: 's' })
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
      removeTree(root)
    }
  })
})
