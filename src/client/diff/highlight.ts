/**
 * Lightweight syntax highlighting for the shared diff renderer: extension-
 * based language detection plus a single-pass line tokenizer that colors
 * comments, strings, numbers, keywords, types, functions, and preprocessor
 * directives for common languages (C/C++, Java, C#, JS/TS, Python, Go, Rust,
 * shell, batch, PowerShell, and config formats). Pure functions only — no
 * React, no DOM. Multi-line block-comment state threads across lines via
 * scanLine's inBlock parameter, so interior lines of a block comment color
 * correctly.
 */

/** Token classes mapped 1:1 to panel CSS color classes. */
export type TokenType =
  | 'plain'
  | 'comment'
  | 'string'
  | 'keyword'
  | 'number'
  | 'type'
  | 'function'
  | 'macro'

/** One token span: a run of one line sharing one token class. */
export interface CodeToken {
  readonly text: string
  readonly type: TokenType
}

/** Token classes that imply their own color; `plain` inherits the row color. */
const COLORED: ReadonlySet<TokenType> = new Set(['comment', 'string', 'keyword', 'number', 'type', 'function', 'macro'])

/** Per-language scanner configuration. */
interface LangConfig {
  /** Start-of-line (after blanks) or after-token comment prefixes. */
  readonly lineComments: readonly string[]
  /** Multi-line comment delimiters; the opener may appear anywhere. */
  readonly blockComment?: readonly [open: string, close: string]
  /** String delimiter characters; the escape character precedes any literal. */
  readonly strings?: readonly string[]
  /** Reserved words colored as keywords. */
  readonly keywords: ReadonlySet<string>
  /** Constant literals colored as keywords (true/false/null). */
  readonly constants: ReadonlySet<string>
  /** '#' starts a preprocessor directive / directive-like annotation. */
  readonly macro: boolean
  /** Identifier chars (word body). */
  readonly wordStart: RegExp
  readonly wordBody: RegExp
}

const LETTER = /[A-Za-z_$]/u
const WORD = /[A-Za-z0-9_$]/u
const ANYWORD = { wordStart: LETTER, wordBody: WORD }

const kw = (words: string): ReadonlySet<string> => new Set(words.split(/\s+/))

const C_FAMILY = (words: string): LangConfig => ({
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  strings: ['"', "'", '`'],
  keywords: kw(words),
  constants: kw('true false null NULL nullptr TRUE FALSE'),
  macro: true,
  ...ANYWORD,
})

const HASH_FAMILY = (words: string, constants = ''): LangConfig => ({
  lineComments: ['#'],
  strings: ['"', "'"],
  keywords: kw(words),
  constants: kw(constants.length > 0 ? constants : 'True False None true false null'),
  macro: false,
  ...ANYWORD,
})

const CONFIG_LANG: LangConfig = {
  lineComments: ['#'],
  strings: ['"', "'"],
  keywords: new Set(),
  constants: new Set(),
  macro: false,
  wordStart: LETTER,
  wordBody: WORD,
}

/** SQL: '--' line comments plus '#', quoting with single quotes. */
const SQL_LANG: LangConfig = {
  lineComments: ['--', '#'],
  strings: ["'"],
  keywords: kw(`select from where insert into values update set delete create table drop alter add column
    primary key foreign references index view join inner left right outer on as order by group having
    limit offset distinct union all and or not in exists between like is null asc desc count sum avg
    min max case when then else end begin commit rollback transaction default constraint unique`),
  constants: kw('true false null'),
  macro: false,
  ...ANYWORD,
}

/** Windows batch: 'REM'/'::' comments, '%' variable quoting. */
const CMD_LANG: LangConfig = {
  lineComments: ['::'],
  strings: ['"'],
  keywords: kw(`rem if else for in do goto call exit echo set setlocal endlocal shift
    exist defined errorlevel not equ neq lss leq gtr geq nul con defined enabledelayedexpansion`),
  constants: new Set(),
  macro: false,
  wordStart: LETTER,
  wordBody: WORD,
}

/** PowerShell: '#' comments, quoted strings including here-string quotes. */
const PS_LANG: LangConfig = {
  lineComments: ['#'],
  blockComment: ['<#', '#>'],
  strings: ['"', "'"],
  keywords: kw(`function param begin process end if elseif else foreach for while do until switch
    try catch finally throw return break continue filter in workflow class enum interface
    dynamicparam data checkpoint systemlanguage default expand`),
  constants: kw('true false null'),
  macro: false,
  ...ANYWORD,
}

/** Markdown: no tokenizer; the whole line stays plain. */
const MD_LANG: LangConfig = {
  lineComments: [],
  strings: [],
  keywords: new Set(),
  constants: new Set(),
  macro: false,
  wordStart: LETTER,
  wordBody: WORD,
}

/** Extension → language id, mirroring the read tool's hint table. */
const LANGS: Readonly<Record<string, LangConfig>> = {
  ts: C_FAMILY(`abstract any as asserts async await boolean break case catch class const constructor
    continue debugger declare default delete do else enum export extends false finally for from
    function get if implements import in infer instanceof interface is keyof let module namespace
    never new null number object of override private protected public readonly return satisfies set
    static string super switch symbol this throw true try type typeof undefined union unknown var
    void while with yield`),
  tsx: C_FAMILY(`abstract any as asserts async await boolean break case catch class const constructor
    continue declare default delete do else enum export extends false finally for from function get
    if implements import in infer instanceof interface is keyof let module namespace never new null
    number object of override private protected public readonly return satisfies set static string
    super switch symbol this throw true try type typeof undefined union unknown var void while with
    yield`),
  js: C_FAMILY(`async await break case catch class const continue debugger default delete do else
    export extends false finally for from function get if implements import in instanceof interface
    let new null of return set static super switch this throw true try typeof undefined var void
    while with yield`),
  jsx: C_FAMILY(`async await break case catch class const continue debugger default delete do else
    export extends false finally for from function get if implements import in instanceof interface
    let new null of return set static super switch this throw true try typeof undefined var void
    while with yield`),
  json: CONFIG_LANG,
  py: HASH_FAMILY(`and as assert async await break class continue def del elif else except finally
    for from global if import in is lambda nonlocal not or pass raise return try while with yield
    match case`, 'True False None self cls NotImplemented __name__ __main__'),
  go: C_FAMILY(`break case chan const continue default defer else fallthrough for func go goto if
    import interface map package range return select struct switch type var nil iota make new len
    cap append copy close delete panic print println recover`),
  rs: C_FAMILY(`as async await break const continue crate dyn else enum extern false fn for if impl
    in let loop match mod move mut pub ref return self Self static struct super trait true type
    unsafe use where while`),
  java: C_FAMILY(`abstract assert boolean break byte case catch char class const continue default do
    double else enum extends final finally float for goto if implements import instanceof int
    interface long native new package private protected public return short static strictfp super
    switch synchronized this throw throws transient try void volatile while var record sealed
    permits yield`),
  c: C_FAMILY(`auto break case char const continue default do double else enum extern float for
    goto if inline int long register restrict return short signed sizeof static struct switch
    typedef union unsigned void volatile while _Bool _Complex _Atomic`),
  cpp: C_FAMILY(`alignas alignof and auto break case catch char class co_await co_return co_yield
    concept const consteval constexpr constinit const_cast continue decltype default delete
    do double dynamic_cast else enum explicit export extern false final float for friend goto if
    inline int long mutable namespace new noexcept not nullptr operator or override private
    protected public register reinterpret_cast requires return short signed sizeof static
    static_assert static_cast struct switch template this thread_local throw true try typedef
    typeid typename union unsigned using virtual void volatile wchar_t while`),
  cs: C_FAMILY(`abstract as async await base bool break byte case catch char checked class const
    continue decimal default delegate do double dynamic else enum event explicit extern false
    finally fixed float for foreach get goto if implicit in init int interface internal is lock
    long namespace new null not null forgiving object operator out override params partial
    private protected public readonly record ref return sbyte sealed set short sizeof stackalloc
    static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort
    using var virtual void volatile when where while with yield`),
  kt: C_FAMILY(`as break by catch class companion const constructor continue crossinline data do
    dynamic else enum external false final finally for fun get if import in infix init inline
    interface internal is lateinit lazy null object open operator out override package private
    protected public reified return sealed set super suspend tailrec this throw true try typealias
    val var vararg when where while`),
  swift: C_FAMILY(`actor as associatedtype async await break case catch class continue
    convenience default defer deinit didSet do dynamic else enum extension fallthrough false
    final for func get guard if import in indirect infix init inout internal is lazy let nil
    nonmutating open operator optional override postfix precedencegroup prefix private protocol
    public repeat required rethrows return self set some static struct subscript super switch
    throw throws true try typealias unowned var weak where while willSet`),
  php: C_FAMILY(`abstract and array as break callable case catch class clone const continue declare
    default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum
    extends final finally fn for foreach function global goto if implements include
    include_once instanceof insteadof interface isset list match namespace new or print private
    protected public readonly require require_once return static switch throw trait try unset use
    var while xor yield true false null int string bool float void mixed never self parent`),
  sh: HASH_FAMILY(`if then else elif fi for while until do done case esac function in select time
    coproc return break continue local export readonly declare typeset unset shift eval exec trap
    exit source alias set`, 'true false'),
  bash: HASH_FAMILY(`if then else elif fi for while until do done case esac function in select time
    coproc return break continue local export readonly declare typeset unset shift eval exec trap
    exit source alias set`, 'true false'),
  zsh: HASH_FAMILY(`if then else elif fi for while until do done case esac function in select time
    coproc return break continue local export readonly declare typeset unset shift eval exec trap
    exit source alias set`, 'true false'),
  yaml: CONFIG_LANG,
  yml: CONFIG_LANG,
  toml: CONFIG_LANG,
  ini: CONFIG_LANG,
  sql: SQL_LANG,
  cmd: CMD_LANG,
  bat: CMD_LANG,
  ps1: PS_LANG,
  psm1: PS_LANG,
  psd1: PS_LANG,
  md: MD_LANG,
  markdown: MD_LANG,
  mdx: MD_LANG,
  html: CONFIG_LANG,
  htm: CONFIG_LANG,
  css: HASH_FAMILY(''),
  scss: HASH_FAMILY(''),
  less: HASH_FAMILY(''),
  lua: HASH_FAMILY(`and break do else elseif end false for function goto if in local nil not or
    repeat return then true until while`),
}

/**
 * Language id for a file path's extension (the read tool's mapping): the
 * lowercase extension without its dot; dotfiles and unknown extensions map to
 * undefined (plain text).
 * @param path - the op's file path exactly as recorded.
 * @returns the language id, or undefined for plain text.
 */
export function langOfPath(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  return Object.hasOwn(LANGS, ext) ? ext : undefined
}

/** One line's scan output: its tokens plus whether a block comment stays open. */
export interface ScanResult {
  readonly tokens: CodeToken[]
  readonly inBlock: boolean
}

/** Scan one line, entering from (and reporting) block-comment state. */
export function scanLine(line: string, lang: string | undefined, inBlock = false): ScanResult {
  if (line.length === 0) return { tokens: [], inBlock }
  const cfg = lang !== undefined ? LANGS[lang] : undefined
  if (cfg === undefined || (cfg.lineComments.length === 0 && cfg.keywords.size === 0)) {
    return { tokens: [{ text: line, type: 'plain' }], inBlock: false }
  }
  // A language without block delimiters never carries block state forward.
  let inComment = inBlock && cfg.blockComment !== undefined
  const tokens: CodeToken[] = []
  const push = (text: string, type: TokenType): void => {
    if (text.length === 0) return
    const last = tokens[tokens.length - 1]
    if (last !== undefined && last.type === type) tokens[tokens.length - 1] = { text: last.text + text, type }
    else tokens.push({ text, type })
  }
  let i = 0
  const atLineComment = (): string | undefined => {
    for (const lead of cfg.lineComments) {
      if (line.startsWith(lead, i)) return lead
    }
    return undefined
  }
  const atBlockOpen = (): string | undefined => cfg.blockComment !== undefined && line.startsWith(cfg.blockComment[0], i) ? cfg.blockComment[0] : undefined
  const readString = (): void => {
    const quote = line[i]!
    i += 1
    while (i < line.length && line[i] !== quote) {
      if (line[i] === '\\') i += 1
      i += 1
    }
    i = Math.min(i + 1, line.length)
  }
  while (i < line.length) {
    if (inComment) {
      const closeIdx = cfg.blockComment !== undefined ? line.indexOf(cfg.blockComment[1], i) : -1
      if (closeIdx === -1) {
        push(line.slice(i), 'comment')
        return { tokens, inBlock: true }
      }
      const end = closeIdx + (cfg.blockComment?.[1].length ?? 0)
      push(line.slice(i, end), 'comment')
      i = end
      inComment = false
      continue
    }
    const ch = line[i]!
    const wsMatch = /\s/u.exec(line.slice(i))
    if (wsMatch !== null && wsMatch.index === 0) {
      push(ch, 'plain')
      i += 1
      continue
    }
    const commentLead = atLineComment()
    if (commentLead !== undefined) {
      push(line.slice(i), 'comment')
      break
    }
    const blockOpen = atBlockOpen()
    if (blockOpen !== undefined && cfg.blockComment !== undefined) {
      const close = line.indexOf(cfg.blockComment[1], i + blockOpen.length)
      const end = close === -1 ? line.length : close + cfg.blockComment[1].length
      push(line.slice(i, end), 'comment')
      i = end
      inComment = close === -1
      continue
    }
    if (cfg.strings !== undefined && cfg.strings.includes(ch)) {
      const start = i
      readString()
      push(line.slice(start, i), 'string')
      continue
    }
    if (/[0-9]/u.test(ch)) {
      const m = /^(?:0[xXbo][0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9_]+)?)/u.exec(line.slice(i))
      const len = m !== null ? m[0].length : 1
      push(line.slice(i, i + len), 'number')
      i += len
      continue
    }
    if (cfg.wordStart.test(ch)) {
      let j = i + 1
      while (j < line.length && cfg.wordBody.test(line[j]!)) j += 1
      const word = line.slice(i, j)
      // Batch 'REM whatever' runs to end of line as a comment.
      if ((lang === 'cmd' || lang === 'bat') && word.toLowerCase() === 'rem') {
        push(line.slice(i), 'comment')
        break
      }
      let k = j
      while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k += 1
      if (cfg.constants.has(word)) push(word, 'keyword')
      else if (cfg.keywords.has(word)) push(word, 'keyword')
      else if (line[k] === '(') push(word, 'function')
      else if (/^[A-Z]/u.test(word) && word.length > 1) push(word, 'type')
      else push(word, 'plain')
      i = j
      continue
    }
    if (cfg.macro && ch === '#' && (i === 0 || /\s/u.test(line[i - 1]!))) {
      let j = i + 1
      while (j < line.length && cfg.wordBody.test(line[j]!)) j += 1
      push(line.slice(i, j), 'macro')
      i = j
      continue
    }
    push(ch, 'plain')
    i += 1
  }
  return { tokens, inBlock: inComment }
}

/** Tokenize one line with no incoming block state (standalone lines). */
export function tokenizeLine(line: string, lang: string | undefined): CodeToken[] {
  return scanLine(line, lang).tokens
}

/** True when the language has multi-line block-comment delimiters. */
export function hasBlockComment(lang: string | undefined): boolean {
  return lang !== undefined && LANGS[lang]?.blockComment !== undefined
}

/** Token classes worth wrapping in a span; plain runs join the parent text node. */
export function isColored(token: CodeToken): boolean {
  return COLORED.has(token.type)
}
