/**
 * Host-package shadow contract (#1107).
 *
 * DSH resolves a profile plugin's bare imports through its own profile
 * interception, where a copy installed inside the profile beats the
 * installation's tuple and becomes the anchor for that copy's own siblings.
 * A profile carrying its own `@deepseek-ai/dsh-subagent` therefore also
 * resolves `@deepseek-ai/dsh-attachment` from the profile tree; when the two
 * copies disagree, loading this plugin dies in the ESM linker and the whole
 * host refuses to boot ("required plugins did not activate") instead of
 * disabling one row.
 *
 * `scripts/check-profile-host-tree.mjs` must predict exactly the resolution the
 * host will perform: profile-local copies only (plus the pairing rule), silent
 * pass otherwise. `tests/...` run the shipped script itself, so the assertions
 * below fail if the detection is removed, not just if its output is reworded.
 * Both standalone installers must run it after installing and before telling
 * the user to restart, and the script must be published or that run silently
 * skips.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTree } from './temp-tree.ts'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CHECK = resolve(ROOT, 'scripts/check-profile-host-tree.mjs')
const SUBAGENT = '@deepseek-ai/dsh-subagent'
const ATTACHMENT = '@deepseek-ai/dsh-attachment'
const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshbs-host-tree-'))
  tempDirs.push(dir)
  return dir
}

function writePackage(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

/** One profile with the plugin installed and the requested host-package copies. */
function profileFixture(options: { plugin?: boolean; subagent?: string; attachment?: string; peer?: string }): string {
  const profile = join(tempDir(), 'web')
  if (options.plugin !== false) writePackage(join(profile, 'node_modules', 'dsh-better-sidebar'), { name: 'dsh-better-sidebar', version: '0.29.0' })
  if (options.subagent !== undefined) {
    writePackage(join(profile, 'node_modules', SUBAGENT), {
      name: SUBAGENT,
      version: options.subagent,
      peerDependencies: { [ATTACHMENT]: options.peer ?? options.subagent },
    })
  }
  if (options.attachment !== undefined) writePackage(join(profile, 'node_modules', ATTACHMENT), { name: ATTACHMENT, version: options.attachment })
  return profile
}

function runCheck(profile: string): { status: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [CHECK, profile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, output: stdout }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failed.status ?? -1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` }
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTree(dir)
})

describe('profile host-package shadow check', () => {
  it('fails a torn subagent/attachment pair and names both versions', () => {
    const profile = profileFixture({ subagent: '0.2.1-rc.5', attachment: '0.1.0-rc.8', peer: '0.2.1-rc.5' })
    const { status, output } = runCheck(profile)

    expect(status).toBe(1)
    expect(output).toContain('0.2.1-rc.5')
    expect(output).toContain('0.1.0-rc.8')
    expect(output).toContain(realpathSync(profile))
  })

  it('passes a profile copy pair that matches the subagent peer pin', () => {
    const profile = profileFixture({ subagent: '0.2.1-rc.5', attachment: '0.2.1-rc.5' })

    expect(runCheck(profile).status).toBe(0)
  })

  it('passes a shadowed subagent whose attachment the installation then supplies', () => {
    const profile = profileFixture({ subagent: '0.2.1-rc.5' })

    expect(runCheck(profile).status).toBe(0)
  })

  it('ignores a stale copy above the profile, where the host never looks', () => {
    const root = tempDir()
    const profile = join(root, 'web')
    writePackage(join(profile, 'node_modules', 'dsh-better-sidebar'), { name: 'dsh-better-sidebar', version: '0.29.0' })
    writePackage(join(profile, 'node_modules', SUBAGENT), { name: SUBAGENT, version: '0.2.1-rc.5', peerDependencies: { [ATTACHMENT]: '0.2.1-rc.5' } })
    writePackage(join(root, 'node_modules', ATTACHMENT), { name: ATTACHMENT, version: '0.1.0-rc.8' })

    expect(runCheck(profile).status).toBe(0)
  })

  it('passes a profile without the plugin or without any shadow copy', () => {
    expect(runCheck(profileFixture({ plugin: false, subagent: '0.2.1-rc.5', attachment: '0.1.0-rc.8' })).status).toBe(0)
    expect(runCheck(tempDir()).status).toBe(0)
  })

  it('is shipped in the published package and run by both standalone installers', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files?: string[] }
    expect(pkg.files).toContain('scripts/check-profile-host-tree.mjs')

    const invocations = [
      ['scripts/install.sh', 'node_modules/$PKG/scripts/check-profile-host-tree.mjs', 'node "$HOST_TREE_CHECK" "$PROFILE_DIR"'],
      ['scripts/install.ps1', 'node_modules\\$PKG\\scripts\\check-profile-host-tree.mjs', '& node $hostTreeCheck $PROFILE_DIR'],
    ] as const
    for (const [installer, scriptPath, command] of invocations) {
      const source = readFileSync(join(ROOT, installer), 'utf8')
      expect(source, installer).toContain(scriptPath)
      expect(source, installer).toContain(command)
    }
  })
})
