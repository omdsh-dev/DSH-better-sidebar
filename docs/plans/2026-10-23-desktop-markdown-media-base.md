# 桌面壳下 Markdown 预览本地图片不渲染（媒体 URL 基址）

## 现象

DeepSeek Harness 桌面端（Electron 壳，DSH 0.2.1-rc.2，插件 0.28.0）：打开一个引用本地图片的
`.md`（`![图](images/x.png)`），右侧「预览」里图片不出现，只显示图片的 **alt 文本**；把插件
禁用后，同一文件的宿主内置文档预览正常。浏览器（`dsh web`）下没有这个问题。

## 根因

1. **预览把媒体 URL 拼在 transport base 上。** `TextEditor` / `DiffPane` 用
   `hostTransportBase()`（桌面壳里 = `__DSH_TRANSPORT__.streamBaseUrl`，即 Host 的
   `http://127.0.0.1:<port>` origin）把本地图片改写成绝对 URL。
   桌面壳的页面 origin 是 `dsh-app://app/`，所以这是**跨站子资源**
   （`Sec-Fetch-Site: cross-site`）。
2. **宿主拒绝它。** `/sidebar/*` 的围栏（0.28.0 起为 `ctx.connection.requestRejection()`）里，
   Host 的 `isTrustedApiRequest` 对 `cross-site` 直接拒绝；会话 cookie 是
   `HttpOnly; SameSite=Strict`，跨站 `<img>` 不会携带。桌面壳只为两类请求补凭据/同源标记——
   `dsh-app://app/*` 的转发（`forwardWebRequest` 加 cookie、删 `Origin`/`Sec-Fetch-Site`）和
   `ws://127.0.0.1/*` 升级——普通 http 图片 GET 不在其中。实测同一 URL：不带 cookie
   `403 forbidden`，带桌面会话的 `dsh-auth-*` cookie `200 image/png`。
3. **为什么不能只换基址。** `MarkdownText` 对 markdown 语法只接受绝对 http(s) 目标，其余交给
   所属表面的图片词汇钩子（`pathImages`）并由渲染器**复检协议**：http(s)/blob/data，或
   桌面应用文件路由 `dsh-app://app/api/file?`。所以：

   - 换 `hostHttpBase()` 后直接拼 `/sidebar/file` → `dsh-app://app/sidebar/file?...` 会被
     白名单拒绝，仍是 alt 文本；
   - 桌面壳里能过白名单的本地文件形状只有 `dsh-app://app/api/file?path=...`（宿主
     `SessionMediaReferences` 的认证文件路由，内置文档预览的 markdown 图片也用它）。

4. **宿主的文件路由只收绝对路径。** 从聊天地址打开的编辑 tab 可以携带**工作区相对**的
   `path`（面包屑显示 `openwrt-proxy-primer/PRINCIPLES.md`）。插件的 `/sidebar/file` 路由
   （v1 的 `/sidebar/file` 与浏览器的 `/sidebar/file` 分支）能靠 `cwd` 参数解析相对路径，
   但 `/api/file?path=` 对相对路径直接回 **400 `absolute path required`** —— 最初只换路由
   不换路径拼接时，桌面壳图片因此仍回退 alt 文本。

## 方案

沿用「渲染前把目标交给渲染器词汇」的既有架构，只修正词汇产出的 URL：

- `pathImages.resolve(destination)`：本地目标 → **页面 base** 上的可显示 URL；
  - **浏览器**（页面 base 是 http(s)）：插件的 `/sidebar/file` 媒体路由（与今天逐字相同，
    保留反代前缀与会话/工作区围栏）；
  - **桌面壳**（页面 base 是 `dsh-app://app/`）：宿主的认证 `api/file?path=` 路由
    （`dsh-app://app/api/file?...`，壳转发时带 launch cookie）。
- 原始 HTML 的 `<img src="./x.png">` 是普通 DOM，不经渲染器白名单，继续由
  `resolveLocalMediaDest` 直接重写为**页面 base** 的 `/sidebar/file`。
- markdown 图片目标保持作者原文（交给词汇钩子），因此删除 `rewriteLocalImageUrls`；
  链接 pass 跳过**被图片引用的引用式定义**（否则定义被加 `?`，图片又退回 alt 文本），
  只被普通链接引用的定义仍照旧钉住。

不新增界面元素：图片仍渲染为单个 `<img>`（max-width: 100%），尺寸与浏览器/内置预览一致，
不引入聊天里那种 640×360 缩略图 + 灯箱（那是 `MarkdownDelegate.fileImages` 的行为，
本次刻意不用）。

## 备选与取舍

| 方案 | 结论 |
| --- | --- |
| 只把 `hostTransportBase()` 换成 `hostHttpBase()` | 不够：`dsh-app://app/sidebar/file` 被渲染器白名单拒绝，仍是 alt 文本 |
| `MarkdownDelegate.fileImages` 委托 + 插件媒体路由 | 能修且保留插件路由，但宿主会按聊天惯例给委托图片加 640×360 缩略图上限与灯箱按钮，预览尺寸与内置预览/旧版不一致 |
| 预取字节 → blob:/data: URL | 异步、逐图缓存与失效成本高 |
| **`pathImages` + 桌面壳宿主文件路由（本方案）** | 浏览器 URL 与现状逐字相同；桌面壳用内置预览同款路由；单个 `<img>`，尺寸不变 |

## 改动

- `src/client/markdown-images.ts`：删除 `rewriteLocalImageUrls`；新增
  `markdownImageTarget` / `markdownMediaUrl` / `desktopFileUrl` / `createMarkdownPathImages`，
  `resolveLocalMediaDest` 共用同一路径解析（含一次百分号解码）；桌面分支先用会话 cwd 把
  相对目标补成绝对路径（无 cwd 时退回 alt 文本，而不是发一个必然 400 的 URL）。
- `src/client/markdown-labels.tsx`：`markdownTextProps` 透传可选 `pathImages`。
- `src/client/TextEditor.tsx`：`htmlMedia` 用页面 base + `pathImages`；预览不再重写图片目标。
- `src/client/MarkdownHtml.tsx`：markdown run 只跑链接 pass，`media.pathImages` 透传给
  MarkdownText / mermaid chunk。
- `src/client/mermaid-blocks.ts` / `src/client/mermaid.tsx`：chunk props 透传 `pathImages`。
- `src/client/changes/DiffPane.tsx`：阅读模式同样传 `pathImages`（`filePath` 用绝对路径）。
- `src/client/markdown-navigation.ts`：链接 pass 跳过图片引用的定义。

## 验证

- `tests/markdown-images.spec.ts`：目标解析；浏览器/反代前缀/`dsh-app://app/` 三种 base
  （桌面壳走 `dsh-app://app/api/file?path=`）；**相对 tab 路径在桌面壳里必须补成绝对路径**
  （无 cwd 时返回 undefined）；一次百分号解码；raw HTML 分支。
- `tests/markdown-html-render.spec.tsx`：真实 `MarkdownText` + `pathImages`，断言
  **`dsh-app://app/` 页面下 markdown 图片渲染为 `dsh-app://app/api/file?...`、raw HTML 图片
  渲染为 `dsh-app://app/sidebar/file?...`**（修复前是 alt 文本）；http 页面现有断言逐字不变。
- `tests/markdown-navigation.spec.ts` / `tests/markdown-crlf.spec.ts`：图片引用定义不被
  链接 pass 改动，普通链接定义仍被钉住不可点；CRLF 与 LF 逐字一致。
- `pnpm typecheck` / `pnpm lint` / `pnpm build` / 全量 `pnpm test`。

## 已知边界

- 侧边对话转录、任务窗口等**其它** markdown 表面没有挂 `pathImages`，其中的本地图片行为不变
  （修复前后都回退 alt 文本）；本 PR 只覆盖编辑器预览与变更阅读窗。
- 桌面壳的 markdown 图片走宿主 `api/file` 路由（与内置文档预览一致）；原始 HTML 图片走
  插件自己的 `/sidebar/file` 路由（普通 DOM，不参与渲染器白名单）。
