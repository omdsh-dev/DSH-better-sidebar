# 选区引用改气泡：把「添加到对话」从铺开正文改成 chip

**日期**：2026-10-24
**分支**：`feat/selection-chip-compact`（从 `dev` 切出）
**状态**：已实施，门禁见 §5

---

## 1. 背景

侧栏文本查看器（markdown 预览 + 兜底代码查看器）选中文字后点浮层的「添加到对话」，draft 里插进去的是一整段**围栏代码块**（info line = `相对路径:起止行`，正文 = 选中文字）。

单次引用没问题；连续引用几段就把输入框铺满，用户真正要写的那句话被挤没影了。DSH 自己的 `@file` 引用在同一个输入框里却是**一个紧凑气泡**（图标 + 文件名）。这次的诉求就是把这个反差抹平：**引用只要一个标识，正文交给模型**。

## 2. 机制（为什么插件侧就能做到）

宿主 composer 是 Lexical contenteditable，引用条目是 `ReferenceChipNode`。它有三个可以分开的字段：

| 字段 | 作用 |
|---|---|
| `label` | 气泡上显示的字 |
| `ref` | 发送时序列化给模型的正文（`source: 'reference'` 的 codec 是恒等） |
| `clipboardText` | 草稿串里占位的那段文本 |

所以「显示短、发送长」本来就是宿主支持的能力，插件只需按这个形状发插入请求。

插入走宿主 facade 上的 `SessionInput.insertReference(ref, span)`——native `@` 选择器的监听器就是转调它，相位与 revision 守卫都在宿主里。宿主 `SessionInput` 上没有纯文本方法（`insertText` 在 InputBar 私有的 `InputActions` 上），所以「往已有气泡的草稿追加纯文本」只能发 `slash/input-insert-text` 事件。

## 3. 关键坑：两套坐标系

宿主对输入框维护两个投影：

| 投影 | 一个气泡占多长 | 谁在用 |
|---|---|---|
| clipboard（`InputState.draft`、`occurrences`） | 整个 `clipboardText` | 插件：读草稿串、算位置 |
| detect（`detectText`） | **1 个字符** `U+FFFC` | 宿主：所有插入事件的 `span` |

草稿为空时两套坐标重合，第一次插入成功；草稿里一旦有气泡，从草稿偏移直接算出的 `span` 必然越界，宿主拒绝（`applied = false`），**第二次插入静默失败**。

修复：`foldClipboardOffset` 按 `occurrences` 把草稿偏移折到 detect 偏移。唯一有意的偏离——偏移正好落在气泡**起点**时，返回气泡**之前**的位置（宿主自己的同名函数会把它读成「在气泡内部」而返回尾边）。

**命令气泡是第二个坑**：`/goal ` 这类命令 chip 在 detect 投影里同样只占 1 个字符，但它**不在** `occurrences` 里（宿主只收 `ReferenceChipNode`）。所以折叠前要先按 `claim.token` 把命令前缀摘掉，折完再加回 1。`appendOffset` 做这件事。

## 4. 改动

| 文件 | 变更 |
|---|---|
| `src/client/conversation-draft.ts` | 新增 `foldClipboardOffset`、`appendOffset`、`insertDraftReference`、`DraftReference`；`appendToDraft` 在草稿有气泡或处于 `claimed` 时改走 `slash/input-insert-text` |
| `src/client/selection-payload.ts` | `buildSelectionInsert` 返回 `{ label, text }`（原返回单个字符串） |
| `src/client/selection-popup.ts` | 三个导出接口与 hook 泛型化，默认 `T = string`，字符串调用方零改动 |
| `src/client/TextEditor.tsx` | `useSelectionPopup<DraftReference>`；commit 走 `insertReferenceOrText` |
| `src/context-types.ts` | `SidebarSessionInput` 补 `insertReference`、快照补 `occurrences` / `phase` / `claim` |

**为什么 `appendToDraft` 也要改**：`setDraft` 会 `root.clear()` 重建纯文本文档，把草稿里**每一个**气泡碾平。命令气泡更糟——碾平后 claim 丢失，宿主把 `/goal` 读成普通文字并取消命令。

**为什么气泡插入前要先占一个分隔位**：宿主的 `insertReference` 只在气泡**之后**补空格（`client.js:14758`），之前不补。草稿是 `hello` 时直接插会读成 `hello[chip]`。

**为什么 `clipboardText` 取短形态**：它是草稿串里对外可见的投影（复制、纯文本视图都读它），整段围栏正文放在那里就是这次要消灭的铺满输入框。注意这**不是**为了兼容重挂载——宿主持久化的是 `{text, references}`，气泡能正常恢复。

**为什么选区气泡不传 `appearance`**：宿主把 `appearance: 'file'` 的气泡标记成可点开，点击会把 `ref` 当路径交给文件打开器。选区气泡的 `ref` 是围栏正文，不是路径。

## 5. 验证

- `pnpm typecheck` / `pnpm lint` / `pnpm build` 通过。
- `pnpm test`：本机 4 例符号链接 `EPERM` 失败（Windows 权限差异，已在干净 `dev` 上复现同样 4 例），其余全绿。
- 本改动相关：`tests/conversation-draft.spec.ts` 32 passed、`tests/selection-payload.spec.ts` 16 passed、`tests/selection-popup.spec.tsx` 8 passed。
- 真机 mount lane：在 markdown 预览里选中一行、点提交按钮，断言 composer 里出现 `diagram.md:` 气泡、草稿不含三反引号围栏、气泡不与前一个词粘连、且气泡不带 `openable` 标记。

## 6. 已知边界

- 气泡的 `clipboardText` 取 `label`（文件引用另取 `@path`），`ref` 存发送用的完整正文，宿主提交前 `trim`。
- 插入一律追加在文档末尾：宿主 composer 是 contenteditable，这个面上没有光标 API。
- 冻结期（`adjudicating` / `submitting`）直接拒绝，不回退——回退会绕过宿主的相位守卫。
