# Issue #985 诊断：Linux 侧边栏打开 docx 报「无法显示 PDF：n.toHex is not a function」

**日期**：2026-11-21
**状态**：已诊断，结论为**宿主侧 / 客户端 JS 引擎版本问题**，本仓库不打补丁
**关联**：issue #985、`src/client/native/index.ts` 的 `HOST_OWNED_EXTS`（6586e3e2，v0.25.0 起生效）

## 1. 问题报告

[issue #985](https://github.com/omdsh-dev/DSH-better-sidebar/issues/985)（DSH Web 0.2.0-rc2、插件 0.25.0、浏览器访问）：Linux 下侧边栏打开 `.docx` 失败，面板显示「无法显示 PDF：n.toHex is not a function」+「重试」；同一文件在 Windows 正常。

## 2. 根因

两层，都不在本插件：

1. **docx 不归插件渲染。** `HOST_OWNED_EXTS`（`src/client/native/index.ts:73`）把 `doc/docx/ppt/pptx/pdf/xls*/csv/图片` 交还宿主：`canOpen` 对这些扩展名返回 false（同文件 :489-494），地址落到 DSH 内置预览。宿主把 Office 文档**转成 PDF** 再画出来（该文件 :53-59 的注释写明「the built-in converts them to PDF host-side」），所以 docx 的报错文案是「无法显示 PDF」。
2. **pdf.js 需要 `Uint8Array.prototype.toHex`。** 宿主打包的是 `pdfjs-dist 6.3.289`，它的 `PDFDocument.fingerprints` getter 直接调用 `[first.toHex(), second?.toHex() ?? null]`（pdf.js ≥5.6 起用该 API 算 document fingerprints）。`Uint8Array.prototype.toHex` 是 2024–2025 才落地的 API（Chrome 140 / Firefox 133 / Safari 18.2），旧 JS 引擎没有这个方法 → `TypeError` → 宿主 PDF body 用 `sidebarPdf.failed` 文案包一层，显示成「无法显示 PDF：n.toHex is not a function」。

**所以「Linux vs Windows」不是平台差异，是客户端 JS 引擎版本差异**：Windows 那侧是当前 Chrome/Edge，Linux 那侧多半是发行版自带的旧 Chromium、Firefox ESR 等。同一浏览器打开任意 `.pdf` 也会同样失败——与 docx、与 Office 转换都无关。

## 3. 证据

- **插件侧**：`HOST_OWNED_EXTS` + `canOpen` 的让位逻辑（`src/client/native/index.ts:73-93`、`:489-494`，`tests/native-surface.spec.ts` 钉住两个方向）。插件唯一的 PDF 视图是 Changes 面板的 `src/client/PdfView.tsx`——blob URL 塞进 iframe、交给**浏览器原生** PDF 阅读器，不经过 pdf.js，也不处理 docx；文件树里的 docx/pdf 一律落到宿主预览。
- **宿主侧**（在安装的宿主 bundle 内检索，桌面端为 `dsh-tauri/dependencies/dsh/*.asar`）：
  - 错误文案 `无法显示 PDF：{message}` 来自 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 的 `sidebarPdf.failed`；
  - `.toHex(` 在整个宿主 bundle 里只出现一次，就是 pdf.js 的 `fingerprints` getter：`return shadow(this,"fingerprints",[n.toHex(),a?.toHex()??null])`；
  - 同一 bundle 里 `pdfjsVersion = 6.3.289`，依赖清单 `"pdfjs-dist": "6.3.289"`。
- **上游**：pdf.js ≥5.6 用 `Uint8Array.prototype.toHex` 算 document fingerprints（第三方 polyfill 包 `pdfjs-serverless` 的 `polyfills.mjs` 注释点名）；[MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array/toHex) 与 [Web Platform DX](https://web-platform-dx.github.io/web-features-explorer/features/uint8array-base64-hex/) 都记 Chrome 140 / Firefox 133 / Safari 18.2 起可用。
- **版本不是变量**：让位逻辑 6586e3e2 是 v0.25.0 的祖先，reporter 的插件版本已经走宿主预览，升级插件不会改变这条路径。

## 4. 处置

- **本仓库不打补丁**：docx/pdf 由宿主预览拥有，插件侧没有 docx 渲染路径，也没有能替换宿主 pdf.js 的入口；改 DSH 源码是仓库硬约束禁止的；给全局 `Uint8Array.prototype` 打 polyfill 属于越界（红线「不写运行时兼容层」），而且会把宿主的问题藏起来。
- **宿主侧修法（转上游，二选一）**：给 pdf.js 的运行环境补 `Uint8Array.prototype.toHex`（pdf.js 官方不提供 polyfill），或在文档与错误文案里写清浏览器基线。
- **reporter 侧**：把浏览器升到 Chrome/Edge ≥140、Firefox ≥133、Safari ≥18.2 后重试。

## 5. 验证

本记录是诊断文档，无代码改动，不涉及 `pnpm test` / `typecheck`。证据链可复现：在安装的宿主 bundle 里搜 `无法显示 PDF`、`toHex`、`pdfjsVersion` 三处即可对上；反向判据是同一浏览器打开任意 PDF 同样报错、升级浏览器后恢复。

## 6. Issue #985 回复草稿（供 maintainer 发布/关闭用）

> 感谢报告。诊断结论：docx 预览由 DSH 内置的文档预览渲染——宿主先把 Office 文档转成 PDF，再用 pdf.js 6 画出来；pdf.js 6 依赖 `Uint8Array.prototype.toHex`，这个 API 要到 Chrome/Edge 140、Firefox 133、Safari 18.2 才有。你的 Linux 浏览器内核比这更旧，所以报 `n.toHex is not a function`，跟 Linux 本身无关（Windows 那侧浏览器够新）。
>
> 请把浏览器更新到上述版本后重试。同一浏览器里打开任意 PDF 也会是同样的报错，可以拿它验证。如果升级后仍复现，请回复浏览器名称与版本号，我们按宿主侧问题跟进。
