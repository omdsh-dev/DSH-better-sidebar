---
type: ChangeSpec
title: Side Chat 渲染对齐与 Markdown 性能
description: 修 Side Chat 的本地 Markdown 图片、present/deliverables 卡片，并让 markdown labels 稳定、live 行走 streaming，消除每行全量重解析。
status: implemented
---

# Side Chat 渲染对齐与 Markdown 性能

## 目标

Side Chat 是插件自建的 compact transcript，不是宿主 chat 的复用视图。它在三处落后于主 Session：本地 Markdown 图片只回退 alt 文本、image/file content block 在 reducer 被丢弃、`present` 工具没有 deliverables 卡片。同时，`markdownTextProps` 每次新建 labels 对象，打穿宿主 `MarkdownText` 的 `memo`，导致流式 push 与每次按键都重解析整个 transcript。

本 spec 的交付：Side Chat 的**本地 Markdown 图片**正常渲染；Side Chat 的**`present` 文件交付**有 compact 卡片；**markdown 渲染热路径**不再全量重解析，live 行走增量 `streaming`。不改变宿主、不改变会话格式、不增加新服务端路由。

## 契约层（durable）

### 行为契约

**C1 — 本地 Markdown 图片（Side Chat prose）**
- 任何 Side Chat prose 行（user/assistant 的 Markdown 文本）中的本地图片目的地——相对路径（`./cat.png`、`cat.png`）、绝对本地路径、reference-style 定义——必须解析为可显示的图片，而不是 alt 文本。
- 解析基准：当前会话的工作目录（session cwd）；相对路径按该目录解析，绝对路径按原样。
- 生成的媒体 URL 必须走插件已有的本地文件媒体路由（形如 `/sidebar/file?sessionId=…&path=…&cwd=…` 的绝对 http(s) URL），从而满足宿主 `MarkdownText` 的 http(s) allowlist；不得引入新的 host API 或新的公开路由。
- 非本地目的地（http/https/data/mailto/锚点）保持不变；代码块与 inline code 中的图片语法不得被改写（复用现有代码区域 masking）。
- 图片改写必须先于现有的本地链接改写执行；链接改写不得吞掉图片目的地。
- 远程 http(s) 图片保持现有行为（渲染、无 lightbox）。

**C2 — `present` 交付卡片（Side Chat）**
- Side Chat 的 thread **自身**日志中出现 `present` 工具调用或 `deliverables/presented` 事件时，必须渲染一张 compact deliverables 卡片。
- 卡片每个文件显示：文件类型图标、文件名（basename）、可选 description；图片文件额外显示缩略图（通过已有本地媒体路由）；点击文件使用插件已有的 `openSidebarFile` 路径打开。
- 文件数据来源优先级：`deliverables/presented` 事件（含绝对的 `files[].path` / `description`，以 `turn`/`callId` 关联）优先；事件尚未到达时使用 `present` 调用的参数（`files`，按 cwd 解析）。
- 同一个 `present` 调用只出现一张卡片；事件到达时按 `callId` 附着/更新，事件先于调用到达时同样只有一张，不重复渲染。
- `present` 调用失败（`tool/result` 带 `data.error`）时不显示交付卡片：回退为通用 failed tool 行并保留错误文本，与该功能上线前的行为一致。
- 继承 seed 中的 `present`/deliverables 事件不得渲染（Side Chat 只显示 thread 自己的对话）。
- 卡片文案必须走 locale 字典，不允许硬编码；新增 key 覆盖全部现有 locale，并通过 locale key 一致性测试。
- 不新增服务端依赖/路由；不引入 `ui-deliverables` 等新的 host peer。

**C3 — Markdown 渲染热路径**
- `markdownTextProps(text, labels)` 对**相同 label 值**必须返回**同一个**嵌套 `labels` 对象引用（模块级、有界缓存）；不同 label 值必须返回不同对象。
- Side Chat 的未 settled assistant live 行必须向宿主 `MarkdownText` 传 `streaming={true}`；settled 行传 `false`/省略。
- 父组件因流式 push 或 composer 按键重渲染时，未变化的行不得重新执行 `MarkdownText` 的解析（memo 必须命中）；只有文本变化/新增的行重新解析。
- 不改变宿主 `MarkdownText` 实现；标签缓存同时惠及插件其它 markdown 调用点（编辑器预览/diff/TaskWindow）。

**C4 — 兼容与安全**
- 仅客户端改动；不改变会话事件、`SESSION_FORMAT_VERSION`、sidechat 路由协议或 profile 配置。
- 保持宿主 peer 基线 `^0.2.1-rc.1`；不新增依赖。
- 文件读取只经现有会话 scoped 的 `/sidebar/file` 路由和 `openSidebarFile`；卡片/缩略图不得接受任意路径输入、不得绕过会话范围。
- 现有 Side Chat 行为不回归：远程图片、本地文件链接、tool 行、reasoning/injection/error/turnSummary、pending/echo、push/poll。

### 交付物与验收

**D1 — Markdown labels 稳定 + streaming**
- 可观察结果：相同 label 值返回同一 labels 引用；未 settled assistant 行走 `streaming`；父组件重渲染时未变化行的 `MarkdownText` 解析次数为 0。
- 验收：
  - `pnpm vitest run tests/markdown-copy-labels.spec.tsx tests/sidechat-markdown-labels.spec.tsx tests/sidechat-view.spec.tsx` 通过；新增的 labels identity / render-count 用例在旧实现上失败（TDD Red 证据）。
  - 真实 `SideChatView` 性能测量（jsdom，50/100/200 markdown 组件）记录 push/keystroke；200 组件目标 < 10ms（基线 101.7–117.8ms），数字写入交付报告。
- 状态：`- [x]`

**D2 — Side Chat 本地 Markdown 图片**
- 可观察结果：Side Chat 行中的 `![alt](./cat.png)`/绝对本地路径/reference image 渲染为 `<img>`，src 为 `/sidebar/file?...` 绝对 URL；代码块中的示例不改写；http(s) 图片不变。
- 验收：
  - `pnpm vitest run tests/markdown-images.spec.ts tests/markdown-crlf.spec.ts tests/sidechat-markdown-images.spec.tsx tests/sidechat-view.spec.tsx` 通过；新增的局部图片 DOM 与 prose 图片改写用例（cwd 变体、angle destination、title 保留）在旧实现上失败（Red）。
  - 浏览器验证：第二实例或 plugin-mount 场景中，Side Chat 行显示本地图片（截图证据）。
- 状态：`- [x]`

**D3 — Side Chat `present` 卡片**
- 可观察结果：thread 自身 `present` 调用/`deliverables/presented` 事件渲染 compact 卡片（文件名/描述/图标/图片缩略图/打开动作）；seed 中事件不渲染；同一次调用不重复。
- 验收：
  - `pnpm vitest run tests/sidechat-transcript.spec.ts tests/sidechat-present-card.spec.tsx tests/sidechat-view.spec.tsx tests/locales.spec.ts`（或等价 locale 一致性测试）通过；新增 mapping/DOM 用例（含 failed present、event-first 去重、event-only、同 callId 二次事件、seed cut、row reuse、malformed files）在旧实现上失败（Red）。
  - 浏览器验证：Side Chat 显示 present 卡片且点击可打开文件（截图证据）。
- 状态：`- [x]`

**D4 — 一次性测量与验证**
- 可观察结果：一次完整验证运行覆盖 D1–D3 的单元/jsdom、全量测试、类型、lint、build、浏览器 UI 与性能测量；记录命令与结果。
- 验收（同一分支、同一轮执行）：
  - `pnpm run test`（全量；唯一允许的既有失败是本地 git 2.34.1 的 `tests/git.spec.ts` 环境用例，需在报告中标注；CI 覆盖真实环境）。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run build` 全部通过。
  - 浏览器：第二实例（隔离 `DSH_HOME` + 独立 session DB）或 plugin-mount lane；打开含本地图片 + present 卡片的 Side Chat，记录截图/DOM 证据。
  - 性能：同一 jsdom 测量脚本在最终分支记录 50/100/200 行 push/keystroke，与审计基线对比。
- 状态：`- [x]`

### 明确非目标（Out of scope）

- image/file **content block**（assistant/tool-result/legacy user）与 attachment loader：需要新的会话内授权 attachment 路由，另案。
- Side Chat composer 的图片粘贴/上传/附件输入：独立功能。
- fileMentions、reasoning body Markdown、max-tokens/cancelled/`llm/retry` 行。
- 长 transcript 窗口化/虚拟化、live payload 游标。
- 宿主仓库修改、生产部署/重启、上游 PR（需 owner 单独批准）。

### 已确认约束

- 基线分支 `upstream/dev`（PR #1035 已合入）；单 PR（spec 默认），分支名 `fix/sidechat-render-parity`。
- 仅插件仓库改动；§C4 的兼容/安全约束。
- 前端变更必须浏览器验证（不能只靠 jsdom/代码审查）。
- 测试不得用真实计时作为 CI gate；计时数字只作交付证据，确定性 gate 用 labels 引用/render-count。
- 不硬编码 UI 文案；locale 全量覆盖。
- 不在上游 PR/issue 发评论；上游 PR 与生产动作需 owner 批准。

### 关键决策

- **present 卡片插件侧实现**，不复用宿主 `ui-deliverables`：后者不是插件 peer，且 `PresentRow`/`Deliverables` 依赖 host chat 的 slot/chat-node owner 与 image loader，接入成本高于自绘 compact 卡片。
- **图片采用 source rewrite**（复用 `rewriteLocalImageUrls`）而非 `pathImages` prop：现有 helper 已处理相对/绝对/reference/masking，且产出绝对 `/sidebar/file` URL，无需给共享 `MarkdownText` 传新词汇；prose 以 cwd 为 base。
- **labels 按值缓存**（不动调用点、惠及所有 markdown 面），而不是把 labels 提升到每个调用方。
- **streaming 依据行的 settled 状态**：只有未 settled 的 assistant live 行传 true；settled/静态行保持 false。
- **一次性测量**：确定性测试 + 一次浏览器 e2e + 一次性能测量，都在最终分支同一轮完成，不拆多轮。

## 上下文层（volatile snapshot）

**快照于 `f418302`（upstream/dev，2026-10-22）**，声明会过时；执行前重新核对代码与依赖。

### 基线与工作区

- 插件仓库：本仓库检出；worktree 位于仓库根的 `.worktrees/sidechat-render`，分支 `fix/sidechat-render-parity`，基于 `f418302`（PR #1035 已合入）。
- 宿主：独立检出的 DSH 0.2.1-rc.2 线（不在本仓库内）；插件 peer 基线 `^0.2.1-rc.1`。
- 依赖：worktree 已 `pnpm install --frozen-lockfile`（0.2.1-rc.1 devDeps；注意主 checkout 的 node_modules 是旧的 0.1.7-rc.1）。
- 审计证据：2026-10-22 的只读能力矩阵与性能基线由维护者留档；本 spec 的验证证据见文末。

### 当前实现证据（file:line 快照）

- 本地图片：`src/client/markdown-labels.tsx:37-52`（无 pathImages）；`src/client/SideChatView.tsx:1254`（provider 无 fileImages）；宿主 `ui-primitives/src/markdown/render.tsx:103-108,630-646`（非 http(s) → alt）；`src/client/markdown-images.ts:102-139`（已有 rewrite，仅编辑器预览用）；`src/client/use-markdown-surface.ts:125-128`（rewrite 仅链接）；`src/client/markdown-navigation.ts:336-339`（要求 image rewrite 先行）。
- content block 丢弃：`src/client/sidechat-transcript.ts:110-121`（blockText 只 text）、`:442-468`（user）、`:515-525`（assistant）、`:163-190`（tool result）；主聊天 image 路径 `ui-chat/src/client/chat/MessageItem.tsx:20-40`、`UserContent.tsx:22-45`、`AssistantMarkdown.tsx:132-158`、`ui-chat/src/client/apply.ts:274-277`。
- present：宿主 `packages/client/ui-deliverables/src/client/index.ts:83`（`tool.call.toolview` key `present` → `PresentRow`）、`:106-110`（turn-tail deliverables）；插件 `sidechat-transcript.ts:218-302`（callCard/resultCard 仅 bash/edit/write/read）、`SideChatView.tsx:428-467`（toolCardBody）、`sidechat-transcript.ts:402-580`（无 `deliverables/presented` case）。
- 性能：`src/client/markdown-labels.tsx:37-52`（每次新嵌套 labels）；`SideChatView.tsx:636`（composer state 与 rows 同组件）、`:1255`（rows.map 无 memo 边界）、`:890-910`（rows useMemo）；宿主 `ui-primitives/src/markdown/MarkdownText.tsx:174-196`（memo + useMemo deps labels）；`src/client/sidechat-push.ts:29-31`（250ms/60ms 合并）；主聊天 mounted-window `ui-chat/src/client/chat/fork/mounted-window.ts`。

### 代码地图（供执行者核对）

- Side Chat：`src/client/SideChatView.tsx`（renderRow、toolCardBody、composer、rows）、`src/client/sidechat-transcript.ts`（transcriptRows、blockText、cards）、`src/client/markdown-labels.tsx`、`src/client/markdown-images.ts`、`src/client/use-markdown-surface.ts`、`src/client/markdown-navigation.ts`。
- 媒体/打开：`src/index.ts`/`src/sidechat-routes.ts` 的 `/sidebar/file` 与 `openSidebarFile`（`src/client/sidebar-file.ts`）；`src/client/api.ts` 的 hostRouteUrl/mediaUrl。
- 测试：`tests/sidechat-view.spec.tsx`、`tests/sidechat-transcript.spec.ts`、`tests/markdown-images.spec.ts`、`tests/markdown-crlf.spec.ts`、`tests/markdown-copy-labels.spec.tsx`、`tests/test-utils.ts`、locale 测试（`rg -l "locale" tests`）。
- 颜色/布局：`SideChatView.module.css`；工具行/卡片沿用现有 `css.sidechatRow*`。
- 构建/门禁：`package.json` scripts（`test`/`typecheck`/`lint`/`build`/`test:mount`）；CI `.github/workflows/ci.yml` 的 plugin-mount lane。

### 探索笔记

- `exploration.md`（同目录）：根因、测试 harness 细节、性能基线数字。

### 风险与回归基线

- labels 缓存必须按值且**有界**；locale 数量有限，键为五个 label 值拼接。
- streaming 与 labels 缓存有依赖：streaming 模式依赖 labels 稳定；只加 streaming 不加缓存会回退到全量解析。
- 图片 rewrite 与链接 rewrite 顺序：image 先行；代码区域 masking 必须保留；CRLF/byte parity 由既有 `markdown-crlf.spec.ts` 覆盖。
- present 事件可能先于/后于 call 到达；seed 中事件必须过滤（现有 `threadOwnLogEvents` 已切 seed；transcript 再按 `seedEnd` 过滤）。
- locale 新增 key 必须全量；否则 locale 一致性测试失败。
- 浏览器 e2e 需要第二实例/隔离 DB；禁止触碰生产 3080 进程/profile。

## 验证证据（2026-10-22，worktree 分支 `fix/sidechat-render-parity`）

- **聚焦（review 修复后重跑）**：`tests/sidechat-transcript.spec.ts`、`tests/markdown-images.spec.ts`、`tests/sidechat-present-card.spec.tsx`、`tests/sidechat-markdown-labels.spec.tsx`、`tests/sidechat-markdown-images.spec.tsx`、`tests/markdown-crlf.spec.ts`、`tests/sidechat-view.spec.tsx`、`tests/locales.spec.ts` 共 8 files / 124 tests 全绿；`tsc --noEmit`、`eslint .` 干净。
- **RED 证据（review 修复）**：M1a/M1b 的 2 个 mapping 用例在旧 `sidechat-transcript.ts` 上失败；N7 的 5 个 angle/title 用例在旧 `markdown-images.ts` 上失败；修复后全部转绿。
- **审阅驱动回归（2026-10-22 review）**：
  - M1a：失败的 `present`（`data.error`）不再显示成功卡片，替换为通用 failed tool 行并保留错误文本；成功结果仍只保留卡片、结果行不渲染。
  - M1b：`deliverables/presented` 先于 `tool/call` 时只保留一张事件权威卡片；call-first 亦为一张且事件数据覆盖调用参数；event-only、同 callId 二次事件、seed cut、row reuse、malformed/empty files 均有 mapping 覆盖。
  - N7：inline angle destination（含空格路径）与 `"…"`/`'…'` title 保留；reference definition 的 `<…>` 与 title 保留；remote angle destination 不动；prose rewrite 覆盖 cwd 缺省、尾分隔符、Windows cwd、reference image 与 image-then-link 组合。
  - N1：卡片按钮 accessible name 含可见 description，`title` 为 cwd 解析后的绝对路径（DOM 断言）；S1：卡片边框改用宿主 `--dsw-alias-border-l1`。
- **全量（review 修复轮）**：`vitest run` 223 文件通过 / 1 失败（唯一失败为 `tests/git.spec.ts` 的 2.34.1 环境用例，基线同失败）/ 17 跳过；2717 tests 通过。
- **构建（`909f536` 提交轮 + review 修复轮）**：`pnpm run build` + `pnpm pack` 均成功（tarball 4.6 MB）。
- **浏览器 e2e（`909f536` 提交轮；第二实例，宿主 0.2.1-rc.2，独立 DSH_HOME + JSONL session store + 确定性 Messages mock）**：
  - `present` 卡片渲染 `Present files` + `README.md`/`Render-check document` + `running-whale@2x.png`/`Render-check image`，图片缩略图 28×28；
  - assistant 文本的本地 Markdown 图片渲染为 `/sidebar/file` 的 `<img>`（alt `whale`，`naturalWidth=28`）；
  - 点击卡片文件在插件编辑器打开 `README.md`；
  - 浏览器截图由维护者留档（仓库外）；确定性 mock 脚本见验收记录。
- **浏览器复验（review 修复，宿主 app 重建后）**：生产 GUI 的 Side Chat 渲染出 `Present files` 卡片，按钮 aria 带描述（`Open README.md: …`、`Open running-whale@2x.png: …`），review 修复后的边框/aria 已确认生效；此前旧标签页/旧 app client 构建的缓存阻塞已定位并解除。
- **性能（jsdom，真实 `SideChatView`）**：`909f536` 200 组件 push 3.60 / keystroke 5.37 ms；review 修复后（`1904ed8`）200 组件 push 5.38 / keystroke 3.18 ms（单次测量噪声；审计基线 101.7–117.8 / 105.1–117.2 ms，约 19–37×）；100 组件 2.19 / 1.96 ms、50 组件 2.72 / 1.63 ms；隔离 100 行 0.71 ms、200 行 1.39 ms；labels 引用相等；未变化行的 `MarkdownText` 执行数为 0；8 KB 增长行 22.0 ms（settled）→ 1.01 ms（streaming）。review 修复仅改图片正则/卡片行，未动 labels/streaming 热路径；200 组件数字含单次噪声。
- **plugin-mount lane（本地，非基线宿主 0.2.1-rc.2）**：12 passed / 3 skipped / 1 failed；失败点是 `tests/e2e/mount.e2e.ts` 的 `hostRpc session.list` 参数描述符（0.2.1-rc.2 要求 `request`，仓库 CI 基线 0.2.1-rc.1），不是插件渲染；sidechat tab/view 在 sweep 与 perf e2e 中已加载。CI 基线宿主上该 lane 不受影响。

### 交付状态

- D1 `- [x]`；D2 `- [x]`；D3 `- [x]`；D4 `- [x]`（PR #1044 已开；合并/部署为 owner 门）。
- Review 修复（M1a/M1b/S1/S2/S3/N1–N5/N7）`- [x]`；N6 为 spec 一致的设计说明（绝对本地图片目的地走 session-scoped `/sidebar/file`），无代码改动。

### 待解决

- 无阻塞；review 修复的浏览器边框/aria 已在宿主 app 重建后的生产 GUI 复验通过；上游 PR #1044 已开，合并/部署为 owner 门。
