/**
 * Built chunk artifact contract: each lib/client-<name>.js must, when
 * executed as a classic script, assign its factory to the plugin-owned
 * global registry (globalThis.__dshChunks__[<name>]), and the factory must
 * be callable with a require that resolves the platform externals — the
 * exact shape the loader (src/client/chunk-loader.ts) depends on. Reads the
 * built lib/ output, so run `pnpm build` first (like manifest-consistency).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// Browser globals first: chunk bodies probe `self`/`document` at evaluation
// (xterm's UMD wrapper, CodeMirror's UA probe).
import './browser-globals.ts'
import { CHUNK_EXTERNALS } from '../src/client/chunk-loader.ts'

const g = globalThis as Record<string, unknown>

const CHUNKS = ['terminal', 'editor']

describe('built chunk artifacts', () => {
  it('each chunk assigns its global registry slot when executed as a script', () => {
    g.window = g // classic-script globals
    for (const name of CHUNKS) {
      const code = readFileSync(`lib/client-${name}.js`, 'utf8')
      // eslint-disable-next-line no-new-func
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
})
