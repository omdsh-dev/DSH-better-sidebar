import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LanguageSupport } from '@codemirror/language'
import { isImageExt } from '../src/client/image-types.ts'
import { extOf, languageForPath, languageKeyForExt, supportedLanguageKeys } from '../src/client/lang.ts'
import { isPdfExt } from '../src/client/pdf-types.ts'

describe('editor language mapping', () => {
  it('derives extensions from paths', () => {
    expect(extOf('/a/b/main.tsx')).toBe('tsx')
    expect(extOf('README.MD')).toBe('md')
    expect(extOf('/a/b/.gitignore')).toBe('gitignore')
    expect(extOf('noext')).toBe('')
  })

  it('maps common extensions to languages and falls back to plain text', () => {
    expect(languageKeyForExt('tsx')).toBe('tsx')
    expect(languageKeyForExt('js')).toBe('js')
    expect(languageKeyForExt('py')).toBe('python')
    expect(languageKeyForExt('yaml')).toBe('yaml')
    expect(languageKeyForExt('sh')).toBe('shell')
    expect(languageKeyForExt('md')).toBe('md')
    expect(languageKeyForExt('cs')).toBe('csharp')
    expect(languageKeyForExt('kt')).toBe('kotlin')
    expect(languageKeyForExt('swift')).toBe('swift')
    expect(languageKeyForExt('txt')).toBeNull()
    expect(languageKeyForExt('log')).toBeNull()
    expect(languageKeyForExt('')).toBeNull()
  })

  it('maps the P0/P1 extension batch (vue + legacy-modes) and keeps ambiguous ones plain', () => {
    // P0
    expect(languageKeyForExt('vue')).toBe('vue')
    // P1
    expect(languageKeyForExt('scss')).toBe('scss')
    expect(languageKeyForExt('sass')).toBe('sass')
    expect(languageKeyForExt('less')).toBe('less')
    expect(languageKeyForExt('styl')).toBe('stylus')
    expect(languageKeyForExt('rb')).toBe('ruby')
    expect(languageKeyForExt('lua')).toBe('lua')
    expect(languageKeyForExt('pl')).toBe('perl')
    expect(languageKeyForExt('pm')).toBe('perl')
    expect(languageKeyForExt('r')).toBe('r')
    expect(languageKeyForExt('dart')).toBe('dart')
    expect(languageKeyForExt('scala')).toBe('scala')
    expect(languageKeyForExt('sc')).toBe('scala')
    expect(languageKeyForExt('groovy')).toBe('groovy')
    expect(languageKeyForExt('ps1')).toBe('powershell')
    expect(languageKeyForExt('psm1')).toBe('powershell')
    expect(languageKeyForExt('diff')).toBe('diff')
    expect(languageKeyForExt('patch')).toBe('diff')
    expect(languageKeyForExt('proto')).toBe('protobuf')
    expect(languageKeyForExt('cmake')).toBe('cmake')
    expect(languageKeyForExt('pug')).toBe('pug')
    expect(languageKeyForExt('tcl')).toBe('tcl')
    expect(languageKeyForExt('hs')).toBe('haskell')
    expect(languageKeyForExt('clj')).toBe('clojure')
    expect(languageKeyForExt('cljs')).toBe('clojure')
    expect(languageKeyForExt('erl')).toBe('erlang')
    expect(languageKeyForExt('jl')).toBe('julia')
    expect(languageKeyForExt('pas')).toBe('pascal')
    expect(languageKeyForExt('vb')).toBe('vb')
    expect(languageKeyForExt('vhd')).toBe('vhdl')
    expect(languageKeyForExt('tex')).toBe('stex')
    expect(languageKeyForExt('mm')).toBe('objectivecpp')
    // 跨语言歧义扩展故意不映射（错配高亮比纯文本更误导）
    expect(languageKeyForExt('v')).toBeNull()
    expect(languageKeyForExt('m')).toBeNull()
  })

  // 完备性回归门：switch case 与 FACTORIES 必须双向一一对应。①扩展清单
  // 从 lang.ts 源码的 `case 'xxx'` 正则派生、与下方手写 pairs 双向差集
  // （「加了 case 忘更新清单」在此暴露）；②每个 ext 的 key 逐条断言
  // （「case 指向错误 key」在此暴露）；③key 集合与 supportedLanguageKeys()
  // 双向差集（「加了 case 忘加 factory」或「factory 成了死条目」在此暴露）；
  // ④每个已映射扩展都能构造出语言（「factory 构造期抛错」在此暴露）。
  it('every mapped extension resolves without throwing and no language key is unreachable', () => {
    const pairs: Array<[string, string]> = [
      ['js', 'js'], ['mjs', 'js'], ['cjs', 'js'], ['jsx', 'jsx'],
      ['ts', 'ts'], ['mts', 'ts'], ['cts', 'ts'], ['tsx', 'tsx'],
      ['json', 'json'], ['jsonc', 'json'], ['md', 'md'], ['markdown', 'md'],
      ['py', 'python'], ['pyw', 'python'], ['html', 'html'], ['htm', 'html'],
      ['css', 'css'], ['xml', 'xml'], ['xsl', 'xml'], ['yaml', 'yaml'],
      ['yml', 'yaml'], ['sql', 'sql'], ['java', 'java'], ['cs', 'csharp'],
      ['kt', 'kotlin'], ['kts', 'kotlin'], ['swift', 'swift'],
      ['c', 'c'], ['h', 'c'], ['cc', 'cpp'], ['cpp', 'cpp'], ['cxx', 'cpp'],
      ['hpp', 'cpp'], ['hh', 'cpp'], ['hxx', 'cpp'], ['rs', 'rust'],
      ['go', 'go'], ['php', 'php'], ['sh', 'shell'], ['bash', 'shell'],
      ['zsh', 'shell'], ['toml', 'toml'], ['nginx', 'nginx'], ['conf', 'nginx'],
      ['dockerfile', 'dockerfile'], ['docker', 'dockerfile'],
      ['properties', 'properties'], ['env', 'properties'],
      ['vue', 'vue'], ['scss', 'scss'], ['sass', 'sass'], ['less', 'less'],
      ['styl', 'stylus'], ['rb', 'ruby'], ['lua', 'lua'], ['pl', 'perl'],
      ['pm', 'perl'], ['r', 'r'], ['dart', 'dart'], ['scala', 'scala'],
      ['sc', 'scala'], ['groovy', 'groovy'], ['ps1', 'powershell'],
      ['psm1', 'powershell'], ['diff', 'diff'], ['patch', 'diff'],
      ['proto', 'protobuf'], ['cmake', 'cmake'], ['pug', 'pug'], ['tcl', 'tcl'],
      ['hs', 'haskell'], ['clj', 'clojure'], ['cljs', 'clojure'],
      ['erl', 'erlang'], ['jl', 'julia'], ['pas', 'pascal'], ['vb', 'vb'],
      ['vhd', 'vhdl'], ['tex', 'stex'], ['mm', 'objectivecpp'],
    ]
    const mappedKeys = new Set(pairs.map(([, key]) => key))
    const supported = supportedLanguageKeys()
    // 双向：switch 每个返回值都有 factory；每个 factory 都可达（无死条目）。
    expect([...supported].sort()).toEqual([...mappedKeys].sort())
    // 扩展清单与 switch 源码的双向差集（锚定真源，防手写镜像漂移）。
    const source = readFileSync(new URL('../src/client/lang.ts', import.meta.url), 'utf8')
    const switchExts = new Set<string>()
    for (const match of source.matchAll(/case\s+'([a-z0-9]+)'/g)) switchExts.add(match[1]!)
    expect([...switchExts].sort()).toEqual([...pairs.map(([ext]) => ext)].sort())
    // 每个 ext 的 key 逐条断言 + 都能构造出语言。
    for (const [ext, key] of pairs) {
      expect(languageKeyForExt(ext), ext).toBe(key)
      expect(languageForPath(`/work/example.${ext}`), ext).not.toBeNull()
    }
  })

  // P0 目标行为断言：vue 语言解析 SFC 时 template/script/style 三段
  // 均产出语法树节点（插值证明 Vue 层生效而非纯 HTML 底座）。
  // 强度要点：`interface` 声明只有 TS 解析器能无错吃掉（lezer JS 是
  // 超集、会报 error 节点），证明 lang="ts" 分派生效而非 JS 兜底；
  // `type="application/json"` 内容产出 SingleExpression，证明未被
  // JS 条目遮蔽。
  it('parses a Vue SFC through the vue language', () => {
    const lang = languageForPath('/work/App.vue')
    expect(lang).toBeInstanceOf(LanguageSupport)
    const parser = (lang as LanguageSupport).language.parser
    const tree = parser.parse(
      '<template><p v-if="ok">{{ msg }}</p></template>\n'
      + '<script setup lang="ts">interface A { x: number }</script>\n'
      + '<script type="application/json">{"a": 1}</script>\n'
      + '<style scoped>.a { color: red; }</style>',
    )
    const names = new Set<string>()
    let hasError = false
    tree.iterate({ enter: (node) => { if (node.type.isError) hasError = true; names.add(node.name) } })
    expect(hasError).toBe(false)
    expect(names.has('Script')).toBe(true)
    expect(names.has('StyleSheet')).toBe(true)
    expect(names.has('Interpolation')).toBe(true)
    expect(names.has('SingleExpression')).toBe(true)
  })

  // P1-2 修复守护：<style lang="scss"> 必须分派到 scss stream parser
  // （无 StyleSheet 节点、无 error），而非被 CSS parser 错配接管。
  it('dispatches <style lang="scss"> to the scss parser, not CSS', () => {
    const lang = languageForPath('/work/App.vue') as LanguageSupport
    const tree = lang.language.parser.parse('<style lang="scss">$c: red; .a { color: $c }</style>')
    const names = new Set<string>()
    let hasError = false
    tree.iterate({ enter: (node) => { if (node.type.isError) hasError = true; names.add(node.name) } })
    expect(hasError).toBe(false)
    // 两条正向鉴别：无 StyleSheet = CSS parser 未接管；无 StyleText =
    // 内容确有 parser 接管（删掉 scss 条目时内容会退化回纯文本 StyleText）。
    expect(names.has('StyleSheet')).toBe(false)
    expect(names.has('StyleText')).toBe(false)
  })
})

describe('pdf preview kind', () => {
  it('routes only .pdf to the browser-native preview', () => {
    expect(isPdfExt('.pdf')).toBe(true)
    expect(isPdfExt('.PDF')).toBe(false)
    expect(isPdfExt('.docx')).toBe(false)
    expect(isPdfExt('')).toBe(false)
  })
})

describe('image preview kind', () => {
  it('routes supported image extensions before binary probing', () => {
    expect(isImageExt('.png')).toBe(true)
    expect(isImageExt('.jpg')).toBe(true)
    expect(isImageExt('.svg')).toBe(true)
    expect(isImageExt('.avif')).toBe(true)
    expect(isImageExt('.pdf')).toBe(false)
    expect(isImageExt('')).toBe(false)
  })
})
