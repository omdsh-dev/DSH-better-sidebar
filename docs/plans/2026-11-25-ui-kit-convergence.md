# 统一 UI 组件层收敛：地基与批次规划（2026-11-25）

> 目标：把 `src/client` 里还没接统一组件层（`src/client/ui/index.ts`）的页面盘点清楚，按风险分批，
> 并为跨页面的重复模式补齐共享件。本文是分批施工的地图，不是逐文件的实施记录。

## 结论

- 存量 `src/client/**/*.tsx` 共 119 个；已 import 统一层（`ui/` 任意模块）的 60 个，`ui/` 自身 10 个；
  扣除 `clues/`、`changes/`、`native/` 三个已接入目录后，**剩余 36 个未接入**。
- 36 个里 **22 个是纯技术件（A）**，不该接组件层（chunk 入口、图标、描述符、iframe、portal、分发器）；
  **12 个有现成等价组件（B）**，**2 个缺共享件（C）**。
- C 类只需造 2 个件：`FallbackPane`（pane 级兜底消息）与 `DownloadLink`（下载出口），
  本轮已落进 `src/client/ui` 并从 `index.ts` 导出；另有 2 个**部分接入**文件（`PdfView`、`LargeFileView`）
  只差 `DownloadLink`，已列为同批收编对象。
- 批次按风险从低到高：**B1 任务/作业 → B2 侧边对话 → B3 标签页与预览宿主 → B4 文件树与侧栏外壳**。

## 盘点口径

```sh
# 未 import 统一层的 tsx（排除已接入目录与 ui/ 自身）
comm -23 \
  <(find src/client -name '*.tsx' | grep -vE '/(clues|changes|native|ui)/' | sort) \
  <(grep -rl "from '[^']*/ui[/']" src/client --include='*.tsx' | grep -vE '/ui/' | sort)
```

口径只认「是否 import 了 `ui/` 下的任意模块」，因此**部分接入**的文件不会出现在名单里：
`PdfView.tsx` 只引了 `ui/LoadingIndicator.tsx`，`LargeFileView.tsx` 引了 `ActionButton` 等，
两处仍手搓下载链接，单独补充在 B3 里。

## 映射表

### A 类：纯技术件，不接组件层（22）

| 文件 | 依据 |
| --- | --- |
| `chunks/editor.tsx`、`chunks/terminal.tsx`、`chunks/mermaid.tsx`、`chunks/locale.tsx` | 懒加载 chunk 入口，只 re-export |
| `mermaid-lazy.tsx`、`terminal-lazy.tsx` | chunk 包装器，无自有 UI |
| `icons.tsx`、`activity-icons.tsx`、`file-icons.tsx`、`builtins/tab-icons.tsx` | 图标集（宿主 `Icon*` 之外的品牌图标） |
| `markdown-labels.tsx` | 宿主 `MarkdownText` 的 props 工厂 |
| `SidechatAssistantRow.tsx` | 包一层宿主 `MarkdownText`，无自有 chrome |
| `HtmlPreviewFrame.tsx` | iframe 传输层（沙箱 / 内联 / blob） |
| `MarkdownHtml.tsx` | 纯 Markdown-HTML 段渲染器 |
| `selection-sidechat.tsx` | 会话与窗口接线，UI 全在 `SideChatView` |
| `windows/HostedWindow.tsx` | 纯 `createPortal` 到宿主窗口，无自有视觉（不是组件替换对象） |
| `sidebar/TabContent.tsx` | tab 分发器 + `+` 菜单构建 |
| `sidebar/bottom-toggle.tsx` | 槽注册（`conversation.session.header.utilities`） |
| `builtins/clues.tsx`、`builtins/viewers.tsx`、`builtins/tabs.tsx` | 描述符注册与设置项声明 |
| `index.tsx` | 插件入口 / 服务装配 |

### B 类：有现成等价组件（12）

> `builtins/media-preview.tsx` 归 C 类（需要新建件），见下一表。

| 文件 | 批次 | 目标组件 |
| --- | --- | --- |
| `tasks-shared.tsx` | B1 | `StatusLine` / `FactList`（`TaskLine`、`LiveLine` 的文本行） |
| `TaskWindow.tsx` | B1 | `Field` + `TextArea`/`TextInput`（`taskField/taskLabel/taskInput`）、`FactList`（`popKey/popValue`）、`ActionFooter`（`jobPopActions`） |
| `TasksGraph.tsx` | B1 | `ListRow`、`StatusBadge`、`Disclosure` |
| `SidechatImages.tsx` | B2 | `Notice`（inline）/ `StatusLine` |
| `SidechatAttachments.tsx` | B2 | `ListRow`、`Chip` |
| `diff/DiffFiles.tsx` | B3 | `ListRow`、`StatusBadge`、`ActionButton` |
| `diff/DiffRows.tsx` | B3 | 行壳 + `ActionFooter`（折叠） |
| `TerminalView.tsx` | B3 | `IconButton` / `ActionButton`、`Notice`、`StatusLine` |
| `OrphanedTab.tsx` | B3 | **本批已完成**：`FallbackPane`（`role="status"`）+ 既有 `EmptyState` |
| `Switch.tsx` | B4 | `controls.ToggleSwitch`（唯一消费者 `native/guide-order.tsx`） |
| `sidebar/dock-fallback.tsx` | B4 | `IconButton` / `ActionButton` |
| `split-pane.tsx` | B4 | `IconButton`（拖拽手柄保留原生 pointer 事件） |

### C 类：缺共享件（2，本轮已造件）

| 文件 | 新组件 | 消费者 |
| --- | --- | --- |
| `binary-download.tsx` | `FallbackPane` + `DownloadLink` | **本批已完成**（示范替换） |
| `builtins/media-preview.tsx` | 同上 | 待 B3 |
| `PdfView.tsx`（部分接入） | `DownloadLink` | 待 B3 |
| `LargeFileView.tsx`（部分接入） | `DownloadLink`（`inline` 变体） | 待 B3 |

## 本轮新增的组件

- **`FallbackPane`**（`patterns.tsx`）：pane 级「这里没有东西可渲染，出口在下面」的填充块——
  内层复用 `EmptyState`（`tone="page"`），外层负责 `flex:1` 与居中。签名：
  `{ icon?, title, description?, actions?, role?, className? }`。
  之前 `binary-download` 与 `media-preview` 各手搓一遍同款布局（一个 24/16 padding、一个 16 padding）。
- **`DownloadLink`**（`kit.tsx`）：真实 `<a download>`；`variant: 'button' | 'inline'`。
  `button` 是兜底面板里的描边胶囊，`inline` 是提示条里的下划线出口。
  此前四处各写一份（binary / media / PDF 工具栏 / 大文件提示条），其中三处共用同一个 `editorDownloadLink` 类。
- 两者都从 `src/client/ui/index.ts` 导出；样式只用 `--dsw-*` / `--ds-*` 令牌；
  测试补在 `tests/ui-patterns.spec.tsx`（`FallbackPane`）与 `tests/ui-kit.spec.tsx`（`DownloadLink`）。

## 示范替换（行为与文案不变）

| 文件 | 改动 |
| --- | --- |
| `src/client/OrphanedTab.tsx` | 正文从手写 `.editorPlaceholder` 换成 `FallbackPane role="status"`；标题栏保留；`my-plugin:db` / 标题文本不变（`tests/orphaned-tab.spec.tsx` 继续断言） |
| `src/client/binary-download.tsx` | 整页换成 `<FallbackPane title={t('binaryNoPreview')} actions={<DownloadLink …>} />`；删除自身 CSS 引用 |

## 风险与阻塞

- `windows/HostedWindow.tsx` 没有自有视觉（纯 portal），不在替换范围；建议里把它当示范是误判。
- `.editorPlaceholder` 仍被 `lazy-chunk.tsx`、`EditorHost.tsx`、`LargeFileView.tsx` 共用，
  本轮只换 `OrphanedTab` 的用法、不动共享类，避免同批改三处宿主。
- `Switch.tsx` 与 `controls.ToggleSwitch` 语义不同（原生 checkbox vs `button[role=switch]`），
  替换要同步改 `native/guide-order.tsx` 与相关测试，因此放 B4。
- 更名 / 删除 CSS 类属于行为面之外的视觉调整，一律放在「文件已确认无其他引用」之后做，
  本轮只删了 `binary-download` 独占的 `.editorBinary` / `.editorBinaryNotice`。

## 批次顺序建议

1. **B1 任务/作业**（`tasks-shared` → `TaskWindow` → `TasksGraph`）：模式最像 clues，收益最大。
2. **B2 侧边对话**（`SidechatImages` → `SidechatAttachments`）。
3. **B3 标签页与预览宿主**（`diff/*` → `TerminalView` → `media-preview` → `PdfView`/`LargeFileView` → `OrphanedTab` 收尾）。
4. **B4 文件树与侧栏外壳**（`Switch` → `dock-fallback` → `split-pane`）：直接动交互与布局，放最后。
