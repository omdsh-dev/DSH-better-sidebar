# 编辑器未提交变更提示：行号着色 + 左侧细色条 + hover blame（issue #212）

> 分支 `feat/212-editor-git-gutter`（基于 `dev`，DSH 0.2.0-rc.1 线）。
> 口径按维护者定调：**和 VS Code 一样，左侧颜色小提示即可，样式不要浮夸** ——
> 不做行尾常驻作者 widget、不做彩色徽章、不做动画、不做渐变色。

## 落地内容

`code` 视图（可编辑 CodeMirror）多出三层提示，全部挂在**一个**布尔设置
`editorGitGutter`（默认开）下：

1. **行号槽着色**：新增 / 修改 / 删除行的行号取对应状态色；
2. **左侧细色条**：行号左边 2px 竖条，位置与 VS Code 一致（颜色同上）；
3. **hover blame**：鼠标停在某行时按需取该行 blame，纯文本 tooltip 显示
   `作者 · 时间` + 提交摘要。

## 设计要点

- **行映射只有一个来源**：`useGitStatus`（文件树着色用的同一个共享 store，全插件
  只有一个 `git status` 轮询器）决定「这个文件有没有改动 / 是不是未跟踪」；行级类型
  来自 `git diff --no-color -U3` 的输出，经**既有**统一 diff 引擎
  （`src/client/diff/rows.ts` 的 `parseUnifiedDiff` + `unifiedSegments`）折成
  `行号 → add | mod | del`。上下文行不产生任何标记；重写行由引擎的配对规则合成一个
  `mod`（不会在上一行多出一根删除条）；未配对的删除锚在**缺口上一行**（文件头删除锚
  第 1 行）——与 VS Code 的位置一致。
- **新路由 `git.diff-head`**：`git diff HEAD -- <path>` 一次给出「已暂存 + 未暂存」的
  整份未提交变更。既有的 `git.diff` 两个 side 各自只看一半（一个文件部分暂存时，
  gutter 会漏掉另一半），所以这里没有拼两次 diff、也没有新增第三个「status」概念。
  HEAD 尚未出生（`git init` 后有暂存无提交）时 `diff HEAD` 必然失败，此时回退
  `diff --cached`（索引对空树，同一问题的未出生 HEAD 形态）。
- **未跟踪文件不走 diff**：`git diff` 任何一侧都不会列出未跟踪文件，客户端按状态
  store 的 `untracked` 音调把整篇标成新增（与 VS Code 一致）。
- **blame 只在 hover 时按需请求**：`src/git.ts` 新增 `blame()`（`git blame --porcelain -L`），
  每次只取被 hover 的那一行；结果按 `sessionId + path + line` 记忆化（同一行反复 hover
  不再打 git），滚动不触发请求，整篇文件永不预取；该文件变更集重算时清掉它的 memo。
  未跟踪文件、非 git 仓库、路径不存在、命令失败**一律 catch 成空数组**（route 也是空
  列表），tooltip 什么都不显示，绝不能影响编辑面。
- **只给 `code`**：`gitGutterExtensions(null)` 返回**空扩展数组**（不是「装了但没画」
  ——DOM 里连 gutter 包裹元素都不存在），markdown / html 视图与关闭开关后都是这一支。
  开关用 `useSyncExternalStore` 读（与 EditorHost 读 `editorExplorer` 同一 seam），
  经 CodeMirror `Compartment` 原地重配：关掉即拆掉扩展，文档 / 撤销栈 / 滚动位置不丢。
- **取色复用既有 tone 口径**：新增 / 未跟踪取 `--dsw-alias-state-success-primary`、
  修改取 `--dsw-alias-state-warn-primary`、删除取 `--dsw-alias-state-error-primary`，
  与文件树 `explorerGitName[data-git-tone]` 完全一致；样式写在
  `src/client/sidebar.module.css`（class 名以 `elementClass` / marker DOM 交回
  CodeMirror），因此 `tests/theme.spec.ts` 的皮肤契约照常扫描。
- **一个开关，不是四个**：作者 / hash / 日期 / 摘要没有独立开关；行尾 widget、
  徽章、动画、渐变都不做。

## 实施偏差

- **`useGitStatus` 补了 `useSyncExternalStore` 的第三个参数（server snapshot）**：
  `TextEditor` 会被 markdown 预览用例整份 SSR 成字符串，缺这一参数 React 直接抛
  `Missing getServerSnapshot`。slot 版本号两侧同为 0，行为不变。
- **`tests/text-editor-conflict.spec.tsx` 的 api mock 改为保留真实 api 对象**
  （原先只替换出 `{ fsWrite }`）：`code` 视图现在也会读共享 git status store，
  部分 mock 会让 store 拿到 `api.gitStatus is not a function`。这是 mock 的既有形状
  问题，不是产品回归。
- **`tests/prefs.spec.ts` 三个「整份 prefs 深比较」补上 `editorGitGutter: true`**：
  新增 schema 字段的既有约定动作。

## 验收

- `tests/editor-git-gutter.spec.tsx`（17 例）：行映射（新增 / 重写 / 纯删除 / 头删 /
  混合 hunk / mode-only / 空 patch / 未跟踪整篇）、扩展门（关=空数组、类名落到真实
  样式表、空 state 上 dispatch 不炸）、blame memo（同一行只问一次、失败回 null、
  变更集重算清 memo）、`TextEditor` 真实 DOM（code 有 gutter / 关掉没有 / markdown
  没有 / 中途关开关就地拆除）。
- `tests/git-blame.spec.ts`（14 例）：真实 git 产出上的 porcelain 解析（含未提交
  全零 hash 行与「同一 commit 第二行只给 header」的缩写形态）、`blame()` 四条失败
  路径（未跟踪 / 非仓库 / 路径不存在 / 命令失败）、`diffHead()` 的「部分暂存给全量」、
  未出生 HEAD 回退、未跟踪不出现，以及**真实 git 输出 → 行类型**的端到端映射。
