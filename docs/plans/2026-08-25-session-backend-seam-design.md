# Session Backend Seam 设计文档

- 日期：2026-08-25
- 分支：`feat/session-backend-seam`
- 关联 issue：#238（dsh-remote SSH 会话下侧边栏无法识别目标机工作区）
- 状态：设计 + 实现

## 1. 背景

侧边栏的扩展哲学在 **client 半是完整的**：`ctx.betterSidebar.registerTab` / `registerFileViewer` 让任意插件贡献页面与文件预览器，`features` 做能力协商，声明式设置让插件登记自己的开关。

**host 半的扩展点是零**。`AGENTS.md` §7 明确写着「host 半无此服务：`ctx.betterSidebar` 只在 client 侧存在；host 半需要 better-sidebar 数据走 `/sidebar/api/*` HTTP 路由」——但那句话解决的是「读」，不解决「写」：host 半把三件事焊死在本进程上。

| 能力 | 当前实现 | 焊死在哪 |
|---|---|---|
| 文件树 / 读写 / 搜索 | `buildApi` 里直接 `node:fs` | 本机文件系统 |
| Git 面板 | `git.ts` 直接 spawn | 本机 git |
| 终端 | `PtyManager` + `/sidebar/ws/terminal` | 本机 node-pty |

只要一个会话的工作区**不在本进程所在的机器上**，整个侧边栏就失效。

### 1.1 这不是单一插件的问题

- **#238（dsh-remote，第三方报告，本设计的直接触发点）**：用户通过 `dsh-remote` 插件 SSH 到目标机器工作，侧边栏读的仍是主机的文件系统，「无法去识别目标机器上的工作区内容」。
- **容器 / 云沙箱会话**：会话的 cwd 在容器内，宿主机路径无意义。
- **多节点编排**：会话由另一台节点拥有，本机只是 ingress。

三者的形状完全相同：**某些 sessionId 的文件与终端字节不该来自本进程**。当前架构下，每种远程形态都只能 fork 侧边栏——这正是本设计要消除的。

## 2. 目标与非目标

**目标**：给 host 半开一个与 client 半对称的扩展点，让插件能为**它认领的会话**提供文件 / Git / 终端的替代后端，并且——

- 不认领的会话**零开销**：本地路径一个分支判断，不新增网络跳、不改变现有语义；
- 后端缺席 / 卸载后自动回退本地；
- 接口只描述「会话的字节从哪来」，不含任何具体传输（SSH / 联邦 / 容器）的概念。

**非目标（KISS 排除项）**：

- 不做后端发现、健康检查、重试与熔断——那是后端插件自己的事；
- 不做部分认领（一个会话要么整体归后端，要么整体本地），避免「文件远程但 git 本地」这类无法解释的半吊子状态；
- 不代理 client 半，浏览器侧代码零改动（后端对前端完全透明）；
- 不导出全局设置、浏览器探针、依赖状态与 agent 终端（UUID 寻址）等与会话工作区无关的方法。

## 3. 接口

两个可选 host 服务，互相独立：一个让插件**接管**会话（消费侧），一个让插件**借用**本地会话能力（提供侧）。

### 3.1 `sidebarSessionBackends`（消费侧）

```ts
/** 一次会话作用域的 JSON 调用结果。 */
type SessionBackendResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }

/** 二进制读取结果（媒体 / HTML 路由）。 */
type SessionBackendBinaryResult =
  | { ok: true; status: number; headers: Readonly<Record<string, string>>; body: Uint8Array }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }

interface SidebarSessionBackend {
  /** 诊断用的稳定标识（日志、冲突排查）。 */
  readonly id: string
  /**
   * 该 sessionId 是否归此后端管。必须是廉价纯判断（每次 API 调用都会问）：
   * 按 id 形状 / 前缀 / 自有注册表判断，不要做 I/O。抛错视为不认领。
   */
  claimSession(sessionId: string): boolean
  /** 执行一次被认领会话的 JSON API 方法（方法名同 `/sidebar/api/<method>`）。 */
  invoke(method: string, sessionId: string, payload: unknown, signal?: AbortSignal): Promise<SessionBackendResult>
  /** 执行一次二进制读取（`file.read` / `html.read`）。 */
  invokeBinary(method: string, sessionId: string, payload: unknown, signal?: AbortSignal): Promise<SessionBackendBinaryResult>
  /**
   * 接管一个已完成 upgrade 的终端 WebSocket。侧边栏交出 socket 后不再读写它，
   * 生命周期（关闭、错误、重连宽限）由后端全权负责。
   * 不实现时该后端的会话无法开终端（文件 / Git 仍可用）。
   */
  attachTerminal?(ws: WebSocket, sessionId: string, tab: string | null, options: { reconnectGraceMs: number }): void
}

interface SidebarSessionBackendRegistry {
  /** 注册后端；返回 disposer（用 `ctx.effect` 包裹以获得 HMR 安全）。 */
  register(backend: SidebarSessionBackend): () => void
}

// ctx.sidebarSessionBackends —— 由侧边栏 host 半 provide
```

**认领与路由规则**

1. 每次 `/sidebar/api/<method>`、`/sidebar/file`、`/sidebar/html`、`/sidebar/ws/terminal` 请求，按注册顺序问各后端 `claimSession(sessionId)`，**第一个返回 true 的赢**（先到先得，与 client 侧 `urlTarget` 同款语义）；
2. 无人认领 → 原本地路径，逐字节不变；
3. 只有**会话作用域方法**可路由（见 §3.3 白名单）；白名单外的方法即使会话被认领也走本地（全局设置、浏览器探针、依赖状态等本就与工作区无关）；
4. 后端返回 `ok:false` 时，`code` 为 `session-not-found` 映射 404，其余映射 502——后端故障不伪装成本地文件系统错误。

### 3.2 `sidebarHostApi`（提供侧）

远程场景是两端的：ingress 端要把请求送出去，**owner 端要把本地能力借出来**。owner 端插件此前只能重新实现一遍文件树 / Git / 终端逻辑（或 fork），现在直接取用：

```ts
interface SidebarHostApiService {
  /**
   * 一份 owner-strict 的会话 API 表：cwd **只**取自 Session header，
   * 绝不接受调用方传入的 cwd，也不回退 process.cwd()。
   *
   * 本地 UI 的 cwd 解析带水化回退（首帧 Session 尚未就绪时用客户端提示值），
   * 那对同机浏览器是合理的；但对跨机调用方，回退会把一次路由错误变成
   * 「访问了一个无关目录」。owner-strict 关掉全部回退：Session 不存在或
   * 无 cwd 直接 404。
   */
  createSessionApi(): {
    invoke(method: string, sessionId: string, payload: unknown): Promise<SessionBackendResult>
    invokeBinary(method: string, sessionId: string, payload: unknown): Promise<SessionBackendBinaryResult>
    /** 可路由的会话作用域方法白名单（供后端声明自己的能力清单）。 */
    readonly methods: { readonly read: readonly string[]; readonly write: readonly string[]; readonly binary: readonly string[] }
  }
}

// ctx.sidebarHostApi —— 由侧边栏 host 半 provide
```

一个远程后端插件的完整形状因此是：**ingress 端注册 `SidebarSessionBackend`，owner 端消费 `sidebarHostApi`**，中间那段传输（SSH / RPC / 联邦）完全是它自己的事，侧边栏不需要知道。

### 3.3 会话作用域方法白名单

```
read:   session.cwd, fs.tree, fs.search, fs.read,
        git.status, git.diff, git.branch, git.log, git.commit-diff, git.show,
        jobs.output, terminal.read
write:  fs.write, git.stage, git.unstage, git.commit, git.checkout,
        git.discard, git.revert, git.cherry-pick,
        pty.close, jobs.kill,
        terminal.open, terminal.input, terminal.resize, terminal.terminate, terminal.detach
binary: file.read, html.read
```

**刻意排除**：`settings.*`（全局，非会话）、`browser.probe`（探针指向 ingress 自己的网络）、`deps.status`（本机 node-pty 安装状态）、agent 终端（按 UUID 寻址，属于本机 agent 运行时）。

### 3.4 终端读取模型

远程终端不能共享本地 `attachTerminal` 的「pty 事件直推」路径——中间隔着一次 RPC。因此 `PtyManager` 增加两个单调计数器，让 owner 端可以**按偏移拉取**：

```ts
interface SidebarPty {
  transcript: string       // 既有：有界回放缓冲（超限丢头部）
  outputOffset: number     // 新增：spawn 至今的单调输出偏移
  transcriptBase: string   // 新增：transcript[0] 对应的偏移
}
```

`terminal.read({ tab, offset })` 返回 `{ offset, next, data, base, exited, exitCode }`。调用方按 `next` 推进；`offset` 落在 `base` 之前（缓冲已滚过）时钳到 `base`，即丢失最早的输出而不是报错——与本地 tab 超限丢头部的行为一致。

这两个字段对本地路径**完全惰性**（只是两个加法），不改变既有回放语义。

## 4. 实现要点

- `src/session-backend.ts`（新文件）：注册表实现、白名单常量、`claimBackendFor(sessionId)` 解析（含 `claimSession` 抛错的吞并降级）、`ownerSessionCwdOf`（owner-strict cwd 解析）。
- `src/index.ts`：
  - `buildApi` 增加 `cwdMode: 'local-fallbacks' | 'owner-strict'` 与 `ownerSessionGet` 两个**带默认值**的参数——本地调用点一字不改；
  - `/sidebar/api` handler 在 `api[method]` 之前插入认领判断；
  - `/sidebar/file`、`/sidebar/html` 同理，认领时转 `invokeBinary` 并原样回写 status/headers/body；
  - `/sidebar/ws/terminal` 在 `handleUpgrade` 回调内判断认领，命中则把 ws 交给 `backend.attachTerminal`，未实现该可选方法时以 1011 关闭并给出明确原因；
  - `ctx.provide('sidebarSessionBackends', ...)` 与 `ctx.provide('sidebarHostApi', ...)`。
- `src/context-types.ts`：两个服务面加入 `SidebarContextShape`，并从包根导出类型供后端插件消费。
- 服务查找不引入轮询：注册表由侧边栏自己 provide，后端插件用标准 `inject` + `ctx.effect` 注册，Cordis 保证顺序。

## 5. 安全边界

| 边界 | 规则 |
|---|---|
| cwd 权威性 | owner-strict 模式下 cwd **只**来自 Session header；调用方 payload 里的 `cwd` 字段在转发前被显式删除，不因藏在普通字段里而生效 |
| sessionId 权威性 | 转发时 sessionId 由路由层决定并覆写 payload，后端 handler 不接受 payload 里的 sessionId |
| 路径围栏 | owner 端二进制读取保持既有 `requireAbsolute` + `isWithin(cwd, path)` 围栏，与本地路由同一套 |
| 方法面 | 白名单是允许列表而非拒绝列表：新增 API 方法默认**不可**远程路由，需显式加入 |
| 认领谓词 | `claimSession` 抛错视为不认领（降级本地），不让一个坏后端拖垮整个侧边栏 |

## 6. 测试

`tests/session-backend.spec.ts`：

1. 未注册后端时所有路由走本地（回归保护）；
2. 单后端认领 → JSON / 二进制 / 终端三条路径均转发，且 payload 里的 `cwd` 被剥离、`sessionId` 被覆写；
3. 多后端按注册顺序先到先得；先注册者不认领时顺延；
4. `claimSession` 抛错 → 降级本地，不冒泡；
5. disposer 调用后回退本地；
6. 白名单外方法即使会话被认领仍走本地；
7. owner-strict：Session 缺失 → 404、无 cwd → 404、相对 cwd → 400；绝不回退 `process.cwd()`；
8. `terminal.read` 偏移语义：正常推进、offset 落后于 base 时钳制、exited 后仍可读尾部；
9. 后端 `attachTerminal` 缺席时终端 WS 以明确原因关闭。

## 7. 兼容性

- 纯增量：不改任何既有签名的**调用点**，不改 client 半，不改持久化格式，不改 `/sidebar/api` 线格式；
- 无后端安装时行为与 v0.16.0 逐字节一致；
- 市场清单约束（依赖字段不得出现 `cordis`、无生命周期脚本）不受影响；
- 服务均为可选：`ctx.get('sidebarSessionBackends')` 缺席时后端插件自行降级，反向亦然。

## 8. 已知消费者

| 消费者 | 形态 | 状态 |
|---|---|---|
| `@fzhiyu/dsh-federation` | ingress 注册后端 + owner 消费 `sidebarHostApi`，跨节点会话 | 本 PR 的实证消费者，已在真实多节点部署验证（此前靠 fork 侧边栏实现，本设计即为消灭该 fork） |
| `dsh-remote`（#238） | ingress 注册后端，SSH 会话的文件 / Git / 终端走 SSH 通道 | 按同一接口可修复，无需改侧边栏 |
