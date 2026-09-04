/**
 * Return the Markdown source used by preview renderers.
 *
 * A closed YAML frontmatter block is metadata, but the shared MarkdownText
 * parser treats its delimiters as a thematic break and a setext heading. Hide
 * only a block that starts on the first line and has its own closing `---`
 * line. Unclosed or non-leading delimiters remain byte-for-byte unchanged so
 * ordinary Markdown is never truncated. The editor and save path keep using
 * the original source; this helper is preview-only.
 */
export function markdownPreviewSource(source: string): string {
  const firstLineEnd = source.indexOf('\n')
  if (firstLineEnd === -1) return source

  const firstLineStart = source.charCodeAt(0) === 0xFEFF ? 1 : 0
  const firstLine = source.slice(firstLineStart, firstLineEnd).replace(/\r$/u, '')
  if (firstLine !== '---') return source

  let lineStart = firstLineEnd + 1
  while (lineStart <= source.length) {
    const newline = source.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? source.length : newline
    const line = source.slice(lineStart, lineEnd).replace(/\r$/u, '')
    if (line === '---') return newline === -1 ? '' : source.slice(newline + 1)
    if (newline === -1) return source
    lineStart = newline + 1
  }
  return source
}
