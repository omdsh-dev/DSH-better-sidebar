/**
 * Host baseline contract: package DSH peers/dev pins, standalone installers,
 * e2e fallback/version check and CI must move together, without floating CLI tags.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const baseline = '0.2.1-rc.1'
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const bash = readFileSync(new URL('../scripts/install.sh', import.meta.url), 'utf8')
const powershell = readFileSync(new URL('../scripts/install.ps1', import.meta.url), 'utf8')
const e2e = readFileSync(new URL('../scripts/e2e-common.sh', import.meta.url), 'utf8')
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

describe('DSH host baseline', () => {
  it('keeps all DSH package peers and dev pins on the exact baseline', () => {
    for (const [section, prefix] of [['peerDependencies', '^'], ['devDependencies', '']] as const) {
      const entries = Object.entries(pkg[section]).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      expect(entries.length, section).toBeGreaterThan(0)
      for (const [name, version] of entries) {
        expect(version, `${section}.${name}`).toBe(`${prefix}${baseline}`)
      }
    }
  })

  it('does not publish or depend on the retired invariant companion', () => {
    expect(pkg.exports).not.toHaveProperty('./invariant')
    expect(pkg.files).not.toContain('lib/invariant.js')
    for (const section of ['peerDependencies', 'devDependencies', 'dependencies']) {
      expect(pkg[section]).not.toHaveProperty('@deepseek-ai/dsh-invariants')
    }
  })

  it('pins both standalone installer npx fallbacks', () => {
    expect(bash).toContain(`printf 'npx -y --package @deepseek-ai/dsh@${baseline} dsh'`)
    expect(powershell).toContain(`$cliArgs = @('-y', '--package', '@deepseek-ai/dsh@${baseline}', 'dsh', 'plugin'`)
    for (const source of [bash, powershell]) {
      expect(source).not.toMatch(/^\s*(?:source|\.)\s+[^\r\n]*e2e-common/m)
    }
  })

  it('pins the e2e fallback and expected version to the same baseline', () => {
    expect(e2e).toContain('DSH_NPX_SPEC="${DSH_NPX_SPEC:-@deepseek-ai/dsh@' + baseline + '}"')
    expect(e2e).toContain('expected="${DSH_EXPECT_VERSION:-' + baseline + '}"')
  })

  it.each(['\n', '\r\n'])('pins CI with its heap budget and peer resolution intact (%j)', (eol) => {
    // Git may check out YAML as CRLF on Windows; the contract is the same.
    const source = ci.replace(/\r?\n/g, eol)
    expect(source).toContain(`NODE_OPTIONS: --max-old-space-size=4096${eol}        run: npm install -g @deepseek-ai/dsh@${baseline}${eol}`)
    expect(source).not.toMatch(/^\s*run:.*--legacy-peer-deps/m)
  })
})
