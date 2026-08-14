# 快捷键系统（含侧边栏开/关）设计

**日期**：2026-08-14
**状态**：已实施（本文档含实施偏差记录）
**目标版本**：v0.12.0

## 1. 目标

1. **侧边栏开/关快捷键**：默认 `Ctrl/Cmd+B`（macOS = Cmd+B，其余 = Ctrl+B，即 `Mod+B`）在任意位置开/关右侧面板（当前会话的 `panelOpen`；无会话时 no-op）。
2. **快捷键可配置**：本插件全部三个键盘快捷键——开/关侧边栏、保存编辑（默认 `Mod+S`）、Git 提交（默认 `Mod+Enter`）——可在 DSH 设置页「Side card → 快捷键」分组中修改，持久化到 `SidebarPrefs.shortcuts`，**实时生效**。
3. 兜底行为：终端聚焦时快捷键让位（`Ctrl+B` 在终端里仍是控制字符 / tmux 前缀）；IME 组合中让位；已被其他处理器认领（defaultPrevented）的事件让位。

## 2. 非目标

- 鼠标交互（中键关 Tab）、组件内无障碍键处理（列表 Enter/Space/方向键、浏览器地址栏 Enter）不做配置化。
- 不做 DSH 全局快捷键页；不做 per-session 快捷键；不做冲突检测。
- 不改 DSH 源码；不加依赖。

## 3. 现状回顾

- 无任何全局快捷键；开/关面板只能点右上角按钮。
- 保存 = TextEditor 的 CodeMirror keymap 硬编码 `Mod-s`（默认 keymap 无 Ctrl-b，因此编辑器内 Ctrl+B 无既有含义）。
- Git 提交 = GitView 输入框硬编码 `(ctrlKey || metaKey) && Enter`。
- 设置页已有 text/number 行机制（v0.11.0 `FeatureSettingsRows` / `TypedRow`），可复用行式样与提交管道（`applyPref` → 乐观更新 → 失败回滚）。
- `SidebarPrefs` / `PrefsSchema` / `parsePrefs` 三处同步维护的既有惯例。

## 4. 设计

### 4.1 chord 语法与解析（新模块 `src/client/shortcuts.ts`）

- 语法：`修饰键+` 连接，最后一项是按键：`Mod+B`、`Ctrl+Shift+Enter`、`Cmd+S`。
- 修饰键（大小写不敏感）：`Ctrl/Control`、`Cmd/Command/Meta`、`Shift`、`Alt/Option`、`Mod`（平台主修饰键：macOS=Cmd，其余=Ctrl）。
- 按键：单个字母/数字，或具名键（Enter、Space、Tab、Escape、Backspace、Delete、ArrowLeft/Up/Right/Down、Home、End、PageUp、PageDown、Insert、F1–F12；接受 Esc/Del 别名）。
- **至少一个非 Shift 修饰键**（`Ctrl` / `Cmd` / `Alt` / `Mod`；`Shift` 可叠加），避免 `Shift+B` 等普通输入被全局劫持；匹配是**精确**的（`Ctrl+Shift+B` 不匹配 `Ctrl+B`）。Shift 字母按键在修饰键状态确认后忽略大小写（兼容 Caps Lock），Shift 数字优先按 `event.code=DigitN` 识别（兼容非美式键盘布局）。
- 纯函数：`parseChord` / `canonicalChord` / `displayChord`（Mod 按平台展开）/ `chordMatchesEvent` / `chordToCodeMirrorKey`（CM 键语法：所有 Shift 组合都显式编码 `Shift-`，让 CodeMirror 可按 keyCode 回退兼容键盘布局与 Caps Lock）/ `captureShortcutEvent`（将真实 keydown 转成录制结果）。

### 4.2 注册表与默认值

`SHORTCUT_DEFS`：`toggleSidebar → Mod+B`、`saveEditor → Mod+S`、`commitGit → Mod+Enter`（id 稳定，titleKey 走 locales）。`chordOf(store, id)` = 偏好覆盖或默认。

### 4.3 偏好扩展

- `SidebarPrefs.shortcuts: Record<string, string>`（开放 map，缺省 = 默认 chord），默认 `{}`。
- `PrefsSchema`：`z.dict(z.string()).default({})`（与 tabsEnabled 同模式）。
- `parsePrefs` 经 `normalizeShortcutMap` 校验：仅 canonical 合法的 chord 保留，非法项丢弃 → 回落默认。

### 4.4 消费点

- **开/关**：`registerSidebarToggleShortcut(store)` 注册 document bubble keydown 监听；让位顺序：IME（`isImeComposition`）→ `defaultPrevented` → chord 不匹配 → 目标在 `.xterm` 内（xterm 把 Ctrl+B 作为控制字符转发给 pty 且**不** preventDefault，目标检查是唯一防线）；命中则 `preventDefault` + `store.reduce(togglePanel)`。disposer 经 `ctx.effect` 注册（HMR 安全）。
- **编辑器保存**：TextEditor 用 `Compartment` 承载 keymap，chord 变化时原地 reconfigure（文档/撤销/滚动不丢）；chord 经 `props.store.subscribe` 实时同步。
- **Git 提交**：GitView 增加 `store` prop，keydown 时 `chordMatchesEvent(chordOf(store,'commitGit'), e)` 实时读取。
- **按钮 tooltip**：右上角切换按钮 tooltip 追加当前 chord（`折叠侧边栏 (Ctrl/Cmd+B)`）。

### 4.5 设置页 UI

- 「Side card → 快捷键」新分组：每快捷键一行（标题 + 操作提示 + 录制按钮）。显式激活按钮后捕获下一组「非 Shift 修饰键 + 最终键」（`Shift` 可叠加），修饰键按下过程实时预览，合法 chord 立即提交；裸键、仅 Shift 或不支持键给出行内反馈且不改设置，`Esc` / `Tab` / 失焦取消。录制 keydown 会 `preventDefault + stopPropagation`，避免正在修改的快捷键同时触发应用或浏览器动作；行仍按 `id:已提交值` 作 key（失败回滚 → remount 显示存储值）。
- 提交走既有 `applyPref` 乐观管道；shortcut 使用派生 patch 工厂，排队写真正执行时再基于最新成功的 store 合并，避免前一请求尚未完成时连续改两行而丢失第一项。

### 4.6 文案与文档

- locales（zh/en 键集相等）：`settingsShortcutsTitle` / `settingsShortcutDesc` / `shortcutToggleSidebar` / `shortcutSaveEditor` / `shortcutCommitGit`。
- README.md / README_EN.md 快捷键表：新增开/关行、Git 提交改 `Ctrl/Cmd + Enter`（与既有代码语义一致），并注明可配置位置与语法。

## 5. 测试策略

- `tests/shortcuts.spec.ts`（新，jsdom）：parse/canonical/display/match/CM 映射纯函数全矩阵；监听器：开关切换、无会话 no-op、默认 chord、.xterm 让位、defaultPrevented 让位、IME 让位、prefs 覆盖生效、preventDefault 断言、disposer。
- `tests/unit.spec.ts`：parsePrefs 对 shortcuts map 的校验/规范化。
- `tests/side-card-section-rows.spec.tsx`：ShortcutRow 交互（显式激活、修饰键预览、立即提交、无效键反馈、Esc/Tab 取消、事件隔离、失败回滚重挂载）。
- 全量 `pnpm typecheck` / `pnpm test` / `pnpm build`。

## 6. 实施步骤与提交边界

1. `feat(shortcuts): chord vocabulary, configurable prefs, and sidebar toggle shortcut`（shortcuts.ts + prefs 三处 + 相关测试）——chord 核心与偏好管道原子合一（parsePrefs 依赖 normalizeShortcutMap，无法独立编译）。
2. `feat(shortcuts): wire the sidebar toggle listener and show its chord in the tooltip`（index.tsx + Sidebar.tsx）。
3. `feat(shortcuts): make the editor save and git commit chords configurable`（TextEditor / GitView / tabs.tsx）。
4. `feat(shortcuts): settings rows to rebind every shortcut chord`（SideCardSection + locales + rows 测试）。
5. `docs: shortcuts design + README`（本文档 + README 双语文档）。

## 7. 实施偏差记录

- **Git 提交默认键**：原实现为 `(ctrlKey || metaKey) + Enter`（全平台双修饰）；新默认为 `Mod+Enter`（macOS=Cmd+Enter、其余=Ctrl+Enter）。macOS 上原 Ctrl+Enter 用户需在设置里改回——这是配置化的预期行为，README 已按 `Ctrl/Cmd + Enter` 表述。
- **提交边界**：计划中的步骤 1/2 合并为一步（见 §6）。
- **harness 流程**：本文档按仓库惯例提交在 `docs/plans/`（该目录被跟踪）；其余流程工件（requirements/plan/state）保留在仓库外，未污染 PR。
- **评审修复（独立 code review 一轮）**：① macOS 上 Meta+Shift 组合键 DOM 报未加 Shift 的 key（w3c-keyname ignoreKey / WebKit 174782），`keyMatches` 在该场景接受未加 Shift 的形式并加钉死测试；② GitView 提交 chord 命中时 preventDefault（可配置 chord 如 Mod+S/Mod+W 不得落到浏览器默认动作），提交输入框 placeholder 显示实时 chord；③ 切换监听忽略 `event.repeat`、无会话时不 preventDefault；④ chord 词汇拒绝 `Mod+Ctrl/Cmd` 冗余组合、接受旧版 Edge 的 Esc/Del/Left 事件拼写、删除冗余的 `SHORTCUT_DEFAULT_CHORDS`；⑤ 快捷键行提交改为在串行写真正执行时从最新成功 store 合并（连续两行提交不再互相覆盖，前一失败也不会被后一写复活）；⑥ 新增回归测试：mac Cmd+Shift、CapsLock、旧别名、repeat、document 目标、无会话默认动作保留、canonical 幂等、Enter 提交、独立无会话契约。
- **验收记录（独立验收：ACCEPT-WITH-NOTES）**：① 全局切换对输入框/弹窗焦点无专门守卫——按用户批准的"除终端外任意位置"范围是有意为之（终端是唯一让位面）；设置行内编辑时按下当前 chord 会触发切换，属已批准行为，不做守卫；② 编辑器保存按钮 tooltip 改为显示实时 chord（不再硬编码 Ctrl/Cmd+S）；③ 跨快捷键重复 chord 不做冲突检测（设计 §2 明确排除）。
- **安全审计（独立审计：LOW-RISK，无可利用项）**：① 用户自定义 chord 可能吞掉浏览器默认动作（如 Mod+W 关标签页）——设置 desc 增加冲突提示文案，不做强制冲突检测（与验收记录③一致）；② 平台检测缓存为模块级常量 `MAC_PLATFORM`（全局监听不再逐键读 navigator）；③ `normalizeShortcutMap` 显式过滤 `__proto__`/`constructor` 键并加测试钉死（无污染向量，纯卫生处理）。
- **录制式改键（用户后续要求）**：设置行由自由文本输入改为显式激活的按键录制器；保留既有 chord 存储、校验和实时生效管道，不新增依赖。录制器将真实 `Ctrl` / `Cmd` 精确写入（既有 `Mod` 默认值仅在展示时按平台展开），并保留至少一个修饰键的安全门。
