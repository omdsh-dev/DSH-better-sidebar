# 设计：工作区路径围栏开关（`workspaceFence` 设置 + 错误面一键关闭）

> 日期：2026-08-29 · 状态：已实现 · 仓库：omdsh-dev/DSH-better-sidebar

## 需求

侧栏所有文件系统路由（`fs.tree` / `fs.read` / `fs.write` / `/sidebar/file` 媒体 / `/sidebar/html` 预览 / `/sidebar/upload`）默认强制工作区包含检查：客户端路径经 realpath 解析后必须落在会话工作区内，否则 403 `path "..." is outside workspace`（`src/path-security.ts`，由 `tests/smoke.spec.ts` 的穿越/符号链接用例守护）。

两个真实痛点：

1. 打开工作区外的合法文件被拒——全局 `~/.dsh/AGENTS.md`、会话 cwd 之外的 linked worktree（GitView 为此隐藏了「在编辑器中打开」菜单项）。
2. 拒绝时直接暴露原始 wire 文本 `path "/tmp/xxx.sh" is outside workspace`，用户不知道原因也不知道怎么办。

方案（用户拍板）：

1. 新增**持久化**内置布尔设置 `workspaceFence`（默认 `true`），挂在设置页「文件」卡片的「功能设置」二级弹窗（`settings.toggles`）。
2. 编辑器加载失败与文件树列目录失败两处错误面：命中围栏拒绝时不再显示原始文本，改为**本地化原因 + 「关闭工作区检测」按钮**——点击全局关闭并**自动重试**失败的操作。

## 关键决策

### 1. 全局开关而非 allowlist（取舍记录）

评估过「受控额外根 allowlist（如 `~/.dsh`）」方案：边界更细，但需要路径管理模式、UI 管理界面与 per-root 读写语义，超出本次需求。用户明确选择单一全局开关贯穿**全部**文件路由（树/读/写/媒体/HTML/上传一体放行），KISS 优先。

**安全代价已明示**：关闭期间，页面内任意同源脚本（包括第三方消费插件）都能通过 `/sidebar` 路由读写主机任意文件。默认 `true`、设置描述文案与接入指南 §8.1 均写明该风险。

### 2. host 侧读取：每次调用经 settings seam 同步读

`fenceEnabledOf(getSettings)`（仿 `shellOverridesOf`）：`record.workspaceFence !== false`——**缺省即武装**（无 settings 服务 / 字段缺失 / 值非法一律 `true`，安全默认不依赖设置面可达性）。`ensureWorkspacePath` / `ensureWorkspaceWritePath` 增加可选 `fence = true` 参数：`false` 时跳过包含断言，**realpath 解析保留**（调用方拿到的 canonical 路径语义不变，符号链接仍被解析）。上传 `writeWorkspaceUpload` 以可选 `fence` 入参同语义透传。

### 3. 错误识别：wire 不变，客户端按消息片段匹配

不新增 wire 错误码：`/sidebar/api` 信封内 `code: 'forbidden'` 有两个来源——请求信任 fence（消息恒为 `forbidden`）与路径围栏（消息含 `outside workspace`）。客户端 `isOutsideWorkspaceError(e)` / `isOutsideWorkspaceMessage(msg)`（`src/client/api.ts`）以消息片段区分，既有 403 断言零改动。

### 4. 关闭按钮：写设置 → 更新 store → 自动重试

`FenceErrorNotice`（新组件）：按钮点击 → `api.settingsUpdate({ workspaceFence: false })`（revision-free，同 `plugin-settings.ts` 队列的 last-write-wins 语义）→ `store.setPrefs(parsePrefs(view.value))`（GitView 的 open 预判、设置页等所有 prefs 读者随之翻转）→ `onDisabled()` 回调：

- EditorHost：`setReloadSeq(seq + 1)` 复用既有重载机制；
- FileTree：`retryDir(dir)` 删该层缓存后重载。

失败路径：保持按钮可用并 console 记录（无乐观翻转）。

### 5. 客户端预判同步放行

GitView 两处 `isWithinWorkspace` 预判（菜单项隐藏 :578、纵深防御 no-op :601）改为仅在 `workspaceFence !== false` 时限制，组件新增 `store` prop。`fs.search` 不动——它锚定 cwd 向下走，本来就不会越界。

## 实施清单

- 字段三处声明 + 解析：`prefs-shared.ts`（含默认 `true`）/ `config.ts` PrefsSchema / `client/prefs.ts` parsePrefs。
- host：`path-security.ts` fence 参数；`index.ts` `fenceEnabledOf` + 六个调用点（fs.tree/fs.read/fs.write 走 buildApi 的 `getSettings` 闭包，媒体/HTML/上传走模块级 `settingsFace`）；`fs-operations.ts` 上传入参。
- client：`api.ts` 识别 helper；`FenceErrorNotice.tsx`；EditorHost 错误分支；FileTree `retryDir` + 错误分支（store 经 EditorHost → TreePanel → FileTree 穿透）；GitView 预判放行；tabs.tsx editor 卡片 toggles 追加开关行。
- i18n：4 个 key（`settingsFenceTitle` / `settingsFenceDesc` / `fenceErrorReason` / `fenceDisableAction`）× 全部 21 个词典（zh/en/ja + 18 第三语言，`locales.spec` 强制 key 集相等）。
- 测试：smoke「disarms the workspace fence…」（先拒后放，覆盖 tree/read/write）；prefs 解析专测（缺省/非法 → `true`，显式 `false` 透传）；plugin-shape schema 默认；builtins editor toggles 清单。
- 文档：接入指南 §8 内置键清单 + 新增 §8.1（本特性对消费插件的可感知行为与风险）。
