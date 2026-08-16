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

/** Reserved-word completions per language key ('' keys opt out). */
const KEYWORDS_BY_LANGUAGE: Record<string, string[]> = {
  js: ['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield'],
  jsx: ['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield'],
  ts: ['abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'override', 'private', 'protected', 'public', 'readonly', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield'],
  tsx: ['abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'override', 'private', 'protected', 'public', 'readonly', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield'],
  python: ['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'],
  java: ['abstract', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'false', 'final', 'finally', 'float', 'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'true', 'try', 'void', 'volatile', 'while'],
  c: ['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'int', 'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while'],
  cpp: ['alignas', 'alignof', 'and', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class', 'const', 'constexpr', 'continue', 'default', 'delete', 'do', 'double', 'else', 'enum', 'explicit', 'extern', 'false', 'final', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'namespace', 'new', 'noexcept', 'nullptr', 'operator', 'override', 'private', 'protected', 'public', 'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'while'],
  rust: ['as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while'],
  go: ['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var'],
  php: ['break', 'case', 'catch', 'class', 'const', 'continue', 'declare', 'default', 'do', 'echo', 'else', 'elseif', 'enddeclare', 'endfor', 'endforeach', 'endif', 'endswitch', 'endwhile', 'extends', 'final', 'finally', 'for', 'foreach', 'function', 'global', 'if', 'implements', 'interface', 'namespace', 'new', 'print', 'private', 'protected', 'public', 'require', 'require_once', 'return', 'static', 'switch', 'throw', 'trait', 'try', 'use', 'while'],
  sql: ['ADD', 'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CREATE', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'ELSE', 'END', 'EXISTS', 'FROM', 'GROUP', 'HAVING', 'IN', 'INDEX', 'INSERT', 'INTO', 'IS', 'JOIN', 'LEFT', 'LIKE', 'LIMIT', 'NOT', 'NULL', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'RIGHT', 'SELECT', 'SET', 'TABLE', 'THEN', 'UNION', 'UPDATE', 'VALUES', 'VIEW', 'WHEN', 'WHERE'],
  shell: ['break', 'case', 'cd', 'continue', 'do', 'done', 'echo', 'elif', 'else', 'esac', 'exit', 'export', 'fi', 'for', 'function', 'if', 'in', 'local', 'read', 'return', 'select', 'set', 'then', 'times', 'trap', 'unset', 'until', 'while'],
  dockerfile: ['ADD', 'ARG', 'CMD', 'COPY', 'ENTRYPOINT', 'ENV', 'EXPOSE', 'FROM', 'HEALTHCHECK', 'LABEL', 'MAINTAINER', 'ONBUILD', 'RUN', 'SHELL', 'STOPSIGNAL', 'USER', 'VOLUME', 'WORKDIR'],
  nginx: ['access_log', 'add_header', 'alias', 'allow', 'auth_basic', 'client_max_body_size', 'deny', 'error_log', 'fastcgi_pass', 'gzip', 'index', 'listen', 'location', 'log_format', 'proxy_pass', 'return', 'rewrite', 'root', 'server', 'server_name', 'ssl_certificate', 'ssl_certificate_key', 'try_files', 'upstream'],
}

/** Reserved words for a language key, or undefined when the language has none. */
export function keywordsForLanguage(key: string): string[] | undefined {
  return KEYWORDS_BY_LANGUAGE[key]
}
