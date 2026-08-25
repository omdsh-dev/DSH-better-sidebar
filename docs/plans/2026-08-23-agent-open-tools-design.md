# 设计：模型主动在侧边栏打开（`sidebar_open` 工具 + `agentOpenTools` 设置）

> 日期：2026-08-23 · 状态：已实现 · 仓库：omdsh-dev/DSH-better-sidebar

## 需求

新增一个侧边栏**全局设置**（Side card 设置页「常规」分组）：`agentOpenTools`，**默认关闭**。
开启后向模型注入**一个**工具 `sidebar_open`，允许模型主动在**调用方会话**的侧边栏中打开：

- 本地**文件** → 内置 editor tab（按 path 去重，聚焦既有 tab）
- 本地**文件夹** → 内置 editor tab 的**文件夹窗口**（文件树以该目录为根）
- **HTTP(S) 网页** → 内置 browser tab（URL 预填）

## 关键决策

### 1. 作用域 = 调用方 agent 会话

与 `terminal_*` 工具一致：工具只绑定 `exec.agent.session.id`，模型不传 sessionId。
子代理（或未激活会话）调用时若无客户端连接，打开请求排队，该会话侧边栏下次可见时重放。
工具结果通过 `delivered` 如实报告「当前是否已推送到已连接的侧边栏视图」。

### 2. 投递通道：host→client WS 推送（无 ack 协议）

- 新增 WS 升级路由 `/sidebar/ws/agent-opens?sessionId=...`（与 `/sidebar/ws/agent-terminals` 同模式，过同一 trust fence）。
- host 侧 `AgentOpenRegistry` 维护会话级队列 + 已连接视图集合：
  - `enqueue`：有订阅者 → 即时推送并**消费**（`delivered: true`）；无订阅者 → 保留队列（`delivered: false`）。
  - `attach`：注册订阅者并**重放**队列（消费即出队），返回 disposer（close/error 时退订）。
  - `drainAll`：特性关闭时丢弃未投递队列。
- **消费即出队**是关键：browser tab 无 per-URL 去重，重连重放会铸造重复 tab；消费语义保证每个请求恰好推送一次。
- 不加 ack 回执、不加 `/sidebar/api` 路由——结果的最佳努力语义（`delivered`）已足够，符合 KISS 与 terminal 先例。

### 3. `sidebar_open` 工具（唯一新增工具）

- 参数：`target`（必填：绝对/相对路径，或 http(s) URL）、`title`（可选：tab 标题）。
- 执行流程：`throwIfAborted` → 分类 → 目标 tab 启用检查 → 入队 → 返回规范结果。
- 分类规则：
  - `http://` / `https://`（大小写不敏感）→ `url`，默认标题 = hostname；
  - 其他 scheme（`file:` / `javascript:` / `vscode:` 等）→ 报错（Windows 盘符前缀 `C:\`/`C:/` 除外，它是路径不是 scheme）；
  - 本地路径 → 相对路径以会话 cwd（`sessionCwdOf`）解析为绝对路径，`stat` 定 `file`/`folder`；不存在/不可读 → 报错；
  - 目标 tab 类型被用户禁用（`tabsEnabled['editor'|'browser'] === false`）→ 报错并提示启用（避免客户端静默 no-op）。
- 输出（canonical JSON，`render` 纯文本投影）：`{ kind, target, title, delivered }`。
- 工具描述/错误消息为英文（与 8 个 `terminal_*` 一致）。

### 4. 文件夹窗口：editor tab 的 `meta.dir`

- 打开文件夹 = `openTab({ type: 'editor', path: <dir>, id: 'editor:'+<dir>, title, meta: { dir: true } })`。
- EditorHost 识别 `meta.dir === true`：不进入 viewer 加载流程，渲染**全窗 TreePanel**（`cwd = tab.path`）；
  FileTree 根部即 `cwd`（`fs.tree` 接受绝对路径），搜索结果/上传仍受会话工作区约束（已知限制，见下）。
- `meta` 为可持久化的 tab 状态（v0.12.0+），`sanitizeState` 原样保留——刷新后文件夹窗口恢复。
- 折叠/展开、右键打开、拖拽上传等全部复用 TreePanel 既有能力。

### 5. 设置与门控

- 新 prefs 字段 `agentOpenTools: boolean`（`SidebarPrefs` + `PrefsSchema` + 客户端 `parsePrefs`），默认 `false`。
- SideCardSection「常规」分组新增一行 Switch（标题/描述走新 locale key）。
- host 门控完全拷贝 `agentTerminalTools` 的 `syncToolsGate` 模式：
  - 开启 → `registerOpenTool(...)`；关闭 → 注销工具 + `agentOpenRegistry.drainAll()`；
  - 一次 `scope.watch` 同时驱动两个门控（各持有自己的 disposer，互不干扰）；
  - 工具不依赖 node-pty，降级模式下也可用。
- 客户端防御：Sidebar 的 agent-opens 推送订阅在 `prefs.agentOpenTools !== true` 时忽略消息（host 已门控，此为双保险）。

### 6. 与既有拦截开关的关系

- URL 打开**不受** `browserInterceptLinks` / `browserInterceptHttp` / `browserInterceptHttps` 约束——那是用户点击外链的接管开关；
  模型显式调用 `sidebar_open` 只受 browser tab 自身启用开关约束（openTab 既有 gating）。
- 文件打开**不受** `interceptOpenPath` 影响（那是聊天点击路径的接管开关）。

## 既有模式复用（零新公共 API）

| 新事物 | 复用/镜像的既有模式 |
|---|---|
| `agentOpenTools` 门控 | `agentTerminalTools` 门控（settings seam `watch` → 注册/注销） |
| `/sidebar/ws/agent-opens` | `/sidebar/ws/agent-terminals` 推送（升级注册、fence、每会话 attach） |
| 客户端推送订阅 | Sidebar 的 agent-terminals effect（重连上限 `FAILURE_LIMIT`、防抖/清理） |
| 文件/URL 打开 | `service.openFile` / `openTab({ type:'browser', url })`（link-intercept 同款） |
| 文件夹窗口 | path-less explorer 的全窗 TreePanel 分支（仅根目录改为 `tab.path`） |

不新增 `BetterSidebarService` 方法；不改变任何现有路由协议。

## 已知限制

- **多浏览器窗口**：推送按「有订阅者即发送并消费」执行，多窗口同时连接时后连接的窗口不会收到已消费的请求
  （其本体状态由 localStorage 恢复——与 agent-terminals 的全量列表 fan-out 不同，属尽力而为语义）。
- **文件夹窗口的全局搜索/上传**：TreePanel 的搜索盒仍以**会话 cwd** 为根（`fs.search` 是有意的工作区限定），
  目录内上传经 host 会话工作区校验（目录在 cwd 内可上传，cwd 外拒绝）。
- **无 ack**：`delivered: true` 只表示「推送已发出」，客户端处理失败（罕见）不重试。
- **关闭特性不清已打开 tab**：与 tab 启用开关语义一致，只注销工具并清空未投递队列。

## 测试覆盖

- `tests/agent-opens.spec.ts`（新）：注册表语义（排队/重放/消费/作用域隔离/drain/dispose）+ 工具行为
  （分类、相对路径、缺路径、非 http(s) scheme、tab 禁用、schema 校验、无 agent 错误）。
- `tests/smoke.spec.ts`：WS 升级路由清单 + `settings.get` 默认值 + 独立 gating 测试（默认 off → 0 工具；on → 1；off → 注销）。
- `tests/plugin-shape.spec.ts` / `tests/prefs.spec.ts`：schema/parse 默认值 + 全量 prefs 字面量。
- `tests/editor-host.spec.tsx`：`meta.dir` 文件夹窗口（树以目录为根、无编辑器 chrome、不触发 viewer 加载）。
- `tests/locales.spec.ts`：zh/en/ja 词典 key 集相等（自动覆盖新键）。
