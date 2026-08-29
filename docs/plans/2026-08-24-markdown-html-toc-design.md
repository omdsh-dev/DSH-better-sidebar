# Markdown 预览内嵌 HTML 渲染 + 目录大纲（TOC）设计

> 日期：2026-08-24
> 状态：已实现
> 范围：`dsh-better-sidebar` 插件，Markdown 文件预览（`TextEditor.tsx` preview 模式）；Sidechat 与其他渲染面**零改动**
> 基线：复用 mermaid 预览（PR #164）确立的「检测切分 + 单次 MarkdownText 解析 + commit 后 DOM 手术」架构与安全姿势

## 1. 背景与问题

DSH 宿主的 `MarkdownText` 出于聊天安全把 raw HTML 按字面文本渲染（协议白名单、相对链接禁用、图片仅绝对 http(s)）。这对聊天是对的，但对**文件预览**是灾难：GitHub 风格的 README（本仓库自己的 README 即典型）大量使用内嵌 HTML——`<div align="center">` 徽章墙、`<details>` 折叠块内嵌 markdown、表格单元格里的 `<br/>`/`<sub>`/`<img>`、`<video>`/`<picture>`——预览时全部显示为源码文本。

用户需求（确认记录）：覆盖 Markdown 文件预览；块级 + 内联 HTML 都做；安全模型选 DOMPurify 白名单内联渲染（非沙箱 iframe）；TOC 选浮动按钮 + 弹出面板；Sidechat 暂不动；**不更换渲染器**（保住 MarkdownText 的 shiki 高亮 + KaTeX 数学 + GFM 表格）。

## 2. 方案

### 2.1 检测与切分：`src/client/markdown-html.ts`（纯函数）

- `splitHtmlBlocks(text)`：行扫描器把文档切成 `markdown | html` 段。HTML 段 = 围栏外的**块级标签行**（CommonMark type-6 名单 + `<summary>`，开或闭标签）开头、延伸到空行的连续行；`<!-- -->` 注释段在含 `-->` 的行结束。**围栏识别复用 `mermaid-blocks.ts` 导出的 fence 助手**——```html 围栏内的 `<div>` 示例不会被误切。段边界的空行是分隔符，被丢弃。
- `analyzeHtmlSegment(source)`：段内标签 tokenizer（跳过注释，void/自闭合标签不进栈，错配闭标签按 HTML 解析器的隐式闭合弹出）归约为有序 parts：`html`（平衡的原始片段，渲染为消毒叶子）/ `open`（未闭合开标签 + 原始 attrs，成为包裹后续段的容器）/ `close`（多余闭标签，弹出一层）。
- `collectReferenceDefinitions(segments)`：从 markdown 段收集 `[label]: dest` 行。**每个 markdown 段渲染时追加密全文档定义**——跨 HTML 段的 `[text][id]` 语义保真（追加副本在已含定义的段内因 first-match-wins 而惰性）。这是 mermaid 预览「单次解析」约束（引用定义跨 fence 解析，e2e 钉死）在切分渲染下的等价物。
- `analyzeMarkdownHtml(text)`：整体入口，含 `hasInlineHtml` 廉价正则门（fence 内误报只多走增强路径，内联 pass 本身跳过代码块，无行为差异）。

### 2.2 渲染：`src/client/MarkdownHtml.tsx`

- **安全管线**（三个入口共用）：块叶子 / 内联文本 / 包裹开标签 attrs 全部过 DOMPurify（显式 `FORBID_TAGS: script/style/iframe/object/embed/form/input/button/select/textarea/meta/link/base/frame/frameset/applet` + `FORBID_ATTR: srcdoc/formaction`，叠加在默认白名单之上）；消毒后 DOM 遍历强制 `<a>` → `target=_blank rel=noopener noreferrer`；本地 `img/video/audio/source` 的 `src` 经 `resolveLocalMediaDest`（从 `markdown-images.ts` 抽出的共享助手）重写为 `/sidebar/file` 会话媒体 URL——与 markdown 图片重写同一信任围栏。包裹标签的 attrs 走「迷你文档消毒再读回」；`class/for` 映射 React 名，`style` 丢弃（React 需对象，不值得引入 CSS 解析器）；整标签被禁时容器透明（子内容照常渲染）。
- **`MarkdownDocument` 段渲染状态机**：markdown 段 → `MarkdownSegment`；平衡 html 段 → `dangerouslySetInnerHTML` 叶子（`[data-dsh-html-segment]`）；`open`/`close` 部件驱动一个**跨段持久的帧栈**——`<details>` 开段把后续段降为自己的子元素，`</details>` 段弹栈（GitHub 线性 HTML 输出的同款嵌套）。顶层多余闭标签渲染为无（消毒器/解析器本就会丢弃）；文档结束仍开着的帧按浏览器解析器语义收口。消毒在 `useMemo` 内按段缓存。
- **`MarkdownSegment` 内联替换**：段内含 mermaid fence 走现有 `LazyMermaidMarkdown`（chunk 逻辑不变），否则 `MarkdownText`；`useLayoutEffect` + **MutationObserver**（微任务去抖、幂等、跳过 `code/pre/.md-code-block/[data-mermaid-processed]/[data-html-inline]`）把含标签样式文本的文本节点整体消毒后包进 `<span data-html-inline>` 替换——纯散文（`a < b`）消毒后无元素子节点则原样保留；observer 覆盖懒 chunk 迟挂载、shiki 异步高亮等迟到内容。与 mermaid 换装同款「React 持有宿主树、只动叶子」姿势。
- **接线（`TextEditor.tsx`）**：`analyzeMarkdownHtml` 发现块级或内联 HTML 才走 `MarkdownDocument`；**纯 markdown 文档走原路径原样**（无 HTML → 单次 `MarkdownText`/mermaid chunk，现有 e2e「单次解析」守卫继续成立——种子 md 文件不含 HTML，断言一字未改）。

### 2.3 TOC：`src/client/md-toc.tsx`

- 零高度 sticky 条（`position: sticky; top: 0; height: 0; pointer-events: none`，不占布局、滚动常驻）+ 右上角按钮 `[data-dsh-md-toc]`（≥3 个标题才出现）+ 弹出面板 `[data-dsh-md-toc-panel]`（按层级缩进、独立滚动、Esc 关闭）。
- 标题从**渲染后的 DOM** 收集（h1–h6，含 HTML 段内标题），MutationObserver 重扫（签名比对防重渲染循环）。
- 跳转：展开 `closest('details:not([open])')` → `scrollIntoView({behavior:'smooth'})` → CSS 动画高亮 1.2s。
- **⚠️ 关键实现陷阱（本次踩坑）**：MdToc **不能**通过传入父容器 ref 定位——React 的 layout 阶段子先于父，子组件的 `useLayoutEffect` 执行时父 div 的 ref **尚未挂上**（实测 `containerRef.current === null`，且依赖数组恒定导致 effect 永不重跑，按钮永不出现；jsdom 单测传预填 ref 对象会掩盖此 bug，只有真实挂载 e2e 能抓到）。修复：MdToc 用**自身 bar div 的 ref**（自身 effect 前必然已挂）取 `parentElement` 作为容器——挂载契约「渲染为目标滚动容器的直接子元素」写入组件文档；bar 常驻渲染（零高度无副作用）以保证 ref 恒在。

### 2.4 依赖与产物

- `dompurify ^3.4`（已是 mermaid 的传递依赖，提升为直接依赖后 pnpm 去重单版本，零额外体积）随 editor chunk 内联，未新增 chunk。
- 市场清单守卫合规（dependencies 无 `cordis`、无 install 脚本）。

## 3. 测试

- `tests/markdown-html.spec.ts`：切分器（21 例：块级标签成段/空行终止/注释段/闭标签段/围栏免疫/CommonMark 恢复/README details 三段形）+ tokenizer 平衡分析（9 例）+ 引用定义收集 + 内联门。
- `tests/markdown-html-render.spec.tsx`：真实 `MarkdownText` 渲染——消毒叶子（script 剥除、a 加固、本地 src 重写）、details 跨段嵌套（fence 在 details 元素内、后续段是兄弟）、跨段引用定义解析、禁用标签容器透明、内联替换（表格单元格 `<br/>` 生效、代码块与 `a < b` 不动、内联本地 img 重写）。
- `tests/md-toc.spec.tsx`：阈值门、标题收集、跳转（mock `scrollIntoView`、折叠祖先展开、高亮清除）、observer 迟到标题、Esc 关闭。
- `tests/e2e/mount.e2e.ts`：新增 `readme-style.md` 种子（徽章 div 含 script、details 包 fence+标题、表格内联 `<br/>`、跨段引用定义）+ 探针（徽章 img 真实元素、无 script、details 嵌套、内联 br、引用解析、TOC 按钮→面板→跳转展开）。**现有 mermaid 探针与断言一字不动**（纯 markdown 文档零回归证明）。

## 4. 已知取舍（明确不做）

- GFM 脚注跨段不保（宿主本就把脚注渲染为纯文本）；`srcset` 不重写（实际只有远程 URL）；HTML 实体不解码；标题锚点 permalink、TOC 滚动联动高亮不做；Sidechat 不动；不换渲染器。
- CommonMark HTML 块类型 1（script/pre/style/textarea 按闭标签终止）与类型 7（单行完整标签）不做专门处理——块级名单 + 空行终止已覆盖 README 级真实用法。
