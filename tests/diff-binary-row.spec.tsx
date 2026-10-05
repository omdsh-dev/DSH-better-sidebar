// @vitest-environment jsdom
/**
 * The rows git sends without `---`/`+++` (binary file, pure rename, mode-only
 * change) must still name their file. The regression this locks down: the
 * row rendered as a bare badge, so a reader saw「二进制」sandwiched between two
 * .md rows and reasonably concluded the .md files were the binary ones.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { DiffFiles } from '../src/client/diff/DiffFiles.tsx'
import { t } from '../src/client/locales.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

afterEach(() => { document.body.innerHTML = '' })

/** Render one diff and return its container plus the file-header buttons. */
function render(diff: string): { container: HTMLElement; rows: HTMLButtonElement[] } {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(DiffFiles, { diff })) })
  return { container, rows: [...container.querySelectorAll<HTMLButtonElement>('button')] }
}

describe('DiffFiles rows without ---/+++', () => {
  it('names a binary row and keeps it unexpandable', () => {
    const { container, rows } = render([
      'diff --git a/docs/20_D2_Tree_current.jpg b/docs/20_D2_Tree_current.jpg',
      'new file mode 100644',
      'index 0000000..1234567',
      'Binary files /dev/null and b/docs/20_D2_Tree_current.jpg differ',
      'diff --git a/CURRENT_STATUS.md b/CURRENT_STATUS.md',
      '--- a/CURRENT_STATUS.md',
      '+++ b/CURRENT_STATUS.md',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n'))

    expect(rows).toHaveLength(2)
    const binaryRow = rows[0]!
    expect(binaryRow.textContent).toContain('docs/20_D2_Tree_current.jpg')
    expect(binaryRow.textContent).toContain(t('diffBinary'))
    // No path, no way to tell what the badge belongs to: not expandable, and
    // no toggle affordance either.
    expect(binaryRow.disabled).toBe(true)
    expect(binaryRow.hasAttribute('aria-expanded')).toBe(false)
    // The text row next to it is untouched — it is the one that kept its name.
    expect(rows[1]!.disabled).toBe(false)
    expect(container.textContent).toContain('CURRENT_STATUS.md')
  })

  it('names a pure rename on both sides', () => {
    const { rows } = render([
      'diff --git a/old/name.md b/new/name.md',
      'similarity index 100%',
      'rename from old/name.md',
      'rename to new/name.md',
    ].join('\n'))

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.textContent).toContain('new/name.md')
    expect(row.textContent).toContain('old/name.md')
    expect(row.textContent).toContain(t('diffRenamed'))
    expect(row.disabled).toBe(true)
  })

  it('names a mode-only row without pretending it was renamed', () => {
    const { rows } = render([
      'diff --git a/tools/run.sh b/tools/run.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n'))

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.textContent).toContain('tools/run.sh')
    expect(row.textContent).not.toContain(t('diffRenamed'))
    expect(row.disabled).toBe(true)
  })

  it('renders a C-quoted path as the file name it stands for', () => {
    const { container, rows } = render([
      'diff --git "a/docs/\\346\\226\\207\\344\\273\\266.md" "b/docs/\\346\\226\\207\\344\\273\\266.md"',
      'new file mode 100644',
      'index 0000000..1234567',
      'Binary files /dev/null and "b/docs/\\346\\226\\207\\344\\273\\266.md" differ',
    ].join('\n'))

    expect(rows[0]!.textContent).toContain('docs/文件.md')
    expect(container.textContent).not.toContain('\\346')
  })
})
