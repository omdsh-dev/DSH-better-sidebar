# 桌面壳 HTML 预览：沙箱子帧 403 与自包含内联

## 现象

- 桌面壳（`dsh-app://app/`）里从插件侧栏打开任意 `.html`，沙箱开启（默认）时预览区空白；关闭沙箱后同一文件正常。
- DevTools 里是 `GET dsh-app://app/sidebar/html/<session>/<path> 403 (Forbidden)`；插件 `/sidebar/html` 路由没有收到请求。
- 同一入口在浏览器（http 页面）正常；宿主自带 documentpreview 正常（Blob 内联，不产生文档级导航）。

## 根因

桌面壳的转发层只给满足以下条件的子帧请求注入 `x-dsh-desktop-renderer`：

```
request.resourceType !== "mainFrame"
request.frame.origin === "dsh-app://app"
```

插件的 HTML 预览 iframe 带 `sandbox` 且**没有** `allow-same-origin`，因此它是不透明源（origin 不是 `dsh-app://app`）。主文档导航就被壳拒绝，插件的 `/sidebar/html` 路由根本收不到请求。关闭沙箱后帧与页面同源，条件成立，所以“关沙箱就好”。

这不是插件路由或路径围栏的问题：路由的 workspace 解析、MIME、CSP 都正常，只是请求到不了。

## 方案

不删除沙箱、不加 `allow-same-origin`（那会让预览页与 GUI 同源、可读会话数据），也不改 DSH 源码。采用与宿主官方预览一致的形状：**顶层可信帧取回文档与本地静态资源，改写为自包含文档，再用 sandboxed `blob:` iframe 渲染**。

- 顶层帧的 origin 是 `dsh-app://app`，它的 `fetch('/sidebar/html/…')` / `fetch('/sidebar/file…')` 会被壳正常转发（带 launch cookie），因此能取到 HTML、CSS、JS、图片、字体。
- `src/client/html-preview-inline.ts`（纯函数）：
  - 只内联同协议/同 host/同 port 的资源；外部 http(s)、`data:`、`blob:`、`file:` 原样保留。
  - `<img>/<source>/<video>/<audio>/<track>/<input type=image>` 的 `src`/`srcset`/`poster` → `data:`。
  - 样式表 → 内联 `<style>`；CSS `url()` 与 `@import` 递归内联；脚本 → 内联 `<script>`。
  - 失败资源保留原作者引用；单个资源失败不让整页失败。
  - 输出 UTF-8 meta；补 `object-src 'none'` 的 meta CSP（保留原路由 CSP 的纵深防御）。
- `src/client/HtmlPreviewFrame.tsx`：浏览器与“关闭沙箱”的桌面路径保持 route-src；桌面 + 沙箱时 fetch → 内联 → Blob → `<iframe sandbox={HTML_IFRAME_SANDBOX} src={blobUrl}>`。组件负责 AbortController 与 object URL 的 revoke。
- 编辑器（`TextEditor`）与 changes 阅读视图（`DiffPane.HtmlRenderPreview`）共用该组件。

## 为什么不是更小的改动

| 方案 | 结论 |
| --- | --- |
| 继续 route-src | 主帧导航 403，路由收不到请求 |
| 只换 srcdoc / Blob，不内联资源 | 子帧发起的 `dsh-app:` 资源请求仍按不透明源 403 |
| 给 iframe 加 `allow-same-origin` | 预览页与 GUI 同源，安全边界被撤掉 |
| 让宿主 documentpreview 接管 | 插件 Files 页面用自有 viewer 注册表，宿主预览不是该入口组件；且会丢沙箱开关 |
| 顶层 fetch + 自包含 Blob（本方案） | 保留沙箱、无需 DSH 改动、与官方预览同路线 |

## 已知边界

- 嵌套 iframe、Web Worker、脚本运行时对相对 URL 的 `fetch`/XHR、ES module 的 `import` 仍不会自动改写；它们仍受壳的同源限制。文档本身与静态资源正常。
- `<a>` 的相对导航仍指向 Blob 文档，不会自动打开侧栏文件；这是预览而不是完整浏览器。
- 外部 http(s) 资源继续由浏览器直接请求，可能受其 CORS/证书/网络影响。

## 验证

- `tests/html-preview-inline.spec.ts`：同源解析、图片/srcset/poster、CSS import/url、脚本内联、失败保留、循环 import、UTF-8/CSP。
- `tests/html-preview-frame.spec.tsx`：浏览器 route-src、桌面 Blob + 精确 sandbox、卸载 revoke、失败回退。
- `tests/sandbox-views.spec.tsx`：现有 route-src 契约不回归。
- `tests/markdown-images.spec.ts` / `tests/markdown-html-render.spec.tsx`：`data:image` Markdown 与原始 HTML 均可渲染；`data:text/html` 仍拒绝。
- 真实宿主 + Chromium 的 `test:mount` 增加本地 PNG 与 `data:image` 的 Markdown 图片断言。
