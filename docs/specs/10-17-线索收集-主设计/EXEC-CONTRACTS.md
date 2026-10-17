# 线索收集执行契约（/exec 编排）

> 本文件是执行期协调文档，不是产品设计：它只记录**已经落地的公共 API、写入范围与集成出口**，避免并行子 Spec 回头改别人的文件。产品语义以各子 Spec 为准；本文件与代码冲突时以代码为准，并先修本文件。

## 0. 基线与环境

- 目标仓库：`DSH-better-sidebar`，集成分支 `dev`，基线 DSH `0.2.1-rc.1`。
- 每个子 Spec 在 `.worktrees/exec-clues/<id>` 独立 worktree 中实现；只允许改该 Spec 的写入范围，最终由主线程串行合入 `dev`。
- 本地命令统一加 `--config.verify-deps-before-run=false`，避免 pnpm 11 隐式 install。
- 不修改 DSH 源码、不新增 DSH peer、不启动第二个 GUI 服务；`test:mount` 只在主线程收尾时尝试（PATH 上的 `dsh` 是 rc.2，需要用 rc.1 的 `DSH_CMD`）。

## 1. 波次与写入范围

| 波次 | Spec | 写入范围（互不重叠） | 依赖 |
|---|---|---|---|
| 1 | S1 | `src/clues/**`、`src/client/clues/**`、`src/fs-read.ts`、`src/index.ts`、`src/client/service.ts`、`src/client/index.tsx`、`src/config.ts`、`src/prefs-shared.ts`、`src/client/prefs.ts`、`package.json` exports/files、`tsdown.config.ts`、`tests/clues-*` | — |
| 2 | S2 | `src/clues/runtime/**`、`src/context-types.ts`、`tests/clues-runtime-*`、`tests/fixtures/clues-runtime/**` | S1 |
| 2 | S5 | `src/clues/context/**`、`src/clues/tools.ts`、`src/client/clues/mentions.ts`、`tests/clues-context-*`、`tests/clues-tools*`、`tests/clues-mentions*` | S1 |
| 2 | S6 | `src/client/FloatingWindow.tsx`、`src/client/FloatingWindow.module.css`、`src/client/windows/**`、`src/client/TaskWindow.tsx`、`src/client/JobsDrawer.tsx`、`src/client/Sidebar.tsx`、`src/client/service.ts`、`src/client/index.tsx`、窗口相关 locale keys、`tests/floating-window*`、`tests/window-*` | S1 |
| 2 | S7 | `src/clues/share/**`、`tests/clues-share-*`、`tests/fixtures/cluepack-*` | S1 |
| 3 | S3 | `src/clues/sources/github/**`、`src/client/clues/sources/github/**`、`tests/clues-github-*` | S1/S2/S6 |
| 3 | S4 | `src/clues/sources/feishu/**`、`src/client/clues/sources/feishu/**`、`tests/clues-feishu-*` | S1/S2/S6 |
| 3 | S8 | `src/client/SideCardSection.tsx`、`src/client/SideCardSection.module.css`、`src/client/clues/settings/**`、`src/client/clues/runtime-api.ts`、`src/client/locales*.ts`、`src/client/settings-nav-icon.ts`、`tests/clues-settings-*`、`tests/side-card-section*` | S1/S2/S6 |
| 4 | S9 | 其余总装配：`src/client/clues/tab/**`、`src/client/clues/pages/**`、`src/client/builtins/**`、`src/client/index.tsx`、`src/client/service.ts`、`src/index.ts`、`src/client/locales*.ts`、`src/bundle-route.ts`/chunk 镜像、`docs/external-plugin-guide.md`、`CHANGELOG.md`、`tests/e2e/**`、`tests/clues-integration-*` | S1—S8 |

规则：并行波内**只加新文件/改自己范围**；任何入口文件（`src/index.ts`、`src/client/index.tsx`、`src/client/service.ts`、`package.json`、locale 词典、chunk 镜像、公共指南）的最终接线归 S9。并行节点不要为了“本地能跑”去改入口；用导出的 `install*` 函数 + 直接单测验证，S9 统一接线。

## 2. 跨 Spec 公共契约（以 S1 落地代码为准）

### 2.1 服务与包边界

- 宿主 Cordis 服务：`betterSidebarClues`（`src/clues/index.ts` 的 `installClues`）。
- 公共子路径：`dsh-better-sidebar/clues`（`src/clues/index.ts` 构建为 `lib/clues.js`，npm 与 registry 两个渠道都必须携带；`ClueError` 由 tsdown externalize 到该产物，宿主与外部来源插件共享同一个类对象）。
- 客户端扩展面：`ctx.betterSidebar.clues`（`BetterSidebarCluesClientFace`）：来源展示注册、`format` 渲染器注册、开关语义、类型化 `clues.*` 调用。
- 数据只经 fenced `/sidebar/api` 暴露；客户端不 in-process 调宿主。Clue API 方法注册走 `CluesService.registerApi(name, handler)`，`src/index.ts` 的 dispatcher 有唯一回退；后续 Spec 不新增第二条 RPC。

### 2.2 身份、偏好与数据

- 内置 sourceId：`builtin.files`、`builtin.github.issues`、`builtin.github.pulls`、`builtin.feishu.docs`、`builtin.feishu.tasks`；包目录身份 `builtin.packs`（不是来源）。这些 id 是核心保留，外部 `registerSource` 拒绝；内置来源经 `createCluesService({ builtinSources })` 注册。
- 类型 id 用命名空间（`builtin.files.markdown` 等）；`ClueTypeCapabilities` 必须声明 `concurrency: 'native-cas' | 'check-before-save' | 'none'`。
- 稳定 id 禁止使用会话 id、缓存 id、CLI 页码、临时下载链接、token。`locator` 与 `data` 必须是 JSON 值；来源负责 `normalizeLocator`/`locatorKey`。持久化按宿主稳定 `workspaceId`（`ctx.workspaceRegistry.get`），不是 cwd、不是 `ctx.workspaces`。
- 插件数据目录：`<profileContext.home>/better-sidebar-data/clues`；store 负责原子写、串行写、revision CAS、损坏报错、快照元数据/内容分离。
- 偏好键（全部 volatile，缺项 = 开）：`clueSourcesEnabled`、`clueSourcesMentionEnabled`、`cluePacksMentionEnabled`；共享 helper 在 `src/prefs-shared.ts`（`isClueSourceEnabled` 等）。

### 2.3 错误与引用协议

- 错误类别：`source-missing`、`dependency-missing`、`dependency-incompatible`、`auth-required`、`permission-denied`、`not-found`、`unsupported`、`rate-limited`、`conflict`、`cancelled`、`timeout`、`invalid-request`、`failed`；`invalid-request` → 400，其余见 `src/wire.ts` 的 `clueStatusOf`。
- 原始 stdout/stderr、Authorization、token、env 秘密不得进入 message/日志/模型返回。来源插件必须从 `dsh-better-sidebar/clues` 导入 `ClueError`。
- 引用 token（S5 拥有）：`[[dsh-clue:<id>]]`、`[[dsh-cluepack:<id>]]`、`[[dsh-clue-snapshot:<snapshotId>]]`；codec 名：`better-sidebar:clues` / `better-sidebar:packs`。
- 未解析引用：`CluesService.importUnresolved`（core-only）为 S7 落库缺来源的线索；`Clue.unresolved` 记录原因与可选 portable locator；read 返回 `source-missing`，快照仍可独立读；来源恢复后 `ensure` 复用同一 id 并清除 unresolved。

### 2.4 API 命名空间（S2/S7 注册，不冲突）

- S1：`clues.*`（sources/resolve/list/search/read/loadEdit/saveEdit/portable/ensure/clues/pins/packs/bindings/snapshots）。
- S2：`clues.dependencies.*`、`clues.connections.*`（inspect/plan/start/status/cancel、status/connect/cancel）。
- S7：`clues.share.*`（exportPreview/exportInspect/exportProgress/importPreview/importProgress/import）；导出与原始 ZIP 导入走 S7 的 raw route handler（含 `exportId`/`importId` 进度查询），`clues.share.import` 只承载小包 base64 JSON 导入，S9 注册。S7 导出 `CLUES_SHARE_API_METHODS` 与 `CLUES_SHARE_ROUTE_PATHS`（`src/clues/share/index.ts`，node-only）作为服务端单一拼写来源；S9 客户端只用通用 `call('clues.share.*')` 字符串，不 import 该模块。

## 3. 各 Spec 的集成出口（S9 装配用）

- S2：`installCluesRuntime(ctx, clues, options)` 返回 `ClueRuntime`（依赖/连接注册、`runCli`、HTTP/MCP 边界）；`src/clues/runtime/index.ts` 导出类型。
- S5：`installClueTools(ctx, clues)`、`installClueInjection(ctx, clues, options)`、`createClueInputTriggers(...)` / `installClueInputTriggers(...)`（客户端）；token 解析/序列化纯函数从 `src/clues/context/**` 导出。
- S6：客户端 `BetterSidebarService.windows`（`createWindowHost()`），<WindowHost> 由 S6 自己挂到 `Sidebar.tsx` 或 `index.tsx`；公开 `open/update/focus/close`、尺寸预设、导航、脏态关闭保护、format 渲染器承载。
- S7：`installCluesShare(ctx, clues, options)` 返回 share service；`createCluesShareRoutes(share, fence)` 返回 raw route handlers（S9 用 `ctx.webServer.register` 挂载）。
- S3/S4：`createGithubSources({ runtime: () => ClueRuntime })` / `createFeishuSources({ runtime: () => ClueRuntime })` 返回 `ClueSourceRegistration[]` 与依赖/连接定义。**runtime 用惰性 getter**，因为服务构造（builtin sources）先于 runtime 安装，直接传实例会形成循环；S9 先建 source registrations（闭包捕获后置 runtime），再 `installClues(ctx, { builtinSources })`，最后 `installCluesRuntime(ctx, clues)` 并注册依赖/连接定义。客户端预览/编辑器注册函数由各自模块导出，S9 调用。
- S8：`SideCardSection` 内部重排即可，无需新的宿主入口；来源行使用 S1 的 `ctx.betterSidebar.clues` 与**本 Spec 新建的** `src/client/clues/runtime-api.ts`（typed `call('clues.dependencies.*')` / `call('clues.connections.*')`）；S2 不拥有客户端文件。

## 4. 验证

单 Spec 最低门禁：

```bash
pnpm --config.verify-deps-before-run=false typecheck
pnpm --config.verify-deps-before-run=false lint
pnpm exec vitest run tests/clues-*.spec.ts <本 Spec 相关既有 spec>
pnpm --config.verify-deps-before-run=false test
pnpm --config.verify-deps-before-run=false build
pnpm --config.verify-deps-before-run=false check:consumer-types
```

全量收尾（S9 合入后）：上述全部 + `pnpm check:engines` +（环境允许时）`DSH_CMD='npx -y --package @deepseek-ai/dsh@0.2.1-rc.1 dsh' pnpm test:mount`。

## 5. 明确不做

- 不修改 DSH 源码、不新增 DSH peer、不恢复已删除的自由窗口/`floatWindows` 能力。
- 不引入按会话访问许可表、临时资源票据、Agent 写入工具、自动安装/自动登录、嵌套线索包。
- 不把线索正文/包成员/快照塞进 settings 偏好；不把二进制 base64 填进聊天消息。
