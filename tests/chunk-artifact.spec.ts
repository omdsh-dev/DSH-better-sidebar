/**
 * Built chunk artifact contract: each lib/client-<name>.js must, when
 * executed as a classic script, assign its factory to the plugin-owned
 * global registry (globalThis.__dshChunks__[<name>]), and the factory must
 * be callable with a require that resolves the platform externals — the
 * exact shape the loader (src/client/chunk-loader.ts) depends on. Reads the
 * built lib/ output, so run `pnpm build` first (like manifest-consistency).
 * A missing lib/ (fresh clone before the first build) skips the whole suite
 * instead of crashing on ENOENT.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// Browser globals first: chunk bodies probe `self`/`document` at evaluation
// (CodeMirror's UA probe).
import './browser-globals.ts'
import { CHUNK_EXTERNALS } from '../src/client/chunk-loader.ts'
import { CHUNK_NAMES } from '../src/bundle-route.ts'

const g = globalThis as Record<string, unknown>

/**
 * The chunk set, DERIVED from the host route's allowlist — the same registry
 * `/sidebar/bundle` serves from (src/bundle-route.ts). Never hand-mirrored:
 * the hand-written list that used to live here drifted (`locale` was
 * missing), so the locale artifact went unguarded.
 */
const CHUNKS = CHUNK_NAMES

/** All chunk artifacts present (tsdown emits the whole lib/ in one run). */
const chunksBuilt = CHUNKS.every(name => existsSync(`lib/client-${name}.js`))

if (!chunksBuilt) {
  console.warn('[chunk-artifact] lib/ chunk artifacts missing — run `pnpm build` first; skipping this suite')
}

describe.skipIf(!chunksBuilt)('built chunk artifacts', () => {
  it('each chunk assigns its global registry slot when executed as a script', () => {
    g.window = g // classic-script globals
    // mermaid's core hooks window.addEventListener('load') at module scope
    // (its startOnLoad wiring); the Node global lacks the API, so stub it
    // exactly like browser-globals.ts does for its window stub.
    if (typeof g.addEventListener !== 'function') g.addEventListener = () => {}
    if (typeof g.removeEventListener !== 'function') g.removeEventListener = () => {}
    for (const name of CHUNKS) {
      const code = readFileSync(`lib/client-${name}.js`, 'utf8')
      expect(() => new Function(code)(), name).not.toThrow()
      const registry = g.__dshChunks__ as Record<string, unknown>
      expect(typeof registry[name], name).toBe('function')
    }
  })

  it('each chunk factory materializes through a require over the platform externals', () => {
    const registry = g.__dshChunks__ as Record<string, unknown>
    const table = new Map<string, unknown>(CHUNK_EXTERNALS.map(spec => [spec, { spec }]))
    for (const name of CHUNKS) {
      const factory = registry[name] as (require: (spec: string) => unknown) => Record<string, unknown>
      expect(() => factory((spec) => {
        if (!table.has(spec)) throw new Error(`require("${spec}") missed the module table`)
        return table.get(spec)
      }), name).not.toThrow()
    }
  })

  /**
   * The emulator's own DOM contract, present in xterm's runtime source AND in
   * its stylesheet — either half landing in the core bundle means the lazy
   * split broke. `@xterm/xterm` alone would be too weak a probe: the package
   * NAME also shows up in doc comments and locale copy.
   */
  const XTERM_MARKER = 'xterm-char-measure-element'

  it('the terminal chunk carries xterm and the core bundles carry none of it', () => {
    // #774's whole build requirement: several hundred KB of emulator must not
    // reach startup. The core bundle is what the plugin ships to every page
    // load, so a static import of src/client/TerminalView.tsx (or of the
    // xterm stylesheet) from a core module would show up here.
    const chunk = readFileSync('lib/client-terminal.js', 'utf8')
    expect(chunk).toContain(XTERM_MARKER)
    expect(chunk).toContain('@xterm/xterm/lib/xterm.js')
    for (const file of ['lib/client.js', 'lib/client-registry.js']) {
      const source = readFileSync(file, 'utf8')
      expect(source, `${file} must not bundle xterm`).not.toContain(XTERM_MARKER)
      expect(source, `${file} must not resolve @xterm/xterm`).not.toContain('@xterm/xterm')
    }
  })
})
