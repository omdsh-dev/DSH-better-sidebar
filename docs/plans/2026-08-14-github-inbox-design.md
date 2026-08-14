# GitHub 收件箱提醒设计（内置 GitHub tab）

**日期**：2026-08-14
**状态**：待审阅
**作者**：用户 + AI agent
**当前版本**：v0.12.0（main `cba7e77`）
**目标版本**：v0.13.0

## 1. 目标

在 dsh-better-sidebar 内新增一个**内置 tab「GitHub」**，让用户不打开 github.com 也能跟进和处理 GitHub 收件箱（PR Workflow）：

1. 展示收件箱未读通知（PR / issue / CI 等），tab 角标显示未读数；
2. 按类别**勾选过滤**，CI 失败类通知默认隐藏；
3. 快捷操作：已读 / Done / 全部已读、Approve / Request changes / Comment、Merge（门控）；
4. 只消费 v0.12.0 已就绪的扩展点（`badge`、声明式设置），**不新增服务接口**。

## 2. 非目标

- 不改 `BetterSidebarService` 接口（badge / settings 能力已在 v0.12.0 就绪，本设计只消费）。
- 不做多账户切换（单 token 解析链）。
- 不做实时推送（webhook / SSE）——轮询即可，KISS。
- 不引入 GitHub GraphQL（REST Notifications 端点足够）。
- 不引入 Agent 侧的 GitHub 工具（那是 agent 的事，本 tab 是人的操作面）。
- 不接 DSH 的 credentials 服务（避免可选依赖耦合；若后续需要统一凭据管理，可作为解析链的新一级加入）。
- 不改 DeepSeek Harness 源码。

## 3. 现状回顾（证据）

### 3.1 既有积木（本设计全部复用）

| 能力 | 位置 | 用途 |
|---|---|---|
| tab 角标 `badge` | `src/client/service.ts:180`；渲染 `src/client/Sidebar.tsx:658-667`（抛错吞掉） | 未读数 pill（99+ 封顶），GitHub tab 将是**首个使用 badge 的内置 tab** |
| 声明式设置 `settings.toggles` | `src/client/builtins/tabs.tsx`（git/subagent/terminal 先例） | 过滤开关直接落 Side card 齿轮弹窗 |
| host JSON API 方法表 | `src/index.ts` 的 `/sidebar/api` 前缀路由 + `buildApi`；信封/栅栏/1MB 上限在 `src/wire.ts` | GitHub 路由以**方法**并入现有表，零新路由注册 |
| 路由组模块模板 | `src/jobs-routes.ts` | `src/github-routes.ts` 照此结构 |
| 信任栅栏 | `src/trust-fence.ts`（loopback Host + `webRuntime.trustedHosts`） | GitHub 方法继承 `/sidebar/api` 前缀的既有栅栏，token 永不进浏览器 |
| 偏好设置 | `src/prefs-shared.ts`（词汇表+默认值）、`src/config.ts`（`PrefsSchema`）、client 写路径 `src/client/prefs.ts` + `api.settingsUpdate` | 过滤偏好持久化 |
| 客户端调用面 | `src/client/api.ts`（`call<T>(method, payload)`） | 新增 `github.*` 方法 |
| 内嵌浏览器 tab | `openTab({type:'browser', url})`（`OpenTabSeed.url`） | 「在侧边栏浏览器打开 PR」零新代码 |

### 3.2 GitHub API 事实（官方文档证据）

- `GET /notifications`：线程含 `reason` / `subject.{title,url,latest_comment_url,type}` / `repository` / `unread` / `updated_at`；只返回**未读**线程。
- **为轮询而设计**：`Last-Modified` + 304 条件请求，无变化不耗限流；必须遵守 `X-Poll-Interval` 响应头（默认 60s，高负载会加大）。
- 标记：`PATCH /notifications/threads/:id` 已读；`DELETE /notifications/threads/:id` Done；`PUT /notifications` 全部已读。
- 动作：`POST /repos/{o}/{r}/pulls/{n}/reviews`（`APPROVE|REQUEST_CHANGES|COMMENT`）；`POST /repos/{o}/{r}/issues/{n}/comments`；`GET /repos/{o}/{r}/pulls/{n}` + `GET .../commits/{sha}/check-runs`（CI 状态）；`PUT /pulls/{n}/merge`。
- scope：`notifications`（读+标记）与 `repo`（review/comment/merge）。
- **reason 语义会漂移**（官方文档）：你 author 的线程，后续动态统一报 `author`（review 结果、他人新评论都算）；被 @ 后变 `mention`。因此分类是**展示级**的，不承诺精确事件语义。

参考：<https://docs.github.com/en/rest/activity/notifications>

## 4. 方案选型

| 决策点 | 选项 | 结论 |
|---|---|---|
| 数据源 | REST Notifications vs GraphQL vs 封装 `gh` CLI 子命令 | **REST**：条件轮询 + 免限流是现成能力；GraphQL 无对应轮询语义 |
| 拉取位置 | host 拉取 vs client 直连 GitHub | **host**：token 不进浏览器、304 缓存单实例、绕开 CORS |
| host 轮询模型 | 常驻定时器 vs **请求驱动**（client 轮询触发 host 条件请求） | **请求驱动**：无服务端定时器生命周期，304 短路后多标签页/多 client 成本≈0 |
| 推送机制 | SSE / WS vs client 短轮询 | **短轮询**：sentinel 先例（2s 轮询），KISS；间隔取 `max(pollSeconds, X-Poll-Interval)` |
| token 来源 | 单选 vs 解析链 | **解析链**（见 §5.2），覆盖 CLI 与手配两种部署 |
| Merge | 全开 vs **config 门控** | **门控**：`Config.githubAllowMerge` 默认 `false`；开前必须展示 CI 状态并二次确认 |
| 形态 | 独立插件 vs **内置 tab** | **内置 tab**（用户拍板）：开箱即用；tab id `github` |

## 5. 详细设计

### 5.1 数据模型（client 可序列化形状）

```ts
interface GithubThread {
  id: string            // 线程 id
  unread: boolean
  reason: string        // GitHub 原始 reason
  repo: string          // 'owner/name'
  title: string         // subject.title（review verdict 也在这里）
  url: string           // subject.url（PR/issue 页面）
  type: string          // subject.type: 'PullRequest' | 'Issue' | …
  updatedAt: string     // ISO 8601
  latestCommentUrl?: string
}

type GithubCategory = 'reviewRequested' | 'prActivity' | 'comments' | 'ci' | 'other'

interface GithubStateResult {
  configured: boolean   // token 是否解析成功
  ghAvailable?: boolean  // gh 二进制是否可用（未配置时驱动引导文案的路径推荐）
  error?: { code: string; message: string }  // 未配置 / 401/403 / 网络
  threads: GithubThread[]
  fetchedAt?: string
  pollIntervalSec: number  // host 折算后建议值（≥ 60）
}
```

**分类纯函数**（`src/client/github-inbox.ts`，独立可单测）：

| 类别 | 映射 | 默认 |
|---|---|---|
| `reviewRequested` | `reason === 'review_requested'` | 显示 |
| `prActivity` | `reason === 'author'` 且 `type === 'PullRequest'`（review 结果 / 新评论） | 显示 |
| `comments` | `reason ∈ {comment, mention, team_mention}` + `author`+issue | 显示 |
| `ci` | `reason === 'ci_activity'` | **隐藏** |
| `other` | 其余（assign / subscribed / security_alert / state_change / manual / …） | 显示 |

- review verdict（✅ approved / ⛔️ changes requested）由 `title` 关键词（`approved these changes` / `requested changes`）做**展示级**识别，不引入额外 API 调用。
- `filterThreads(threads, prefs)` 与 `countUnread(threads)` 为纯函数；**badge = 过滤后未读数**（CI 被勾掉后角标不受 CI 干扰）。

### 5.2 host 半

**`src/github.ts`**：

- `resolveToken(config)` 解析链（**不依赖 gh**：任何一级缺失都静默落到下一级；未安装 gh 时 Config/env 两条路照常可用）：
  1. `Config.githubToken` —— 零依赖基线，显式配置直接短路，不再探测后续来源
  2. `gh auth token` 子进程（`execFile`）：二进制缺失（ENOENT）按**进程生命周期**缓存「gh 不可用」，不做重复 spawn；登录态有效时 token 缓存 5 分钟；未登录/超时等可恢复失败缓存 30s
  3. `GH_TOKEN` / `GITHUB_TOKEN` 环境变量 —— 无 gh 部署的主路径
  4. 全部未命中 → `configured: false` + `ghAvailable` 标志
- `GitHubClient`（注入 base + token）：
  - `fetchInbox(lastModified?)`：`GET {base}/notifications`（`per_page=50`）带 `If-Modified-Since`；304 → `{notModified: true}`；否则返回线程列表 + 新 `Last-Modified` + `X-Poll-Interval`。线程按 `updated_at` 降序、截断到 `githubPerPage`。
  - `fetchThreadDetail(id)`：线程详情 + `latest_comment_url` 正文（供展开渲染，失败时正文缺省）。
  - 动作：`markRead` / `markDone` / `markAllRead` / `review(repo, pr, event, body)` / `comment(repo, issue, body)` / `mergeStatus(repo, pr)`（PR 详情 + head sha 的 check-runs，归一化为 `{checks: {name, status, conclusion}[], mergeable, state}`）/ `merge(repo, pr, method)`。
  - 错误归一化 `GithubApiError{status, code, message}`：401/403 → `github-auth`（client 降级只读提示）；422 → `github-rejected`（透传 GitHub 文案，如分支保护拒绝 merge）。
- **内存缓存**：`{threads, lastModified, fetchedAt, pollIntervalSec}`。`github.state` 处理：缓存新鲜（< pollIntervalSec）直接返回；否则条件 GET（304 → 返回缓存 + 刷新 `fetchedAt`）。已读/Done/全部已读成功后**本地乐观更新缓存**（移除/置 read），client 无需二次拉取。

**`src/github-routes.ts`**（照 `src/jobs-routes.ts` 模板）：`state / thread / markRead / markDone / markAllRead / review / comment / mergeStatus / merge` 九个方法，并入 `buildApi` 返回表。`merge` 在 host 再次检查 `Config.githubAllowMerge`（未开 → `github-forbidden` 码）。所有方法继承 `/sidebar/api` 前缀路由的栅栏、POST-only、1MB body 上限，**零新路由注册**。

**`src/config.ts`** 新增（均可 cordis.patch.yml 覆盖）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `githubToken` | `undefined` | 显式 PAT（保密建议走 `gh` 或 env，见 §5.2 解析链） |
| `githubApiBase` | `https://api.github.com` | 企业版可配 GHES 地址 |
| `githubPollFloorSeconds` | `60`（min 60） | 尊重 `X-Poll-Interval` 的硬下限 |
| `githubPerPage` | `50`（max 50） | 单次线程数 |
| `githubAllowMerge` | `false` | Merge 门控（默认关） |

**`src/prefs-shared.ts` / `src/config.ts`（PrefsSchema）/ `src/client/prefs.ts`（parsePrefs）** 同步新增：

| prefs 键 | 类型 | 默认 |
|---|---|---|
| `githubShowReviewRequested` | boolean | `true` |
| `githubShowPrActivity` | boolean | `true` |
| `githubShowComments` | boolean | `true` |
| `githubShowCi` | boolean | **`false`** |
| `githubShowOther` | boolean | `true` |
| `githubPollSeconds` | number（30–300） | `60` |

### 5.3 client 半

**`src/client/github-inbox.ts`**：分类/过滤/计数/verdict 纯函数 + `GithubInboxStore` 工厂（`useSyncExternalStore` 适配；由 `builtinTabs(ctx)` 在注册时创建一次——遵守「production 只建一处」规则，badge 与 view 闭包共享）。

- store 持有 `{state: GithubStateResult | null}`；创建时订阅 `service.subscribeState()` 同步 prefs 快照（badge 计算过滤需要）。
- **轮询器归 store 所有**（不归 view）：tick 间隔 `githubPollSeconds`；`document.hidden` 时跳过；`configured === false` 时降为 5 分钟探测一次；fiber dispose 时清除。这样**tab 从未打开过，角标也保持鲜活**。
- `badge(ctx, scope, state)`：`countUnread(filterThreads(store.threads, store.prefs))`，0 → `null`（隐藏），99+ 封顶；抛错被宿主吞掉。

**`src/client/builtins/tabs.tsx`** 新增注册（表 §3.4 增加一行）：

```ts
{
  id: 'github',
  title: () => t('githubTab'),
  icon: (size) => <IconInbox…/>,
  order: 25,          // git(20) 与 subagent(30) 之间
  single: true,
  badge: () => githubStore.badgeValue(),
  settings: { toggles: [/* 5 个过滤开关 + githubPollSeconds number 行 */] },
  component: ({ scope, visible }) => <GitHubInboxView store={githubStore} visible={visible} />,
}
```

**`src/client/GitHubInboxView.tsx`**（新组件）：

- **顶栏**：标题 + 未读汇总、刷新、全部已读、过滤 chips 行（5 个勾选，点击即写 prefs——与 Side card 齿轮弹窗**同键同源**）。
- **状态行**：未配置 → 按 `ghAvailable` 展示引导（gh 可用：推荐本机 `gh auth login`；gh 不可用：推荐 cordis.patch.yml 配 `githubToken` 或设 `GH_TOKEN` 环境变量）；`github-auth` → 只读降级提示；网络错误 → 保留上次快照 + 警告行。
- **列表**：按 repo 分组（`updated_at` 降序），每行 = 类别图标 + 未读圆点 + 标题 + 分类标签（prActivity 附加 ✅/⛔️ verdict 标签）+ repo · 相对时间；点击展开。
- **展开详情**：`api.githubThread(id)` 拉正文，`MarkdownText` 渲染（必须传 `codeLabels={{ copyLabel: t('copy'), copiedLabel: t('copied') }}`）；动作行：
  - ✅ 已读 / 🗑 Done（乐观更新 + 列表移除）
  - Approve / Request changes / Comment（文本框，PR 用 reviews 端点，issue 用 comments 端点）
  - 在侧边栏浏览器打开（`openTab({type:'browser', url})`）/ 新标签页打开
  - **Merge**（仅 PR + host 门控开启时出现）：面板展示 `mergeStatus`（check-runs 状态 + mergeable）→ 选 merge 方式（squash 默认 / merge / rebase）→ 显式确认 → 成功后线程标记已读。
- 全局数据不按会话隔离（收件箱是账号级），`single: true` 每会话一个 tab。
- 轮询/挂起：view 挂载不轮询（store 已在轮询），`visible=false` 不影响 badge 数据流。

**`src/client/api.ts`** 增加 9 个类型化方法 + `GithubThread`/`GithubStateResult` 等类型（沿用 `call` 封装；`sessionId` 照传、host 忽略）。

**i18n（`src/client/locales.ts`）**：zh/en 双词典新增 `githubTab`、5 个 chips、动作文案、未配置/权限降级提示等键。

### 5.4 安全与降级

- token 只存在于 host 内存与 Config/env；`github.state` 响应**不含 token**；错误消息不透传请求头。
- 动作路由走既有栅栏 + POST-only；写操作无 CSRF 面（同源 + Host 校验）。
- 限流：条件轮询豁免限流；动作请求频率由人工操作天然受限；`X-Poll-Interval` 硬下限 60s。
- 降级矩阵：未配置 → 引导；401/403 → 只读 + 提示；404/422 → GitHub 文案透传；网络失败 → 上次快照。

## 6. 测试计划

- **纯函数**：`github-inbox.ts` 的分类映射（含 reason 漂移样本）、过滤、未读计数、verdict 标题识别（vitest）。
- **host**：`GitHubClient` 以 mock `fetch` 测条件请求（304 路径）、`X-Poll-Interval` 折算、错误归一化；`github-routes.ts` 信封 + 栅栏 403 + `githubAllowMerge` 门控拒绝；`PrefsSchema` 新字段校验。
- **client**：api 面（`tests/api-surface.spec.ts` 模式）；badge 吞错（`Sidebar.tsx:664` 已吞）；chips 写 prefs 与齿轮弹窗同源。
- **存量守护**：`tests/builtins.spec.ts` 内置清单 7 tab → 8 tab 断言更新；`tests/consumer-types.ts` 类型面。
- **手动验收清单**（真实 PAT）：未配置引导 → 配置后 badge 计数 → 勾掉 CI 后计数变化 → Approve / Comment 生效 → 门控关闭时 Merge 不可见 → 开启后 mergeStatus 展示 + merge 成功。

## 7. 实施阶段（每步独立可验证）

| 阶段 | 内容 | 验证 |
|---|---|---|
| P1 只读 | host `github.ts`/routes（state/thread）+ client store/badge/列表/chips/prefs | 真实账号收件箱渲染、过滤、角标 |
| P2 动作 | markRead/markDone/markAllRead + review/comment + 降级矩阵 | 动作生效、403 只读降级 |
| P3 Merge | mergeStatus/merge + 门控 + 面板 | 门控拒绝、CI 展示、合并成功 |
| 收尾 | AGENTS.md §3.4 表 + README（zh/en）+ 版本 0.13.0 + 全量测试 | `pnpm run test` 全绿 |

## 8. 风险与权衡

| 风险 | 应对 |
|---|---|
| reason 语义漂移（官方确认） | 分类为展示级；verdict 由标题关键词辅助识别，文案不承诺事件级精确 |
| `gh auth token` 子进程开销 | 5 分钟成功缓存 / 30s 失败缓存 / 二进制缺失按进程生命周期缓存；env/Config 可完全绕过 |
| 高负载时 `X-Poll-Interval` 增大 | host 折算 `max(pollSeconds, X-Poll-Interval)` 下发，client 遵守 |
| 多标签页并发轮询 | host 条件请求 304 短路，成本≈0 |
| Merge 不可逆 | `githubAllowMerge` 默认关 + CI 状态前置展示 + 显式确认 + 422 文案透传 |
| 通知列表只含未读 | 已读/Done 后本地乐观移除，语义与 GitHub 一致 |
