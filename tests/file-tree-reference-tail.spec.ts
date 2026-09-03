/**
 * The @-reference button and its transient copied label share a file-tree
 * row with a shrinking filename. Both need the row's only auto margin so a
 * short filename cannot leave the affordance stranded in the middle.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/sidebar.module.css', 'utf8')

describe('FileTree @-reference row tail', () => {
  it('anchors both mutually-exclusive reference affordances after a short filename', () => {
    const rule = css.match(/\.explorerRef,\s*\.explorerCopied\s*\{([\s\S]*?)\n\}/)?.[1]
    expect(rule).toBeDefined()
    expect(rule).toMatch(/margin-left:\s*auto/)
  })
})
