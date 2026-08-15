# Markdown 预览增强（Mermaid 渲染 + 本地图片）设计

> 日期:2026-08-16
> 状态:已实现
> 范围:`dsh-better-sidebar` 插件,Markdown 预览 + 新 `mermaid` 懒加载 chunk

## 1. 背景与问题

Markdown 预览(`TextEditor.tsx` 的 preview 模式)直接把全文交给 DSH 的 `MarkdownText`(`@deepseek-ai/dsh-client-ui-primitives`)渲染。该渲染器的 fenced code 一律走 `CodeBlock`(Shiki 高亮 + 复制按钮),且 **不支持自定义 fence 渲染器**——```` ```mermaid ```` 块只会显示成一段无高亮的代码,不会渲染成图(DSH 宿主内 `mermaid` 字样出现 0 次,Shiki 别名表也无此语言)。

## 2. 方案

### 2.1 拆分:纯函数按 fence 切块

新增 `src/client/mermaid-blocks.ts`(`splitMermaidBlocks`,纯函数、无依赖):

- 逐行扫描,命中 info string 为 `mermaid` 的围栏(大小写不敏感,支持 `mermaid{...}` 属性后缀,缩进 ≤3 空格,CommonMark 语义)即从 md 流中"提出"为 `{ kind: 'mermaid', code }` 块;
- 其余行原样保留在 `{ kind: 'markdown', text }` 块中(含非 mermaid 围栏,行为与现在完全一致);
- 未闭合的 mermaid fence 吞掉文件剩余部分(与 CommonMark 对开 fence 的恢复一致)。

`TextEditor` 预览时先 `splitMermaidBlocks`,**无 mermaid 块则走原 `MarkdownText` 直渲路径(零行为变化)**;有则渲染 `MermaidBlocks`(mermaid chunk 内),由它按源顺序交错渲染 md 段(`MarkdownText`)与图段(`MermaidDiagram`)。参考定义/脚注跨块失效等极边缘情况只影响含 mermaid fence 的文件,可接受。

### 2.2 懒加载 chunk:`mermaid`

mermaid 及其图依赖(d3 / dagre-d3-es / cytoscape 等)打包进新的 `lib/client-mermaid.js`,复用既有 chunk 机制(tsdown `CHUNKS` + `/sidebar/bundle` 路由 + `globalThis.__dshChunks__` 注册表 + `lazyChunkComponent` 懒包装),仅当预览的 md 文件实际含 mermaid fence 时才下载/执行。chunk 名在 4 处同步:`tsdown.config.ts` `CHUNKS`、`src/bundle-route.ts` `CHUNK_NAMES`、`src/client/chunk-loader.ts` `ChunkName`、`package.json` `files`(及各 spec 的硬编码清单)。

### 2.3 渲染与安全

- `mermaid.render(id, code)` 客户端渲染 → SVG 字符串注入;每个渲染调用用单调递增 id(文档内唯一);
- `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: 深/浅色 })`——strict 下标签被转义;`htmlLabels: false` 强制节点文字走真实 SVG `<text>`(默认的 `foreignObject` HTML 标签通道会被清洗器整体删除,导致文字丢失),同时把 HTML 标签注入面关死;`bindFunctions` **不**应用(静态图,无点击交互);订阅 `subscribeColorScheme`,深浅色切换自动按新主题重渲;
- SVG 注入前二次清洗(`DOMParser` 解析):删除 `foreignObject`,剥离 `@` 前缀与 `on*` 事件属性,再经 `dangerouslySetInnerHTML`;
- 渲染失败(如语法错误)展示 `t('mermaidError')` 错误条 + 原始代码块(便于对照修改),错误全文挂 tooltip;空 fence 不渲染;
- 块头保留与 `CodeBlock` 一致的 chrome:info string「mermaid」+ 复制按钮(`writeClipboard`,沿用 `copy`/`copied` 字典)。块体带稳定锚点 `data-mermaid-diagram`(e2e 断言用)。

### 2.4 本地图片引用（顺带补齐的预览缺口）

DSH `MarkdownText` 只渲染**绝对 HTTP(S)** 图片,相对路径 `![](./pic.png)` 会降级成 alt 文字。预览前把本地图片引用重写为插件自有媒体路由的绝对 URL(`location.origin + /sidebar/file?…`,路由本身有会话 cwd 边界 + 信任围栏),图片随预览正常显示:

- 新增纯函数 `src/client/md-image-rewrite.ts`(`rewriteLocalImages` + `resolveLocalPath`):逐行扫描 `![alt](dest)`,跳过代码围栏(```` ``` ````/`~~~`)与行内代码;`http:`/`data:`/`mailto:` 等 scheme、根相对(`/…`)与锚点(`#…`)不动;dest 支持 `<…>` 角括号与 title 后缀,查询串/hash 剥离,`.`/`..` 归一;
- `TextEditor` 预览前对 md 源重写(对含 mermaid 的文件同样生效:先重写、后切块,mermaid 代码是围栏、天然不受影响);编辑器与选区弹窗仍用原始文本;
- 参考式图片(`![alt][ref]`)不在范围(保留 alt 文字展示)。

## 3. 验证

- 单测:`tests/mermaid-blocks.spec.ts` 覆盖 fence 识别(大小写/属性/缩进)、非 mermaid 围栏不动、交错顺序、开 fence 恢复、空文件;`tests/md-image-rewrite.spec.ts`(10 例)覆盖相对路径归一、scheme/根相对/锚点不动、代码围栏与行内代码保护、角括号与 title;
- 产物契约:`chunk-artifact.spec.ts` / `manifest-consistency.spec.ts` / `bundle-route.spec.ts` 的 chunk 清单同步加入 `mermaid`,CI 保证产物存在、注册表槽位正确、require 白名单纯净;
- 挂载冒烟:`tests/e2e/mount.e2e.ts` 新增 seed `diagram.md`(mermaid fence + 本地图片引用)与 `pixel.png`,打开后强制 `client-mermaid.js` 往返、断言 `[data-mermaid-diagram] svg` 含节点文字、`img[src*="/sidebar/file"]` 实际加载(naturalWidth>0)、预览模式编辑器隐藏;缺 chunk、文字丢失、图片路由失效任一即红;
- 现有 `markdown-copy-labels.spec.tsx` 不回归(无 mermaid/图片的文件走原路径)。

## 4. 风险与取舍

- 编辑器 chunk 之外新增 ~7MB(mermaid + d3/dagre/cytoscape/katex 图依赖)的懒 chunk;仅预览含 mermaid fence 的 md 时下载,启动与普通文本打开路径零成本;
- mermaid 官方核心包持续演化,锁 `^11.16.1`,升级靠 Renovate 常规流程;
- `splitMermaidBlocks` 对"mermaid 围栏嵌在其他代码块内"的极边缘情况会误提——预览级工具接受该取舍(与常见 md 渲染器行为一致);
- 回滚:删除 chunk 三处声明 + `files` 条目 + `TextEditor` 分支即可回到纯代码块展示。
