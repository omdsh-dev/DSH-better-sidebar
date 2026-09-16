# 终端 Shell 配置加固（引号解析 + 双平台预检 + 友好报错）设计

日期：2026-09-08 ｜ 状态：已确认（用户选定方案二） ｜ 分支：`feat/terminal-shell-quoted-args-probe`

## 背景与现状

配置启动终端命令的功能已存在于 main（`fd9544f` #95 部署级 `config.shell`/`shellArgs` + pwsh 探测；`c973d6e` #125 设置页 `terminalShell`/`terminalShellArgs` 用户偏好，覆盖顺序：设置页 > yaml > 平台自动，UI 标签页与模型 `terminal_*` 工具两终端面共用）。本次不是新增功能，而是加固三处已知缺口：

1. **参数解析硬切**：`shellOverridesOf`（`src/index.ts:257`）用 `args.split(/\s+/)`，引号内空格被切碎（`-File "C:\my script\init.ps1"` 得到 3 个参数）。
2. **POSIX 无预检**：`resolveShellExecutable`（`src/pty-manager.ts:351`）仅 win32 做存在性探测（PATHEXT/PATH/System32/pwsh 目录，找不到抛 `SidebarError('pty-error', 'shell executable not found: …')` → WS catch `ws.close(1011, message)`）；POSIX 直接透传 node-pty，配错路径只得到 `[process exited with code N]`。
3. **报错不可操作**：客户端 `TerminalView.tsx:247` 对任意 `1011 + reason` 显示原始英文 reason 横幅，没有本地化说明与"去设置改"指引；粘贴带引号路径（`"C:\Program Files\…\pwsh.exe"`）会因引号参与路径解析而失败；`shell.get` 返回启动时解析的 shell，设置页覆盖后新终端标签标题不跟随。

## 方案取舍

- **方案一（最小）**：只修引号参数解析。POSIX 配错仍不可诊断，引号路径仍炸——否。
- **方案二（选定）**：解析 + 双平台预检 + 本地化友好报错 + 标题跟随。不碰声明式设置契约。
- **方案三（全家桶）**：方案二 + 设置页实时 `shell.probe` inline 校验。校验型输入行需扩展 declarative settings 契约（`service.ts` + `docs/external-plugin-guide.md`），收益/成本比低（保存后开终端立即可见）——YAGNI，不做。

## 设计

### 1. 引号感知参数解析 `splitShellArgs`（`src/pty-manager.ts`）

- 空白分词；`'…'` / `"…"` 分组，组内字符**全部字面**——`\` 不是转义符（Windows 路径场景直接可用）。代价：参数值本身含引号无法表达，注释注明该取舍。
- 未闭合引号宽容处理：剩余输入并入当前 token（不抛错——设置页输入体验优先）。
- 空引号对 `""` 丢弃，不产生空参数。
- `shellOverridesOf` 中 `args.split(/\s+/).filter(Boolean)` 替换为 `splitShellArgs(args)`。

### 2. 路径去引号 `unquotePath`（`src/pty-manager.ts`）

- 长度 ≥2 且首尾为成对 `"` 或 `'` 时剥掉，否则原样返回。
- 统一入口：`shellOverridesOf` 与 `resolveShellExecutable` 首行均走它（单一实现防两处漂移）。

### 3. POSIX 预检（泛化 `resolveShellExecutable`）

- POSIX 分支：配置值含 `/` → `existsSync` 直查；裸名 → 沿 `env.PATH`（`:` 分隔，缺省回退 `/usr/bin:/bin`）逐目录探测。
- 找不到统一抛 `SidebarError('shell-not-found', 'shell executable not found: "…"')`（新错误码；消息保持英文技术文案——模型侧 `terminal_create` 工具报错复用同一消息，模型读英文更稳）。
- `ShellExecutableResolutionOptions` 的 `platform/env/exists` 注入口径不变，win32 逻辑不动。

### 4. 友好报错（host ↔ client 线协议）

- `SidebarError` 增加可选 `meta` 载荷，`shell-not-found` 时携带配置的 shell 原文。
- WS 升级 handler catch（`src/index.ts` 终端 upgrade）识别 `error.code === 'shell-not-found'` → close reason 发机器标记 `shell-not-found:<shellDisplayName(shell)>`（受 WS close reason 123 字节上限约束，超长截断显示名）。
- `TerminalView.tsx` `onclose` 在通用 1011 分支**之前**识别 `reason.startsWith('shell-not-found:')` → 本地化 fatal 横幅：`terminalShellNotFound`（「未找到配置的 Shell：<名>」）+ `terminalShellNotFoundHint`（「请检查 设置 → 侧边卡片 → 终端 的 Shell 路径」）。
- locale 新 key 落点：`locales.ts`（zh + en 两块）+ `locales-ja.ts`（仓库规则强制同步），其余语言文件走既有回退链。

### 5. 标题跟随

- `shell.get` 路由改为 `overrides.shell ?? 启动时解析值`，`shellDisplayName` 随之；仅影响新开标签的标题，不触碰已存在 pty。

## 错误流总览

```
设置页 terminalShell/Args（或 yaml config.shell/Args）
  → shellOverridesOf：unquotePath(shell) + splitShellArgs(args)
  → ptyManager.open / registry.create
  → resolveShellExecutable：win32 既有探测 ∥ POSIX 新探测
  → 找不到：SidebarError('shell-not-found', msg, meta:{shell})
      ├─ WS 路径：catch → close(1011, 'shell-not-found:<name>') → TerminalView 本地化横幅 + 设置指引
      └─ 工具路径：terminal_create 抛英文消息 → 模型可见，自行纠正
```

## 测试计划

- `tests/pty-helpers.spec.ts`：`splitShellArgs` 语义矩阵（普通分词 / 单双引号 / 含空格路径 / 反斜杠字面 / 未闭合宽容 / 空引号丢弃 / 连续空白）；`unquotePath`（成对剥、不成对留）；POSIX 探测（fake `options.env.PATH` + `options.exists`：命中解析、绝对路径缺失抛 `shell-not-found`）；win32 既有用例保持绿。
- `shellOverridesOf` 引号行为与 `shell.get` 跟随：就近扩展现有 spec，无宿主则新建。
- 客户端横幅为纯展示逻辑，已有 TerminalView spec 则扩展，否则不强行 e2e。
- 门禁：`pnpm typecheck` + `pnpm test`；不改 chunk 边界与 exclude 配置，mount e2e 不受影响。

## 实施偏差记录

- **报错文案合并为单 key**：设计时的 `terminalShellNotFound` + `terminalShellNotFoundHint` 两 key 合并为单个 `terminalShellNotFound`（含 `{name}` 占位符，一句话内含指引），避免跨语言的句子拼接问题。
- **POSIX 旧契约用例被有意改写**：`tests/pty-helpers.spec.ts` 原用例 `keeps POSIX bare shell resolution delegated to execvp` 锁定「POSIX 裸名直通 execvp」，与本设计冲突，已删除并由 `POSIX: resolves bare names along PATH…` 等新用例替代。
- **locale 落点为全部 21 词典**：设计原计划只写 zh/en/ja，实施时受 `tests/locales.spec.ts` 的「第三方词典键集必须与 zh 相等」门禁约束，`terminalShellNotFound` 实际落入 `locales.ts`（zh+en 双块）+ 19 个 `locales-*.ts`（共 21 文件 22 处），`chunks/locale.tsx` 的 `Record<CopyKey, string>` 类型检查兜底。
- **`resolveShellExecutable` 的 JSDoc 同步**：win32 错误码从 `pty-error` 变更为 `shell-not-found` 后，函数上方文档一并更新（commit `8704994`）。
- **本机全量测试基线**：`pnpm test` 在本机（Windows）存在 29 个**预存**环境性失败（5 个 client spec 的 jsdom `reading 'clear'` ×24、smoke 的 git 身份 ×2、git.spec 截断用例、agent-pty 的 node-pty「Signals not supported on windows」unhandled error）。经与 `origin/main` 同法全量对比确认**零新增失败**（main 30 个，feat 29 个——main 上多出的 `git-worktree` 用例为 flaky）。CI 以 CI 环境为准。

## 交付

- AGENTS 硬约束：`feat/*` 分支开发，commit 后 `gh pr create`，review 合并进 main；不直推。
