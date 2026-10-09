/**
 * `githubHeadingSlug` must produce the id GITHUB gives a heading — that is the
 * whole contract, because the anchors the repo's own READMEs carry were written
 * for GitHub. Two independent checks:
 *
 * 1. PARITY against the real `github-slugger@2.0.0` slugger regex (vendored in
 *    `tests/helpers/github-slug-reference.ts`), character class by character
 *    class — a "roughly GitHub-like" implementation fails here.
 * 2. THE REPOS' OWN READMEs, end to end: every in-document anchor must resolve
 *    against the ids their headings get. Before this batch the answer was
 *    **0 of 16 in each file** (the old slugger trimmed and collapsed whitespace
 *    runs, so a heading `🚀 安装` got the id `安装` while its table of contents
 *    pointed at `#-安装`).
 *
 * The id ASSIGNMENT (`assignHeadingIds`) is checked here too, on a real DOM
 * tree, because repeat suffixes are part of GitHub's rule and the renderer
 * ships bare `h1..h6`. tests/markdown-surface.spec.tsx covers the same pass
 * through the real renderer.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assignHeadingIds, githubHeadingSlug } from '../src/client/markdown-navigation.ts'
import { referenceHeadingIds, referenceSlug, scanDocumentAnchors } from './helpers/github-slug-reference.ts'

const REPO_ROOT = process.cwd()

/** The repo's own READMEs: the two documents whose anchors this batch must fix. */
const README_FILES = ['README.md', 'README_EN.md']

function readme(name: string): string {
  return readFileSync(join(REPO_ROOT, name), 'utf8')
}

/**
 * Drop the variation selectors from a heading text. GitHub renders an emoji
 * heading into `<g-emoji>🚀</g-emoji> 安装`, and the slug text it hands
 * `github-slugger` is the element's `alt` value — `🚀` WITHOUT the U+FE0F that
 * followed it in the source. The vendored oracle has no such pipeline, so it is
 * fed the same shape (the emoji itself it drops by range, the selector it does
 * not — the deliberate divergence the parity case below pins).
 */
function vs16Free(text: string): string {
  return text.replace(/[\uFE00-\uFE0F]/gu, '')
}

describe('githubHeadingSlug', () => {
  it('lower-cases ASCII, drops punctuation and symbols, keeps - and _', () => {
    expect(githubHeadingSlug('Hello, World!')).toBe('hello-world')
    expect(githubHeadingSlug('Foo-Bar_Baz')).toBe('foo-bar_baz')
    // `/` is dropped WITHOUT collapsing the two spaces it sat between: GitHub
    // yields `c--c`, the old trimmed-and-collapsed slugger yielded `c-c`.
    expect(githubHeadingSlug('C++ / C#')).toBe('c--c')
    expect(referenceSlug('C++ / C#')).toBe('c--c')
    expect(githubHeadingSlug('`code` & "quotes"')).toBe('code--quotes')
    expect(referenceSlug('`code` & "quotes"')).toBe('code--quotes')
    expect(githubHeadingSlug('Trailing punctuation:')).toBe('trailing-punctuation')
  })

  it('does NOT trim and does NOT collapse whitespace runs — each space is its own dash', () => {
    // GitHub's slugger is `text.toLowerCase().replace(RE, '').replace(/ /g, '-')`:
    // no trim, no run collapsing. This is what makes the READMEs' `#-安装`
    // anchors work at all after the emoji is removed.
    expect(githubHeadingSlug('  Mixed   CASE  ')).toBe('--mixed---case--')
    expect(githubHeadingSlug('Installation')).toBe('installation')
    // The repo's own evidence, verbatim: `🛠️ Development & Build` is linked as
    // `#-development--build` — a leading dash from the space the emoji left,
    // and a double dash from the removed `&`.
    expect(githubHeadingSlug('🛠️ Development & Build')).toBe('-development--build')
    // A tab is not a space, so it is dropped rather than turned into a dash.
    expect(githubHeadingSlug('a\tb')).toBe('ab')
  })

  it('drops emoji and the variation selectors that follow them', () => {
    // `🎉 Party` → the space before `Party` survives as a dash.
    expect(githubHeadingSlug('🎉 Party')).toBe('-party')
    // `🖼️` is U+1F5BC + U+FE0F: both go, and the id carries no invisible mark.
    expect(githubHeadingSlug('🖼️ 特性巡礼')).toBe('-特性巡礼')
    expect(githubHeadingSlug('🖼️ 特性巡礼')).not.toContain('\uFE0F')
    expect(githubHeadingSlug('🚀 安装')).toBe('-安装')
    expect(githubHeadingSlug('⌨️ 快捷键')).toBe('-快捷键')
    // A flag emoji is a regional-indicator pair (`\p{So}`, outside
    // Extended_Pictographic) — dropped all the same.
    expect(githubHeadingSlug('🇨🇳 中国')).toBe('-中国')
    // ZWJ sequences: the joiner is format-category, the pictographs go too.
    expect(githubHeadingSlug('👨‍👩‍👧 Family')).toBe('-family')
    // Nothing left at all: the slug is empty and no id is assigned.
    expect(githubHeadingSlug('🚀')).toBe('')
  })

  it('keeps letters, digits and combining marks of every script', () => {
    expect(githubHeadingSlug('中文标题')).toBe('中文标题')
    expect(githubHeadingSlug('已核实的事实')).toBe('已核实的事实')
    expect(githubHeadingSlug('API 参考 (v2)')).toBe('api-参考-v2')
    // The full-width colon is punctuation: it goes, the text stays.
    expect(githubHeadingSlug('认领文件链接：在侧栏打开')).toBe('认领文件链接在侧栏打开')
    // A combining mark is NOT punctuation: `é` written as `e` + U+0301 keeps
    // both halves (github-slugger keeps `\p{M}` too).
    expect(githubHeadingSlug('Cafe\u0301')).toBe('cafe\u0301')
    // Non-ASCII digits and letters survive as themselves.
    expect(githubHeadingSlug('Γειά σου Κόσμε')).toBe('γειά-σου-κόσμε')
  })

  it('yields an empty slug for text with nothing to keep', () => {
    expect(githubHeadingSlug('!!!')).toBe('')
    expect(githubHeadingSlug('')).toBe('')
    // Whitespace is not "nothing" to GitHub — each space is a dash, so a
    // space-only heading has a non-empty id (and `assignHeadingIds` keeps it).
    expect(githubHeadingSlug('   ')).toBe('---')
  })

  it('matches the real github-slugger regex on emoji-free text', () => {
    // Everything the reference slugger keeps or drops that is NOT an emoji: the
    // Unicode ranges, the punctuation/symbol classes, case folding. (Emoji and
    // variation selectors are excluded on purpose — see `vs16Free` below.)
    const samples = [
      ...README_FILES.flatMap(name => scanDocumentAnchors(readme(name)).headings.map(vs16Free)),
      'Hello, World!',
      '  Mixed   CASE  ',
      'API 参考 (v2)',
      '认领文件链接：在侧栏打开',
      'Cafe\u0301 au lait',
      'Foo-Bar_Baz',
      'a\tb',
      'Trailing punctuation:',
      'C++ / C#',
      '100% 覆盖 · 12/12',
      'ΑΒΓ αβγ',
      'Привет, мир',
      '한국어 제목',
      'emoji-free ~~~ tilde fence',
      '1. 有序标题',
      '– dash –',
      '已核实的事实',
    ]

    // Every README heading and every sample above must slug identically.
    for (const sample of samples) {
      expect(githubHeadingSlug(sample), sample).toBe(referenceSlug(sample))
    }
    // Guard the guard: the list really did carry the interesting scripts, and
    // the README headings really were in it.
    expect(samples).toContain('认领文件链接：在侧栏打开')
    expect(samples).toContain('Cafe\u0301 au lait')
    // The README headings were in the list too, emoji stripped (the emoji case
    // is pinned separately below).
    const stripped = vs16Free('🖼️ 特性巡礼')
    expect(stripped).toBe('🖼 特性巡礼')
    expect(samples).toContain(stripped)
    expect(githubHeadingSlug(stripped)).toBe(referenceSlug(stripped))
    // The one deliberate divergence: github-slugger KEEPS U+FE0F (the emoji is
    // rendered to an `<img>` before the slugger ever runs, so upstream never has
    // to drop it). Against the raw text `🖼️` would slug to `️` — an invisible
    // id — which is exactly what we fix.
    expect(referenceSlug('🖼️ 特性巡礼')).toBe('\uFE0F-特性巡礼')
    expect(githubHeadingSlug('🖼️ 特性巡礼')).toBe('-特性巡礼')
  })

  it('assigns document-order ids with GitHub repeat suffixes, skipping empty slugs', () => {
    const root = document.createElement('div')
    root.innerHTML = [
      '<h2>Hello, World!</h2>',
      '<h2>Hello, World!</h2>',
      '<h2>Hello, World!</h2>',
      '<h2>🚀</h2>',
      '<h2 id="authored">Authored</h2>',
      '<h2>Authored</h2>',
      '<h3>🚀 安装</h3>',
    ].join('')
    assignHeadingIds(root)
    expect([...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(heading => heading.id))
      .toEqual(['hello-world', 'hello-world-1', 'hello-world-2', '', 'authored', 'authored-1', '-安装'])
    // The generated ids are the ones the reference slugger would produce.
    expect(referenceHeadingIds(['Hello, World!', 'Hello, World!', 'Hello, World!', '', 'Authored', 'Authored']))
      .toEqual(['hello-world', 'hello-world-1', 'hello-world-2', '', 'authored', 'authored-1'])
  })
})

describe('the repos\u2019 own READMEs', () => {
  for (const name of README_FILES) {
    it(`${name}: every in-document anchor resolves against a real heading id`, () => {
      const { headings, anchors } = scanDocumentAnchors(readme(name))
      // The ids the PREVIEW actually puts on the headings — the plugin's own
      // slugger, run over the parser's own heading list, exactly as
      // `assignHeadingIds` does it in the DOM.
      const ids = new Set(headings.map(heading => githubHeadingSlug(heading)).filter(id => id !== ''))
      const unresolved = anchors.filter(anchor => !ids.has(decodeURIComponent(anchor.slice(1))))
      // The regression this guards: `0/16 resolved` before this batch (the old
      // slugger trimmed and collapsed whitespace, so `🚀 安装` got the id `安装`
      // while its table of contents pointed at `#-安装`).
      expect(anchors.length).toBeGreaterThanOrEqual(15)
      expect(unresolved).toEqual([])
      // Guard the other direction: resolution is not vacuous — the ids really
      // are the emoji-stripped GitHub spellings, and an anchor no heading
      // produces would still fail.
      const expectsChinese = name === 'README.md'
      expect(ids.has('-特性巡礼')).toBe(expectsChinese)
      expect(ids.has('\uFE0F-特性巡礼')).toBe(false)
      expect(ids.has('-preview-plugins-file-previewers')).toBe(false)
      expect([...ids].filter(id => id.includes('\uFE0F'))).toEqual([])
    })
  }
})
