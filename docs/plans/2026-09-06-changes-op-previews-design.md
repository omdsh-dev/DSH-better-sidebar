# 变更页操作预览增强设计（2026-09-06）

> 状态：已实现（PR #499）。本文档记录六个特性的设计、关键取舍与已知限制，含 2026-09-06 规范化审查后的整改记录。特性移植自 dsh-file-trace v0.2.0/v0.2.1 会话（PDF 渲染为作者后续追加）。

## 背景

变更页（Changes tab）底部预览面板此前只渲染统一 diff / 逐行读取 / 错误文本。本批扩展为：markdown 文档可切「阅读模式」、mermaid 围栏随阅读模式渲染、预览载荷做「敏感内容脱敏」、`.html` / `.pdf` 操作可切「渲染模式」，并把 diff 引擎的语法着色表扩到此前无色/错配的一批语言。全部特性共用同一预览面板与头部 toggle 交互。

## 1. Markdown 阅读模式

- 适用：`.md / .markdown / .mdx` 的 read / write / edit 操作（非错误）→ 头部「阅读 / 原文」toggle。
- 渲染走共享 `MarkdownText`（与编辑器预览、Side Chat 同一栈，labels 契约经 `markdownTextProps()`，见 AGENTS §3.3）；本地图片目的地经 `rewriteLocalImageUrls` 改写到会话域 `/sidebar/file` 媒体路由。
- 内容来源：read → `parseReadContent()`（见下）；write → 写入内容；edit → 已知 prior 时 `prior.replace(oldString, newString)` 重建结果文档，否则仅展示 newString（设计上「prior 已知才重建」）。
- `parseReadContent`（`src/client/changes/ops.ts`）：与 `parseReadLines` 共享 `contentLines()` envelope 核心（`<content>` 提取 + "(Showing lines …)" 过滤）；区别在前者剥 `<n>: ` 前缀后**保留空行**（markdown 块结构依赖空行）并修剪首尾空行（渲染不可见），后者解析行号、丢弃空行。

## 2. Mermaid 围栏渲染

- 阅读模式检测到 ```mermaid 围栏时，走编辑器同款懒加载渲染器（`LazyMermaidMarkdown`，mermaid chunk 经 `/sidebar/bundle` 按需下发）；无围栏文档保持单次 MarkdownText 直渲染（字节不变）。
- `LazyMermaidMarkdown` 的定义从 `MarkdownHtml.tsx` 移到轻量模块 `src/client/mermaid-lazy.tsx`：变更页（核心 bundle）要引用这个 stub 而不把 `MarkdownHtml` 的 DOMPurify/HTML 分析机械拖进核心 bundle；`MarkdownHtml.tsx` 改为 re-export。
- 已知边界：无引号节点标签内含被遮密钥（`[REDACTED]` 字面）时 mermaid 解析失败，回落到「错误条 + 已遮源码」——该回落是 `mermaid.tsx` 既有机制（catch → 错误 + 源码），本批未新增代码，亦未为该路径加测试（README 已注明规避方式：标签加引号）。

## 3. 语法着色扩展（`src/client/diff/highlight.ts`）

- `mjs/cjs → JS_WORDS`、`mts/cts → TS_WORDS`（此前无映射 → 纯文本）；`tsx/jsx` 同用共享词表（规范化整改：原先保留内容相同的内联副本）。
- `css/scss/less → CSS_LANG`：slash-star 块注释跨行、连字符属性词（`background-color` 整词着色）、字符串、十六进制数；此前误用 `#` 行注释配置导致不着色。
- `html/htm/xml/svg/vue → MARKUP_LANG`：`<!-- -->` 注释 + 常见标签/属性；`graphql/gql`、`jsonc/json5` 映射。
- 着色是启发式（词表驱动单遍扫描）；CSS/MARKUP 词表混排选择器/属性/标签是刻意为之——`LangConfig` 只有一个 keywords 集，再分类属过度设计。

## 4. 敏感内容脱敏（`src/client/redact.ts`）

- 动机：追踪器把 read/write 工具结果重放进 DOM；模型读取凭据文件时明文不应上屏。**仅显示层**：会话日志与 fs 层字节不动；不是对同上下文恶意插件的安全边界。
- 两层启发式：
  1. **路径层**：文件名含凭据形态（`.env`、`secret(s)`、`credential(s)`、`token`、`api-key`、`password(s)`、私钥/证书扩展名…）→ 整文件逐行 `[REDACTED]`。匹配带**右边界**（模式后不得继 `[a-z0-9]`），且复数只收「密钥仓库」义（credentials/secrets/passwords），不收 `tokens`（api-tokens.md 通常是文档）——避免 `tokenizer.ts` / `dev.environment.ts` / `style.keys.ts` / `api-tokens.md` 被整文件误伤。
  2. **内容层**：普通文件按行遮值——赋值形（`api_key:` / `TOKEN=` / `"password":`，**字段名保留**）、`Bearer` 头、`sk-`/`AKIA`/`ghp_`/`gho_`/`xox*`/`ya29.` 前缀 token、PEM 私钥块头。字段表**不含裸词 `key`/`auth`/`token`/`pass`**（规范化整改：这些词标注的普通内容远多于密钥——键盘键名、CSS 自定义属性、词法 token；Bearer 场景由 `BEARER_RE` 单独覆盖）。
- 开关：默认开，头部一键切换，localStorage 记忆（key `dsh-sidebar:v1:redaction`，仓库既有前缀）。所有载荷消费方（diff 行、读取行、阅读模式源、错误文本、prior）统一从**遮蔽后**形状渲染；命中时头部显示「已脱敏」条。

## 5. HTML 渲染模式

- 适用：`.html / .htm` 操作（与编辑器 html viewer 的扩展集对齐；规范化整改：去掉越权的 `.xhtml`）→ 头部「渲染 / 原文」toggle。
- 实现：`HtmlRenderPreview`（`DiffPane.tsx` 导出，供沙箱 spec 钉契约）以 route-src iframe 加载 `/sidebar/html`——相对资源（`./style.css`、`img/x.png`）在路由内解析；分段读取也能渲染完整文档。
- **语义边界（刻意）**：路由服务的是**盘上已保存文件**而非操作快照——失败/未落盘的写入会渲染旧内容（README 已声明）。共享常量 `HTML_IFRAME_SANDBOX` 提到 `src/client/html-preview.ts`（编辑器与变更页共用）；此面**恒定沙箱**（opaque origin + CSP 头），编辑器 tab 才持有带警告的去沙箱逃生门。

## 6. PDF 渲染模式（作者 2026-09-06 追加）

- 适用：`.pdf` 操作（非错误）→ 头部「渲染 / 原文」toggle，复用编辑器 `PdfView`（媒体路由字节流 + 显式类型 Blob → 浏览器原生 PDF 查看器内嵌，附下载入口）。规范化整改：扩展名正则补 `\.` 转义（原 `/.pdf$/i` 会误命中任何以 pdf 结尾的路径）、toggle 并入 `PaneToggle`。无独立单测（PdfView 行为由编辑器侧既有测试覆盖）。

## 规范化整改（2026-09-06 审查后）

- **皮肤契约**：`.htmlFrame` 背景硬编码 `#fff` → `var(--dsw-alias-bg-base)`（对齐 `.editorHtml`）；`.redactBanner` 原用的 `--dsw-alias-state-warning-primary` 在 DSW 词表中**不存在**（实际为 `state-warn-*`），var() 恒回落到硬编码 `#b8860b` → 改用真实令牌 `var(--dsw-alias-state-warn-primary)`。
- **约定对齐**：localStorage key 并入 `dsh-sidebar:v1:` 前缀；`tests/redact.spec.ts` 源码 import 由 `.js` 改 `.ts`（仓库惯例）；DiffPane 三份同形 toggle 按钮提取 `PaneToggle`，阅读视图提取 `MdReadingView`（吸收 mermaid 分支与 codeLabels 计算）；遮蔽 useMemo 单遍化（每字段一次 `redactText`，此前 hit 扫描 + mask 双遍）。
- **去重**：`tsx/jsx` 共享 `TS_WORDS`/`JS_WORDS`；`parseReadContent`/`parseReadLines` 共享 `contentLines()`；CSS 词表去重（`hidden`/`inherit` 重复项）并去掉 CSS 没有的 `true false` 常量。

## 已知限制

- 脱敏是启发式：右边界规则放行 `mytoken.yaml`（命中遮蔽）而拒绝 `api-tokens.md`（文档）；字段级遮蔽不覆盖未知命名的密钥字段——按 token 形态（`sk-` 等前缀）兜底。一键关闭可在受信任环境看原文。
- HTML 渲染读盘上文件（见 §5）；mermaid 无引号标签含遮蔽密钥时回落源码（见 §2）。
- 阅读模式 edit 重建依赖窗口内已知 prior；窗口外旧内容不可知时仅展示新串（面板本就以「已知内容」为限）。

## 测试

`tests/redact.spec.ts`（两层遮蔽 + 边界/裸词误伤回归）、`tests/diff-highlight.spec.ts`（后缀映射、CSS 注释穿行/属性、markup 注释/标签、mjs 关键字）、`tests/changes-ops.spec.ts`（`parseReadContent` 空行保留）、`tests/changes-tab.spec.tsx`（阅读模式端到端：h1/GFM 表格/本地图片改写/切回原文）、`tests/sandbox-views.spec.tsx`（HTML 渲染 iframe 恒定沙箱 + toggle 出现条件）。
