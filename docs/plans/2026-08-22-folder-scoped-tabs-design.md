# 目录作用域 tab：文件夹资源管理器（子文件）与目录仓库（子源代码管理）

> 设计日期：2026-08-22 · 基线：`v0.15.1`（`924f377` 之后）· 目标：为 `omdsh-dev/DSH-better-sidebar` 新增两个"以某个工作区子文件夹为作用域"的新 tab 类型。
> 本文档区分**已实机/源码验证的结论**与**实现方案**。验证基于当时克隆的源码，改动点均给出 `文件:行` 便于复现。

---

## 1. 背景与动机

工作区的根目录可能**本身不是 git 仓库**，但工作区下的某个**子文件夹自身是一个 git 仓库**。用户希望：
1. 把工作区下的某个**子文件夹**作为**新的「文件 tab」**打开（一个以该文件夹为根的目录浏览器）；
2. 把该子文件夹作为**「源代码管理 tab」的对象**（显示"包含该文件夹的那个 git 仓库"的信息）。

边栏的 `ctx.betterSidebar` 服务（`src/client/service.ts`）是一个开放式 tab 注册中心，内置的 7 个 tab（editor/git/subagent/sidechat/terminal/browser/diff）本身就是通过 `registerTab` 注册的（`src/client/builtins/tabs.tsx`）。因此**新增两种 tab 类型、并新增一个右键入口**是低爆炸半径的加法式改动——不改造已有 tab 的行为。

---

## 2. 现状限制（源码验证的结论）

**结论：当前两者都不可实现。** 证据：

### 2.1 无法把子文件夹作为「文件 tab」
- 文件树里目录行点击 = 展开/折叠（`src/client/FileTree.tsx` L338 `onClick={() => onToggle(entry.path)}`），右键菜单里**只有**"上传到这里 / 复制相对/绝对路径"，**没有**"打开作 tab"。"在新 Tab/在侧边打开"被 `rowMenu?.isDir === false` 门控（`FileTree.tsx` L500-505），即只对**文件行**生效。
- `editor` tab 是**单文件窗口**：`matchFileViewer` 对无扩展名的目录路径会命中兜底 `code` viewer（`src/client/builtins/viewers.tsx` L104-111，`exts: []`、`priority: -100`、`fetchStrategy: 'fsRead'`），而 host 的 `fs.read` 明确拒绝目录（`src/index.ts` L150-152 `if (info.isDirectory()) throw new SidebarError('fs-error', '"X" is a directory', 400)`）。即使强行传入目录路径，编辑区只会报"cannot read ... is a directory"，不会出现目录树。
- 客户端没有"目录 tab / 目录 viewer"概念：`SidebarState.expanded`（`src/client/state.ts` L73，absolute directory paths）只服务于**树的展开集合**；`openFile` / `openSidebarFile`（`src/client/service.ts` L785、`src/client/intercept.tsx` L18）都不做目录识别。

### 2.2 无法把子文件夹作为「源代码管理 tab」
- `git` tab 是 `single: true`，其 component 只拿 `scope = { sessionId, cwd }`，**忽略 `tab.path`**（`src/client/builtins/tabs.tsx` L134-140）。
- 所有 git 命令都 `git -C <sessionCwd>`（`src/git.ts` L94-95 `runGit` 的 `full = ['-C', cwd, ...]`），而 `cwd` 来自 `src/index.ts` 的 `cwdOf → sessionCwdOf`。`sessionCwdOf` 优先返回 `session?.header.cwd`（`src/index.ts` L110），**一旦会话挂了工作区，请求里的 `clientCwd` 就被忽略**（只作 hydrate 兜底）。因此仅靠修改客户端 scope 无法把 git 指向子文件夹。

---

## 3. 术语（领域模型）

| 术语 | 精确含义 | 备注 |
|---|---|---|
| **folder tab**（类型 id `folder`，显示名「子文件」） | 以 `tab.path`（子文件夹）为**浏览根**的文件树。**仅改变查看根，不改变会话 cwd**（终端 / git / 全局搜索仍留在工作区根）。 | 当前无此概念，需新增 |
| **repo-git tab**（类型 id `repo-git`，显示名「子源代码管理」） | 以 `tab.path` 为 git cwd 的源码管理面板，**复用现有 `GitView`**。 | 当前无此概念，需新增 |
| 仓库发现（A 语义） | 对子文件夹执行 `git -C <folder>`，git 向上/向下寻找 `.git`，展示"**包含该文件夹的那个仓库**"。**工作区根可以不是仓库**。 | 采用；不采用"根仓库过滤到子目录"（B 语义，见 §5 ADR） |

**命名决断**：两个新 tab 显示名定为**「子文件」「子源代码管理」**，与现有「文件」「源代码管理」平行区分；标签栏**只显示文件夹名**，类型靠**左侧图标**区分（子文件复用 `IconFolderOpen16`、子源代码管理复用 `IconBranchOutline16`）。菜单项命名为「在此目录打开文件」「在此目录打开源代码管理」。

---

## 4. 设计树（收敛后的决策全集）

| 项 | 结论 |
|---|---|
| 新对象 | ① `folder`（目录资源管理器，`tab.path` 为根，不改会话 cwd）；② `repo-git`（`tab.path` 为 git cwd，复用 `GitView`） |
| git 语义 | **A**：`git -C <folder>` 仓库发现；工作区根可非仓库；若 folder 落在更大仓库内则显示该仓库（接受） |
| 非仓库 folder | 复用 `GitView` 的 `notRepo` 空态 |
| 去重 / 菜单 | 非 single、`dedupeKey = (t) => t.path`；`hidden: true`（只走右键，不进 `+` 菜单） |
| 递归 | 允许：folder tab 内可对嵌套子文件夹再打开更深的 folder / repo-git tab |
| 设置清单 | 接受两张新卡片（顺带获得该功能的 kill-switch） |
| 菜单标签 | 「在此目录打开文件」「在此目录打开源代码管理」 |
| 标签栏标题 | 仅文件夹名；类型靠图标区分 |
| 类型名 | 子文件 / 子源代码管理 |

---

## 5. ADR：目录作用域 tab 的关键决策

> 以下决策满足 ADR 三条件（难逆转 / 无上下文难懂 / 有真实取舍），故记录。

### 状态
已接受（Accepted）。

### 上下文
工作区根可能不是 git 仓库，但子文件夹自身是 git 仓库；需要把这些子文件夹作为"文件 tab"与"源代码管理 tab"的对象打开。现有边栏：文件夹在文件树里只能展开/折叠；git 面板硬绑会话 cwd。

### 决策
1. **新增 tab 类型，而非改造已有 `editor`/`git`**。`folder` 与 `repo-git` 都通过 `registerTab` 注册，`hidden: true`（只走右键），非 single、按 `path` 去重。
2. **repo-git 采用 A 语义**：以子文件夹为 cwd 运行 git（`git -C <folder>`）的仓库发现，而非对根仓库做 `-- <folder>` 路径过滤。原因是"工作区根可以不是仓库"——B 语义（根仓库过滤）默认根必须是仓库，与需求前提冲突。
3. **host 侧 git/fs 的 cwd 覆盖是显式的、最小化的**：`sessionCwdOf` 的"header cwd 优先"语义保持不变（它被 media/html/file/tools 等多处共享，且这些路由靠 `isWithin` 把文件钉死在工作区），只在其子集 `cwdOf`（仅 `/sidebar/api/*` 的 fs.*/git.* 使用）上增加一个**可选且带 `isWithin` 守卫**的目标工作目录覆盖。

### 备选（未被采纳）
- **B 语义**（根仓库过滤到子目录）：仅在根是仓库时有意义；与"根可能非仓库"的诉求冲突。**拒绝。**
- 直接改 `sessionCwdOf` 让 `clientCwd` 优先：爆炸半径变大（影响 media/html/file/tools 路由），并可能破坏"会话工作区权威"语义。**拒绝。**
- 标签栏恒定标题「子文件」「子源代码管理」：与非 single / 多 tab 并存冲突（多个 tab 不可区分）。**拒绝**，改为"仅文件夹名 + 图标区分"。

### 后果
- 正向：最小爆炸半径；对现有 tab 行为零改动；前向兼容（新增参数均为可选 + 缺省回落）。
- 负面/需注意：① 同一仓库既以根又以子文件夹被打开时，`repo-git` 与 `git` 会显示相同仓库（可通过 A 语义接受）；② 需同步更新 `tests/builtins.spec.ts` 的 tab 计数与 `hidden` 断言；③ 必须为 `targetCwd` 覆盖加 `isWithin` 守卫，防 git 跑出工作区。

---

## 6. 实现计划（改动点清单）

### 6.1 host（`src/index.ts`）
- **`cwdOf`（L226-231）**：新增可选 `targetCwd` 字段，仅当调用方显式传了 `targetCwd` 且 `isWithin(sessionCwd, targetCwd)` 时优先采用；否则回落到 `sessionCwdOf`（完整前向兼容）。`requireAbsolute(targetCwd)` 拒绝非绝对路径；越界抛 `fs-error`（用法同 media/html 路由的 `isWithin` 校验，L712/L777）。**这一个改动同时服务 git\* 与 `fs.search`**——两者都走 `cwdOf(payload)`，返回的 `cwd` 即目录作用域根。
  ```ts
  const targetCwd = typeof record?.targetCwd === 'string' && record.targetCwd !== '' ? record.targetCwd : undefined
  if (targetCwd !== undefined) {
    const abs = requireAbsolute(targetCwd)
    if (!isWithin(sessionCwd, abs)) throw new SidebarError('fs-error', 'target working directory outside the session working directory', 403)
    return { sessionId, cwd: abs }
  }
  ```
- **`fs.search` 无需单独改**：它本来就是 `const { cwd } = cwdOf(payload); return searchFiles(cwd, query)`，所以 `cwdOf` 的 `targetCwd` 覆盖自动把搜索根限定到目录作用域；`searchFiles(root, query, opts)`（`src/fs-search.ts`）第一个参数本就是绝对根。

> `fs.tree` 已支持任意目录路径（L250 `const target = record.path === undefined ? cwd : requireAbsolute(...)`），**零改动**。

### 6.2 client：注册两个新 tab + 新组件
- **`src/client/builtins/tabs.tsx`**：在 `builtinTabs` 增 `folder` / `repo-git` 两 descriptor：
  - `icon`：`IconFolderOpen16`（folder）/ `IconBranchOutline16`（repo-git）。
  - `hidden: true`、非单实例、`dedupeKey: (tab) => tab.path`；`order` 11 / 21。
  - `title`：`t('subFiles')` / `t('subScm')`（打开时由调用方用 `openTab({ title: baseName(path), path })` 覆盖为文件夹名）。
- **新增 `src/client/folder-tabs.tsx`**：`FolderTab`（以 `tab.path` 为根渲染 `TreePanel`，自带局部展开集，`targetCwd=tab.path` 让搜索限定到该目录）与 `RepoGitTab`（把 `GitView` 的 scope 设为 `{ sessionId, cwd: tab.path, targetCwd: tab.path }`，并让 `onOpenFile` 把 git 相对路径解析到 `tab.path`）。
- **两个新 tab 用路径派生 id**（`id: `folder:<path>` / `repo-git:<path>`，与编辑器 `editor:<path>` 同模式）：否则 `openTabInActivePane` 的 id 安全网会把同类型第二、三次打开**聚焦到首个 tab**而非新建——不同文件夹就无法并存（该 id 冲突已实测复现并修复）。`dedupeKey: (tab) => tab.path` 仍保证**同一路径**再次打开时聚焦既有 tab。
- **diff 引用贯通 `targetCwd`**：`SidebarDiffRef`（`src/client/state.ts`）加可选 `targetCwd`；`GitView` 的 `openWorktreeDiff`/`openCommitDiff` 写入 `scope.cwd`；`DiffTab`（`src/client/DiffTab.tsx`）用它构建 scope——让嵌套仓库里点改动文件打开的 diff 正确读取。
- **`src/client/api.ts`**：`SessionScope` 加 `targetCwd?: string`，`scopePayload` 在有值时带上。

### 6.3 client：目录行右键入口
- **`src/client/FileTree.tsx`**：在新 props（`onOpenDirFiles` / `onOpenDirScm`）存在时，目录行右键菜单（`rowMenu?.isDir === true` 分支）新增两项「在此目录打开文件」「在此目录打开源代码管理」（置于"上传到这里"上方）。文件行现有打开项逻辑不动。
- **`src/client/TreePanel.tsx` / `src/client/EditorHost.tsx`**：把新回调透传，并在有上下文中 wired 到 `ctx.betterSidebar.openTab({ type: 'folder'|'repo-git', title: baseName(path), path })`。`EditorHost` 的 `treeOnly`（L266-277）与 dock 树（L360-369）两处都要传；**`folder-tabs.tsx` 的 `FolderTab` 同样提供这两个回调**以支持递归（在目录 tab 内再开更深的 folder / repo-git tab）。

### 6.4 测试与守卫
- **`tests/builtins.spec.ts`（已改）**：
  - `getTabs()` 列表断言更新为 **9 个**：`['browser', 'diff', 'editor', 'folder', 'git', 'repo-git', 'sidechat', 'subagent', 'terminal']`。
  - `hidden` 断言更新为 `['folder', 'repo-git', 'diff']`（按注册顺序），并断言 `folder`/`repo-git` 非 single、按 path 去重。
- 其余守卫**确认不受影响**：`tests/manifest-consistency.spec.ts`（只查模块表 require）、`tests/plugin-shape.spec.ts`（只查 prefs 形状，新 tab 不新增 prefs 字段）、`tests/api-surface.spec.ts`（只查版本/特性数 ≥8）、`tests/e2e/mount.e2e.ts`（`BUILTIN_TABS` 是 `+` 菜单标题，新 tab 为 hidden 不进 `+` 菜单，故不破）。

> **验证记录**：`pnpm typecheck` ✅、`pnpm build` ✅、与改动相关的测试（`builtins`/`service`/`state`/`file-tree-drop`/`editor-host`/`git`，共 163 个）✅。全量 `pnpm test` 有 26 个失败，全部集中在 `agent-pty.spec.ts` 与 `smoke.spec.ts` 的 `node-pty` **shell spawn** 测试（`posix_spawnp failed`）；经 `git stash` 对比，**在未改动的 `main` 上同样失败**——属该环境无法 spawn shell 的**基线环境问题**，与本次改动无关。

---

## 7. 复现 / 验证建议

- 改动后 `pnpm typecheck && pnpm build && pnpm test`（CI 另有 npm 打包 → 真实挂载 → 无头渲染门禁 `pnpm test:mount`）。
- **⚠️ host 改动须重启 `dsh web`**：本次改了 host 的 `cwdOf`（`lib/index.js`），按插件规范 host 半更新需**重启 `dsh web`**，仅硬刷新浏览器不会生效（client 半热加载即可）。若只硬刷新而未重启，`repo-git` 会因旧 host 不认 `targetCwd` 而在会话根跑 git → 显示"当前目录不是 git 仓库"（已在 `dsh web` 上实测定位）。
- 实机验证要点：在工作区根（非 git 仓库）下建一个独立 git 的子文件夹 → 文件树右键该文件夹 → 「在此目录打开源代码管理」应显示该子仓库的 status/history；「在此目录打开文件」应打开以该文件夹为根的目录树；再右键另一子文件夹 → 两个同类 tab **并存**（不同路径）；点击已有路径再次打开 → **聚焦**而非重复新建；两 tab 可递归。
- 前向兼容回归：未带 `targetCwd` / 目标根参数的全部既有调用（git.*、fs.*、media/html/file/tools）行为应逐字节不变。
