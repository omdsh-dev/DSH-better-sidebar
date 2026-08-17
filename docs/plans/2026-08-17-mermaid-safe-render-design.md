# Markdown 预览 Mermaid 安全渲染设计

> 日期：2026-08-17
> 状态：已实现
> 范围：`dsh-better-sidebar` 插件，Markdown 预览 + 新 `mermaid` 懒加载 chunk
> 基线：社区 PR #99（`feat/mermaid-md-preview`）的架构与安全姿势；借鉴 PR #75（`feat/mermaid-rendering`）的点击放大交互

## 1. 背景与问题

Markdown 预览（`TextEditor.tsx` 的 preview 模式）直接把全文交给 DSH 的 `MarkdownText`（`@deepseek-ai/dsh-client-ui-primitives`）渲染。该渲染器的 fenced code 一律走 `CodeBlock`（Shiki 高亮 + 复制按钮），且**不支持自定义 fence 渲染器**——```` ```mermaid ```` 块只会显示成一段无高亮的代码，不会渲染成图（DSH 宿主内 `mermaid` 字样出现 0 次，Shiki 别名表也无此语言）。

社区出现过两个 mermaid PR，安全姿势差异极大：

| | PR #75 | PR #99 |
|---|---|---|
| 加载 | 运行时 jsdelivr CDN（第三方供应链、离线不可用、无版本锁） | 自有懒加载 chunk（mermaid 11.16.1 本地打包，`/sidebar/bundle` 同源下发） |
| 安全 | `securityLevel: 'loose'`（标签可注入原始 HTML）+ 无清洗 + `innerHTML` 直插 | `securityLevel: 'strict'` + `htmlLabels: false` + SVG 二次清洗 + 不应用 `bindFunctions` |
| 测试/文档 | 无 | 单测 + e2e + 设计文档 |
| 亮点 | 点击放大弹窗（滚轮缩放/拖拽/快捷键） | 主题跟随、错误回退、CodeBlock 同款 chrome |

**结论：以 #99 为基线**。md 文件来自工作区（可能来自克隆仓库/下载），不可信；`loose` + 无清洗在 DSH GUI origin 下就是 XSS（可读会话数据）。**仅借鉴 #75 的点击放大交互**，在 #99 的已清洗 SVG 之上用 React 重写（克隆节点无事件面，弹窗不新增攻击面）。本地图片引用重写（#99 顺带功能）不在本 PR 范围，另行独立 PR。

## 2. 方案

### 2.1 检测：纯函数按 fence 切块

新增 `src/client/mermaid-blocks.ts`（`splitMermaidBlocks`，纯函数、无依赖），职责是**检测**预览是否需要 mermaid chunk：

- 逐行扫描，命中 info string 为 `mermaid` 的围栏（大小写不敏感，支持 `mermaid{...}` 属性后缀，缩进 ≤3 空格，CommonMark 语义）即"提出"为 `{ kind: 'mermaid', code }` 块；
- 其余行原样保留在 `{ kind: 'markdown', text }` 块中（含非 mermaid 围栏）；
- 未闭合的 mermaid fence 吞掉文件剩余部分（与 CommonMark 对开 fence 的恢复一致）；
- **CommonMark fence 规则完整**：开 fence 为 3+ 反引号**或波浪号**；闭 fence 必须同字符且长度 ≥ 开 fence；反引号 fence 的 info string 含反引号时该行不是开 fence。

`TextEditor` 预览时先 `splitMermaidBlocks`，**无 mermaid 块则走原 `MarkdownText` 直渲路径（零行为变化）**；有则渲染 `MermaidMarkdown`（mermaid chunk 内）。

### 2.2 渲染架构：单次解析 + 占位替换（CR 第 3 轮 P1 修正）

早期方案把文档切成多个独立 `MarkdownText` 片段，会破坏跨 fence 的 Markdown 语义（引用式链接定义在 fence 之后、脚注、有序列表连续性）。当前实现：

- **整篇文档只走一次 `MarkdownText`**（`MermaidMarkdown`），跨 fence 语义完整；
- 布局阶段（`useLayoutEffect`）扫描容器内 `.md-code-block`，识别 mermaid 块（双通道：shiki 路径的 `code.language-mermaid` 类，或 plain 路径的 banner infostring 文本 === `mermaid`——mermaid 无 shiki 语法必走 plain，语言只显示在 infostring 里），用 `createRoot` 把 `MermaidDiagram` 挂进替换后的子节点；**React 管理的 `.md-code-block` 宿主节点保留在树中**（仅替换其 children，CSS `display: contents` 抑制代码块自身盒子），React 协调不会丢失宿主；
- 块内容变化（编辑后重新预览）按源码 diff 重渲；块不再是 mermaid fence 时还原原 children（普通代码块恢复显示）；fence 消失时卸载对应 root；
- DSH `MarkdownText` 无代码块渲染扩展入口（且仓库硬约束禁止改 DSH），这是约束内的最小侵入方案。

### 2.2 懒加载 chunk：`mermaid`

mermaid 及其图依赖（d3 / dagre-d3-es / cytoscape 等）打包进新的 `lib/client-mermaid.js`（~7MB），复用既有 chunk 机制（tsdown `CHUNKS` + `/sidebar/bundle` 路由 + `globalThis.__dshChunks__` 注册表 + `lazyChunkComponent` 懒包装），仅当预览的 md 文件实际含 mermaid fence 时才下载/执行。chunk 名在 4 处同步：`tsdown.config.ts` `CHUNKS`、`src/bundle-route.ts` `CHUNK_NAMES`、`src/client/chunk-loader.ts` `ChunkName`、`package.json` `files`（及各 spec 的硬编码清单）。构建侧对 mermaid chunk 注入 `mermaidChunkAliases`：把裸 `uuid` 说明符解析到浏览器入口（`uuid/dist/index.js`，Web Crypto 实现），绕过其 node 入口的 `node:crypto` 触发客户端纯度门。

### 2.3 渲染与安全（纵深防御）

- `mermaid.render(id, code)` 客户端渲染 → SVG 字符串注入；每个渲染调用用单调递增 id（文档内唯一）；
- `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme })`——strict 下标签被转义、`click` 指令失效；`htmlLabels: false` 强制节点文字走真实 SVG `<text>`（默认的 `foreignObject` HTML 标签通道会被清洗器整体删除，导致文字丢失），同时把 HTML 标签注入面关死；`bindFunctions` **不**应用（静态图，无点击交互）；订阅 `subscribeColorScheme`，深浅色切换自动按新主题重渲；
- **SVG 注入前二次清洗**（`src/client/mermaid-sanitize.ts`，独立纯函数、可单测）：`DOMParser`（`image/svg+xml`）解析，删除 `foreignObject` 与 `script`/外来 HTML 元素（`img`/`iframe`/`object`/`embed`/`video`/`audio`/`input`/`button`/`form`/`link`/`meta`/`base`），剥离 `@*`/`on*` 属性，**移除全部 `href`/`xlink:href`**（静态图不需要链接，杜绝 javascript:/data: 乃至普通外链把整个 GUI 导航走）；仅接受根元素为 `<svg>` 的文档；解析失败（parsererror/非 SVG 根）返回空串，调用方显示错误回退，**原始字符串永不过清洗器**；
- 渲染失败（语法错误/清洗拒绝）展示错误条 + 原始代码块（便于对照修改），错误全文挂 tooltip；空 fence 不渲染；
- 块头保留与 `CodeBlock` 一致的 chrome：info string「mermaid」+ 复制按钮（`writeClipboard`，沿用 `copy`/`copied` 字典）。块体带稳定锚点 `data-mermaid-diagram`（e2e 断言用）。

### 2.4 点击放大弹窗（借鉴 PR #75，React 重写）

点击 `[data-mermaid-diagram]` 内 SVG → 克隆节点（**已清洗**，无事件属性）→ portalled fixed overlay（`data-mermaid-modal`）：

- 滚轮缩放（以鼠标位置为不动点，被动标志关闭防止页面滚动）；
- 拖拽平移（mousedown/mousemove/mouseup on window）；
- 工具栏按钮：− / + / ⟳ / ✕（i18n title）；
- 键盘：`+`/`=` 放大、`-` 缩小、`0` 重置、`Esc` 关闭；
- 背景点击关闭；卸载时移除全部监听；
- 样式全部走 CSS Module + DSH 令牌（遮罩 `--dsw-alias-bg-mask-1` + `blur(2px)`，与 DSH `Modal` 一致；z-index 1000 落在 DSH 浮层栈）。

## 3. 验证

- 单测：`tests/mermaid-blocks.spec.ts`（14 例：fence 识别大小写/属性/缩进、4 反引号/波浪号、同字符且不短于开 fence 的闭 fence、非 mermaid 围栏不动、交错顺序、开 fence 恢复、空文件）；`tests/mermaid-sanitize.spec.ts`（10 例 XSS：foreignObject/script/外来元素整节点剥离（含混合大小写元素名与属性名）、`on*`/`@*` 剥离、href/xlink:href 全删、畸形 XML → 空串、非 SVG 根 → 空串、良性图保真）；`tests/mermaid-markdown.spec.tsx`（3 例架构回归：mermaid 块被交换为图、**跨 fence 引用式链接在单次解析下解析**、非 mermaid 围栏不动）；
- 产物契约：`chunk-artifact.spec.ts`（mermaid chunk 执行 + registry 槽位 + 平台 externals require，`addEventListener` stub）/ `manifest-consistency.spec.ts` / `bundle-route.spec.ts` 的 chunk 清单同步加入 `mermaid`；
- 挂载冒烟：`tests/e2e/mount.e2e.ts` 新增 seed `diagram.md`，打开后强制 `client-mermaid.js` 往返、断言 `[data-mermaid-diagram] svg` 含节点文字（真实 `<text>`）、**跨 fence 引用式链接解析为真实锚点（单次解析证明）**、点击弹窗出现且 Esc 关闭、预览模式编辑器隐藏；缺 chunk、文字丢失、语义破坏、弹窗失效任一即红；
- 现有 `markdown-copy-labels.spec.tsx` 不回归（无 mermaid 文件走原路径）。

## 4. 风险与取舍

- 编辑器 chunk 之外新增 ~7MB 懒 chunk（mermaid + d3/dagre/cytoscape/katex 图依赖）；仅预览含 mermaid fence 的 md 时下载，启动与普通文本打开路径零成本；
- `splitMermaidBlocks` 对"mermaid 围栏嵌在其他代码块内"的极边缘情况会误提（只影响是否走 mermaid 路径，不影响渲染正确性）——预览级工具接受该取舍（与常见 md 渲染器行为一致）；
- 占位替换依赖 DSH `MarkdownText` 的 DOM 输出结构（`.md-code-block` + `language-mermaid`）：宿主节点保留在 React 树中、仅换 children，协调安全；若未来 DSH 渲染器结构变化，`data-mermaid-processed` 扫描点需要同步（有 e2e 兜底）；
- 清洗器删除全部 `href`/`xlink:href`：`<use href>` 类图标引用可能不显示（纯装饰性损失），换取确定性的无导航/无脚本面；
- mermaid 官方核心包持续演化，锁 `^11.16.1`，升级靠 Renovate 常规流程；
- 回滚：删除 chunk 三处声明 + `files` 条目 + `TextEditor` 分支即可回到纯代码块展示。
