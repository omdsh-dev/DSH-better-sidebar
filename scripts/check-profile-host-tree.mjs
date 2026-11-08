/**
 * Detect the torn host-package shadow pair that keeps this plugin from
 * activating at all (issue #1107: `DesktopHostFatalError: required plugins did
 * not activate / better-sidebar`).
 *
 * DSH resolves a profile plugin's bare imports through its own runtime
 * interception (`dsh-app-boot`'s `routeScoped`): a copy the profile installs
 * under `<profile>/node_modules` wins over the installation's own tuple, and
 * that winning copy is itself the anchor for that copy's siblings' imports.
 * So a profile carrying its own `@deepseek-ai/dsh-subagent` also binds
 * `@deepseek-ai/dsh-attachment` from the profile tree. The plugin statically
 * imports `dsh-subagent` (src/sidechat-routes.ts), whose module graph pulls
 * the rest of the host packages — a mixed set can strip a symbol that graph
 * imports, and the failure surfaces as a host fatal error ("required plugins
 * did not activate") instead of one readable plugin error.
 *
 * The reliable signal for that mix is the sibling pin: `dsh-subagent` declares
 * the exact host version of `dsh-attachment`, so a profile copy that disagrees
 * with it came from a different host release. When the profile shadows only the
 * subagent, the installation supplies the sibling and that pairing is out of
 * reach here.
 *
 * The lookup below mirrors that resolution exactly: Node's node_modules order
 * from the installed plugin, restricted to the profile directory — the prefix
 * the interception stops at (`layer.localPrefix`), which is why copies above
 * the profile (the shared `profiles/node_modules` tree) never win there and
 * are ignored here.
 *
 * Only an exact pinned peer is judged (`dsh-subagent` pins the sibling host
 * package by exact version, so the pairing is decidable); ranged peers are
 * treated as clear rather than guessed at.
 *
 * Usage: node scripts/check-profile-host-tree.mjs <profile dir>
 * Exit 0 — nothing torn (plugin not installed, no shadow copy, or a matching
 *          pair); exit 1 — torn pair, with the repair printed to stderr.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'

const PLUGIN = 'dsh-better-sidebar'
const SUBAGENT = '@deepseek-ai/dsh-subagent'
const ATTACHMENT = '@deepseek-ai/dsh-attachment'
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function realOrUndefined(path) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function manifestOf(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

/**
 * The copy Node would pick for `name` from `anchor`, limited to the profile
 * tree. Returns undefined when the profile installs no such copy (the host
 * installation then supplies it, consistently for every importer).
 */
function shadowOf(anchor, name, profileDir) {
  const prefix = profileDir + sep
  for (const searchPath of createRequire(anchor).resolve.paths(name) ?? []) {
    if (!searchPath.startsWith(prefix)) continue
    const dir = join(searchPath, name)
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  return undefined
}

/** The broken pairing, or undefined when the profile cannot break this import. */
function tornPair(profileDir) {
  const profile = realOrUndefined(profileDir)
  if (profile === undefined) return undefined
  const pluginDir = realOrUndefined(join(profile, 'node_modules', PLUGIN))
  // A `link:` install resolves outside the profile tree and is not intercepted
  // as a profile-layer importer, so the shadow rule does not apply to it.
  if (pluginDir === undefined || !pluginDir.startsWith(profile + sep)) return undefined
  const subagentDir = shadowOf(join(pluginDir, 'package.json'), SUBAGENT, profile)
  if (subagentDir === undefined) return undefined
  const expected = manifestOf(subagentDir).peerDependencies?.[ATTACHMENT]
  if (typeof expected !== 'string' || !EXACT_VERSION.test(expected)) return undefined
  const attachmentDir = shadowOf(join(subagentDir, 'package.json'), ATTACHMENT, profile)
  if (attachmentDir === undefined) return undefined
  const subagent = manifestOf(subagentDir).version
  const attachment = manifestOf(attachmentDir).version
  return attachment === expected ? undefined : { profile, subagent, expected, attachment }
}

const profileArg = process.argv[2]
if (profileArg === undefined || profileArg === '') {
  console.error('用法：node scripts/check-profile-host-tree.mjs <profile 目录>')
  process.exit(2)
}

const torn = tornPair(resolve(profileArg))
if (torn === undefined) {
  console.log('[host-tree] profile 未自带宿主包影子副本，或 @deepseek-ai/dsh-subagent ↔ dsh-attachment 配对一致')
  process.exit(0)
}

console.error(`[host-tree] profile 自带的宿主包配对不一致：${SUBAGENT} ${torn.subagent} 要求 ${ATTACHMENT} ${torn.expected}，实际解析到 ${torn.attachment}`)
console.error(`[host-tree] profile：${torn.profile}`)
console.error('[host-tree] 它们会抢在 DSH 安装之前被解析，本插件静态 import 的 dsh-subagent 因此绑到混搭版本；混版缺导出时宿主启动只报')
console.error('[host-tree]   DesktopHostFatalError / required plugins did not activate，看不到是哪个包缺了什么。')
console.error('[host-tree] 修复（任选其一，然后重启 DSH）：')
console.error(`[host-tree]   A. 让 DSH 安装提供宿主包：从 profile 的 package.json 与 overrides 移除 @deepseek-ai/dsh-*，再 cd ${torn.profile} && pnpm install`)
console.error(`[host-tree]      （若副本由别的依赖带进来：cd ${torn.profile} && pnpm update @deepseek-ai/dsh-*` + '）')
console.error(`[host-tree]   B. 把副本对齐到同一版本：cd ${torn.profile} && pnpm add ${SUBAGENT}@${torn.expected} ${ATTACHMENT}@${torn.expected}`)
process.exit(1)
