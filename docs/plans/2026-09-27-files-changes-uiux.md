# 文件页 / 文件变动页 UIUX 重构（2026-09-27）

用户需求（原文要点）：

- 文件页：Ctrl 多选、Shift 多选；复用 DSH 自带的"使用应用打开"；像 VS Code 一样给 Git 变更上色；优化性能；优化拖拽上传体验/样式；新增新建文件夹。
- 文件变动页：彻底优化全部 UIUX 交互与功能，更简洁易用；保留 Git 视角与 Agent 视角。
- 抽取出可复用的全局组件；设计风格与样式参照新的任务管理页；保持 KISS。

本文件是本次重构的**冻结契约**：所有并行实现必须遵守下面的接口与命名，不得自行改动。

---

## 1. 设计基线：任务管理页的原生尺度

`src/client/tasks-graph.module.css:1-15` 已声明插件原生尺度，本次重构把文件页与文件变动页对齐到它：

| 维度 | 值 |
|---|---|
| 正文 | `--dsw-font-xxs-12`（12px）；强调 `--dsw-font-xxs-strong-12` |
| 元信息 | `--dsw-font-xxxs-11`；微标签 10px |
| 行高 | 列表行 **28px**（原 34px）；密集行 24px |
| 控件 | 28px（宿主 `Button sm` 同高） |
| 边 | 结构边 `--dsw-alias-border-l2` 1px；分隔线 `--dsw-alias-border-l1` |
| 悬停 | `--dsw-alias-interactive-bg-hover` |
| 选中 | `--dsw-alias-interactive-bg-active` + 2px 内嵌强调条（`::before`，上下内缩 4px） |
| 圆角阶梯 | 2px 徽标/内联 chip，3px 控件簇，4px 行，8px 卡片 |
| 唯一强调色 | `--dsw-alias-state-business-primary`（当前项、关系、live） |
| 状态色 | 成功 `--dsw-alias-state-success-primary`、错误 `--dsw-alias-state-error-primary`、警告 `--dsw-alias-state-warn-primary` |
| 页面留白 | 12px 横向 gutter；竖直节拍 4 / 6 / 8px |
| 头带 | 36px 高，`padding: 0 8px 0 12px`，底 `1px solid --dsw-alias-border-l1` |
| 阴影 | 流内面板**无阴影**；仅浮层（popover/window）用 `--dsw-shadow-lv2/3` |
| 皮肤契约 | `tests/theme.spec.ts` 逐条扫描 `src/client/**/*.module.css`：任何 `color:` 必须至少含一个 `var(--dsw-*|--ds-*)`，禁止字面色 |

不可触碰的既有断言（改了会红）：

- `tests/theme.spec.ts` 硬编码 `src/client/tasks-graph.module.css` 里的 `.cardBar[data-running='true']::after`、`@keyframes dsh-tasks-bar-sweep`、`.barActivity`；以及 `src/client/sidebar.module.css` 里的 `.paneCard`。
- `tests/file-tree-reference-tail.spec.ts` 要求 `.explorerRef, .explorerCopied { margin-left: auto }` 留在 `sidebar.module.css`。
- `tests/panel-host-css.spec.ts` 要求 `sidebar.module.css` 的 `:global([data-dsh-panel-host])` 规则顺序不变。
- `tests/locales.spec.ts:109,118` 要求 **20 份词典 key 集合完全相等**：新增 key 必须同时进入全部词典。

---

## 2. 全局组件（`src/client/ui/`，由 Lead 冻结）

新目录 `src/client/ui/`：

```
src/client/ui/index.ts        桶导出（唯一对外入口）
src/client/ui/kit.tsx         原子组件
src/client/ui/kit.module.css  样式（token-only）
src/client/ui/git-status.ts   共享 git 状态存储 + hook
```

### 2.1 `kit.tsx` 导出面

```ts
/** 28/24px 方形图标按钮（toolbar / 行尾操作统一用它）。 */
export function IconButton(props: {
  icon: ReactNode
  label: string                 // aria-label + title 默认值
  title?: string
  onClick(event: MouseEvent<HTMLButtonElement>): void
  size?: 'md' | 'sm'            // md=28px（默认），sm=24px
  active?: boolean
  disabled?: boolean
  danger?: boolean
  className?: string
}): ReactNode

/** 过滤/切换 chip（带可选计数）。 */
export function Chip(props: {
  children: ReactNode
  active?: boolean
  count?: number
  title?: string
  disabled?: boolean
  onClick(): void
  className?: string
}): ReactNode

/** 28px 节标题带（左侧标签 + 可选计数 + 右侧动作）。 */
export function SectionHeader(props: {
  label: ReactNode
  count?: number
  action?: ReactNode
  className?: string
  children?: ReactNode
}): ReactNode

/** 空/加载/错误/警告/提示 单行态（替代 14 个重复类）。 */
export function Notice(props: {
  kind: 'empty' | 'loading' | 'error' | 'warn' | 'hint'
  tone?: 'page' | 'well' | 'inline'   // page=16px 居中，well=4px 12px 8px（默认），inline=10px 微文案
  role?: string
  className?: string
  children: ReactNode
}): ReactNode

/** 危险操作确认弹窗（宿主 Modal + 安静描述段）。 */
export function ConfirmDialog(props: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm(): void
  onClose(): void
}): ReactNode

/** 状态字母/词徽标（Git 变更、op 类型、diff 类型共用一套 tone）。 */
export type StatusTone =
  | 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed'
  | 'conflict' | 'read' | 'write' | 'edit' | 'neutral'
export function StatusBadge(props: {
  tone: StatusTone
  title?: string
  children: ReactNode
  className?: string
}): ReactNode
```

实现约束：

- 颜色/尺寸全部来自 `kit.module.css` 的 token；`IconButton` 的 `size` 只切 class，不写内联样式。
- `ConfirmDialog` 用宿主 `Modal`（`@deepseek-ai/dsh-client-ui-primitives`），footer = 取消（`Button variant="outline"`）+ 主按钮（`variant="primary"`，`disabled={busy}`），描述段用 `.confirmDesc`。
- 现有页面的等价类（`.explorerConfirmDesc` / `.gitConfirmDesc` / `.gitEmpty` / `.gitPlaceholder` / `.gitError` / `.filterChip` / `.gitBadge` / `.opKind` …）在各自页面重构时迁移到 kit；迁移期两者可并存，但**不得修改被测试钉住的类**（见 §1）。

### 2.2 `git-status.ts` 导出面

共享的 git 状态存储：一个 `sessionId + cwd + worktree` 键一份快照、一个轮询器，供文件树（着色）与文件变动页（列表）同时消费，避免重复 `git status`。

```ts
export type GitTone =
  | 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'copied' | 'conflict'

/** 一行 porcelain XY 的语义（纯函数，可单测）。 */
export interface GitFileStatus {
  letter: string        // 展示字母：X 侧优先，其次 Y，'??' → 'U'
  tone: GitTone
  staged: boolean
  unstaged: boolean
}
export function statusOfXY(xy: string): GitFileStatus | undefined

export interface GitStatusView {
  /** null = 尚未拿到首个快照。 */
  snapshot: GitStatusResult | null
  loading: boolean
  error: boolean
  /** 强制重新拉取（在飞时排队一次，不丢请求）。 */
  refresh(): void
  /** 绝对路径 → 状态；干净/未知 → undefined。 */
  statusOf(absolutePath: string): GitFileStatus | undefined
  /** 该目录（含其下任意层级）是否有变更。 */
  dirHasChanges(absoluteDir: string): boolean
}

export function useGitStatus(
  scope: { sessionId: string; cwd?: string },
  options?: { worktree?: string; visible?: boolean; pollMs?: number },
): GitStatusView
```

实现要点：模块级 `Map<key, Slot>`；`useSyncExternalStore` 订阅；仅当存在 `visible` 订阅者时轮询（默认 2500ms，`mode:'self-scheduling'` 式单飞）；`statusOf` 首次调用时按快照惰性构建 `Map<abs, GitFileStatus>` 与"含变更目录" `Set`（O(n·depth) 一次）；路径拼接复用 `resolveSidebarPath`。

---

## 3. 文件页（`src/client/FileTree.tsx` / `TreePanel.tsx` / `sidebar.module.css`）

### 3.1 多选（Ctrl/Cmd 多选、Shift 连选）

- 状态：`selected: Set<string>`（绝对路径）+ `anchor: string | null`（Shift 起点），二者都是 FileTree 内部 state（不持久化）。
- 交互（**必须保持现有单击语义不变**，`tests/file-tree-rename-delete.spec.tsx`、`tests/file-tree-drop.spec.tsx` 不得改断言）：
  - 无修饰键单击：文件行 → 打开（并清空选择）；目录行 → 展开/收起（并清空选择）。
  - Ctrl/Cmd + 单击：切换该行选中态，`anchor` 设为该行。
  - Shift + 单击：以 `anchor` 为起点，在**当前可见行序**（深度优先、展开态决定）上连选区间；`anchor` 不变。
  - 点击树空白处 / Esc：清空选择。
  - 右键：目标行未选中时先把选择收敛为该行（VS Code 语义），已选中则保留整个选区。
- 视觉：选中行 `--dsw-alias-interactive-bg-active` + 2px 内嵌强调条；与"reveal 高亮"（`--dsw-alias-state-business-tertiary`）区分。
- 批量操作条：选区非空时贴在树体顶部（不遮行）：`已选择 N 项` + 复制路径 / 删除 / 取消选择。
  - 删除走 `ConfirmDialog`（`deleteSelectedTitle` / `deleteSelectedDesc`），逐个 `api.fsRemove`（顺序执行，失败停下并进错误条），成功后 `pruneTree` + `onPathDeleted`。
  - 复制路径写全部选中行的绝对路径（换行分隔）。
- 键盘：行保持 `role="button" tabIndex={0}`；`ArrowUp/Down` 可移动焦点（可选，若实现须不破坏现有 Enter/Space）。

### 3.2 Git 变更着色（VS Code 风格）

- 数据：`useGitStatus(scope)`（§2.2）；不做第二次 `git.status` 拉取。
- 文件行：名字按 tone 上色（modified=warn、added/untracked/copied=success、deleted/conflict=error、renamed=business），行尾加 `StatusBadge` 字母（M/A/D/U/R）与 `title`=状态词。**实施更正**：初稿把 conflict 写成 business，落地时按语义改为 error（冲突是需要先处理掉的阻塞态；`StatusBadge` 的 conflict 同样落 error 家族）。
- 目录行：其下任意层级有变更时，目录名同样上色（`dirHasChanges`），不显示字母。
- Git 不可用/非仓库：完全不上色、不加徽标（静默降级）。
- 新增 i18n：`gitStatusModified|Added|Deleted|Untracked|Renamed|Conflict`。

### 3.3 新建文件夹

- 宿主新增路由 `fs.mkdir`（`src/index.ts`）+ `mkdirWorkspaceEntry`（`src/fs-operations.ts`）；客户端 `api.fsMkdir(scope, path, name)` → `{ path }`。
- UI：目录行与根行右键菜单新增"新建文件夹"；触发后在**该目录层级顶部**插入内联输入行（与 rename 同一套交互：Enter 提交、Esc 取消、blur 提交、IME 守卫、非法名 `newFolderInvalid`），提交成功即 `retryDir(dir)` 并打开该目录。
- 名称规则与 rename 一致：非空、非 `.`/`..`、不含路径分隔符；服务端二次校验；目标已存在 → 报错进错误条。

### 3.4 性能

必须落地的四条（有证据的痛点）：

1. **行组件 memo 化**：抽出 `FileRow` / `DirRow`（`React.memo`），把每行的回调与数据做成稳定引用（`useCallback` + ref 读 `dataRef`），使"复制态/拖拽目标/选区/菜单"变化只重渲染受影响的行，而不是整棵树。
2. **搜索不再卸载树**：`TreePanel` 用 `hidden` 属性/样式切换结果面板与树（原来 `needle !== ''` 直接卸载 `FileTree`，丢失 level 缓存并在清空时全量重拉，见 `TreePanel.tsx:245`）。
3. **level 拉取加世代守卫 + AbortController**：`loadDir` 丢弃过期响应；`refreshTick` 清缓存后并发重拉（不再串行等待）；tick 触发时只重拉"根 + 已展开"级别。
4. **`fs.tree` 的 `truncated` 不再被丢弃**：该级别底部渲染 `Notice kind="hint"`（新 key `filesTruncated`）。

另外：`useDirectoryWatch` 每次渲染重建 key/数组的问题一并修掉（入参用 memo 化数组）。

### 3.5 拖拽上传体验

- 目标：与任务页同一套视觉（token-only、无硬编码色）。当前 `FileTree.tsx:83-110` 的 SVG 用 `#3964FE` / `#9CE5ED`，改为 `currentColor` + CSS class 上色。
- 结构保持（`tests/file-tree-drop.spec.tsx` 断言 `uploadDropZone`、pill 文案、`busy` 抑制、内存拖拽穿透）：仍是"树区高亮框 + 左侧聊天邀请卡"，但：
  - 高亮框：2px 虚线 `--dsw-alias-border-l2` + 8px 圆角 + 极轻强调色内衬，去掉大范围遮罩阴影（改为 `--dsw-alias-bg-base` 半透明蒙层）；
  - pill：28px 高、`--dsw-alias-bg-layer-1`、1px `-l2` 边、`--dsw-font-xxxs-11`；
  - 悬浮到目录行时，目录行整体高亮（现有 `explorerRowDropTarget` 换成新风格）。
- 上传进度卡（`UploadOverlay.tsx` / `.uploadOverlay*`）：同样对齐新尺度（28px 行、12px 文案、token 色）。

### 3.6 使用应用打开：复用 DSH 自带能力

- **删除**插件自研的 open-with 全链路：配置（`sshHost` / `customEditors` / `pinned`）、`src/client/open-with.ts`、`src/client/open-with-settings.tsx`、宿主 `src/open-external.ts` 与 `open.external` 路由、`api.openExternal`、EditorHost 的 openWith props、`builtins/tabs.tsx` 的 `settings.render`（OpenWithSettings），以及对应 20 份词典里的 `openWith*` key 与相关测试。
- **改为**消费 DSH 自带的 open-in-app（见 §4）：文件行显示宿主探测到的系统关联应用；目录行显示宿主应用目录（VS Code / Cursor / Zed / Finder…）+ 文件管理器显示；宿主不可用时整段隐藏（与宿主自身行为一致）。

新增/改用的 i18n：`openInApp`（打开方式）、`openInAppDefault`（用默认应用打开）、`revealInFileManager`（在文件管理器中显示）、`openInAppFailed`、`openInAppEmpty`。

---

## 4. 宿主接入层（由 Lead 冻结并先行落地）

### 4.1 `src/client/open-in-app.ts`（新）

```ts
/** 一个可打开当前路径的应用（文件=系统关联；目录=宿主应用目录）。 */
export interface OpenInAppEntry {
  id: string
  name: string
  icon: string | null      // 文件：PNG/SVG data URL；目录：宿主图标路由
  isDefault: boolean
}

/** 宿主 open-in-app 能力的客户端封装（不可用时全部降级为 no-op / null）。 */
export interface OpenInApp {
  /** 宿主是否能把路径交给原生桌面；null = 尚在探测。 */
  available(): boolean | null
  /** 目录可用的应用目录（宿主 menu 顺序）。 */
  directoryApps(): Promise<readonly OpenInAppEntry[]>
  /** 某个文件当前注册的系统应用；失败 → null。 */
  fileApps(path: string): Promise<readonly OpenInAppEntry[] | null>
  /** 用默认应用或指定应用打开（文件或目录）。 */
  open(path: string, application?: string): Promise<boolean>
  /** 在系统文件管理器中显示。 */
  reveal(path: string): Promise<boolean>
}

/** 从客户端 ctx 构造（内部使用 ctx.remote.session.* 与宿主 /open-in-app/* 路由）。 */
export function createOpenInApp(ctx: { get(name: string): unknown }): OpenInApp
```

宿主 API（DSH 0.1.7-rc.x 自带，**不得自研替代**）：

- Remote：`ctx.get('remote').session.canOpenWorkspacePath()` / `workspacePathApplications({path})` / `openWorkspacePath({path, action?:'reveal', application?})`（返回值 `{ok, value}`）。
- HTTP（同源、带 cookie）：`GET <prefix>/open-in-app/apps` → `{apps: string[]}`；`GET <prefix>/open-in-app/icon/<id>` 图标；`POST <prefix>/open-in-app/open` `{app, path}`（**仅目录**）。
- 应用名字/图标：宿主 `open-in-app` 命名空间（`app.vscode` 等）经 locale bind 读取，失败回退到 id 本身；图标走宿主 icon 路由。

### 4.2 FileTree 的接线（冻结 prop）

`FileTree` 新增可选 prop：

```ts
/** 宿主 open-in-app 句柄（EditorHost 构造并注入；缺省时不渲染该段）。 */
openInApp?: OpenInApp
```

右键菜单"打开方式"段的新语义：

- 文件行：`fileApps(path)` 异步拉取 → 默认应用（`openInAppDefault`，点击 `open(path)`）+ 其余应用各一行（`open(path, id)`）+ 分隔线 + `revealInFileManager`；无应用 → `openInAppEmpty`（禁用行）；宿主不可用 → 整段隐藏。
- 目录行：`directoryApps()` → 每应用一行（`open(path, id)`）+ `revealInFileManager`。
- 失败 → 树顶部错误条（`openInAppFailed`，带路径）。

### 4.3 `fs.mkdir`

- 宿主：`src/fs-operations.ts` 新增 `mkdirWorkspaceEntry({cwd, path, name, fence})`（fence 与存在性校验同 rename），`src/index.ts` 注册 `'fs.mkdir'`。
- 客户端：`api.fsMkdir(scope, path, name)`。
- smoke 测试的路由清单（`tests/smoke.spec.ts:84-90`）**不含方法索引**，无需改；但要为 `mkdirWorkspaceEntry` 增单测。

---

## 5. 文件变动页（`src/client/changes/*`）

目标：**更简洁易用**，保留 Git 与 Agent 双视角。重构后结构：

```
ChangesTab
├─ header (36px): 宿主 SegmentedControl[Git | 本轮文件]  + 右侧：当前视角的刷新按钮
├─ Git 视角 (GitLens)
│   ├─ 顶部一行：分支/仓库/工作树选择（仅在有多个候选时出现）+ 状态摘要
│   ├─ 变更列表：更改(n) / 已暂存(n) 两组（SectionHeader + 单一 ChangeRow 渲染器）
│   └─ 提交条（吸底）：Input + 提交按钮 + 单条状态/错误行
│   └─ 历史：SectionHeader + log 行 + 加载更多（空态明确）
└─ Agent 视角 (SessionLens)：Chip 过滤 + 按文件分组行 + 预览
└─ DiffPane（共享预览，保留现有能力：redact / md 阅读 / html 渲染 / pdf / 展开为 diff 页签 / 拖拽高度）
```

必须修掉的既有缺陷（来自 §6 证据，逐条给通过/拒绝检查）：

1. 干净的仓库只出现**一处**空态（不再两组各印一次 `noChanges`）；历史区有自己的空态与失败态。
2. 单一错误通道：暂存/取消暂存失败必须被捕获并显示（不再 unhandled rejection）；分支切换错误不再显示在提交框下面，而是统一状态行。
3. 手动刷新不再静默丢弃（在飞时排队一次）；仓库切换只触发**一次**完整刷新；工作树清单带上 `repoRoot`。
4. 工作树不再在用户未操作时被自动切走（仅在首次挂载且用户未选择时自动选一次）。
5. 预览按 `callId` 从最新 ops 重新派生（running → 结算后自动更新）；恢复高度时同时应用上限 clamp。
6. 轮询与共享：git 状态改由 `useGitStatus` 提供（同 session 的文件树共用一份），session ops 仍由本页轮询，但**仅在本视角可见时**轮询。
7. `DiffPane` 与 `DiffTab` 的重复加载逻辑抽成一个共享 hook（`useGitDiffTarget`），行为不变（两者都要继续工作）。
8. 视觉：全部对齐 §1 的尺度（行 28px、12px 正文、4px 行圆角、token-only），图标按钮/徽标/空态/确认弹窗改用 `src/client/ui/kit`。

保留能力（不得回归）：Git 的暂存/取消暂存/全部操作、提交、分支切换、历史分页、放弃更改、revert、cherry-pick、复制哈希/路径、在工作树/子仓库间切换；Agent 视角的 read/write/edit 过滤、按文件分组、相对时间、字节数、运行中/出错标记；预览面板的全部渲染开关。

---

## 6. 验收（每条都要有实际证据）

| # | 检查 | 通过判据 |
|---|---|---|
| 1 | 类型/规范 | `pnpm typecheck` + `pnpm lint` 通过 |
| 2 | 单元/组件测试 | `pnpm test` 全绿（新增测试覆盖：多选、mkdir、git 着色映射、kit 组件、重构后的 changes 页） |
| 3 | 构建 | `pnpm build` 通过（含 CSS module 编译） |
| 4 | 皮肤契约 | `tests/theme.spec.ts` 绿；新增 CSS module 无字面色 |
| 5 | i18n | `tests/locales.spec.ts` 绿（20 份词典 key 集合相等） |
| 6 | 多选 | 组件测试：Ctrl 单击切换、Shift 连选区间、Esc 清空；单击语义不变（既有测试不动仍绿） |
| 7 | 着色 | 组件测试：mock `git.status` 后行名带 tone class、目录带 `dirHasChanges` 着色、非仓库无着色 |
| 8 | 新建文件夹 | host 单测（fence/已存在/非法名）+ 客户端组件测试（菜单 → 输入 → `api.fsMkdir` 调用参数） |
| 9 | open-in-app | 组件测试：宿主可用时渲染应用行、点击调 `open(path, id)`、不可用段隐藏 |
| 10 | 性能 | 组件测试或结构性验证：搜索不再卸载树（缓存保留）、level 过期响应被丢弃、`truncated` 有提示 |
| 11 | 文件变动 | 组件测试：空仓库只一处空态、暂存失败显示错误、预览随结算更新、视角切换仍保留预览 |
| 12 | 真实挂载 | `pnpm build && pnpm pack && pnpm test:mount`（e2e lane）通过 |

---

## 7. 写入范围（并行实现不得越界）

| 范围 | 归属 |
|---|---|
| `src/client/ui/**`、`docs/plans/2026-09-27-files-changes-uiux.md`、`src/client/locales.ts`(zh/en 新 key) | Lead |
| `src/client/FileTree.tsx`、`src/client/TreePanel.tsx`、`src/client/sidebar.module.css`、`src/client/UploadOverlay.tsx`、`src/client/use-dir-watch.ts`、`tests/file-tree-*.spec.tsx`、`tests/editor-host.spec.tsx` | 文件页实现者 |
| `src/client/changes/**`、`src/client/diff/**`、`tests/changes-*.spec.*`、`tests/git-view-worktree.spec.tsx`、`tests/sandbox-views.spec.tsx` | 文件变动页实现者 |
| `src/index.ts`、`src/fs-operations.ts`、`src/client/api.ts`、`src/client/open-in-app.ts`、`src/client/EditorHost.tsx`、`src/client/builtins/tabs.tsx`、`src/open-external.ts`(删)、`src/client/open-with*.ts(x)`(删) | Lead（宿主接入层，先行落地） |
| `src/client/locales-*.ts`（19 份第三方词典） | 词典传播实现者（单一写者） |

`src/client/locales.ts` 的 zh/en 由 Lead 追加；实现者若确需新 key，必须回报 Lead，不得自行添加（避免 20 份词典冲突）。

---

## 8. 实施记录（落地后的偏差与事实）

### 8.1 交付面

- **全局组件**：新增 `src/client/ui/`（`kit.tsx` + `kit.module.css` + `git-status.ts` + `index.ts`）与 `tests/ui-kit.spec.tsx`；文件页与文件变动页均已真实复用（IconButton / Chip / SectionHeader / Notice / ConfirmDialog / StatusBadge / useGitStatus）。
- **文件页**（`FileTree.tsx` / `TreePanel.tsx` / `sidebar.module.css` / `UploadOverlay.tsx` / `use-dir-watch.ts`）：多选（Ctrl/Cmd 切换、Shift 按可见行序连选、Esc/空白/右键收敛）、批量条（复制路径 / 删除所选 / 取消选择）、git 着色（文件行名字上色 + M/A/D/U 徽标，目录行仅着色，非仓库静默降级）、新建文件夹（菜单 + 内联输入 + `api.fsMkdir`）、`FileRow`/`DirRow` memo、level 拉取世代守卫 + AbortController、`fs.tree` truncated 提示、搜索改为 `hidden` 停车不再卸载树、拖拽上传视觉 token 化（原 `#3964FE`/`#9CE5ED` 清零）。
- **宿主接入**：`fs.mkdir` 路由 + `mkdirWorkspaceEntry`（`tests/fs-mkdir.spec.ts` 6 例）；新增 `src/client/open-in-app.ts`（宿主 Remote `canOpenWorkspacePath`/`workspacePathApplications`/`openWorkspacePath` + 宿主路由 `/open-in-app/apps|icon|open` 的客户端适配，`tests/open-in-app.spec.ts` 10 例）。
- **文件变动页**（`changes/**`、`diff/**`、`DiffTab.tsx`）：36px 头（宿主 `SegmentedControl` + 刷新 IconButton）、单一 `ChangeRow`、SectionHeader 分组、吸底提交条 + 单一状态行、历史区独立空态、`useGitStatus` 共享状态、刷新排队、工作树只自动选一次、预览按 callId 重派生、高度恢复 clamp、session ops 轮询按视角门控、`DiffPane`/`DiffTab` 共用新 hook `src/client/diff/use-git-diff.ts`（并修掉 DiffPane 的 untracked 预览从不渲染的既有缺陷）。

### 8.2 相对冻结契约的偏差（均有理由）

1. **open-with 全链路删除**（而非并存回退）：`src/open-external.ts`、`src/client/open-with.ts`、`src/client/open-with-settings.tsx`、`src/client/plugin-settings.ts`（随之成为死代码）、宿主 `open.external` 路由、`api.openExternal`、editor descriptor 的 `settings.render` 面板与 20 个 `openWith*` 词条全部移除；外部打开改为 DSH 自带 open-in-app。**取舍**：原「SSH 远端 + 自定义编辑器 URL 模板」能力随之消失——它服务的场景是 DSH 宿主在远端、浏览器在本地，此时宿主 open-in-app 本就不可用（`canOpenWorkspacePath()` 为 false，整段隐藏，与宿主自身行为一致）。若需要该能力应回到 DSH 侧或单独插件实现。
2. **`useSubmenuFlip` 一并删除**：FileTree 的「打开方式」子菜单消失后，`src/client/menu-flip.ts` + `layout.css` 的子菜单翻转规则 + `tests/menu-flip.spec.tsx` 已无消费者，按死代码清除。
3. **词典同步为 25 个新键**（非 26）：原清单最后一项是插入锚点说明；zh/en 与 19 份词典最终同为 486 键。
4. **`visible` 逐层下传**：文件树的 git 轮询必须随页签可见性暂停（工作台会保留所有 tab body 挂载），因此 `EditorHost → TreePanel → FileTree` 新增可选 `visible`，`useGitStatus(..., { visible })` 在页签隐藏时退订。这是实施期补的性能修正（不在原 §3 清单里）。
5. **计划 §5 的「状态摘要」行**未单独实现：干净时用 `changesClean` 空态 + 两个 SectionHeader 计数 + 分支标签表达，避免第三处重复计数文案（KISS）。
6. **未做浏览器级视觉验证**：拖拽/多选的观感只有 token 与尺度层面的代码证据 + 行为测试；真实挂载 lane（`pnpm test:mount`）见 §8.3。

### 8.3 验证证据

- `pnpm typecheck` / `pnpm lint` / `pnpm test`（126 文件、1318 通过、9 跳过）/ `pnpm build` 全绿（§8.6 是修正后的最终数字：1322 通过）。
- 新增测试：`tests/ui-kit.spec.tsx`（14）、`tests/fs-mkdir.spec.ts`（6）、`tests/open-in-app.spec.ts`（10）、`tests/file-tree-multiselect.spec.tsx`（8）、`tests/file-tree-git-status.spec.tsx`（4）、`tests/file-tree-new-folder.spec.tsx`（7）、`tests/file-tree-open-in-app.spec.tsx`（8）、`tests/file-tree-row-memo.spec.tsx`（2）、`tests/file-tree-search-persist.spec.tsx`（3）、`tests/file-tree-dir-watch.spec.tsx`（5）、`tests/diff-git-target.spec.tsx`（4），以及 changes-tab / git-view-worktree 的大幅扩充。
- 真实挂载 lane：`DSH_CMD='npx -y --package @deepseek-ai/dsh@0.1.7-rc.1 dsh' pnpm test:mount`（本机 PATH 上的 dsh 是 rc.2，脚本按基线拒绝直接运行）→ **7/7 通过**。

### 8.4 真实挂载 lane 抓到的缺陷（单测全绿也漏掉的）

`sidbar` 客户端 bundle 缺少 `remote` / `remote.session` 的 cordis inject 声明时，`ctx.get('remote').session` 会抛
`dsh-better-sidebar: cannot get property "remote.session" without inject`——**这一抛发生在渲染路径上，会把整个「文件」面板替换成错误条 + Retry**（首轮挂载 lane 的截图与 trace 均记录在案，整个 tab sweep 因此失败）。

修法两条，缺一不可：

1. `src/client/index.tsx` 的 `inject` 补上 `'remote'` 与 `'remote.session'`（嵌套属性访问也要单独声明）；
2. `src/client/open-in-app.ts` 的 `remoteOf()` 加 try/catch：没有该服务组合的部署降级为「无打开方式菜单」，而不是把面板整块打崩（`tests/open-in-app.spec.ts` 新增一条「ctx 抛错时全部降级」用例钉子）。

这条正好说明为什么 §6 的验收表里 `pnpm test:mount` 不能省：单元/组件测试全部是绿的，只有真实宿主挂载才暴露了这个 inject 契约。

### 8.5 独立验证后的修正（verifier 报告 → 已全部落地）

| 编号 | 问题（verifier 证据） | 处置 |
|---|---|---|
| P1（高） | `open-in-app` 的 availability 是 tri-state（初始 `null`），但生产路径**没有任何地方调用 `probe()`**，于是 `available() !== true` 恒成立、整段菜单永不渲染——「复用 DSH 自带打开方式」实际未交付 | `FileTree` 挂载时按 handle 探测一次：已知答案（`true`/`false`）直接采用，`null` 才 `probe()`，结果进 state 驱动菜单重渲染。新增两条钉死该生命周期的测试（含**真实 adapter + 假 Host Remote** 的端到端用例）。真实挂载截图确认：菜单出现「Open with default app / Visual Studio Code / QuickTime Player / Reveal in File Manager」（宿主探测到的本机关联应用与真实图标） |
| P2（中） | `EditorHost` 新增的 `visible` 从未被传入（`builtins/tabs.tsx` 的文件 tab 未解构 `visible`）→ 隐藏页签仍在轮询 git | 文件 tab 的 component 解构并传入 `visible` |
| P3（中） | 文件树与文件变动页没有共用同一把 slot 键（GitLens 总把自动选中的 **primary** checkout 当 `worktree` 传）→ 同仓库两条 2.5s 轮询 | GitLens 只在选中 **linked** checkout 时才传 `worktree`（primary 的答案是同一份）；`tests/ui-kit.spec.tsx` 增补「同键两个消费者只发一次请求」用例 |
| P4（中低） | session 视角每个 tick 重折 ops → 新数组击穿下游 memo → 每次都重新 Blob 编码每行正文 | `pull()` 在「无新事件且游标未前进」时**保留上一次 fold 的引用**，直接返回 |
| P5（低） | `noChanges` 成为死键（20 份词典各一条） | 全部删除（`tests/locales.spec.ts` 仍绿） |
| P6（低） | 冻结文档写 conflict=business，实现为 error | 以实现为准修正文档（冲突是阻塞态，归 error 家族更合理） |
| P7（低） | 新增 `fs.mkdir` 未进接入文档的 fence 路由清单 | 指南 §路由安全边界补上 `fs.mkdir`（并补齐原先漏列的 `fs.rename`/`fs.remove`） |
| P8（低） | 行有 `data-dsh-selected` 但无 `aria-pressed` | 文件/目录行按选中态输出 `aria-pressed` |
| P9（低） | 手动刷新与定时 tick 可重叠、重复追加同一 delta | `pull()` 单飞（在飞时新请求是 no-op，在飞的那次已覆盖到当下） |

### 8.6 最终验证（修正之后重跑）

- `pnpm typecheck` / `pnpm lint` / `pnpm test`：126 文件、**1322 通过**、9 跳过；`pnpm build` 通过。
- 真实挂载 lane：`DSH_CMD='npx -y --package @deepseek-ai/dsh@0.1.7-rc.1 dsh' pnpm test:mount` → **7/7 通过**（含 tab sweep、perf lane）。
- 截图级证据（临时 Playwright 取证脚本，已删除，不留在仓库）：真实宿主上文件树行显示 **M/U 字母与状态色**、右键菜单出现宿主探测到的应用列表、文件变动页显示 36px `Git | Session` 头 + 未暂存/已暂存分组 + 吸底提交条 + 历史。
- 仍属未验证：拖拽上传的视觉观感与手动多选手感（只有 token/尺度证据与行为测试）、Windows 宿主差异。

---

## 9. 第二轮：open-with 与宿主能力并存 + 打包下载 + 文件变动树（用户追加需求）

用户追加三条：

1. **打开方式 = 宿主探测到的本机关联应用 + 插件自研 open-with**（两者并存，不是二选一）；
2. **文件页多选时右键新增「压缩打包并下载」**；
3. **文件变动页再次重构：更美观 + 以层级（树）方式显示更改**。

### 9.1 冻结接口

#### A. open-with 恢复并与 open-in-app 并存

- 恢复 `src/client/open-with.ts`（`OpenWithConfig` / `OpenWithTarget` / `parseOpenWithConfig` / `resolveOpenWithTargets` / `openWithUrl` / `openWithSshActive` / `newCustomEditorId` / `isValidCustomEditor`，与 main 逐字一致）、`src/client/open-with-settings.tsx`、`src/client/plugin-settings.ts`、宿主 `src/open-external.ts` 与 `open.external` 路由、`api.openExternal`、editor descriptor 的 `settings.render`，以及 20 个 `openWith*` 词条。
- `FileTree` / `TreePanel` 恢复 main 的可选 props：`openWithTargets` / `openWithPinned` / `openWithSsh` / `onOpenWith` / `onToggleOpenWithPin`，与既有 `openInApp` **并存**。
- 菜单形状（`打开方式` 段）：
  1. 宿主行（`openInApp` 可用时）：`用默认应用打开` + 各系统关联应用；
  2. 插件行：pinned 目标直达 + `在应用中打开 >` 子菜单（含图钉，main 原样）；**当宿主可用时隐藏插件的 `explorer` 目标**（宿主已有「在文件管理器中显示」，避免重复）；
  3. 分隔线 + 宿主 `在文件管理器中显示`（宿主不可用时该行不出现，插件的 `explorer` 目标保留，保证仍能 reveal）。
- 宿主完全不可用（`available() === false` / 无 handle）时：宿主行整段隐藏，插件行照旧可用（SSH 远端场景因此保持可用）。

#### B. 压缩打包并下载

- 新增 `src/zip.ts`：`buildZip(entries, opts)` 产出 ZIP（store + `zlib.deflateRaw` 两种方法按压缩收益选择；UTF-8 名称标志位；目录条目；CRC32；无第三方依赖）。
- 新增宿主 GET 路由 `/sidebar/archive?sessionId=&cwd=&name=<archive.zip>&path=<p>&path=<p>…`：每个 `path` 经既有 workspace fence 校验，文件/目录（递归）都接受；上限（条目数 / 总字节）超限返回 JSON 错误；成功时 `content-type: application/zip` + `content-disposition: attachment`。
- 客户端 `api.archiveUrl(scope, paths, name)`（与 `downloadUrl` 同形的 GET URL）。
- 交互：多选（≥2）时右键菜单出现 `压缩并下载（{count} 项）`；单选且为目录时同样出现（单文件不出，避免与「下载」重复）。
- 新词条：`zipDownload` / `zipDownloadCount` / `zipFailed`。

#### C. 文件变动页层级显示

- Git 视角的两个分组（未暂存 / 已暂存）各自渲染为**目录树**：单子目录压缩（`a/b/c` 一行显示为 `a/b`），目录行有 disclosure chevron + 文件夹图标，文件行有文件图标 + 状态字母 + 名称 + 弱化目录；行尾仍可暂存/取消暂存；默认展开。
- 纯函数 `buildChangeTree(entries)`（`src/client/changes/change-tree.ts`）产出树 + 压缩规则，独立单测。
- 视觉打磨：分组头吸顶、计数胶囊、hover 与选中态、缩进参考线、提交条与历史行间距统一到 §1 尺度。

### 9.2 分工与写入范围

| 范围 | 归属 |
|---|---|
| 计划文档、验证裁决、集成、最终门禁 | Lead |
| `src/index.ts`、`src/zip.ts`、`src/client/api.ts`、`src/client/open-with.ts`、`src/client/open-with-settings.tsx`、`src/client/plugin-settings.ts`、`src/open-external.ts`、`src/client/EditorHost.tsx`、`src/client/builtins/tabs.tsx`、相关测试 | 宿主接入实现者 |
| `src/client/FileTree.tsx`、`src/client/TreePanel.tsx`、`src/client/sidebar.module.css`、文件页测试 | 文件页实现者 |
| `src/client/changes/**`、`src/client/diff/**`、变动页测试 | 文件变动页实现者 |
| `src/client/locales-*.ts`（19 份） | 词典实现者 |
| 独立验证 | 验证者 |

### 9.3 实施记录（第二轮）

- **打开方式并存**（落地形状）：菜单段无标题行 —— 宿主行（`用默认应用打开` + 系统关联应用，仅宿主可用）→ 分隔线 → 插件 pinned 直达行 + `在应用中打开 >` 子菜单（图钉 / SSH 后缀原样）→ 分隔线 → 宿主 `在文件管理器中显示`。宿主可用时过滤插件的 `explorer` 目标；宿主不可用/无 handle 时只留插件行（含 `explorer`，reveal 不丢）。
  - 自研链路逐字恢复：`src/client/open-with.ts`、`open-with-settings.tsx`、`plugin-settings.ts`、`src/open-external.ts`、`open.external` 路由、`api.openExternal`、editor descriptor 的 `settings.render`，以及 20 个 `openWith*` 词条（19 份词典从 `git show main:` 逐字取回）。
  - 因菜单去掉标题行，`openInApp` 词条成为死键 → 已从 21 份词典删除（zh 507 键）。
  - 子菜单需要 `useSubmenuFlip`：第一轮删除的 `src/client/menu-flip.ts` + `layout.css` 翻转规则 + `tests/menu-flip.spec.tsx` 一并恢复。
- **压缩打包下载**：新增 `src/zip.ts`（自研 ZIP 写入器，无第三方依赖）+ `src/archive-route.ts`（下载名净化 + 递归收集）+ `GET /sidebar/archive` + `api.archiveUrl`；`FileTree` 多选右键「压缩并下载（N 项）」（单选目录亦可，单文件不出），下载走 `fetch → blob → objectURL`，**路由错误（超限 / fence 拒绝 / 非 GET）现在会以 `zipFailed` 显示在错误条**。
  - 上限：10 000 条目 / 256 MiB 未压缩负载（收集期即中止）。
  - 实施中由系统 `unzip` 抓到的真实缺陷：central directory 只写 MS-DOS 位而 version-made-by 声称 Unix → Info-ZIP 把每个文件解成 `mode 000`；改为 Unix 语义（`0o100644 * 0x10000`，注意 `<< 16` 溢出 int32）。复验：mode 644/755、UTF-8 名、`unzip -t` 无错。
- **文件变动层级树**：新增 `src/client/changes/change-tree.ts`（`buildChangeTree`：'/' 分段、单子目录链压缩成一行、目录先于文件、大小写不敏感排序、文件带 `GitFileStatus`、目录带下级变更数），两个分组各自渲染树；折叠状态按「组 + 路径」独立保存、默认展开；分组头吸顶 + 计数胶囊；`Stage all`/`Unstage all` 改为带 aria-label 的 IconButton；选中 = `interactive-bg-active` + 2px 内嵌强调条；12px/级缩进 + `-l1` 参考线；历史行 hash 徽标 / ref 胶囊 / 作者·时间右对齐。
  - 契约偏差（已批准）：文件行不再重复渲染目录文本（树已用父行表达层级，重复是噪声）；`ChangeDir` 额外带 `changes` 计数以免每行重扫子树。

### 9.4 第二轮验证证据

- `pnpm typecheck` / `pnpm lint` / `pnpm test`（**134 文件、1422 通过、9 跳过**）/ `pnpm build` 全绿。
- 真实挂载 lane：`DSH_CMD='npx -y --package @deepseek-ai/dsh@0.1.7-rc.1 dsh' pnpm test:mount` → **7/7 通过**。
- 截图取证（临时 Playwright 脚本，已删除）：真实宿主上确认
  ① 文件树多选 5 项 + 右键菜单同时含 **宿主探测应用**（Open with default app / Visual Studio Code / QuickTime Player）与 **插件 `Open with >` 子菜单** + **Zip and download (5 items)**；
  ② 变动页 Git 视角以树显示：`src/client/changes`（单子目录链压缩成一行，带计数胶囊 1）→ `GitLens.tsx`（M 徽标），已暂存组 `src` → `app.ts`。
- 单文件页回归：14 个 spec / 91 用例绿（含新增 `file-tree-archive.spec.tsx` 9 例：出现条件、成功链、三条失败路径、in-flight 守卫）。
- 仍未验证：真实浏览器里 ZIP 的落盘行为（jsdom spy 证据）、拖拽/多选手感、Windows 宿主差异。

### 9.5 第三轮（verifier 二轮报告后的修复，全部完成）

| 编号 | 问题 | 修法 | 判别性验证 |
|---|---|---|---|
| F1【高】 | 中文等非 latin1 下载名 → 真实宿主 **500**（`content-disposition` 直接塞原始名，Node `writeHead` 拒绝 >U+00FF） | `archive-route.ts` 新增 `contentDispositionOf`：ASCII 回退 + `filename*=UTF-8''…`（无可用 ASCII stem 时回退 `download.zip`） | 临时回退 → 真 `node:http` 用例 500；对照断言钉住 `validateHeaderValue` 必抛 |
| F2【中】 | 多选同名不同目录 → 归档条目重名（解压互相覆盖） | `disambiguateArchiveNames`：只对冲突项逐级上溯父目录，必要时回退完整路径 | 临时回退 → 条目重名断言变红 |
| F3【中低】 | `maxBytes` 在读完源文件后才判定（与注释相反）；且 `budget===0` 时 0 字节 FIFO 仍会 `open()` 永久阻塞 | `prepareFile` 先 `stat`，`budget <= 0 || size > budget` 立即抛，再读 | FIFO 探针：回退后 5s 超时（阻塞），修复后 44ms 通过（Windows 跳过该探针） |
| F4【中低】 | SSH 模式下宿主不可用时 reveal 整条消失 | SSH 过滤保留 `kind === 'reveal'` 的目标，并注明理由 | 更新 open-with.spec 断言（`['explorer','vscode','cursor','custom:e2']`，reveal 恰 1 条） |
| F5【低】 | 图钉是 `<span role="button" tabIndex={-1}>` 嵌在 menuitem 按钮内（语义非法 + 键盘不可达） | 去掉 role/tabIndex，改成诚实的鼠标热区；注释写明键盘入口是设置面板 | 临时加回 role → 用例变红 |
| F6【低】 | 变更树行无 memo，空闲 tick 全量重渲染 | ① 行 `memo` + 恒定 props（图标解析搬进行内当探针）② 内容键 `entriesKey` 派生 tree ③ （Lead）共享 store 的 `sameStatus` 保住快照身份 | 三处各自临时回退 → 探针变红 |
| F7【低】 | 排序依赖运行时 locale collation | `localeCompare(other, 'en', { sensitivity: 'base' })` + 码点兜底 | 反向输入顺序不变 + 瑞典 collation 对照断言 |
| F8【低】 | POSIX 文件名里的 `\` 被静默转成层级 | `archiveName` 不再替换 `\` | 实探条目 `a\b.txt` 保持单条成员 |
| F9【低】 | 打包中重复点击静默吞掉、大选择无反馈 | `archiveBusy` state + 树顶 `Notice kind="loading" role="status"` | deferred fetch 断言忙态行出现/消失、重复点选 fetch 仍 1 次 |
| — | 新增交互：目录行支持「暂存/取消暂存该目录」 | `DirRow` hover IconButton（`gitStage`/`gitUnstage` 均接受目录 pathspec） | 断言 `gitStage(scope,'src/deep',MAIN)` 且点击不触发折叠 |

最终门禁（修复后重跑）：`pnpm typecheck` / `pnpm lint` / `pnpm test`（**134 文件 / 1441 通过 / 9 跳过**）/ `pnpm build` 全绿；
`DSH_CMD='npx -y --package @deepseek-ai/dsh@0.1.7-rc.1 dsh' pnpm test:mount` → **7/7 通过**（mount=372ms，p95 帧间隔 16ms，无宽度泄漏）。
