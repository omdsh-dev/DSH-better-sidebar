/**
 * Shared file-type icons for the explorer and editor tabs. Classification
 * uses the full path for workflow directories and the leaf name for familiar
 * manifests, dotfiles, and language extensions. Color is intentionally
 * limited to theme-owned semantic roles so every DSH skin remains legible.
 */
import type { ReactElement } from 'react'
import type { IconType } from 'react-icons'
import {
  VscBracketDot,
  VscCode,
  VscCoffee,
  VscDatabase,
  VscFile,
  VscFileBinary,
  VscFileCode,
  VscFileMedia,
  VscFilePdf,
  VscFileText,
  VscFileZip,
  VscGitCommit,
  VscGithubAction,
  VscJson,
  VscKey,
  VscLock,
  VscMarkdown,
  VscNotebook,
  VscPackage,
  VscPython,
  VscRuby,
  VscSettingsGear,
  VscSymbolColor,
  VscSymbolInterface,
  VscSymbolStructure,
  VscTerminalBash,
} from 'react-icons/vsc'
import css from './sidebar.module.css'

export type FileIconKind =
  | 'archive'
  | 'binary'
  | 'code'
  | 'config'
  | 'database'
  | 'env'
  | 'git'
  | 'image'
  | 'javascript'
  | 'json'
  | 'lock'
  | 'markdown'
  | 'markup'
  | 'notebook'
  | 'package'
  | 'pdf'
  | 'python'
  | 'ruby'
  | 'shell'
  | 'stylesheet'
  | 'text'
  | 'typescript'
  | 'workflow'
  | 'yaml'
  | 'file'

export type FileIconTone = 'code' | 'document' | 'config' | 'special' | 'neutral'

export interface FileIconInfo {
  kind: FileIconKind
  tone: FileIconTone
}

interface FileIconSpec extends FileIconInfo {
  icon: IconType
}

const SPEC: Record<FileIconKind, FileIconSpec> = {
  archive: { kind: 'archive', tone: 'neutral', icon: VscFileZip },
  binary: { kind: 'binary', tone: 'neutral', icon: VscFileBinary },
  code: { kind: 'code', tone: 'code', icon: VscFileCode },
  config: { kind: 'config', tone: 'config', icon: VscSettingsGear },
  database: { kind: 'database', tone: 'config', icon: VscDatabase },
  env: { kind: 'env', tone: 'special', icon: VscKey },
  file: { kind: 'file', tone: 'neutral', icon: VscFile },
  git: { kind: 'git', tone: 'config', icon: VscGitCommit },
  image: { kind: 'image', tone: 'code', icon: VscFileMedia },
  javascript: { kind: 'javascript', tone: 'code', icon: VscBracketDot },
  json: { kind: 'json', tone: 'config', icon: VscJson },
  lock: { kind: 'lock', tone: 'config', icon: VscLock },
  markdown: { kind: 'markdown', tone: 'document', icon: VscMarkdown },
  markup: { kind: 'markup', tone: 'code', icon: VscCode },
  notebook: { kind: 'notebook', tone: 'config', icon: VscNotebook },
  package: { kind: 'package', tone: 'config', icon: VscPackage },
  pdf: { kind: 'pdf', tone: 'document', icon: VscFilePdf },
  python: { kind: 'python', tone: 'code', icon: VscPython },
  ruby: { kind: 'ruby', tone: 'special', icon: VscRuby },
  shell: { kind: 'shell', tone: 'code', icon: VscTerminalBash },
  stylesheet: { kind: 'stylesheet', tone: 'code', icon: VscSymbolColor },
  text: { kind: 'text', tone: 'neutral', icon: VscFileText },
  typescript: { kind: 'typescript', tone: 'code', icon: VscSymbolInterface },
  workflow: { kind: 'workflow', tone: 'special', icon: VscGithubAction },
  yaml: { kind: 'yaml', tone: 'special', icon: VscSymbolStructure },
}

const PACKAGE_NAMES = new Set([
  'bun.lock', 'bun.lockb', 'cargo.toml', 'composer.json', 'deno.json', 'deno.jsonc',
  'gemfile', 'go.mod', 'go.sum', 'package.json', 'package-lock.json', 'pnpm-lock.yaml',
  'poetry.lock', 'pyproject.toml', 'requirements.txt', 'yarn.lock',
])

const CONFIG_NAMES = new Set([
  '.editorconfig', '.jscpd.json', '.prettierrc', '.prettierignore', '.stylelintrc',
  'biome.json', 'jsconfig.json', 'tsconfig.json', 'workspace.json',
])

const GIT_NAMES = new Set(['.gitattributes', '.gitignore', '.gitmodules', '.mailmap'])
const WORKFLOW_NAMES = new Set([
  '.circleci', '.gitlab-ci.yml', '.gitlab-ci.yaml', 'azure-pipelines.yml',
  'azure-pipelines.yaml', 'jenkinsfile',
])

/** The path leaf, lower-cased and independent of host path separators. */
function leafName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
}

/** A lower-case extension without the dot; dotfiles are handled by name. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1)
}

/**
 * Resolve a path into a stable visual category. Exact names win over
 * extensions so package manifests and tool configuration stay recognizable.
 */
function resolveFileIconSpec(path: string): FileIconSpec {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  const name = leafName(normalized)
  const ext = extensionOf(name)

  if (normalized.includes('/.github/workflows/') || WORKFLOW_NAMES.has(name)) return SPEC.workflow
  if (GIT_NAMES.has(name) || name === '.git') return SPEC.git
  if (name === '.env' || name.startsWith('.env.')) return SPEC.env
  if (PACKAGE_NAMES.has(name)) return name.endsWith('.lock') || name.endsWith('-lock.json') ? SPEC.lock : SPEC.package
  if (CONFIG_NAMES.has(name)
    || /(?:^|[._-])(?:config|rc)(?:[._-]|$)/.test(name)
    || (name.startsWith('.') && ['ini', 'json', 'toml'].includes(ext))) return SPEC.config
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.startsWith('compose.')) return SPEC.config
  if (name === 'license' || name.startsWith('license.') || name === 'authors' || name === 'notice') return SPEC.text

  if (['md', 'markdown', 'mdx', 'rst', 'adoc'].includes(ext)) return SPEC.markdown
  if (ext === 'ipynb') return SPEC.notebook
  if (['py', 'pyi', 'pyw'].includes(ext)) return SPEC.python
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return SPEC.typescript
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) return SPEC.javascript
  if (['html', 'htm', 'xml', 'xhtml', 'vue', 'svelte'].includes(ext)) return SPEC.markup
  if (['css', 'scss', 'sass', 'less', 'styl'].includes(ext)) return SPEC.stylesheet
  if (['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'].includes(ext)) return SPEC.shell
  if (['rb', 'rake'].includes(ext) || name === 'rakefile') return SPEC.ruby
  if (['java', 'kt', 'kts', 'scala', 'groovy'].includes(ext)) return { ...SPEC.code, icon: VscCoffee }
  if (['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'go', 'rs', 'swift', 'php', 'lua', 'r', 'dart', 'ex', 'exs'].includes(ext)) return SPEC.code
  if (['json', 'jsonc', 'jsonl', 'geojson'].includes(ext)) return SPEC.json
  if (['yaml', 'yml'].includes(ext)) return SPEC.yaml
  if (['toml', 'ini', 'cfg', 'conf', 'properties'].includes(ext)) return SPEC.config
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tif', 'tiff'].includes(ext)) return SPEC.image
  if (ext === 'pdf') return SPEC.pdf
  if (['sqlite', 'sqlite3', 'db', 'sql', 'parquet'].includes(ext)) return SPEC.database
  if (['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war'].includes(ext)) return SPEC.archive
  if (['lock'].includes(ext)) return SPEC.lock
  if (['wasm', 'bin', 'exe', 'dll', 'so', 'dylib', 'class', 'o', 'a'].includes(ext)) return SPEC.binary
  if (['txt', 'log', 'csv', 'tsv'].includes(ext)) return SPEC.text
  return SPEC.file
}

/** Public, serializable classification used by tests and future consumers. */
export function fileIconInfo(path: string): FileIconInfo {
  const { kind, tone } = resolveFileIconSpec(path)
  return { kind, tone }
}

const TONE_CLASS: Record<FileIconTone, string> = {
  code: css.fileIconCode!,
  document: css.fileIconDocument!,
  config: css.fileIconConfig!,
  special: css.fileIconSpecial!,
  neutral: css.fileIconNeutral!,
}

/** A decorative, theme-aware file icon shared by tree rows and file tabs. */
export function FileTypeIcon(props: { path: string; size?: number }): ReactElement {
  const { path, size = 14 } = props
  const info = resolveFileIconSpec(path)
  const Icon = info.icon
  return (
    <span
      className={`${css.fileTypeIcon} ${TONE_CLASS[info.tone]}`}
      data-file-icon-kind={info.kind}
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      <Icon size={size} />
    </span>
  )
}
