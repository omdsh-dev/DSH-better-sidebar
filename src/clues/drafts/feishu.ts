/** Native XML drafts retain the full source XML; only lossless text edits reach saveEdit. */
import { ClueError } from '../error.ts'
import type { ClueCallOptions, CluesService } from '../service.ts'
import type { ClueEditDocument, ClueSaveEditInput, ClueSaveEditResult, CluesReadParams, JsonValue } from '../types.ts'
import { buildDocBlockXml, escapeXmlText, isEditableBlockTag, isSafeBlockId, parseDocEditXml, topLevelSpans } from '../sources/feishu/edit.ts'
import { parseDocEditData, type FeishuDocEditData } from '../sources/feishu/format.ts'
import { runFeishuCommand } from '../sources/feishu/auth.ts'
import { recordField, stringField } from '../sources/feishu/lark.ts'
import type { ClueRuntime } from '../runtime/types.ts'

export interface FeishuDraftInsertion { readonly afterId: string; readonly xml: string; readonly count: number }
export interface FeishuDraftPlan { readonly document: ClueSaveEditInput; readonly insertions: readonly FeishuDraftInsertion[] }
export interface FeishuDraftBridge {
  loadXml(document: ClueEditDocument, resource: CluesReadParams, call?: ClueCallOptions): Promise<string>
  save(plan: FeishuDraftPlan, baseline: ClueEditDocument, resource: CluesReadParams): Promise<ClueSaveEditResult>
}
interface Node { raw: string; opening: string; closing: string; inner: string; tag: string; id?: string }
const unsupported = (): never => { throw new ClueError('unsupported', 'the XML draft changes unsupported structure, block IDs or resources; its file was preserved') }
function nodesOf(xml: string): Node[] {
  const spans = topLevelSpans(xml)
  if (spans === undefined || !parseDocEditXml(xml).complete) return unsupported()
  return spans.map(span => {
    const raw = xml.slice(span.start, span.end)
    const tag = /^<([A-Za-z][\w:-]*)/u.exec(raw)?.[1]
    if (tag === undefined) return unsupported()
    let end = 1
    let quote = ''
    for (; end < raw.length; end++) {
      const character = raw[end]!
      if (quote !== '') { if (character === quote) quote = ''; continue }
      if (character === '"' || character === "'") quote = character
      else if (character === '>') break
    }
    const opening = raw.slice(0, end + 1)
    const closeAt = /\/\s*>$/u.test(opening) ? raw.length : raw.lastIndexOf(`</${tag}`)
    if (closeAt < end) return unsupported()
    const id = /\s+id\s*=\s*(["'])(.*?)\1/u.exec(opening)?.[2]
    return { raw, opening, closing: raw.slice(closeAt), inner: raw.slice(end + 1, closeAt), tag, ...(id === undefined ? {} : { id }) }
  })
}
function resourcesOf(inner: string): string[] {
  // Resource identity/attributes survive even when the visible label of a link changes.
  return inner.match(/<(?:img|source|cite|a|mention|file|image)\b[^>]*\/?\s*>/giu) ?? []
}
function sameArray(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
/** Confirm that a raw detail-full fetch and the editable source model are the same baseline. */
export function requireFeishuXmlBaseline(document: ClueEditDocument, xml: string): FeishuDocEditData {
  const data = parseDocEditData(document.data)
  const parsed = parseDocEditXml(xml)
  if (data === undefined || !parsed.complete || parsed.title !== data.baselineTitle || parsed.titleBlockId !== data.titleBlockId || parsed.titleAttrs !== data.titleAttrs || !sameArray(parsed.blocks, data.blocks) || !sameArray(parsed.readOnlyBlocks, data.readOnlyBlocks)) {
    throw new ClueError('conflict', 'the native XML no longer matches the loaded editing baseline')
  }
  return data
}
/** Supported additions are id-less top-level text blocks; destruction/reordering is never inferred. */
export function planFeishuDraft(baseline: ClueEditDocument, original: string, edited: string): FeishuDraftPlan {
  const data = requireFeishuXmlBaseline(baseline, original)
  const before = nodesOf(original)
  const after = nodesOf(edited)
  const parsed = parseDocEditXml(edited)
  const insertions: FeishuDraftInsertion[] = []
  const changed = new Map(parsed.blocks.map(block => [block.id, block]))
  const idsOf = (xml: string): readonly string[] => [...xml.matchAll(/\s+id\s*=\s*(["'])(.*?)\1/gu)].map(match => match[2]!)
  if (!sameArray(idsOf(original), idsOf(edited))) return unsupported()
  if (new Set(parsed.blocks.map(block => block.id)).size !== parsed.blocks.length) return unsupported()
  let index = 0
  let anchor = data.titleBlockId ?? data.docToken
  const compare = (left: Node, right: Node): void => {
    if (left.tag !== right.tag || left.opening !== right.opening || left.closing !== right.closing) return unsupported()
    if (left.tag === 'title') {
      if (left.id !== data.titleBlockId || !data.titleEditable) { if (left.raw !== right.raw) return unsupported() }
      if (left.raw !== right.raw && right.inner !== escapeXmlText(parsed.title)) return unsupported()
      return
    }
    if (left.tag === 'ul' || left.tag === 'ol') {
      const originalChildren = nodesOf(left.inner)
      const editedChildren = nodesOf(right.inner)
      if (originalChildren.length !== editedChildren.length) return unsupported()
      originalChildren.forEach((child, childIndex) => compare(child, editedChildren[childIndex]!))
      return
    }
    const block = data.blocks.find(value => value.id === left.id)
    if (block === undefined) { if (left.raw !== right.raw) return unsupported(); return }
    if (!sameArray(resourcesOf(left.inner), resourcesOf(right.inner))) return unsupported()
    if (block.kind === 'plain' && left.raw !== right.raw) {
      const next = changed.get(block.id)
      if (next === undefined || left.inner !== nodesOf(buildDocBlockXml(block, block.baseline))[0]?.inner || right.inner !== nodesOf(buildDocBlockXml(block, next.text))[0]?.inner) return unsupported()
    }
  }
  for (const node of after) {
    const existing = before[index]
    if (node.id === undefined && isEditableBlockTag(node.tag) && node.tag !== 'li' && (existing?.id !== undefined || existing?.raw !== node.raw)) {
      // New nodes never carry style/resource metadata that could retarget existing content.
      if (node.opening !== `<${node.tag}>` || resourcesOf(node.inner).length > 0) return unsupported()
      if (Buffer.byteLength(node.raw) > 64 * 1024) throw new ClueError('invalid-request', 'an inserted XML block exceeds 64 KiB')
      const innerModel = parseDocEditXml(node.raw.replace(`<${node.tag}>`, `<${node.tag} id="draft_new">`)).blocks[0]
      if (innerModel === undefined) return unsupported()
      const safeXml = buildDocBlockXml(innerModel, innerModel.text)
      if (Buffer.byteLength(safeXml) > 64 * 1024) throw new ClueError('invalid-request', 'an inserted XML block exceeds 64 KiB after escaping')
      const previous = insertions.at(-1)
      if (previous?.afterId === anchor) insertions[insertions.length - 1] = { afterId: anchor, xml: `${previous.xml}\n${safeXml}`, count: previous.count + 1 }
      else insertions.push({ afterId: anchor, xml: safeXml, count: 1 })
      continue
    }
    if (existing === undefined) return unsupported()
    compare(existing, node)
    if (node.id !== undefined) anchor = node.id
    else if (node.tag === 'ul' || node.tag === 'ol') anchor = nodesOf(node.inner).at(-1)?.id ?? ''
    else anchor = ''
    index++
  }
  if (index !== before.length || insertions.some(insertion => !isSafeBlockId(insertion.afterId))) return unsupported()
  // Retain comments and every opaque resource block exactly; only XML whitespace between blocks is cosmetic.
  if (!sameArray(original.match(/<!--[\s\S]*?-->/gu) ?? [], edited.match(/<!--[\s\S]*?-->/gu) ?? [])) return unsupported()
  const blocks = data.blocks.map(block => {
    const editedBlock = changed.get(block.id)
    if (editedBlock === undefined || editedBlock.tag !== block.tag || editedBlock.attrs !== block.attrs || editedBlock.kind !== block.kind) return unsupported()
    if (editedBlock.text !== block.baseline) buildDocBlockXml(block, editedBlock.text)
    return { ...block, text: editedBlock.text }
  })
  const titleChanged = data.title !== parsed.title
  if (titleChanged && (!data.titleEditable || parsed.title.trim() === '')) throw new ClueError('invalid-request', 'the native document title cannot be changed to this value')
  if (blocks.some(block => block.text !== block.baseline && Buffer.byteLength(block.text) > 64 * 1024)) throw new ClueError('invalid-request', 'an edited XML block exceeds 64 KiB')
  if (blocks.filter(block => block.text !== block.baseline).length + insertions.reduce((total, value) => total + value.count, 0) + (titleChanged ? 1 : 0) > 200) throw new ClueError('invalid-request', 'the XML draft exceeds 200 text blocks')
  const totalBytes = blocks.reduce((total, block) => total + (block.text === block.baseline ? 0 : Buffer.byteLength(block.text)), 0)
    + insertions.reduce((total, insertion) => total + Buffer.byteLength(insertion.xml), 0)
    + (data.title === parsed.title ? 0 : Buffer.byteLength(parsed.title))
  if (totalBytes > 256 * 1024) throw new ClueError('invalid-request', 'the XML draft exceeds the 256 KiB update capacity')
  const updated = { ...data, title: parsed.title, blocks }
  return { document: { format: baseline.format, data: updated as unknown as JsonValue, ...(baseline.baseRevision === undefined ? {} : { baseRevision: baseline.baseRevision }) }, insertions }
}
export interface FeishuDraftBridgeOptions {
  readonly clues: Pick<CluesService, 'loadEdit' | 'saveEdit'>
  readonly getRuntime: () => ClueRuntime
  readonly resolveWorkspacePath: (workspaceId: string) => string | undefined
}
/** Uses the existing authenticated/gated source transport; no caller-supplied command/path is accepted. */
export function createFeishuDraftBridge(options: FeishuDraftBridgeOptions): FeishuDraftBridge {
  const fetch = async (document: ClueEditDocument, resource: CluesReadParams, call: ClueCallOptions = {}): Promise<{ xml: string; revision?: string }> => {
    const model = parseDocEditData(document.data)
    if (model === undefined) throw new ClueError('invalid-request', 'the XML draft needs a native document editing model')
    const cwd = options.resolveWorkspacePath(resource.workspaceId)
    if (cwd === undefined) throw new ClueError('not-found', 'the draft workspace is unavailable')
    const result = await runFeishuCommand(options.getRuntime(), { args: ['docs', '+fetch', '--api-version', 'v2', '--doc', model.docToken, '--doc-format', 'xml', '--detail', 'full', '--as', 'user', '--format', 'json'], cwd, signal: call.signal })
    const record = recordField(result.data, 'document')
    const xml = record === undefined ? undefined : stringField(record, 'content')
    if (xml === undefined) throw new ClueError('failed', 'the native XML fetch did not return a complete document')
    const revision = record?.revision_id
    return { xml, ...(revision === undefined ? {} : { revision: String(revision) }) }
  }
  return {
    async loadXml(document, resource, call) {
      const fetched = await fetch(document, resource, call)
      if (document.baseRevision !== undefined && fetched.revision !== document.baseRevision) throw new ClueError('conflict', 'the document changed while preparing its native XML draft')
      requireFeishuXmlBaseline(document, fetched.xml)
      return fetched.xml
    },
    async save(plan, baseline, resource) {
      const call: ClueCallOptions = { caller: 'agent-edit', sessionId: resource.sessionId }
      if (plan.insertions.length === 0) return options.clues.saveEdit({ ...resource, document: plan.document }, call)
      let current = baseline
      const originalData = parseDocEditData(baseline.data)!
      const editedData = parseDocEditData(plan.document.data)!
      // Inserts run first: block_replace may replace target IDs, so insertion anchors must still be original.
      for (const insertion of [...plan.insertions].reverse()) {
        const fetched = await fetch(current, resource)
        if (current.baseRevision === undefined || fetched.revision !== current.baseRevision) throw new ClueError('conflict', 'the XML insertion baseline cannot be confirmed')
        const cwd = options.resolveWorkspacePath(resource.workspaceId)
        if (cwd === undefined) throw new ClueError('not-found', 'the draft workspace is unavailable')
        const success = await runFeishuCommand(options.getRuntime(), { args: ['docs', '+update', '--api-version', 'v2', '--doc', originalData.docToken, '--command', 'block_insert_after', '--block-id', insertion.afterId, '--content', '-', '--doc-format', 'xml', '--revision-id', fetched.revision, '--as', 'user', '--format', 'json'], stdin: insertion.xml, cwd })
        const count = success.data.updated_blocks_count
        if (success.data.result !== 'success' || (success.data.warnings !== undefined && (!Array.isArray(success.data.warnings) || success.data.warnings.length > 0)) || (count === undefined || Number(count) !== insertion.count)) throw new ClueError('failed', 'the XML insertion was not confirmed complete', { partial: 'true' })
        current = await options.clues.loadEdit(resource, call)
        const fresh = parseDocEditData(current.data)
        if (fresh === undefined || fresh.baselineTitle !== originalData.baselineTitle || originalData.blocks.some(block => !fresh.blocks.some(value => value.id === block.id && value.tag === block.tag && value.attrs === block.attrs && value.text === block.baseline))) throw new ClueError('conflict', 'the original text blocks changed during insertion', { partial: 'true' })
      }
      const fresh = parseDocEditData(current.data)!
      const changes = new Map(editedData.blocks.map(block => [block.id, block.text]))
      const document: ClueSaveEditInput = { format: current.format, baseRevision: current.baseRevision, data: { ...fresh, title: editedData.title, blocks: fresh.blocks.map(block => changes.has(block.id) ? { ...block, text: changes.get(block.id)! } : block) } as unknown as JsonValue }
      return options.clues.saveEdit({ ...resource, document }, call)
    },
  }
}
