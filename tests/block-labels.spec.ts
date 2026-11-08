/** alpha.5 requires an accessible name for each authored terminal command line. */
import { afterEach, describe, expect, it } from 'vitest'
import { terminalBlockLabels } from '../src/client/block-labels.ts'
import { attachLocale } from '../src/client/locales.ts'

afterEach(() => { attachLocale(undefined) })

describe('terminal command line labels', () => {
  it.each([
    ['en', 'Command line 2'],
    ['zh', '命令第 2 行'],
  ])('localizes the one-based line number in %s', (active, expected) => {
    attachLocale({ getSnapshot: () => ({ active }) })
    expect(terminalBlockLabels().commandLine(2)).toBe(expected)
  })
})
