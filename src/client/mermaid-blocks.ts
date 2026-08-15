/**
 * Markdown/mermaid block splitting for the markdown preview. The splitter
 * walks the source line by line and lifts every fenced code block whose
 * info string names `mermaid` out of the MarkdownText stream into a
 * dedicated block, so the mermaid lazy chunk can render it as a diagram
 * while the rest keeps flowing through the DSH MarkdownText renderer.
 * Pure and dependency-free (unit-tested in tests/mermaid-blocks.spec.ts).
 */

/** One fenced mermaid diagram lifted out of the markdown source. */
export interface MermaidBlock {
  kind: 'mermaid'
  /** The raw diagram source between the fences (info string stripped). */
  code: string
}

/** A span of plain markdown source (may itself contain non-mermaid fences). */
export interface MarkdownBlock {
  kind: 'markdown'
  text: string
}

export type MdBlock = MarkdownBlock | MermaidBlock

/** Props of the chunk-resident `MermaidBlocks` component (shared contract). */
export interface MermaidBlocksProps {
  blocks: MdBlock[]
  codeLabels: { copyLabel: string; copiedLabel: string }
}

/** CommonMark opening fence: 0-3 spaces indent + 3 backticks + info string. */
const OPEN_RE = /^ {0,3}`{3}([^\s`]*)[^\n]*$/
/** Closing fence: a run of 3+ backticks, optional trailing whitespace. */
const CLOSE_RE = /^ {0,3}`{3,}\s*$/

/** True when the fence info string names mermaid (bare or `mermaid{...}`). */
function isMermaidInfo(info: string): boolean {
  const word = info.toLowerCase()
  return word === 'mermaid' || word.startsWith('mermaid{')
}

/**
 * Split markdown source into md/mermaid blocks. Only fences whose info
 * string names mermaid are lifted; every other line stays in the markdown
 * stream untouched (the surrounding MarkdownText renders those fences as
 * plain code blocks, as before). An unterminated mermaid fence swallows the
 * rest of the file (the same recovery CommonMark applies to open fences).
 */
export function splitMermaidBlocks(text: string): MdBlock[] {
  if (text === '') return []
  const lines = text.split('\n')
  const blocks: MdBlock[] = []
  let markdown: string[] = []
  let index = 0
  const flushMarkdown = (): void => {
    if (markdown.length === 0) return
    blocks.push({ kind: 'markdown', text: markdown.join('\n') })
    markdown = []
  }
  while (index < lines.length) {
    const match = OPEN_RE.exec(lines[index] ?? '')
    if (match === null || !isMermaidInfo(match[1] ?? '')) {
      markdown.push(lines[index] ?? '')
      index += 1
      continue
    }
    flushMarkdown()
    const code: string[] = []
    index += 1
    while (index < lines.length && !CLOSE_RE.test(lines[index] ?? '')) {
      code.push(lines[index] ?? '')
      index += 1
    }
    // Consume the closing fence (or run off the end on an open fence).
    index += 1
    blocks.push({ kind: 'mermaid', code: code.join('\n') })
  }
  flushMarkdown()
  return blocks
}
