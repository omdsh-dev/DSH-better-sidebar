import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'
import { markdownPreviewSource } from './markdown-frontmatter.ts'

const unsupportedNodes = new Set(['definition', 'footnoteDefinition', 'footnoteReference', 'html', 'image', 'imageReference', 'table'])

/** 判断 Markdown 是否只包含当前写作编辑器能够保留的语法。 */
export function supportsVisualMarkdown(source: string): boolean {
  if (markdownPreviewSource(source) !== source) return false
  const nodes: Nodes[] = [fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })]
  while (nodes.length > 0) {
    const node = nodes.pop()!
    if (unsupportedNodes.has(node.type)) return false
    if (node.type === 'listItem' && node.checked !== null && node.checked !== undefined) return false
    if ('children' in node) nodes.push(...node.children)
  }
  return true
}
