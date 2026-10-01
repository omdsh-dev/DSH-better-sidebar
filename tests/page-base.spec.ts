// @vitest-environment jsdom
/**
 * Under a reverse proxy that mounts dsh at a path, every sidebar URL must resolve beneath the
 * page's `<base href>`; at the root (no base tag) nothing may change.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dshRoot, dshUrl, pageBase } from '../src/client/page-base.ts'

afterEach(() => {
  document.head.replaceChildren()
})

function mount(href: string): void {
  const base = document.createElement('base')
  base.href = href
  document.head.append(base)
}

describe('page-base', () => {
  it('places root-relative sidebar paths under the mount the base tag names', () => {
    mount('https://cowork.example/site.example/')
    expect(pageBase()).toBe('https://cowork.example/site.example/')
    expect(dshUrl('/sidebar/api/list')).toBe('https://cowork.example/site.example/sidebar/api/list')
    expect(dshUrl('/sidebar/file?sessionId=s&path=%2Fa')).toBe('https://cowork.example/site.example/sidebar/file?sessionId=s&path=%2Fa')
    expect(dshUrl('/sidebar/html/s//server/share/a.html')).toBe('https://cowork.example/site.example/sidebar/html/s//server/share/a.html')
    expect(dshRoot()).toBe('https://cowork.example/site.example')
    expect(new URL(dshUrl('/sidebar/ws/terminal'), location.origin).pathname).toBe('/site.example/sidebar/ws/terminal')
  })

  it('tolerates a base without its trailing slash', () => {
    mount('https://cowork.example/site.example')
    expect(dshUrl('/sidebar/api/list')).toBe('https://cowork.example/site.example/sidebar/api/list')
  })

  it('leaves everything exactly as it was when the page has no base tag', () => {
    expect(pageBase()).toBeNull()
    expect(dshUrl('/sidebar/api/list')).toBe('/sidebar/api/list')
    expect(dshRoot()).toBe(location.origin)
  })

  it('never rewrites what is not a root-relative path', () => {
    mount('https://cowork.example/site.example/')
    expect(dshUrl('https://elsewhere.example/x')).toBe('https://elsewhere.example/x')
    expect(dshUrl('//cdn.example/x')).toBe('//cdn.example/x')
    expect(dshUrl('relative/x')).toBe('relative/x')
  })
})

/** Every client source file, recursively. */
function clientSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? clientSources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []
  )
}

describe('page-base use', () => {
  // `ws/agent-opens` was built as `new URL('/sidebar/ws/agent-opens', location.origin)` and got 403 behind
  // Tracy's `/<siteKey>/` mount: a root-absolute literal handed straight to URL/fetch/WebSocket skips the base.
  it('no client source hands a root-absolute /sidebar/ path to URL, fetch or WebSocket without dshUrl', () => {
    const root = join(process.cwd(), 'src/client') // vitest runs from the package, as the other source-reading specs assume
    const offenders = clientSources(root).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${file.slice(root.length + 1)}:${i + 1}` }))
        .filter(({ line }) => /\b(?:new URL|fetch|new WebSocket)\(\s*['"`]\/sidebar\//.test(line))
        .map(({ at }) => at)
    )
    expect(offenders).toEqual([])
  })
})
