# 编辑器预览刷新三件套（issue #167）

日期：2026-08-19

## 问题（#167，无评论无修复）

`.md` 文件编辑保存后，切到预览不立即渲染新内容，需关闭文件重新打开。根因：`EditorHost` 的加载 effect 只依赖 `[sessionId, cwd, path, ctx, showEmpty]`——保存（fsWrite）与模式切换（setMode）都不重跑加载，且工具栏没有手动刷新入口。

## 方案（最小三件套，全部在 EditorHost.tsx）

| 编号 | 行为 | 实现 |
|------|------|------|
| A | 手动刷新按钮（文本类 viewer，即 toolbar 非空时显示） | 新增 `reloadSeq` state；effect 依赖加 `reloadSeq`；header 刷新按钮 `setReloadSeq(s => s + 1)` |
| B | 编辑保存后切回预览自动刷新 | header「预览」按钮 onClick：`toolbar.mode === 'edit'` 且非 dirty 且 saveState 非 failed → 先 `setReloadSeq(+1)` 再 `setMode('preview')`；dirty 时不刷新（草稿只在 CodeMirror 内，重载会丢） |
| C | 预览模式下保存成功后刷新 | 监听 `toolbar.saveState` 从非 `'saved'` 变为 `'saved'` 且 `mode === 'preview'` → `setReloadSeq(+1)` |

刷新语义：重载走既有 load effect（AbortController 会中止旧加载；重挂载后 TextEditor 内部 state 重置为 preview 模式——与「关闭重开」等价，但保留 tab 与面板状态）。

## 范围外（记录，不实现）

- LLM 改文件后自动刷新（磁盘指纹对比 + silent 不闪屏）——分形有先例，另行立项；
- image/pdf/binary viewer 的手动刷新（toolbar 为空，无入口；内容静态，低优先级）。

## 验证

- 单测：刷新按钮渲染 + 点击触发重载（mock fsRead 调用次数）；B 的 dirty 抑制；C 的 saveState 边沿触发；
- 手工：编辑 md → 保存 → 切预览即时渲染；预览模式 Ctrl+S 后刷新；刷新按钮任意 viewer 可用。
