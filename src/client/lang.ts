/**
 * Syntax highlighting for the file editor: extension → CodeMirror language
 * mapping. The key derivation is pure and unit-tested; the factories pull in
 * the CodeMirror language packages (bundled into the client).
 */
import { Language, LanguageSupport, StreamLanguage } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { php } from '@codemirror/lang-php'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { csharp, kotlin } from '@codemirror/legacy-modes/mode/clike'
import { swift } from '@codemirror/legacy-modes/mode/swift'

/** The lowercased file extension of a path ('' when none). */
export function extOf(path: string): string {
  const at = path.lastIndexOf('.')
  if (at === -1) return ''
  const base = path.slice(at + 1).toLowerCase()
  return base.includes('/') || base.includes('\\') ? '' : base
}

/** Language key for an extension, or null for plain text. Pure (tested). */
export function languageKeyForExt(ext: string): string | null {
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return 'js'
    case 'jsx': return 'jsx'
    case 'ts': case 'mts': case 'cts': return 'ts'
    case 'tsx': return 'tsx'
    case 'json': case 'jsonc': return 'json'
    case 'md': case 'markdown': return 'md'
    case 'py': case 'pyw': return 'python'
    case 'html': case 'htm': return 'html'
    case 'css': return 'css'
    case 'xml': case 'xsl': return 'xml'
    case 'yaml': case 'yml': return 'yaml'
    case 'sql': return 'sql'
    case 'java': return 'java'
    case 'cs': return 'csharp'
    case 'kt': case 'kts': return 'kotlin'
    case 'swift': return 'swift'
    case 'c': case 'h': return 'c'
    case 'cc': case 'cpp': case 'cxx': case 'hpp': case 'hh': case 'hxx': return 'cpp'
    case 'rs': return 'rust'
    case 'go': return 'go'
    case 'php': return 'php'
    case 'sh': case 'bash': case 'zsh': return 'shell'
    case 'toml': return 'toml'
    case 'nginx': case 'conf': return 'nginx'
    case 'dockerfile': case 'docker': return 'dockerfile'
    case 'properties': case 'env': return 'properties'
    default: return null
  }
}

const FACTORIES: Record<string, () => Language | LanguageSupport> = {
  js: () => javascript({ jsx: true }),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  md: () => markdown(),
  python: () => python(),
  html: () => html(),
  css: () => css(),
  xml: () => xml(),
  yaml: () => yaml(),
  sql: () => sql(),
  java: () => java(),
  csharp: () => StreamLanguage.define(csharp),
  kotlin: () => StreamLanguage.define(kotlin),
  swift: () => StreamLanguage.define(swift),
  c: () => cpp(),
  cpp: () => cpp(),
  rust: () => rust(),
  go: () => go(),
  php: () => php(),
  shell: () => StreamLanguage.define(shell),
  toml: () => StreamLanguage.define(toml),
  nginx: () => StreamLanguage.define(nginx),
  dockerfile: () => StreamLanguage.define(dockerFile),
  properties: () => StreamLanguage.define(properties),
}

/** The CodeMirror language support for a path, or null for plain text. */
export function languageForPath(path: string): Language | LanguageSupport | null {
  const key = languageKeyForExt(extOf(path))
  return key === null ? null : FACTORIES[key]!()
}
