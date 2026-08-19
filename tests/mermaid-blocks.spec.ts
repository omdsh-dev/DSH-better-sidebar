/**
 * Markdown/mermaid block splitting: the pure splitter the markdown preview
 * uses to lift mermaid fences out of the MarkdownText stream. Covers fence
 * recognition (case, attributes, indentation), non-mermaid fences staying
 * untouched, interleaved ordering, and open-fence recovery.
 */
import { describe, expect, it } from 'vitest'
import { splitMermaidBlocks } from '../src/client/mermaid-blocks.ts'

describe('splitMermaidBlocks', () => {
  it('leaves mermaid-free markdown as one markdown block', () => {
    expect(splitMermaidBlocks('# hi\n\ntext')).toEqual([
      { kind: 'markdown', text: '# hi\n\ntext' },
    ])
  })

  it('lifts a mermaid fence into a diagram block with the raw source', () => {
    const blocks = splitMermaidBlocks('before\n```mermaid\ngraph TD\n  A-->B\n```\nafter')
    expect(blocks).toEqual([
      { kind: 'markdown', text: 'before' },
      { kind: 'mermaid', code: 'graph TD\n  A-->B' },
      { kind: 'markdown', text: 'after' },
    ])
  })

  it('is case-insensitive and accepts mermaid attribute info strings', () => {
    const lower = splitMermaidBlocks('```Mermaid\na-->b\n```')
    expect(lower[0]).toEqual({ kind: 'mermaid', code: 'a-->b' })
    const attributed = splitMermaidBlocks("```mermaid{theme:'dark'}\na-->b\n```")
    expect(attributed[0]).toEqual({ kind: 'mermaid', code: 'a-->b' })
  })

  it('allows up to 3 spaces of fence indent (CommonMark)', () => {
    const blocks = splitMermaidBlocks('   ```mermaid\na-->b\n   ```')
    expect(blocks).toEqual([{ kind: 'mermaid', code: 'a-->b' }])
  })

  it('does not lift fences inside a 4-space indented code block', () => {
    const source = '    ```mermaid\n    a-->b\n    ```'
    expect(splitMermaidBlocks(source)).toEqual([{ kind: 'markdown', text: source }])
  })

  it('keeps non-mermaid fences in the markdown stream untouched', () => {
    const source = '```ts\nconst a = 1\n```'
    expect(splitMermaidBlocks(source)).toEqual([{ kind: 'markdown', text: source }])
  })

  it('interleaves multiple diagrams preserving source order', () => {
    const blocks = splitMermaidBlocks(
      '# t\n```mermaid\ngraph TD\n  A\n```\nmid\n```mermaid\npie\n  "a": 1\n```\ntail',
    )
    expect(blocks.map(block => block.kind)).toEqual(['markdown', 'mermaid', 'markdown', 'mermaid', 'markdown'])
    expect(blocks[1]).toEqual({ kind: 'mermaid', code: 'graph TD\n  A' })
    expect(blocks[3]).toEqual({ kind: 'mermaid', code: 'pie\n  "a": 1' })
  })

  it('handles an empty file and mermaid-free text with no markdown blocks', () => {
    expect(splitMermaidBlocks('')).toEqual([])
    expect(splitMermaidBlocks('a\n\nb')).toEqual([{ kind: 'markdown', text: 'a\n\nb' }])
  })

  it('swallows the rest of the file on an unterminated mermaid fence', () => {
    const blocks = splitMermaidBlocks('```mermaid\ngraph TD\n  A-->B')
    expect(blocks).toEqual([{ kind: 'mermaid', code: 'graph TD\n  A-->B' }])
  })

  it('treats an empty mermaid fence as an empty diagram block', () => {
    const blocks = splitMermaidBlocks('```mermaid\n```')
    expect(blocks).toEqual([{ kind: 'mermaid', code: '' }])
  })

  it('lifts four-backtick and tilde fences (CommonMark fence runs)', () => {
    const backticks = splitMermaidBlocks('````mermaid\ngraph TD\n  A\n````')
    expect(backticks).toEqual([{ kind: 'mermaid', code: 'graph TD\n  A' }])
    const tildes = splitMermaidBlocks('~~~mermaid\ngraph TD\n  A\n~~~')
    expect(tildes).toEqual([{ kind: 'mermaid', code: 'graph TD\n  A' }])
  })

  it('only a same-char, at-least-as-long fence closes the opening fence', () => {
    // A shorter backtick run must not close a 4-backtick opening fence.
    const blocks = splitMermaidBlocks('````mermaid\na\n```\nb\n````')
    expect(blocks).toEqual([{ kind: 'mermaid', code: 'a\n```\nb' }])
    // A different fence character must not close the fence either.
    const mixed = splitMermaidBlocks('~~~mermaid\na\n```\n~~~')
    expect(mixed).toEqual([{ kind: 'mermaid', code: 'a\n```' }])
  })

  it('ignores backticks inside a backtick fence info string (CommonMark)', () => {
    const source = '```mermaid`graph\na-->b\n```'
    expect(splitMermaidBlocks(source)).toEqual([{ kind: 'markdown', text: source }])
  })
})
