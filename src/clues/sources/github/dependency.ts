/**
 * The `github.gh` dependency definition (S3).
 *
 * Version contract: the recommended version is the release this source was
 * actually verified against (`gh 2.102.0`, executed locally: version probe,
 * every GraphQL document, `auth status --json hosts`, and `issue/pr edit`
 * argv). The minimum (2.40.0) is the compatibility floor by CLI feature
 * availability; only 2.102.0 was executed, so an older compatible binary is
 * reported ready by the version probe but is not claimed as tested.
 *
 * Platform matrix: only the official v2.102.0 asset targets this source
 * verified — each archive was downloaded and its sha256 matched the official
 * `gh_2.102.0_checksums.txt`, and the archive layout was inspected for the
 * executable path. Only darwin/arm64 was actually EXECUTED; the other targets
 * are verified distributions, not run-time claims. Every other target falls
 * back to `manualInstall` + S2's explicit path setting: nothing is invented.
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

/** The verified compatibility floor. */
export const GITHUB_GH_MINIMUM_VERSION = '2.40.0'

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
    { platform: 'darwin', arch: 'amd64' },
    { platform: 'linux', arch: 'amd64' },
    { platform: 'linux', arch: 'arm64' },
    { platform: 'win32', arch: 'amd64' },
  ]
}

/** Each distribution is the official asset of one matrix target. */
function distributions(): readonly DependencyDistribution[] {
  return [
    archive('darwin', 'arm64', 'gh_2.102.0_macOS_arm64.zip',
      'da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e', 'bin/gh', 1),
    archive('darwin', 'amd64', 'gh_2.102.0_macOS_amd64.zip',
      'b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3', 'bin/gh', 1),
    archive('linux', 'amd64', 'gh_2.102.0_linux_amd64.tar.gz',
      'bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386', 'bin/gh', 1),
    archive('linux', 'arm64', 'gh_2.102.0_linux_arm64.tar.gz',
      '7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484', 'bin/gh', 1),
    archive('win32', 'amd64', 'gh_2.102.0_windows_amd64.zip',
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
