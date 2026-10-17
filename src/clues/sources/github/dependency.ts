/**
 * The `github.gh` dependency definition (S3).
 *
 * Version contract: the recommended version is the release this source was
 * actually verified against (`gh 2.102.0`, executed locally: version probe,
 * every GraphQL document, `auth status --json hosts`, and `issue/pr edit`
 * argv). The minimum is `2.81.0`, the first release whose
 * `gh auth status --json hosts` works (the connection adapter's ONLY status
 * projection; `gh auth login --clipboard` exists since 2.79.0, so 2.81.0 is
 * the binding floor). S2 rejects anything older through the version probe
 * before an auth command can run. The 2.81.0 boundary was checked against the
 * real 2.80.0/2.81.0 binaries (2.80.0 fails with `unknown flag: --json`,
 * 2.81.0 returns the same hosts/scopes JSON shape as the fixture); the full
 * source matrix was executed only on 2.102.0.
 *
 * Platform matrix: only the official v2.102.0 asset targets this source
 * verified — each archive was downloaded and its sha256 matched the official
 * `gh_2.102.0_checksums.txt`, and the archive layout was inspected for the
 * executable path. Only darwin/arm64 was actually EXECUTED; the other targets
 * are verified distributions, not run-time claims. `arch` uses NODE's
 * vocabulary (`x64`, `arm64`) because S2 compares it to `process.arch`
 * exactly; the official asset filenames keep their `amd64` spelling. Every
 * other target falls back to `manualInstall` + S2's explicit path setting:
 * nothing is invented.
 */
import type {
  ClueDependencyDefinition,
  DependencyDistribution,
  DependencyTarget,
  NodePlatform,
} from '../../runtime/types.ts'
import { GITHUB_DEPENDENCY_ID, GITHUB_PLUGIN_ID } from './ids.ts'

/** The official release tag the distributions and checksums come from. */
export const GITHUB_GH_RELEASE = '2.102.0'

/** The verified compatibility floor (first release with `auth status --json`). */
export const GITHUB_GH_MINIMUM_VERSION = '2.81.0'

/** The official release asset root. */
const RELEASE_ROOT = `https://github.com/cli/cli/releases/download/v${GITHUB_GH_RELEASE}/`

/** One verified official archive (checksum from the official checksums file). */
function archive(
  platform: NodePlatform,
  arch: string,
  file: string,
  sha256: string,
  executable: string,
  stripComponents: number,
): DependencyDistribution {
  return {
    kind: 'archive',
    source: 'GitHub releases',
    platforms: [{ platform, arch }],
    url: `${RELEASE_ROOT}${file}`,
    sha256,
    archive: file.endsWith('.zip') ? 'zip' : 'tar.gz',
    executable,
    stripComponents,
  }
}

/**
 * The verified platform matrix: official v2.102.0 assets (checksum + layout)
 * for the mainstream targets. Unlisted targets get manual guidance only.
 */
export function githubGhInstallTargets(): readonly DependencyTarget[] {
  return [
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' },
    { platform: 'linux', arch: 'x64' },
    { platform: 'linux', arch: 'arm64' },
    { platform: 'win32', arch: 'x64' },
  ]
}

/** Each distribution is the official asset of one matrix target. */
function distributions(): readonly DependencyDistribution[] {
  return [
    archive('darwin', 'arm64', 'gh_2.102.0_macOS_arm64.zip',
      'da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e', 'bin/gh', 1),
    archive('darwin', 'x64', 'gh_2.102.0_macOS_amd64.zip',
      'b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3', 'bin/gh', 1),
    archive('linux', 'x64', 'gh_2.102.0_linux_amd64.tar.gz',
      'bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386', 'bin/gh', 1),
    archive('linux', 'arm64', 'gh_2.102.0_linux_arm64.tar.gz',
      '7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484', 'bin/gh', 1),
    archive('win32', 'x64', 'gh_2.102.0_windows_amd64.zip',
      'ae64e556ecc240b200f7eba60d550e4bb60d78e860e69dd88c449405b86067f4', 'bin/gh.exe', 0),
  ]
}

/**
 * The shared gh dependency definition registered with S2's dependency runtime.
 * Both GitHub sources reference this one id.
 */
export function githubGhDependency(): ClueDependencyDefinition {
  return {
    dependencyId: GITHUB_DEPENDENCY_ID,
    name: 'GitHub CLI (gh)',
    command: 'gh',
    pluginId: GITHUB_PLUGIN_ID,
    version: {
      minimum: GITHUB_GH_MINIMUM_VERSION,
      recommended: GITHUB_GH_RELEASE,
    },
    // `gh auth login --web --clipboard` spawns the platform clipboard helper.
    // S2's fixed allowlist has no display/session variables, so on Linux the
    // helper would not find the user's session; these NAMES (never secret
    // values) are all the clipboard path needs. A truly headless host still
    // has no clipboard and falls back to the prompt's terminal instruction.
    envAllowlist: ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR'],
    supportedPlatforms: githubGhInstallTargets().map(target => ({ ...target })),
    install: { distributions: [...distributions()] },
    manualInstall: {
      instructions:
        `Install GitHub CLI ${GITHUB_GH_RELEASE} from the official release for your platform, `
        + 'then set the explicit gh executable path in the clue source settings.',
      url: `https://github.com/cli/cli/releases/tag/v${GITHUB_GH_RELEASE}`,
    },
  }
}
