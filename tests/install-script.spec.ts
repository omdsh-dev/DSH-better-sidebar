import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const INSTALL = resolve(import.meta.dirname, '../scripts/install.sh')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  root: string
  profile: string
  dsh: string
}

function fixture(hasBundle: boolean, patch = '# profile patch layer\n# applied after bundles\n[]\n'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'better-sidebar-install-'))
  roots.push(root)
  const profile = join(root, 'profiles/web')
  const bin = join(root, 'fake-dsh')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'test-profile',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['base'] } },
  }, null, 2) + '\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), patch)
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const profile = path.join(process.env.DSH_HOME, 'profiles/web')
const pkgFile = path.join(profile, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
pkg.dependencies['dsh-better-sidebar'] = '0.10.1'
if (${hasBundle}) pkg.dsh.profile.bundles.push('dsh-better-sidebar')
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\\n')
const installed = path.join(profile, 'node_modules/dsh-better-sidebar')
fs.mkdirSync(installed, { recursive: true })
fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({
  name: 'dsh-better-sidebar',
  version: '0.10.1',
  dsh: ${hasBundle} ? { bundle: { patch: './cordis.patch.yml' } } : { client: {} },
}))
`)
  chmodSync(bin, 0o755)
  return { root, profile, dsh: bin }
}

function install(f: Fixture) {
  return spawnSync('bash', [INSTALL, '0.10.1'], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: f.root, DSH_CMD: f.dsh },
  })
}

describe('scripts/install.sh mount reconciliation', () => {
  it('falls back to one valid manual mount when the installed release has no dsh.bundle.patch', () => {
    const f = fixture(false)

    const first = install(f)
    expect(first.status, first.stderr).toBe(0)
    const patch = readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('# profile patch layer')
    expect(patch).not.toContain('[]')
    expect(patch.match(/id: better-sidebar/g)).toHaveLength(1)
    expect(patch).toContain("name: 'dsh-better-sidebar'")

    const second = install(f)
    expect(second.status, second.stderr).toBe(0)
    expect(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  })

  it('does not mistake an id-targeted override for a legacy manual mount', () => {
    const override = '- id: better-sidebar\n  config:\n    readLimit: 1024\n'
    const f = fixture(false, override)

    const result = install(f)
    expect(result.status, result.stderr).toBe(0)
    const patch = readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('readLimit: 1024')
    expect(patch.match(/name: 'dsh-better-sidebar'/g)).toHaveLength(1)
  })

  it('uses the registered bundle and removes an alternate valid legacy mount', () => {
    const legacy = '# old mount\n- insert:\n  - id: better-sidebar\n    name: "dsh-better-sidebar"\n'
    const f = fixture(true, legacy)

    const result = install(f)
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    const pkg = JSON.parse(readFileSync(join(f.profile, 'package.json'), 'utf8'))
    expect(pkg.dsh.profile.bundles).toContain('dsh-better-sidebar')
  })
})
