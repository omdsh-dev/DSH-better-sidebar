# @ 引用插入不再整份重写草稿（chip 被展平成两段文本）

> 现场：文件树的 @ 引用按钮（`src/client/reference-in-chat.ts` → `src/client/conversation-draft.ts`）
> 与编辑器选区弹窗（`src/client/TextEditor.tsx` → `appendToDraft`）。
> 修复：`fix/chip-safe-mention-insert`（`3757f75c` 修复 + `7779b386` 真机断言）。

## 用户可见症状

1. 从 DSH 自己的 `@` 菜单选出来的引用是**原子 chip**（一个整体，glyph + 文件名）。
2. 用插件的 @ 引用按钮连续插两次之后，**先插的那些 chip 变成了纯文本**：composer 里显示为
   `@notes/`（蓝色、宿主 folder 装饰）+ `ENV.md`（无色、普通文本）——也就是"一个 mention 被解析成两段"。
3. 顺序上看起来像"第二次 @ 把第一次改坏了"：空草稿时第一次插入正常（chip），此后每一次插入都会把
   已存在的 chip 全部展平。

## 根因（两条叠加）

### 1. 写入用了 `setDraft`，而它的契约就是"移除 inline chip"

`InputState.setDraft(text)` 的文档原文是 **"Replace the whole draft with plain text, removing inline
reference chips"**（`@deepseek-ai/dsh-client-ui-conversation` 的 `SessionInput` 接口）；实现是
`DraftEditorRuntime.setDraft`：`root.clear()` 之后逐行 append 纯文本。于是草稿里每个 chip 都退化成
它的 clipboard 文本（`@notes/ENV.md`），引用身份丢失；宿主再用自己的文本扫描（`FOLDER_REF_RE`）装饰
到最后一个 `/`，剩下的文件名保持无色——这就是"两段式"的观感。

**`setDraft` 是插件当时唯一的写面**（`conversation.input.for(actx)` 只暴露 `state` 与 `setDraft`），
所以 `appendToDraft` 只能整串重写。

### 2. 结构化插入的 span 用错了投影，导致每一次插入都回退到上面那条路

`slash/input-insert-reference` 的 `span` 是 **detect 坐标**（每个 chip 恰好一个 U+FFFC），而
`InputState.draft` 是**剪贴板投影**（chip 展开成 mention 文本）。旧代码传
`{start: draft.length, end: draft.length}`：草稿里只要已有一个 chip，`span.end` 就大于
`detectLength`，宿主的 `selectSpan` 直接判非法 → `insertFileReference` 返回 false →
`insertWorkspaceReference` 回退到 `appendToDraft` → 第 1 条发生。

空草稿（无 chip）时两个长度相等，插入成功——这解释了"第一次正常、第二次开始坏"。

## 修复

- 两条插入都改走宿主的 scoped composer 事件，只改目标区间、不动其它节点：
  - 文件 → `slash/input-insert-reference`（宿主自己的 `@` picker 用的同一条）；
  - 目录 / 选择区引用 → `slash/input-insert-text`（宿主自己的目录钻取用的同一条）。
- 新增 `detectLength` / `clipboardToDetect`：用 `InputState.occurrences` 把剪贴板坐标折进 detect 坐标
  （落在 chip 内部的位置吸附到该 chip 之前）。`occurrences` 缺失时折叠退化为恒等，不会越界写。
- 事件没人处理（或草稿没有 `draftRev`）时返回 false 并保持草稿不动；**不再有任何"整份重写"的兜底**。
  旧版本在这类变化下会静默损坏草稿，新版本的失败模式是"什么都不插 + 一条 warn"。
- 删掉 `placeComposerCaretAfterInsert`：事件插入后由宿主落 caret；而 0.1.7+ 的 composer 是 Lexical
  contenteditable，`probeComposerCaret` 找的 `<textarea>` 恒不存在 → 探测恒 null → 插入落在草稿末尾
  （与旧代码在 0.2.x 上的实际行为一致），那套 caret 补偿已是死代码。

## 验证

- 单测：`tests/conversation-draft.spec.ts` 的假宿主同时模拟"detect 坐标折叠"与"越界即拒绝"，
  新增 `detectLength` / `clipboardToDetect` 的边界用例，以及"草稿里已有一个 chip 时再插一个 chip：
  事件 span 必须是 detect 坐标、旧 occurrence 仍在、`setDraft` 从未被调用"。
  `tests/reference-in-chat.spec.ts` / `tests/sidebar-workspace-reference.spec.tsx` 改为断言事件载荷
  并断言 `setDraft` 不被调用。
- 真机：`tests/e2e/mount.e2e.ts` 新增
  `the explorer @-reference button keeps earlier chips (no whole-draft rewrite)`——
  真实 composer 里经文件树点两次文件 @ 再点一次目录 @，必须恰好两个 `[data-composer-chip]`、
  第一个 chip 仍带自己的文件名、出现一个 `[data-composer-text-ref]`（目录那条是纯文本，按设计），
  且没有 page error。旧实现第二次点击就会把第一个 chip 展平，前三条断言都会红。
  本机跑法（沙箱里 npm 缓存不可写时需改道）：
  `npm_config_cache=/tmp/dsh-npm-cache pnpm test:mount --grep 'keeps earlier chips'`（钉版 0.2.0-rc.2，实测 3.4 s 通过）。

## 明确不修（宿主行为，插件无能为力）

1. **手打/粘贴的 `@dir/file.md` 永远只装饰到最后一个 `/`**：`TEXT_REF_RE` 的 `@name` 分支需要触发源
   提供 `lexicon`，而唯一的 `@` 源（`ui-reference`）没有实现该钩子——所以文本 mention 只能是
   "`@dir/` + 无装饰文件名"两段，与菜单选出来的 chip 观感不同。
2. **贪婪跨空白**：`FOLDER_REF_RE` 的 `[^\s"]+` 在无空格时会把相邻两个 mention 并成**一个** token
   （`@notes/archive/README.md@notes/` 整段高亮），第二个 mention 的文件名失去装饰。
3. **无空格连打两个 `@…/` 会让字符重排**（更严重）：实测输入 `@notes/ENV.md@notes/STATE.md` 会落成
   `@notes/STATE.mdENV.md@notes/`，`@notes/archive/README.md@notes/STATE.md` 落成
   `@notes/README.md@notes/STATE.mdarchive/`——localStorage 里的 `draft.text` 已是乱序，属文档内容被改写
   （怀疑点在 `ui-conversation` 的 `registerTextRefDecoration` 与 `@lexical/text` 的
   `registerLexicalTextEntity` 移植体的实体吸收/切分循环）。上游不接收 issue，故在此存档；
   遇到用户报告时先按本条解释，别再从插件侧找原因。
4. **修复前已经落库的展平草稿不会自动复原**（reference 身份已丢）：重新从菜单选一次即可。

## 后续可做

- 若上游公开 session 作用域的插入面（`captureInsertion()` + `insertText` / `insertReference`）或提供
  caret/detect 的只读访问，迁移到公开面即可，顺带能修掉"caret 探不到 → 只能往末尾插"这条；
  `src/context-types.ts` 的 `setDraft` 注释已写明届时两条路径要一起复核。
- 若上游把 `setDraft` 改成保留 chip，本模块不受影响（已不再调用它）。
