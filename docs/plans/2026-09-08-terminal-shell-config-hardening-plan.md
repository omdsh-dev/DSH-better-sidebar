# 终端 Shell 配置加固 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置页/yaml 配置的终端 shell 支持引号参数与带引号路径，POSIX 与 Windows 一致地预检可执行文件，配置错误时终端标签显示本地化的可操作报错，且终端标题跟随设置覆盖。

**Architecture:** 全部改动在插件仓库内：`pty-manager.ts` 新增两个纯函数（`unquotePath`/`splitShellArgs`）并把 `resolveShellExecutable` 的探测泛化到 POSIX（统一抛新错误码 `shell-not-found`，`SidebarError` 加可选 `meta`）；`index.ts` 的 `shellOverridesOf` 改用新解析器、`shell.get` 返回覆盖后的有效 shell、`attachTerminal` 的 catch 把错误映射为机器可读 WS close reason `shell-not-found:<名>`；`TerminalView.tsx` 识别该前缀渲染本地化横幅（全部 21 个语言词典同步新 key）。

**Tech Stack:** TypeScript（tsdown 构建，vitest 测试，无新依赖）

**Spec:** `docs/plans/2026-09-08-terminal-shell-config-hardening-design.md`（本计划与其同读；偏差回填其「实施偏差记录」节）

## Global Constraints

- 禁止修改 DSH 源码（`~/.dsh/source/current` 零写入）。
- 代码改动走 `feat/*` 分支 + `gh pr create`，不直推 main。
- 不新增任何依赖；不改 `dependencies`/`peerDependencies`/`scripts`。
- **i18n 键集相等是硬门禁**：新 key 必须同时加进 `locales.ts`（zh + en 两块）与全部 19 个第三方词典（`locales-ja/-de/-fr/-pt/-ko/-ar/-hi/-id/-tr/-vi/-th/-ru/-it/-nl/-sv/-pl/-zh-HK/-zh-TW/-zh-MO.ts`）；`chunks/locale.tsx` 的 `Record<CopyKey, string>` 类型检查 + `tests/locales.spec.ts` 双重拦截。
- 不改 vitest `exclude`；不改 chunk 边界（不新增 core bundle 的静态 import）。
- 测试命令一律 `pnpm exec vitest run <file>`（仓库用 vitest + tsconfig `allowImportingTsExtensions`）。
- 每个任务以 commit 结束，conventional commits（`feat(terminal): …` / `test(terminal): …`），正文可中文。

---

### Task 0: 建分支 + 提交设计与计划文档

**Files:**
- Create: 分支 `feat/terminal-shell-quoted-args-probe`
- 已存在待提交: `docs/plans/2026-09-08-terminal-shell-config-hardening-design.md`、`docs/plans/2026-09-08-terminal-shell-config-hardening-plan.md`

- [ ] **Step 1: 确认工作树干净并建分支**

```bash
git status --porcelain   # 期望为空（main 已与 origin/main 同步）
git checkout -b feat/terminal-shell-quoted-args-probe
```

- [ ] **Step 2: Commit 设计与实施计划**（文档随 feat 分支走 PR，保持 PR 自洽）

```bash
git add docs/plans/2026-09-08-terminal-shell-config-hardening-design.md docs/plans/2026-09-08-terminal-shell-config-hardening-plan.md
git commit -m "docs(plans): 终端 shell 配置加固设计与实施计划"
```

---

### Task 1: `unquotePath` + `splitShellArgs` 纯函数（TDD）

**Files:**
- Modify: `src/pty-manager.ts`（文件末尾 `shellSpawnArgs` 之后追加）
- Test: `tests/pty-helpers.spec.ts`

**Interfaces:**
- Produces: `unquotePath(value: string): string`、`splitShellArgs(input: string): string[]`（均导出，Task 3 的 `shellOverridesOf` 消费）

- [ ] **Step 1: 写失败测试** — `tests/pty-helpers.spec.ts` 顶部 import 补两个名字（第 19-25 行的现有 import 块）：

```ts
import {
  defaultShell,
  ensureSpawnHelper,
  resolveShellExecutable,
  shellDisplayName,
  shellSpawnArgs,
  splitShellArgs,
  unquotePath,
} from '../src/pty-manager.ts'
```

在 `describe('pty helpers', () => {` 内、`'restores the spawn-helper executable bit idempotently'` 用例之后追加：

```ts
  it('unquotes a paired surrounding quote from a configured shell path', () => {
    expect(unquotePath('"C:\\Program Files\\PowerShell\\7\\pwsh.exe"'))
      .toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(unquotePath("'/usr/bin/my shell'")).toBe('/usr/bin/my shell')
    // Unpaired or single characters stay verbatim.
    expect(unquotePath('"mismatched')).toBe('"mismatched')
    expect(unquotePath('pwsh.exe')).toBe('pwsh.exe')
    expect(unquotePath('"')).toBe('"')
    expect(unquotePath('')).toBe('')
  })

  it('splits shell args with quote-aware grouping', () => {
    expect(splitShellArgs('-NoLogo -File "C:\\my init\\init.ps1"'))
      .toEqual(['-NoLogo', '-File', 'C:\\my init\\init.ps1'])
    // Single quotes group too, and preserve inner double quotes verbatim.
    expect(splitShellArgs("-c 'echo \"hi\"'")).toEqual(['-c', 'echo "hi"'])
    expect(splitShellArgs('  -l   ')).toEqual(['-l'])
    expect(splitShellArgs('')).toEqual([])
    expect(splitShellArgs('   ')).toEqual([])
  })

  it('keeps backslashes literal inside quotes and tolerates an unclosed quote', () => {
    // Backslash is NOT an escape (Windows paths): "C:\a\" ends with a slash.
    expect(splitShellArgs('"C:\\a\\"')).toEqual(['C:\\a\\'])
    // An unclosed quote folds the remainder into one token instead of erroring.
    expect(splitShellArgs('"unclosed quote')).toEqual(['unclosed quote'])
    // Empty quote pairs produce no empty-string argument.
    expect(splitShellArgs('"" x')).toEqual(['x'])
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/pty-helpers.spec.ts`
Expected: FAIL — `splitShellArgs`/`unquotePath` 不是导出成员（`SyntaxError` 或 `undefined is not a function`）。

- [ ] **Step 3: 最小实现** — `src/pty-manager.ts` 末尾（`shellSpawnArgs` 函数之后）追加：

```ts
/**
 * Strip ONE pair of surrounding quotes from a configured shell path. Users
 * paste Windows paths with spaces pre-quoted (`"C:\Program Files\…"`); the
 * quotes are shell-input syntax, not part of the path. Unpaired quotes and
 * shorter values stay verbatim.
 */
export function unquotePath(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

/**
 * Split a settings-page shell-arguments string into argv with quote-aware
 * grouping: `'…'` / `"…"` group whitespace, and characters inside quotes are
 * LITERAL — a backslash is never an escape, so Windows paths survive intact
 * (`-File "C:\my init\init.ps1"` → three tokens, the last containing spaces).
 * The price is that an argument containing a literal quote character cannot
 * be expressed; shell startup arguments never need one. An unclosed quote
 * folds the remainder into the current token (settings input stays
 * forgiving); an empty quote pair yields no argument.
 */
export function splitShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of input) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) args.push(current)
  return args.filter(arg => arg !== '')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/pty-helpers.spec.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: Commit**

```bash
git add src/pty-manager.ts tests/pty-helpers.spec.ts
git commit -m "feat(terminal): 引号感知的 shell 参数解析与路径去引号纯函数"
```

---

### Task 2: POSIX 预检 + `shell-not-found` 错误码（TDD）

**Files:**
- Modify: `src/wire.ts:10-36`（错误码联合 + 构造器 meta）
- Modify: `src/pty-manager.ts:351-400`（`resolveShellExecutable` POSIX 分支）
- Test: `tests/pty-helpers.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `unquotePath`
- Produces: `SidebarErrorCode` 新值 `'shell-not-found'`；`SidebarError` 构造器第 4 参 `meta?: Record<string, string>`；`resolveShellExecutable` 在 POSIX 找不到时抛 `SidebarError('shell-not-found', 'shell executable not found: "<configured>"', 400, { shell: configured })`（Task 3 的 WS catch 消费）

- [ ] **Step 1: 写失败测试** — `tests/pty-helpers.spec.ts` 追加（import 区补 `SidebarError`：`import { SidebarError } from '../src/wire.ts'`）：

```ts
  it('POSIX: resolves bare names along PATH and names a missing configured shell', () => {
    const options = {
      platform: 'linux' as const,
      env: { PATH: '/usr/local/bin:/usr/bin' },
      exists: (path: string) => path === join('/usr/bin', 'zsh'),
    }
    expect(resolveShellExecutable('zsh', options)).toBe(join('/usr/bin', 'zsh'))
    const thrown = (() => {
      try {
        resolveShellExecutable('nope', options)
        return undefined
      } catch (error) {
        return error
      }
    })()
    expect(thrown).toBeInstanceOf(SidebarError)
    expect((thrown as SidebarError).code).toBe('shell-not-found')
    expect((thrown as SidebarError).message).toBe('shell executable not found: "nope"')
    expect((thrown as SidebarError).meta?.shell).toBe('nope')
  })

  it('POSIX: checks an absolute path exists and passes it through verbatim', () => {
    expect(resolveShellExecutable('/explicit/zsh', { platform: 'linux', env: {}, exists: () => true }))
      .toBe('/explicit/zsh')
    expect(() => resolveShellExecutable('/missing/zsh', { platform: 'linux', env: {}, exists: () => false }))
      .toThrow('shell executable not found: "/missing/zsh"')
  })

  it('unquotes the configured shell before resolving (Windows probe included)', () => {
    const options = {
      platform: 'win32' as const,
      env: { PATH: 'C:\\Tools' },
      exists: (path: string) => path.replaceAll('\\', '/') === 'C:/Tools/pwsh.exe',
    }
    expect(resolveShellExecutable('"pwsh.exe"', options).replaceAll('\\', '/')).toBe('C:/Tools/pwsh.exe')
  })
```

**同时改写旧契约用例**（第 115-117 行 `'keeps POSIX bare shell resolution delegated to execvp'`）——该用例锁定的正是本任务**有意变更**的行为，整段替换为上面第一个新用例即可（删除旧用例）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/pty-helpers.spec.ts`
Expected: FAIL — `'nope'` 原样返回而非抛错（旧 POSIX 直通行为），且 `SidebarError` 无 `meta` 属性。

- [ ] **Step 3: wire.ts 加错误码与 meta** — `src/wire.ts`：

```ts
/** Machine-readable error codes of the sidebar API. */
export type SidebarErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'forbidden'
  | 'method-error'
  | 'too-large'
  | 'fs-error'
  | 'git-error'
  | 'pty-error'
  | 'pty-deps-missing'
  | 'shell-not-found'
  | 'job-error'
  | 'sidechat-error'
  | 'subagents-unavailable'
  | 'settings-rejected'
  | 'settings-conflict'
  | 'internal'

/** One API failure with its wire code and HTTP status. */
export class SidebarError extends Error {
  constructor(
    readonly code: SidebarErrorCode,
    message: string,
    readonly status = 400,
    /** Optional structured context (e.g. `{ shell }` for shell-not-found). */
    readonly meta?: Record<string, string>,
  ) {
    super(message)
  }
}
```

- [ ] **Step 4: pty-manager.ts 泛化探测** — `resolveShellExecutable` 整体替换为：

```ts
export function resolveShellExecutable(
  shell: string,
  options: ShellExecutableResolutionOptions = {},
): string {
  const configured = unquotePath(shell.trim())
  const platform = options.platform ?? process.platform
  if (configured === '') return configured

  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const notFound = (): SidebarError =>
    new SidebarError('shell-not-found', `shell executable not found: "${configured}"`, 400, { shell: configured })

  if (platform === 'win32') {
    const rawPathext = windowsEnv(env, 'PATHEXT')
    const executableExts = (rawPathext ?? '.COM;.EXE')
      .split(';')
      .map(extension => extension.trim())
      // node-pty ultimately calls CreateProcess; batch files need an
      // intermediate cmd.exe and therefore are not valid shell executables.
      .filter(extension => /^\.(?:com|exe)$/i.test(extension))
    if (executableExts.length === 0) executableExts.push('.EXE', '.COM')

    const hasExtension = win32Path.extname(configured) !== ''
    const names = hasExtension
      ? [configured]
      : executableExts.map(extension => configured + extension.toLowerCase())
    const hasPath = win32Path.isAbsolute(configured) || /[\\/]/.test(configured)
    const candidates: string[] = []
    if (hasPath) {
      candidates.push(...names)
    } else {
      const path = windowsEnv(env, 'PATH')
      if (path !== undefined) {
        for (const dir of path.split(';').map(entry => entry.trim()).filter(Boolean)) {
          for (const name of names) candidates.push(win32Path.join(dir, name))
        }
      }
      const systemRoot = windowsEnv(env, 'SystemRoot')
      if (systemRoot !== undefined && systemRoot.trim() !== '') {
        for (const name of names) candidates.push(win32Path.join(systemRoot, 'System32', name))
      }
      if (/^pwsh(?:\.exe)?$/i.test(configured)) {
        for (const dir of windowsPwshCandidateDirs(env)) {
          candidates.push(win32Path.join(dir, 'pwsh.exe'))
        }
      }
    }

    for (const candidate of [...new Set(candidates)]) {
      if (exists(candidate)) return candidate
    }
    throw notFound()
  }

  // POSIX: the previous pass-through delegated a wrong name to execvp and the
  // pty died with a bare "[process exited with code N]". Probe like Windows:
  // a path with a separator must exist; a bare name is searched along PATH
  // (the colon form is fixed by the platform). A miss is a clear, actionable
  // error instead of a cryptic exit code.
  if (configured.includes('/')) {
    if (!exists(configured)) throw notFound()
    return configured
  }
  const path = env.PATH ?? '/usr/bin:/bin'
  for (const dir of path.split(':').map(entry => entry.trim()).filter(Boolean)) {
    const candidate = join(dir, configured)
    if (exists(candidate)) return candidate
  }
  throw notFound()
}
```

确认 `src/pty-manager.ts` 已有 `join`（node:path）与 `SidebarError` import（`SidebarError` 来自 `./wire.ts`——若尚无此 import 则补 `import { SidebarError } from './wire.ts'`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm exec vitest run tests/pty-helpers.spec.ts`
Expected: PASS。随后跑全量确认无连带破坏：`pnpm exec vitest run tests/smoke.spec.ts tests/tools.spec.ts`（POSIX 预检改变了裸名缺失时的行为——若 smoke/tools 有依赖直通的用例，按新契约修正其期望值并在 commit 正文注明）。

- [ ] **Step 6: Commit**

```bash
git add src/wire.ts src/pty-manager.ts tests/pty-helpers.spec.ts
git commit -m "feat(terminal): POSIX 也预检 shell 可执行文件，统一 shell-not-found 错误码"
```

---

### Task 3: host 接线——覆盖解析、shell.get 跟随、WS close reason（TDD）

**Files:**
- Modify: `src/index.ts:248-259`（`shellOverridesOf`）、`:562-566`（`shell.get`）、`:1306-1308`（`attachTerminal` catch）、新增导出函数 `wsCloseReasonOf`
- Test: `tests/smoke.spec.ts:823-881`（fake settings）+ 新用例

**Interfaces:**
- Consumes: Task 1 `unquotePath`/`splitShellArgs`；Task 2 `SidebarError.meta` + `'shell-not-found'`
- Produces: `shellOverridesOf` 返回 `{ shell?: string; shellArgs?: string[] }`（引号已处理）；`wsCloseReasonOf(error: unknown): string`（导出，`shell-not-found` → `shell-not-found:<displayName≤100字符>`，其余 → message/String）；WS close reason 线协议前缀 `shell-not-found:`（Task 4 客户端镜像）

- [ ] **Step 1: 写失败测试** — `tests/smoke.spec.ts`：

(a) fake settings 的 `register` 保留预置值（第 837-840 行）——替换为：

```ts
      register(ns: string, schema: unknown) {
        // Preserve a pre-seeded value: tests stage prefs through the `pre`
        // map before the plugin mounts and registers the same namespace.
        const existing = namespaces.get(ns)
        namespaces.set(ns, { schema, value: existing?.value ?? undefined, revision: 0 })
        return { get: () => ({}), watch: () => () => {}, update: async () => {}, replace: async () => {} }
      },
```

(b) `'side card settings routes'` describe 内追加（`invoke`/`mountWithSettings` 复用）：

```ts
  it('shell.get reflects the settings-page override with the quotes stripped', async () => {
    const route = mountWithSettings(createFakeSettings({
      'dsh-better-sidebar': {
        terminalShell: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe"',
        terminalShellArgs: '-NoLogo',
      },
    }))
    const result = await invoke(route, 'shell.get', {})
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({
      shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      name: 'pwsh',
    })
  })

  it('maps a shell-not-found failure to the machine-readable close reason', async () => {
    expect(wsCloseReasonOf(new SidebarError(
      'shell-not-found',
      'shell executable not found: "C:\\Program Files\\PowerShell\\7\\pwsh.exe"',
      400,
      { shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
    ))).toBe('shell-not-found:pwsh')
    expect(wsCloseReasonOf(new Error('boom'))).toBe('boom')
    expect(wsCloseReasonOf('plain')).toBe('plain')
  })
```

import 区补：`wsCloseReasonOf` 取自 `'../src/index.ts'`（该文件已 import `apply`——并入同一 import 语句），`SidebarError` 取自 `'../src/wire.ts'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/smoke.spec.ts`
Expected: FAIL — `shell.get` 返回启动时 shell 而非覆盖值；`wsCloseReasonOf` 未导出。

- [ ] **Step 3: 实现 index.ts 三处**

(a) `shellOverridesOf`（第 248-259 行）——解析走新函数：

```ts
function shellOverridesOf(getSettings: () => SidebarSettingsFace | undefined): { shell?: string; shellArgs?: string[] } {
  const settings = getSettings()
  const value = settings?.get().value
  if (value === null || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const shell = typeof record.terminalShell === 'string' ? unquotePath(record.terminalShell.trim()) : ''
  const args = typeof record.terminalShellArgs === 'string' ? record.terminalShellArgs.trim() : ''
  return {
    shell: shell === '' ? undefined : shell,
    shellArgs: args === '' ? undefined : splitShellArgs(args),
  }
}
```

（`unquotePath`/`splitShellArgs` 并入第 48 行现存的 `'./pty-manager.ts'` import。）

(b) `shell.get`（第 562-566 行）——注释与返回值更新：

```ts
    // The effective terminal shell and its display name: the settings-page
    // override when set (quotes stripped), else the boot-time resolution.
    // The client titles terminal tabs with the name, so a changed setting is
    // visible on the next opened tab without a plugin restart.
    'shell.get': () => {
      const effective = shellOverridesOf(getSettings).shell ?? terminalShell
      return { shell: effective, name: shellDisplayName(effective) }
    },
```

(c) `attachTerminal` 的 catch（第 1306-1308 行）改用映射函数，并在 `attachTerminal` 上方新增导出：

```ts
/**
 * The WS close reason for a failed terminal attach. A missing configured
 * shell gets a SHORT machine-readable marker (`shell-not-found:<name>`,
 * capped — a WS close reason allows at most 123 bytes) that the client maps
 * to a localized, actionable banner; every other failure keeps the raw
 * message (the model-side tool errors read it verbatim).
 */
export function wsCloseReasonOf(error: unknown): string {
  if (error instanceof SidebarError && error.code === 'shell-not-found') {
    const name = shellDisplayName(String(error.meta?.shell ?? '')).slice(0, 100)
    return `shell-not-found:${name}`
  }
  return error instanceof Error ? error.message : String(error)
}
```

catch 体改为：

```ts
  } catch (error) {
    ws.close(1011, wsCloseReasonOf(error))
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/smoke.spec.ts`
Expected: PASS（含既有 `'serves the effective terminal shell and its display name'`——无设置时行为不变）。

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/smoke.spec.ts
git commit -m "feat(terminal): shell 覆盖去引号进解析、标题跟随覆盖、close reason 机器标记"
```

---

### Task 4: 客户端本地化横幅 + 全语言词典（typecheck 守门）

**Files:**
- Modify: `src/client/TerminalView.tsx:62`（镜像常量）、`:224-250`（onclose 分支）
- Modify: `src/client/locales.ts`（zh 块 `:120` 后、en 块 `:569` 后各 1 key）
- Modify: 19 个第三方词典各 1 key：`locales-ja.ts:108`、`locales-de.ts`、`-fr`、`-pt`、`-ko`、`-ar`、`-hi`、`-id`、`-tr`、`-vi`、`-th`、`-ru`、`-it`、`-nl`、`-sv`、`-pl`、`-zh-HK`、`-zh-TW`、`-zh-MO`（均插在各自 `terminalDepsProfile` 行后）

**Interfaces:**
- Consumes: Task 3 的线协议前缀 `shell-not-found:`
- Produces: locale key `terminalShellNotFound`（占位符 `{name}`）；`TerminalView` 的 fatal 横幅文本

- [ ] **Step 1: TerminalView 识别前缀** — `src/client/TerminalView.tsx` 第 62 行 `PTY_DEPS_MISSING` 常量后追加：

```ts
/**
 * The WS close-reason prefix the host sends when the CONFIGURED shell was
 * not found (mirror of src/index.ts wsCloseReasonOf; wire contract, keep the
 * literal in lockstep). The view renders a localized, actionable banner.
 */
const SHELL_NOT_FOUND_PREFIX = 'shell-not-found:'
```

`socket.onclose`（第 224 行起）在 `PTY_DEPS_MISSING` 分支之后、通用 1011 分支（第 247 行）之前插入：

```ts
        // The configured shell could not be found (settings page or yaml):
        // a localized banner beats the raw English close reason.
        if (event.code === 1011 && event.reason.startsWith(SHELL_NOT_FOUND_PREFIX)) {
          setFatal(t('terminalShellNotFound', { name: event.reason.slice(SHELL_NOT_FOUND_PREFIX.length) || '?' }))
          return
        }
```

- [ ] **Step 2: 加全语言 key**（21 个词典文件，各在 `terminalDepsProfile` 行后插 1 行；键集由 `chunks/locale.tsx` 的 `Record<CopyKey, string>` 与 `tests/locales.spec.ts` 双重把关，漏一个文件 typecheck 即红）：

```ts
// locales.ts zh 块：
  terminalShellNotFound: '未找到配置的 Shell：{name}，请到 设置 → 侧边卡片 → 终端 检查 Shell 路径',
// locales.ts en 块：
  terminalShellNotFound: 'Configured shell not found: {name} — check the shell path under Settings → Side card → Terminal',
// locales-ja.ts:
  terminalShellNotFound: '設定されたシェルが見つかりません：{name}（設定 → サイドカード → ターミナル のシェルパスを確認してください）',
// locales-de.ts:
  terminalShellNotFound: 'Konfigurierte Shell nicht gefunden: {name} — Shell-Pfad unter Einstellungen → Side card → Terminal prüfen',
// locales-fr.ts:
  terminalShellNotFound: 'Shell configuré introuvable : {name} — vérifiez le chemin du shell dans Réglages → Side card → Terminal',
// locales-pt.ts:
  terminalShellNotFound: 'Shell configurado não encontrado: {name} — verifique o caminho do shell em Configurações → Side card → Terminal',
// locales-ko.ts:
  terminalShellNotFound: '설정된 셸을 찾을 수 없습니다: {name} — 설정 → 사이드 카드 → 터미널에서 셸 경로를 확인하세요',
// locales-ar.ts:
  terminalShellNotFound: 'لم يتم العثور على الصدفة المُعدَّة: {name} — تحقق من مسار الصدفة في الإعدادات → Side card → Terminal',
// locales-hi.ts:
  terminalShellNotFound: 'कॉन्फ़िगर किया गया shell नहीं मिला: {name} — Settings → Side card → Terminal में shell पथ जाँचें',
// locales-id.ts:
  terminalShellNotFound: 'Shell yang dikonfigurasi tidak ditemukan: {name} — periksa path shell di Pengaturan → Side card → Terminal',
// locales-tr.ts:
  terminalShellNotFound: 'Yapılandırılan kabuk bulunamadı: {name} — Ayarlar → Side card → Terminal altındaki kabuk yolunu denetleyin',
// locales-vi.ts:
  terminalShellNotFound: 'Không tìm thấy shell đã cấu hình: {name} — kiểm tra đường dẫn shell trong Cài đặt → Side card → Terminal',
// locales-th.ts:
  terminalShellNotFound: 'ไม่พบ shell ที่กำหนดไว้: {name} — ตรวจสอบพาธ shell ใน การตั้งค่า → Side card → Terminal',
// locales-ru.ts:
  terminalShellNotFound: 'Настроенная оболочка не найдена: {name} — проверьте путь к оболочке в Настройки → Side card → Terminal',
// locales-it.ts:
  terminalShellNotFound: 'Shell configurata non trovata: {name} — verifica il percorso della shell in Impostazioni → Side card → Terminal',
// locales-nl.ts:
  terminalShellNotFound: 'Geconfigureerde shell niet gevonden: {name} — controleer het shell-pad onder Instellingen → Side card → Terminal',
// locales-sv.ts:
  terminalShellNotFound: 'Konfigurerat skal hittades inte: {name} — kontrollera skalsökvägen under Inställningar → Side card → Terminal',
// locales-pl.ts:
  terminalShellNotFound: 'Nie znaleziono skonfigurowanej powłoki: {name} — sprawdź ścieżkę powłoki w Ustawienia → Side card → Terminal',
// locales-zh-HK.ts:
  terminalShellNotFound: '未找到配置的 Shell：{name}，請到 設定 → 側邊卡片 → 終端 檢查 Shell 路徑',
// locales-zh-TW.ts:
  terminalShellNotFound: '未找到配置的 Shell：{name}，請到 設定 → 側邊卡片 → 終端 檢查 Shell 路徑',
// locales-zh-MO.ts:
  terminalShellNotFound: '未找到配置的 Shell：{name}，請到 設定 → 側邊卡片 → 終端 檢查 Shell 路徑',
```

- [ ] **Step 3: typecheck 守门**

Run: `pnpm typecheck`
Expected: PASS —— 若漏改任何一个第三方词典，`chunks/locale.tsx` 的 `checked(dict: Record<CopyKey, string>)` 直接编译失败。

- [ ] **Step 4: 跑 locale 契约测试**

Run: `pnpm exec vitest run tests/locales.spec.ts`
Expected: PASS（含 `keeps every shipped third-language dictionary key-set-equal to zh`）。

- [ ] **Step 5: Commit**

```bash
git add src/client/TerminalView.tsx src/client/locales.ts src/client/locales-*.ts
git commit -m "feat(terminal): 配置 shell 未找到时显示本地化可操作横幅（全语言）"
```

---

### Task 5: 全量门禁 + 设计文档偏差回填 + PR

**Files:**
- Modify: `docs/plans/2026-09-08-terminal-shell-config-hardening-design.md`（「实施偏差记录」节回填）

- [ ] **Step 1: 全量门禁**

Run: `pnpm typecheck && pnpm test`
Expected: PASS。若 `tests/tools.spec.ts` / e2e 有依赖旧 POSIX 直通行为的用例失败，按新契约修期望值并单独 commit（`test(terminal): 跟随 POSIX 预检新契约`）。

- [ ] **Step 2: 文档核对与偏差回填**

Run: `rg -n "terminalShell|shellArgs" docs/ README.md`
Expected: 仅设计/计划文档命中（`docs/external-plugin-guide.md` 不记载设置页 shell 行，无需同步；若出现命中则按 AGENTS §5 同步该文档）。回填设计文档「实施偏差记录」：① `terminalShellNotFoundHint` 并入单 key `terminalShellNotFound`（含 `{name}` 占位）；② 旧用例 `keeps POSIX bare shell resolution delegated to execvp` 被有意改写；③ 新增 locale 键实际落点为全部 21 词典（不止 zh/en/ja）。Commit：

```bash
git add docs/plans/2026-09-08-terminal-shell-config-hardening-design.md
git commit -m "docs(plans): 回填终端 shell 配置加固实施偏差"
```

- [ ] **Step 3: 推送并建 PR**

```bash
git push -u origin feat/terminal-shell-quoted-args-probe
gh pr create --title "feat(terminal): 终端 shell 配置加固——引号解析、POSIX 预检、本地化报错" --body-file - <<'EOF'
## 概要
配置启动终端命令的功能已存在（#95/#125），本 PR 加固三处缺口：
1. 设置页 shell 参数支持引号分组（`-File "C:\my init\init.ps1"` 正确成 3 个 argv）；shell 路径自动剥成对引号
2. POSIX 预检可执行文件（对齐 Windows 既有探测），统一 `shell-not-found` 错误码
3. 配置错误时终端标签渲染本地化可操作横幅（21 语言），终端标题跟随设置覆盖

## 测试
- `tests/pty-helpers.spec.ts`：splitShellArgs/unquotePath 语义矩阵 + POSIX 探测
- `tests/smoke.spec.ts`：shell.get 覆盖跟随 + wsCloseReasonOf 映射
- `pnpm typecheck` + `pnpm test` 全绿
EOF
```

Expected: PR URL 返回。

- [ ] **Step 4: 汇报** — 向用户回报 PR 链接、改动文件清单、行为对照（改前/改后）。
