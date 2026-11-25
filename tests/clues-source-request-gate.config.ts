/** Runs source behavior against an injected gate; real scheduler tests belong to the parent. */
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../vitest.config.ts'
export default mergeConfig(base, defineConfig({
  resolve: { alias: [{ find: /^.*\/request-gate\.ts$/, replacement: fileURLToPath(new URL('./fixtures/clues-source-request-gate.ts', import.meta.url)) }] },
}))
