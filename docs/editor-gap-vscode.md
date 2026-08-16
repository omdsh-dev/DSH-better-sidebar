# Sidebar 编辑器 vs VSCode：差距分析与功能清单

> 目标：把 sidebar 里的 CodeMirror 编辑器补成接近 VSCode 的编码体验。
> 本文是**差距清单 + 优先级**，不是实现说明。基于当前 fork 源码
> (`dsh-better-sidebar`，CodeMirror 6 内核) 与 VSCode (Monaco) 的对比。

---

## 一、当前已具备（无需补）

| 能力 | 状态 |
|---|---|
| 多语言语法高亮 | ✅ 15 种语言（js/ts/jsx/tsx/json/md/py/html/css/xml/yaml/sql/java/c/cpp/rust/go/php/shell/toml/nginx/dockerfile） |
| 行号 | ✅ 默认开启（可配） |
| 撤销/重做 + 历史 | ✅ `history()` |
| Ctrl+S 保存 + 脏标记 | ✅ |
| 括号匹配 + 自动闭合 | ✅ 本次已接入 `bracketMatching()`/`closeBrackets()` |
| Enter 自动缩进 | ✅ `indentOnInput()` |
| 活动行高亮 | ✅ `highlightActiveLine()` |
| 搜索/替换 (Ctrl+F/H) | ✅ 本次已接入 `@codemirror/search` |
| 跳转行号 (Ctrl+G) | ✅ 本次已接入（prompt 输入） |
| 自动补全 (Ctrl+Space) | ✅ 本次已接入 `@codemirror/autocomplete` |
| 编辑器字体/字号/Tab宽/换行/行号 设置 | ⏳ 本次已加 prefs 字段，设置 UI 未接 |
| 多标签页 + 拆分面板 | ✅（workbench 拖拽分栏） |
| 深色/浅色主题跟随 | ✅ |
| Markdown 预览/编辑切换 | ✅ |
| 文件大纲（符号列表） | ✅ 工具栏按钮 → 函数/类/方法/标题，点击跳转 |
| 代码折叠（gutter + 快捷键） | ✅ 折叠服务 + 内置 gutter 点击（根因已修） |
| 尾部空格高亮 | ✅ 行尾空白红色高亮 |
| 括号跳转（Ctrl+Shift+\） | ✅ 跳转配对括号 |
| 语言关键字补全（Ctrl+Space） | ✅ 12 种语言保留字 + 语言自带源合并 |

---

## 二、与 VSCode 的差距（按优先级排序）

### P0 — 基本编码体验（建议先做，直接影响"能不能写代码"）

1. **Tab 键缩进行为**
   - 现状：`indentOnInput` 只在 Enter 后延续缩进；**Tab 键默认是插入制表符/跳到下一个停靠点**，没有"缩进当前行/多行"、"shift+Tab 反缩进"。
   - VSCode：Tab 缩进选中行、Shift+Tab 反缩进、自动对齐到上一个非空行的缩进。
   - 补：`indentWithTab`（@codemirror/commands 自带）+ 多行 Tab/Shift-Tab 缩进命令。

2. **自动对齐（align）**
   - 现状：没有。输入 `=`、`,` 等不会自动对齐连续赋值/参数。
   - VSCode 其实也没有"自动对齐赋值"（那是插件如 Align），但 **格式化**（shift+alt+F）和 **智能缩进** 是有的。
   - 补：接入 `indentUnit` + 语言包的缩进策略（已有基础），再加一个简单的**格式化命令**（JSON/JS 用 prettier？太大；至少提供"整理缩进"）。

3. **自动保存**
   - 现状：只有 Ctrl+S 手动保存，切文件/切 tab 不保存（脏标记会丢？切 tab 时 draft 保留但**不写盘**）。
   - VSCode：`files.autoSave`（afterDelay / onFocusChange / onWindowChange）。
   - 补：设置项 `editorAutoSave`（关 / onBlur / afterDelay:1s），用现有 `api.fsWrite` 实现，debounce 写盘。

4. **选中多行 Tab/Shift-Tab + 撤销粒度**
   - 现状：`defaultKeymap` 有部分，但没有专门的"多行缩进"命令。
   - 补：`indentSelection` / `dedentSelection`（@codemirror/commands 提供 `indentSelection` 等，或自己写）。

### P1 — 代码导航与编辑效率

5. **文件内符号/大纲（Ctrl+Shift+O）** ✅ 已实现（工具栏大纲按钮）
   - 现状：工具栏「大纲」按钮 → 下拉面板列出函数/类/方法（JS/TS 语法树）+ Markdown 标题，缩进按嵌套层级（标题按级别），点击跳转。
   - CodeMirror：`syntaxTree` + `ensureSyntaxTree`（强制完整解析，50ms 兜底），无 LSP。

6. **多光标（Ctrl+D 选下一个相同词 / Alt+Click）**
   - VSCode：Ctrl+D 加选下一个、Ctrl+U 回退、Alt+Click 任意光标。
   - CodeMirror：`selectNextOccurrence`（@codemirror/search 提供 `selectMatches`/`selectNextOccurrence`）—— 接入 keymap 即可。

7. **行操作（Ctrl+Shift+K 删行 / Alt+↑↓ 移动行 / Shift+Alt+↑↓ 复制行）**
   - CodeMirror：`deleteLine`、`moveLineUp/Down`、`copyLineUp/Down` 都在 @codemirror/commands，直接加 keymap。

8. **代码折叠（Ctrl+Shift+[ / ]）**
   - VSCode：折叠函数/块。
   - CodeMirror：`@codemirror/language` 的 `foldGutter()` + `foldCode`/`unfoldCode` 命令 —— 语言包语法树支持。中优先级，加 gutter 指示器。

9. **括号高亮跳转 / 选中括号内容** ✅ 已实现
   - `bracketMatching()` 高亮配对括号（已接入）+ `cursorMatchingBracket`（Ctrl+Shift+\）跳转配对括号（P1 完成）。

### P2 — 补全与智能

10. **语言级自动补全源** ✅ 已实现（关键字补全）
    - 现状：`autocompletion()` 框架已启用，之前无源；现为 12 种语言配了保留字表（js/ts/jsx/tsx、python、java、c/cpp、rust、go、php、sql、shell、dockerfile、nginx），与语言自带补全（如 JS 作用域补全）合并、按 label 去重。
    - 补：`lang.ts` 的 `KEYWORDS_BY_LANGUAGE` + TextEditor 的 override 组合源。真正的语义补全需要 LSP（见 P3）。

11. **LLM 辅助补全 / 续写**
    - VSCode：Copilot 风格。sidebar 编辑器是 CodeMirror，可做：
      - 选中代码 → "让模型解释/补全" 按钮（走 dsh 的模型，需要 Host 回调）。
      - 输入停顿 → 触发续写建议（类似 Copilot ghost text，CodeMirror 有 `@codemirror/view` 的 decoration 可做幽灵文本）。
    - 这是差异化亮点，但工作量大，放 P2 末。

### P3 — 重型（可选，慎重）

12. **LSP 集成（真正的智能感知：跳转定义/引用、错误提示、重命名）**
    - VSCode 的灵魂。CodeMirror 有 `@codemirror/lsp`（未官方）或自接 LSP over WebSocket。
    - 成本：需要语言服务器 + dsh Host 侧进程管理。**建议不做**，或用轻量替代（语法树大纲 + 关键字补全）。

13. **Monaco 替换 CodeMirror**
    - 前文已定论：Monaco 体积大（~10-20MB）、与懒加载 chunk 架构冲突。**不换**。

### P4 — 设置与体验细节

14. **编辑器设置 UI 接入**（已有 prefs 字段，缺设置面板行）
    - 字体、字号、Tab 宽、换行开关、行号开关、自动保存模式 —— 在 SideCard 设置页加 5-6 行（复用 terminal 设置的模式）。

15. **缩进引导线（indentation guides）**
    - CodeMirror：`indentGuide()`（@codemirror/language 有 `indentOnInput` 但引导线要 `@codemirror/view` 的层或 `indentUnit` + CSS）。VSCode 默认开。
    - 低成本：CSS 画引导线或 `indentWithTab` 的配套。

16. **行尾空格/尾随空格显示、空白字符可见**
    - 低成本，`EditorState` 的 `trailingSpaceHighlight`（@codemirror/view）—— 一行搞定，强迫症友好。

17. **当前行号/总行数状态栏**（编辑器右下角 "Ln 12, Col 34"）
    - VSCode 状态栏。CodeMirror 有 `EditorView` 的 `updateListener` 可算行列，画一个小状态条。

---

## 三、建议实施顺序（第一批：P0，直接让"能写代码"）

| 序 | 功能 | 改动量 | 说明 |
|---|---|---|---|
| 1 | Tab/Shift-Tab 缩进 + 多行 | 小 | `indentWithTab` + `indentSelection` |
| 2 | 自动保存（onBlur/延时） | 小 | prefs + debounce 写盘 |
| 3 | 行操作（删行/移行/复制行） | 小 | @codemirror/commands 现成命令 |
| 4 | 多光标 Ctrl+D | 小 | `selectNextOccurrence` keymap |
| 5 | 折叠 gutter + 折叠命令 | 中 | `foldGutter` + `foldCode` |
| 6 | 尾部空格高亮 | 很小 | `trailingSpaceHighlight` |
| 7 | 设置 UI（字体/字号/Tab/换行/行号/自动保存） | 中 | 复用 terminal 设置模式 |
| 8 | 状态栏 Ln/Col | 小 | updateListener + 状态条 |

第二批（P1）：大纲（语法树）、括号高亮跳转、语言关键字补全。
第三批（P2）：LLM 续写/幽灵文本（差异化亮点）。

---

## 四、已开始的改动（本次会话，尚未收尾）

- `TextEditor.tsx`：已接入 search / go-to-line / autocomplete / bracketMatching / closeBrackets / indentOnInput / highlightActiveLine；prefs compartment（字体/字号/Tab宽/换行/行号）已建，但**设置 UI 未接、prefs 字段未在 config.ts 完整落地前**不要发布。
- `prefs-shared.ts` / `config.ts`：已加 `editorFontFamily/editorFontSize/editorTabSize/editorWordWrap/editorShowLineNumbers` 字段。
- **当前分支未提交**，且编辑器改动**尚未通过 typecheck** —— 文档落定后按 P0 顺序收尾并验证。
