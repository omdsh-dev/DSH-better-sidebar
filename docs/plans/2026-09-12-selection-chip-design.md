# 选区引用胶囊：把「添加到对话」从铺开正文改成 chip

日期：2026-09-12　分支：`feat/selection-chip`

## 背景

侧边栏文本查看器（markdown 预览 + catch-all 代码查看器）选中文字后点浮层的「添加到对话」，draft 里插进去的是一段**围栏代码块**（info line = `相对路径:起止行`，正文 = 选中文字）。

单次引用没问题；连续引用几段就出问题：正文把输入框铺满，用户真正要写的那句话被挤没影了。而 DSH 自己的 `@file` 引用在同一个输入框里是**一个紧凑 chip**（图标 + 文件名）——同一块屏幕上，两种引用语气的反差就是这次的诉求：**引用只要一个标识，正文交给模型**。

目标：选区的呈现改用 chip（label = `相对路径:起止行`），**发给模型的正文一字不减**，插入位置契约（#425）不回退。

## 现状与机制（为什么插件侧就能做到）

| 事实 | 位置 | 结论 |
|---|---|---|
| 输入框是宿主的 Lexical contenteditable composer，引用条目是 `ReferenceChipNode`（原子 decorator 节点） | `dsh-client-ui-conversation` 的 `ComposerContentEditable` / `chip-node` | chip 是**真 DOM 元素**，插件只需请求宿主插入 |
| chip 显示 `label`，草稿串里占 `clipboardText`，发送时按 occurrence 的 `span` 换回 `serializeReference(source, ref)` | `sinkSerialized`（同包 `client.js`） | **显示**与**模型文本**是两个字段，可以不同 |
| 宿主 `reference` source 的 codec 是恒等：`{ clipboardText: ref => ref, serialize: ref => ref }` | `dsh-client-ui-reference` | 复用该 source 即可让 chip 原样携带任意文本 |
| 插件的文件树 @ 按钮已经在用宿主事件 `slash/input-insert-reference` | `src/client/conversation-draft.ts` `insertFileReference` | 无需新通道、无需碰 `inputTriggers` |
| `ReferenceChipNode.__invalid` 只由 `setInvalid()` 置位，而全 `@deepseek-ai/*` 包内**没有任何调用点** | grep `setInvalid(` = 定义 1 处 + `.d.ts` 1 处 | 合成的 ref 不会被判非法（不会打红标） |

## 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 复用 `slash/input-insert-reference`（`source: 'reference'`），不注册插件自有 trigger source | 与文件树 @ 按钮同一条已上线路径；注册 source 要经宿主内部 `inputTriggers` 注册表，零收益 |
| 2 | chip label = `相对路径:起止行`（与围栏 info line 同串）；超过上限时 label 与正文同为该行 | 与 DSH 原生文件 chip 同款观感；多段引用可区分来源；**不需要**给 21 份词典加新词条（`locales.spec` 强制 key 集相等） |
| 3 | chip 的 `clipboardText` = `ref` = 改动前那段围栏块（含 splice 的连接空格） | 草稿串与改动前**逐字相同**，序列化出的 prompt 随之相同（宿主最后还会 `trim`）——这是一次纯显示形态变更 |
| 4 | 保留 `SELECTION_LIMIT = 500` 的超限语义（超限只引用位置、不带正文） | 上限的成本理由是上下文 token，与显示形态无关 |
| 5 | 插入位置继续走 `probeComposerCaret`（#425 契约）：span = 光标/活动选区，探测不到则末尾追加 | 不退化成「永远追加到末尾」 |
| 6 | chip 路径**不**调用 `placeComposerCaretAfterInsert` | 宿主事件本身 span-CAS 并接管光标；DOM 光标恢复只服务 `setDraft` 那条路径 |
| 7 | chip 插入失败（无 `draftRev` / 会话 scope 或 conversation 服务缺失）时回退 `appendToDraft` 纯文本 | 降级即改动前行为，任何宿主上都不会丢内容 |
| 8 | `useSelectionPopup` 泛型化，默认 `T = string` | 浮层只负责「搬运一个 payload」，字符串调用方（既有测试）零改动 |

## 改动清单（子系统级）

| 子系统 | 文件 | 变更 |
|---|---|---|
| 载荷 | `src/client/selection-payload.ts` | `buildSelectionInsert` 返回 `SelectionInsert { label, text }`（原返回单个字符串）；`headerOf` / `linesOfSelection` / `SELECTION_LIMIT` 不变 |
| 插入 | `src/client/conversation-draft.ts` | 抽出 `composerInput` / `emitChip` 两个模块内助手；新增 `insertSelectionReference` 与纯函数 `chipTextAt`（插入片段连同连接空格一起取自 `spliceInsert`，不再复述空白规则）；`insertFileReference` 改走同一助手，行为不变（仍末尾追加）。`spliceInsert` 现在同时回报「插入了什么」 |
| 浮层 | `src/client/selection-popup.ts` | `SelectionPopup<T>` / `SelectionPopupOptions<T>` / `SelectionPopupControls<T>` / `useSelectionPopup<T = string>` |
| 接线 | `src/client/TextEditor.tsx` | `useSelectionPopup<SelectionInsert>`；commit 先试 chip，失败回退 `appendToDraft(insert.text)` |
| 测试 | `tests/selection-payload.spec.ts` | 载荷形状（含超限时 label 与正文同为路径行） |
| 测试 | `tests/conversation-draft.spec.ts` | `chipTextAt`（连接空格、选中区替换、未知光标、**拼回纯文本等价表**）+ `insertSelectionReference` 7 例（事件形状 / 草稿与序列化文本双重等价 / 选中区替换 / 兜底追加 / 无 `draftRev` / 服务缺失 / emit 抛错） |

无 i18n、无样式、无对外 API 变更：`insertFileReference` 与 `useSelectionPopup()` 的既有调用语义原样保留。

## 已知边界

- **全空白草稿**：改动前的纯文本路径会把全空白草稿整体替换成 payload，chip 只能占住自己的 span，空白留在 chip 前面（`'   '` + chip）。宿主提交前 `trim`，模型侧无差异。
- chip 的图标是宿主 `appearance: 'file'` 的文件图形（宿主自己画的），插件不新增任何字形或颜色——皮肤契约（指南 §12 / `tests/theme.spec.ts`）不受影响。

## 验证

- `pnpm typecheck` / `pnpm lint` 通过。
- `pnpm test`（全量）：待填。
- 未跑 `pnpm test:mount`（真机挂载冒烟需要 Playwright + 全新 scratch profile，本机未跑）；CI 的 `plugin-mount` 车道覆盖。
