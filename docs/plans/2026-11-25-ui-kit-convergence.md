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
| `diff/DiffFiles.tsx` | B3 | **已完成**：`StatusBadge`（tone 直接用它自带的 `added`/`deleted`/`renamed`/`neutral`）；表头仍是原生 disclosure button |
| `diff/DiffRows.tsx` | B3 | **已完成**：展开全部改 `ActionButton`；折叠行保持原生（测试按 `[data-expandable]` 定位） |
| `TerminalView.tsx` | B3 | **已完成**：`StatusLine`（待连/已退出）+ `ActionButton`、`ErrorBlock`（不可用/错误）、`FallbackPane`（终端已失联） |
| `OrphanedTab.tsx` | B3 | **本批已完成**：`FallbackPane`（`role="status"`）+ 既有 `EmptyState` |
| `Switch.tsx` | B4 | **已完成**：删除自绘开关，唯一消费者 `native/guide-order.tsx` 改用 `controls.ToggleSwitch`（native checkbox + `aria-label` → button `role="switch"` + `aria-checked`） |
| `sidebar/dock-fallback.tsx` | B4 | **判断不接入**：本文件只有定位/让位逻辑，渲染的是一个定位 `<span>` 包壳与 `Sidebar.tsx` 的 `BottomDockToggle`，自身没有按钮或视觉件 |
| `split-pane.tsx` | B4 | **判断不接入**：纯布局与拖拽手柄（原生 pointer 事件 + 帧批处理），空面板卡片是整块可点的卡片形状，不是 `IconButton`/`ActionButton` 的语义 |

### C 类：缺共享件（2，本轮已造件）

| 文件 | 新组件 | 消费者 |
| --- | --- | --- |
| `binary-download.tsx` | `FallbackPane` + `DownloadLink` | **本批已完成**（示范替换） |
| `builtins/media-preview.tsx` | 同上 | **已完成**（B3）：`FallbackPane role="status"` + `DownloadLink` |
| `PdfView.tsx`（部分接入） | `DownloadLink` | **已完成**（B3）：工具栏 `DownloadLink` + 错误态 `ErrorBlock` |
| `LargeFileView.tsx`（部分接入） | `DownloadLink`（`inline` 变体） | **已完成**（B3）：`DownloadLink` + 空文件 `EmptyState` |

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

## B3 实施记录（标签页与预览宿主）

| 文件 | 实际改动 |
| --- | --- |
| `diff/DiffFiles.tsx` | 文件头徽标 `<span className={css.fileTag}>` → `StatusBadge`，`fileTag()` 从返回字符串改为 `{ tone, label }`；表头仍是原生 `button`，因为 `ListRow` 没有 `disabled` / `aria-expanded`，而这两条是折叠语义与 `tests/diff-*-*.spec.tsx` 的定位依据 |
| `diff/DiffRows.tsx` | 「展开全部」按钮 → `ActionButton size="sm"`；折叠行保留原生 div + `[data-expandable]`，因为测试按该属性点击并断言加载/失败标记 |
| `TerminalView.tsx` | 不可用告警 → `ErrorBlock`；待连/已退出状态行 → `StatusLine` + `ActionButton`；终端已失联（`role="alert"` + 新建终端）→ `FallbackPane`；连接错误 → `ErrorBlock` |
| `builtins/media-preview.tsx` | 不可播放提示 → `FallbackPane role="status"`；下载出口 → `DownloadLink` |
| `PdfView.tsx` | 工具栏下载 `<a className={css.editorDownloadLink}>` → `DownloadLink`；加载失败 → `ErrorBlock` |
| `LargeFileView.tsx` | 超大文件提示条里的下载 → `DownloadLink`；空文件占位 → `EmptyState tone="well"` |

缺口（留给后续批次，不动 `src/client/ui/**`）：

- `StatusLine.role` 只接受 `'status'`，没有 `'alert'` 变体；告警态因此由 `FallbackPane` 承担。若 B4 也要用，再统一给 `StatusLine` 加 `role` 联合类型。
- `ListRow` 缺 `disabled` 与任意 `aria-*` 直通，带折叠语义的行只能继续用原生 button。
- 未改任何测试断言：`diff-binary-row` / `diff-files-collapse` / `diff-fold-expand` / `editor-large-file` / `terminal-tab` / `lazy-chunk` 六个 spec（49 例）直接通过。

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

## B4 实施记录（外壳与残余件）

- **`Switch.tsx` → `ToggleSwitch`**：删掉自绘开关与 `Switch.module.css`，`native/guide-order.tsx` 改用组件层 `ToggleSwitch`。受控写回契约不变——下一次值仍由 prop 推导（`onChange(!checked)`），父级异步写回时开关不会被吞掉。`tests/switch.spec.tsx` 相应改名为 `tests/toggle-switch.spec.tsx`，断言从 `input[type=checkbox].checked` 改为 `[role="switch"]` 的 `aria-checked`；`tests/native-guide.spec.tsx` 两处开关查询（`Enable: Git`、`Show on the start page: A`）同步改选择器。
- **`sidebar/dock-fallback.tsx` 不接入**：这个文件的价值全在相位判定、让位走查与 500ms 重对齐，渲染部分是定位包壳 + `BottomDockToggle`（后者在 `Sidebar.tsx`，已有自己的实现）。硬套 `IconButton` 只会把包壳变成按钮，语义反而错。
- **`split-pane.tsx` 不接入**：`Divider` 是 pointer-capture 拖拽手柄（增量、帧批处理），`paneCard` 是整块空面板卡片，`TabBar` 有自己的组件。统一层没有对应形状，硬换会动交互。

结论：B4 实际只有一处组件替换，另两处按「没有语义对应的共享件就不换」保留，与 U1 盘点时把外壳件标为 B4 的预期不同——盘点看见的是「自绘视觉」，实际读下来这两处是布局与手势。

## 组件层补件记录（U2）

收敛过程中，接页面的批次报告了三处「两个以上页面需要、组件层却没有」的缺口。本轮只补组件层与契约测试，消费页面仍在各自批次分支上，切换留到合并后统一做。

| 缺口 | 来源 | 补的件 | 需要切换的消费点 |
| --- | --- | --- | --- |
| 非交互的静态文件附件卡（`FileTypeIcon` + 名称 + 大小 + 可选 title，不是按钮） | B2（`SidechatAttachments.FileChip` 手写一份；`SideChatView` 的交付物项实为可点击 button，见下） | `FileAttachmentChip`（`ui/kit.tsx`，导出 + `FileAttachmentChipProps`） | `src/client/SidechatAttachments.tsx`（已切换） |
| `StatusLine` 只能 `role="status"`，失败需要中断式播报 | B2/B3（错误行只能退回手写 `<div role="alert">`） | `StatusLine.role?: 'status' \| 'alert'`（默认行为不变） | 各批次的错误行 |
| `ListRow` 没有 `disabled`，也没法把 `aria-expanded` / `aria-controls` / `aria-label` 交给标题按钮 | B1（可折叠分组的表头） | `ListRow` 增加 `disabled` 与三个 aria 直通；`disabled` 落 `disabled` + `data-disabled`，aria 落按钮（plain 行落外壳） | B1 的 `tasks-shared` 分组头 |

补件后的约束没变：样式仍只走 `--dsw-*` / `--ds-*` 令牌，`tests/theme.spec.ts` 照旧扫描；三项契约测试分别在 `tests/ui-kit.spec.tsx`（`FileAttachmentChip` 2 例）与 `tests/ui-patterns.spec.tsx`（`ListRow` 2 例、`StatusLine` 1 例）。

### R2 合并与消费点切换（2026-11-25）

- 合并 `refactor/ui-kit-gaps`（`6f9dbdf4`）进地基分支，merge commit `935b674c`，无冲突。
- `SidechatAttachments.FileChip` 已换成 `FileAttachmentChip`，并删除随之零引用的 `.sidechatAttachmentFile`（先 grep 确认）；附件名称仍是原生 tooltip。
- `SideChatView.tsx` **没有**切换：它的「附件卡」是交付物列表里打开文件的 `<button>`（带 `aria-label` 与点击打开），与静态 chip 的「只读图片、不是控件」语义相反；换成 `FileAttachmentChip` 会丢交互，故保留。`tasks-shared` 的分组头同理（纯逻辑 + 卡内微行）。
- `DiffFiles.tsx` 的表头**保持原生 button**：它是「整个表头就是一个控件」的复合网格（chevron + 路径 + 旧路径 + 徽标 + 统计），`ListRow` 的标题按钮模型会把第二层行壳嵌在按钮里、改变几何与 hover/focus 样式；`ListRow` 新增的 `disabled`/aria 直通不解决这一点。
- `StatusLine` 的 `alert` 变体本轮没有消费点：B3 的两处 alert 分别是面板级失联（`FallbackPane role="alert"`）与通知条（`Notice kind="error" role="alert"`），都不是行级状态，保持原样。

仍然缺口但本轮没做（单点使用，按「只被一个页面用到的不要抽象」留下）：

- 图片缩略图的外链壳（`<a target="_blank"><img>`）只有侧边对话一处。
- 终端输出区、diff 行内部结构属于各自的渲染模型，不是页面 pattern，等 B3 报告是否需要形状级共享。
