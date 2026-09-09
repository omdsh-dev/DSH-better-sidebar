# 编辑器未保存草稿保护 + 保存冲突检测 + 内置查找替换

> 状态：已实施（2026-09-09）。三项改动都在内置文本编辑器/侧边栏这一侧，不改 `ctx.betterSidebar` 的服务方法签名，不碰 DSH 源码。

## 1. 背景

三个独立但相邻的问题，都出在「编辑器与磁盘」的边界上：

| 问题 | 现象 | 根因（实施前） |
|---|---|---|
| A 草稿静默丢失 | 关闭标签页 / 删文件 / 刷新页面，未保存的编辑直接消失 | 脏稿确认只挂在**手动刷新按钮**上（`EditorHost.refreshFile`）；关 tab 走 `closeTab`，删文件走 `closePathTabs`，两者都不问；全仓库无 `beforeunload` |
| B 保存覆盖他人写入 | 模型（或另一个标签页 / 外部编辑器）改了同一个文件后，用户在旧草稿上 `Ctrl/Cmd + S`，对方的字节被静默覆盖 | `fs.write` 无并发基线；客户端也没有 mtime 概念 |
| C 并发写互删临时文件 | 同一文件两次保存同时进行时，其中一次报 `ENOENT` | 临时文件名固定为 `${path}.dsh-sidebar-tmp-${process.pid}`，先完成者的 `rm(tmp)` 会删掉后完成者的临时文件 |
| D 编辑器没有查找替换 | `Ctrl/Cmd + F` 无反应 | `@codemirror/search` 在 `dependencies` 里但 `src/` 零引用（依赖白装） |

## 2. 设计

### 2.1 脏稿登记表（`src/client/editor-dirty.ts`，新增）

模块级 `Map<tabId, {sessionId, path}>` + 监听器集合 + 单调 `revision`（供 `useSyncExternalStore` 取稳定快照）。写入方只有一处：`EditorHost` 的工具栏报告已经带 `dirty`，直接转发即可（不为外部 viewer 造新契约）。

```ts
setEditorDirty(tabId, dirty, sessionId, path)  // 登记 / 清除（相同条目不抖动 revision）
clearEditorDirty(tabId)                        // 宿主卸载
isEditorDirty(tabId) / dirtyCount() / dirtyCountForSession(sessionId)
confirmDiscardDraft(tabId, message)            // 统一确认入口
subscribeEditorDirty(fn) / editorDirtyRevision()
```

`EditorHost` 的登记 effect 依赖 `[tab.id, toolbar?.dirty, scope.sessionId, path, isDir]`，**卸载时 `clearEditorDirty`**——tab 关闭、会话切换、就地换文件都会经过卸载，因此条目不会比草稿活得更久。

### 2.2 三个关闭路径共用一次确认

| 路径 | 接线 |
|---|---|
| 标签页 X / 中键 / 右键菜单「关闭（其他/左/右）」 | `Sidebar.actions.closeTab` 开头 `if (!confirmDiscardDraft(tabId, t('closeUnsavedConfirm'))) return` |
| 文件树删除（含目录递归关闭） | `closePathTabs(ctx, store, target, message)` 内部逐个 `confirmDiscardDraft`；文案由调用方（`EditorHost.onPathDeleted`）传入，`tree-mutations.ts` 保持无 i18n 依赖 |
| 浏览器刷新 / 关页 / 导航 | `Sidebar` 的 `beforeunload` 监听：`dirtyCount() === 0` 时直接放行；`dirtyCount()` 而非当前会话，因为页面整个要走了 |

`confirmDiscardDraft` 在确认后**立即清除条目**，因此同一次关闭动作里「右键菜单连续关闭多个脏 tab」不会对同一个 tab 重复弹窗。拒绝删除时标签页保留（其下一次保存会重建文件——这是用户的决定）。

### 2.3 保存的乐观并发门（`fs.write`）

协议（向后兼容，两个字段都可省）：

```
fs.read  → { kind: 'text', content, truncated, mtimeMs }        // 新增 mtimeMs
         | { kind: 'binary', size, truncated, mtimeMs, head }
fs.write → { path, content, expectedMtimeMs? }
         ← { ok: true, mtimeMs }                                 // 新基线
         ← 409 { code: 'fs-conflict' }                            // 基线不符
```

- host：`expectedMtimeMs` 存在且与 `stat(path).mtimeMs` 不等 → `SidebarError('fs-conflict', …, 409)`，**在写临时文件之前**判定，不留垃圾。文件不存在（`stat` 失败）视作无基线。
- client：`EditorHost` 把 `fsRead` 的 `mtimeMs` 透传进 `FileViewerProps.mtimeMs`；`TextEditor` 用 `mtimeRef` 持有它（`null` = 文件原本不存在），保存成功后采纳响应里的新基线。
- 冲突表现：`saveState` 回到 `idle` + 一条警告横幅（文案 `saveConflict`）+「重新载入」按钮 → `FileViewerProps.onReload` → `EditorHost.refreshFile`（那条已有的、会先确认脏稿的刷新路径）。**草稿不丢**。

### 2.4 并发写互删修复

临时文件改为 `.${basename(path)}.dsh-write-${randomUUID()}.tmp`（`fs-operations.ts` 上传路由的同款做法）：每次保存有自己的临时兄弟文件，任何一次 `rm(tmp)` 都只可能删到自己的。

### 2.5 内置查找/替换

`TextEditor` 的 CodeMirror 扩展增加 `search({ top: true })` + `searchKeymap`（`Ctrl/Cmd+F`、`Ctrl/Cmd+H`、`Ctrl/Cmd+G`…），并用 `EditorState.phrases.of(...)` 把面板文案接进本插件词典（CodeMirror 默认只有英文）。工具栏新增放大镜按钮：预览态下先切到编辑态再开面板（面板挂在 CodeMirror 表面上）。文案在打开面板时求值，切换语言后下次 `Ctrl/Cmd+F` 即生效。

## 3. 测试

| 文件 | 覆盖 |
|---|---|
| `tests/editor-unsaved-guard.spec.tsx`（新，8 例） | 登记表语义（幂等 / 换文件重指向 / 订阅）；`EditorHost` 登记与卸载清理；**真 Sidebar** 下取消保留 / 确认关闭 / 干净不弹窗；`confirmDiscardDraft` 分支；`closePathTabs` 的拒绝与确认 |
| `tests/fs-write-route.spec.ts`（新，5 例） | 并发同路径保存无交叉删除、无残留；重复保存；基线不符 409 + 对方字节存活；基线相符成功并回报新基线；省略基线仍可写（旧调用方） |
| `tests/text-editor-conflict.spec.tsx`（新，4 例） | 发送基线 mtime；`fs-conflict` 显示横幅且草稿保留、「重新载入」回调触发；普通失败不显示冲突横幅；成功后采纳新基线 |
| `tests/text-editor-search.spec.tsx`（新，4 例） | 工具栏按钮开面板并切到编辑态；en / zh 文案；`Mod-f` 打开面板 |
| `tests/locales.spec.ts`（既有） | 每个第三语言词典与 zh 键集相等（新增 12 个 key 已同步 19 个词典） |

## 4. 已知偏差与取舍

- **`fs.write` 的基线不是内容哈希**：mtime 足够挡住「模型改了文件」这类秒级以上的改动，且零额外 IO；同一毫秒内的并发写仍可能双双通过（此时以最后一次 rename 为准）。要更强一致需内容哈希，代价是每次保存多读一遍文件，暂不引入。
- **Windows 上并发 rename 可能报 EPERM**（文件被杀软/句柄短暂占用）：这是平台行为，与本次修复的「互删临时文件」无关；`tests/fs-write-route.spec.ts` 的并发用例显式允许 EPERM 但拒绝 ENOENT，并断言无残留。
- **外部 viewer 不参与脏稿保护**：只有内置文本编辑器会报告 `dirty`。第三方 viewer 若想接入，需要自己调用 `setEditorDirty`（当前未开放为服务 API，因为还没有第二个真实消费者）。
- **跨会话切换不弹窗**：切换会话时未保存草稿会随组件卸载消失。页面级 `beforeunload` 覆盖了「关页/刷新」，会话内切换留待有真实需求时再加（会话切换本身是用户主动且可预期的操作）。
- **未做跨文件搜索**：`Ctrl/Cmd+F` 只作用于当前编辑器；按仓库既定理念，跨文件代码搜索留给生态插件（`pluginCodeNav`）。
