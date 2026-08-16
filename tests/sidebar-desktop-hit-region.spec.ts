/**
 * Desktop shell hit-region guard for the fixed panel toggle cluster.
 * Electron drag regions ignore normal stacking, so controls overlapping the
 * DSH titlebar must explicitly opt out of window dragging.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/client/sidebar.module.css', import.meta.url), 'utf8')

describe('desktop panel toggle hit region', () => {
  it('keeps the fixed toggle controls outside Electron drag regions', () => {
    expect(source).toMatch(
      /:global\(html\[data-dsh-desktop='true'\]\) \.toggleCluster,\s*:global\(html\[data-dsh-desktop='true'\]\) \.toggleButton\s*{\s*-webkit-app-region:\s*no-drag;/,
    )
  })
})
