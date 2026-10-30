/**
 * Changelog completeness spec: both changelogs are shipped documents (the
 * Chinese one is also the source for GitHub Releases), so a merge that drops
 * history is a release regression. The 2026-10-29 mermaid merge (`04c6cb8`)
 * cut both files down to their top sections and nothing in CI noticed.
 *
 * Guards the invariants that would have caught it:
 * - both files still carry the oldest release,
 * - neither file has been reduced below the historical release floor,
 * - the English file never lists a release the Chinese (authoritative) file
 *   lacks — it may lag in wording, not in which releases exist.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The oldest release both files must keep. */
const OLDEST_RELEASE = 'v0.12.3'

/** The historical floor: 33 distinct releases carried when this guard landed. */
const MIN_RELEASES = 30

/** Release headings look like `### v1.2.3` / `### v1.2.3-alpha.0`; prose suffixes are ignored. */
const RELEASE_HEADING = /^### (v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/gm

function releases(file: string): string[] {
  const text = readFileSync(resolve(ROOT, file), 'utf8')
  return [...text.matchAll(RELEASE_HEADING)].map(match => match[1]!)
}

describe('changelog integrity', () => {
  const zh = releases('CHANGELOG.md')
  const en = releases('CHANGELOG_EN.md')

  it('keeps the full release history in both files', () => {
    for (const [file, list] of [['CHANGELOG.md', zh], ['CHANGELOG_EN.md', en]] as const) {
      expect(list, `${file} has no release headings`).not.toHaveLength(0)
      expect(list, `${file} lost its oldest release`).toContain(OLDEST_RELEASE)
      expect(new Set(list).size, `${file} dropped below the historical release floor`)
        .toBeGreaterThanOrEqual(MIN_RELEASES)
    }
  })

  it('never lists an English release the Chinese file lacks', () => {
    const known = new Set(zh)
    expect(en.filter(release => !known.has(release))).toEqual([])
  })
})
