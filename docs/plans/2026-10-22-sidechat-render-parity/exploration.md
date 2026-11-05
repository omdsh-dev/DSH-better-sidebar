# 探索笔记 — Side Chat 渲染对齐与 Markdown 性能

快照于 `f418302`（2026-10-22），会过时；执行前按 spec 的代码地图重新核对。

## 审计来源

- 2026-10-22 的只读能力矩阵与性能基线由维护者留档；本文件只保留与实现直接相关的结论。

## 差距摘要

| 类别 | 主 Session | Side Chat | 结论 |
| --- | --- | --- | --- |
| 本地 Markdown 图片 | `<img>` via `pathImages`/`fileImages` | alt text | 修（D2） |
| 远程图片 | `<img>` + lightbox | `<img>` 无 lightbox | 保持 |
| present/deliverables | toolview key `present` + turn-tail 卡 | 通用 tool 行 | 修（D3） |
| assistant/tool-result image block | gallery + attachment loader | reducer 丢弃 | 非目标（另案） |
| fileMentions、reasoning Markdown、max-tokens/cancel/retry | 有 | 无/纯文本 | 非目标 |
| GFM、代码卡、表格、KaTeX、footnotes、raw HTML、mermaid | 对齐 | 对齐 | 不动 |
| 性能 | windowed、labels memo | 无 windowing、labels 不稳定、无 streaming | 修（D1）；windowing 另案 |

**设计事实**：Side Chat 只显示 thread 自己的对话；继承父日志在 `session/end-seed` 处切掉。父 Session 的图片附件本来就不在 Side Chat 出现；composer 是纯 textarea，不支持图片输入。

## 测试 harness（sidechat-view）

`tests/sidechat-view.spec.tsx` 已提供完整的真实组件 harness：
- `FakeLocale`（zh）、`EVENTS`（thread 自己的事件：user/turn/tool/assistant/turn-end）、`makeStore`/`makeConnection`、`FakeSocket`（阻止真实 WebSocket）、fetch stub（`sidechat.events`/`info` 等）。
- 渲染：`renderRoot(createElement(SideChatView, ...))`；可直接在 `EVENTS` 里加 `tool/call` + `deliverables/presented`/local-image markdown 事件，断言 DOM。
- 现有覆盖：bash TerminalBlock + turnSummary；disconnect banner；archive；queue/echo/model picker。
- 相关：`tests/sidechat-transcript.spec.ts`（纯 mapping）、`tests/markdown-images.spec.ts`（`rewriteLocalImageUrls`）、`tests/markdown-crlf.spec.ts`（image+link rewrite 的 CRLF byte parity）、`tests/markdown-copy-labels.spec.tsx`（labels chrome）、`tests/test-utils.ts`（`renderRoot`/act）。
- locale 一致性：`rg -l "locale" tests`（如 `tests/locales*.spec.ts`）钉住 key 覆盖；新增 present 卡片文案必须全量。

## 性能基线（jsdom，2026-10-22 审计）

- 真实 `SideChatView`（100 turns = 200 markdown 组件）：
  - streaming push **101.7–117.8 ms** → labels 缓存原型 **3.3–3.8 ms**（~27–32×）
  - composer keystroke **105.1–117.2 ms** → **3.5–3.9 ms**
  - 100 组件 push 62.4 → 2.0 ms
  - mount：100 组件 126 ms render/248 ms wall；200 组件 219–244 ms/428–470 ms；labels 缓存不改善
- 隔离 harness（100% 长 prose 行）：100 行 95.4→1.10 ms（~87×）；200 行 190.6→1.36 ms（~140×）；复现 v0.26 的 96.8 ms。
- 未传 `streaming` 的增长行：8 KB 时 15.8 ms/update → 0.92 ms（streaming + stable labels，17×）；labels 新鲜时 14.8 ms。
- live payload：236 B/chunk；1000 chunks 236 KB；60 s 回答约 34 MB 累计重发（带宽/GC，非当前卡顿主因）。
- 宿主主聊天 mounted-window：50/150/1000 行；Side Chat 无窗口化（另案）。

## 关键代码位置（快照，执行前复核）

- `src/client/markdown-labels.tsx`：`markdownTextProps`（labels 对象；所有调用点）。
- `src/client/SideChatView.tsx`：`renderRow`（MarkdownText）、`toolCardBody`、`rows`（useMemo）、composer、`MarkdownDelegateProvider`、`useMarkdownSurface`。
- `src/client/sidechat-transcript.ts`：`blockText`、`transcriptRows`、`callCard`/`resultCard`/`SidechatToolCard`、事件 switch。
- `src/client/markdown-images.ts`：`rewriteLocalImageUrls`、`resolveLocalMediaDest`、`normalizeLocalPath`。
- `src/client/use-markdown-surface.ts`：`rewrite`（link-only）、`openFile`；`src/client/markdown-navigation.ts`（要求 image 先行）。
- `src/client/sidebar-file.ts`：`openSidebarFile`（插件自己的文件打开路径）。
- `/sidebar/file` 媒体路由：`src/index.ts`（约 1611-1669）/`src/sidechat-routes.ts`（会话 scoped）。
- 主聊天 present：`packages/client/ui-deliverables/src/client/index.ts:83,106-110`（toolview key `present` → `PresentRow`；turn-tail deliverables）、`PresentedFileCard.tsx`、`Deliverables.tsx`；`deliverables/presented` 事件 `{turn, callId, files:[{path, description?}]}`（`packages/deliverables/tool-present`）。
- 主聊天 image：`ui-chat/src/client/chat/AssistantMarkdown.tsx:132-158`、`MessageItem.tsx:20-40`、`UserContent.tsx:22-45`；loader `ui-chat/src/client/apply.ts:274-277`。
- 宿主 MarkdownText：`ui-primitives/src/markdown/MarkdownText.tsx:174-196`（memo；labels/pathImages/fileMentions 词汇）；`render.tsx:103-108,630-646`（非 http(s) 图片 → alt）。

## 实现注意

- 图片 rewrite：prose base 用 session cwd；先 mask 代码区域；绝对 `/sidebar/file` URL（`hostRouteUrl`）以保留反向代理前缀；不要改宿主渲染器。
- present 卡片：数据来自 `deliverables/presented`（优先，绝对 path）或调用 args（相对 cwd）；按 callId 去重；seed 事件过滤；图片缩略图走 `/sidebar/file`；点击 `openSidebarFile`；21 个 locale 加 key。
- labels 缓存：模块级 Map，键为 `copyLabel/copiedLabel/codeLabel/wrapLabel/unwrapLabel` 值拼接；有界（locale 有限）；不得用对象身份 WeakMap（调用方新建字面量）。
- streaming：未 settled assistant 行 true，settled/静态 false；streaming 模式依赖 labels 稳定。
- 测试：确定性断言（labels 引用、render-count、DOM）；计时只作报告证据，不作为 CI gate。全量套件唯一允许的既有失败是本地 git 2.34.1 的 `tests/git.spec.ts` 环境用例（CI 覆盖真实环境）。
- 浏览器：第二实例需独立 `DSH_HOME` 与 session DB；禁止触碰生产 3080 的进程/profile；plugin-mount lane 可复用。
