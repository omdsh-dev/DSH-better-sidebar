# Markdown 文件预览配色主题

> 日期：2026-09-09
> 状态：已实现
> 范围：`dsh-better-sidebar` 插件，Markdown **文件预览**（`TextEditor.tsx` 的 `.editorMd`）；Side Chat 与 Changes 阅读模式**零改动**
> 基线：继续复用宿主 `MarkdownText`；不换渲染器、不硬编码颜色

## 1. 背景

宿主 `MarkdownText` 的配色跟皮肤令牌走，文件预览里标题/引用/表头等对比偏弱。用户反馈「颜色不够丰富，其他（字号/间距）还好」，且主题先只作用于文件预览。

## 2. 方案

`pluginSettings['markdown'].previewTheme`（声明式 `select`）：

| value | 含义 | 默认 |
|-------|------|------|
| `vivid` | 在 `.editorMd` 下用 `--dsw-alias-*` 拉高标题/引用/表头/分割线对比 | 是 |
| `host` | 不加配色覆写，还原宿主 MarkdownText | |

接线：`previewThemeOf` → `usePreviewTheme` → `data-md-preview-theme` on `.editorMd` → [sidebar.module.css](../../src/client/sidebar.module.css) 元素选择器（不依赖 `_markdown_*` 哈希类名）。

## 3. 刻意不做

- 不 fork / 替换 `MarkdownText`
- 不硬编码 hex/rgb
- 不把主题应用到 Side Chat / Changes
- 不引入第三方 markdown 主题 CSS
- 不改 CodeMirror 编辑态主题、mermaid、shiki 语法色
