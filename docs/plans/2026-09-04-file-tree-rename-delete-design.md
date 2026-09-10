# 文件树重命名 / 删除设计（2026-09-04）

> 状态：已实现。本文档记录功能设计、关键取舍与已知限制。

## 背景

文件树右键菜单此前只有打开/复制/上传下载等只读+导出操作，缺少资源管理器最基本的两个变更操作。本次补全：

- **重命名**：行内编辑（VS Code/Finder 惯例，用户已确认）——菜单点「重命名」后行内名字变输入框（预选中、Enter/失焦提交、Esc 取消）。
- **删除**：弹窗确认（用户指定）——复用 git lens 的 Cancel/Confirm Modal 范式，文件/目录文案区分，确认后永久删除。

同批修复二级菜单的视觉关系（见下节）。

## 服务端

- `src/fs-operations.ts` 新增 `renameWorkspaceEntry` / `removeWorkspaceEntry`（与 `writeWorkspaceUpload` 同层）：
  - **链路感知（link-aware）**：存在性与围栏校验对**完全解析后的目标**进行（fence 开启时指向工作区外的 symlink 一律拒绝），但操作本身作用于**词法行路径**——重命名/删除一个 symlink 行只改/删**链接本身**，绝不动目标（lstat 判定，link-to-dir 不会递归进目标）。与 VS Code 语义一致：行显示什么就操作什么。
  - `renameWorkspaceEntry`：`name` 必须单段（非空、非 `.`/`..`、无分隔符——重命名不是移动）；目标已存在直接 409 拒绝（POSIX rename 会静默覆盖）；工作区根本身不可重命名；同名 no-op 直接成功（不触发 409）。返回**规范路径**（realpath 解析后的祖先链）供 tab 改址。
  - `removeWorkspaceEntry`：目录递归删除、文件/symlink 解链；根拒绝。无回收站（宿主无此 API；等同 git lens discard 的永久语义）。
- `src/index.ts` 路由 `'fs.rename'`（`{path, name}`）/ `'fs.remove'`（`{path}`），走 `cwdOf` + `fenceEnabledOf(getSettings)`，与 `fs.write` 同一围栏开关。
- `src/client/api.ts`：`fsRename` / `fsRemove`。

## 客户端（FileTree）

- 菜单尾部（复制项之后）：`separator + 重命名(IconEditOutline16) + 删除(IconTrashOutline16, danger)`；**根行**（`rowMenu.path === cwd`）不渲染这两项（服务端双保险）。
- 行内编辑：命中的行换渲染为编辑行（同缩进/图标/行高），**无 role="button"**（编辑器不是点击目标，也避免 button 嵌套 interactive 的非法结构）。裸 `<input>`（primitives `Input` 不转发 ref，而 focus+select 正是要点）；ref 回调 `useCallback([])` 稳定身份——内联箭头每渲染重跑会把正在输入的缓冲区重新全选。Enter/失焦提交、Esc 取消；`isImeComposition` 守卫（IME 组合期的 Enter/Esc 属于输入法，不提交不取消——顺手把该守卫的入参 `isComposing` 放宽为可选，React 合成事件类型未声明该字段）。
- 删除确认：primitives `Modal`（git lens 同款 outline Cancel + primary Confirm）。
- 失败面：树顶一条可点消失的错误条（`role="alert"`），展示服务端原文（与 FenceErrorNotice 同策略）；客户端单段校验失败也走这里（`renameInvalid`）。
- **落定收尾 `pruneTree(prefix)`**：清掉旧路径前缀的所有缓存层 → `onToggle` 收起 stale 的 expanded 项 → `retryDir(parent)` 单层重载（无需整树 refresh tick）。重命名已展开目录后新目录折叠展示（expanded 不迁移，VS Code 同样）。

## tab 调解（tree-mutations.ts + EditorHost）

- `retargetPathTabs(ctx, store, old, new)`：`tab.path === old` → `service.updateTab(id, {path: new, title: baseName(new)})`（编辑内容存活，后续保存落到新路径）。
- `closePathTabs(ctx, store, target)`：`tab.path === target || isWithinWorkspace(target, tab.path)` → `service.closeTab(id)`（目录连整个子树的打开文件一起关）。
- tab 枚举覆盖 `state.splits` / `state.bottomSplits` / `state.floats`（浮动窗口的 tab 同样算打开）。走 service 路径（而非直改 state）使注册的生命周期回调照常触发。
- FileTree/TreePanel 透传 `onPathRenamed?` / `onPathDeleted?`（可选，测试可不接线）；EditorHost 两处 `<TreePanel>` 接线。

## 二级菜单视觉关系（layout.css，同批）

针对「二级菜单没有视觉关系」的反馈，两条纯 CSS 规则（仍以 `data-dsh-sidebar-submenu` body 属性限定作用域，宿主默认不受影响）：

1. **父行持续高亮**：宿主 Menu 在子菜单打开期间给父行按钮标 `aria-expanded="true"`（宿主已渲染、稳定），用同一 hover token 重新着色——指针移入侧卡后父行不再熄灭。
2. **卡片贴近**：子菜单与父卡间距 10px → 4px，`::before` 悬停走廊同步收窄；翻转规则（left/down）的间距一并 4px。规则排序：tether 基础规则在前、翻转覆盖在后（同特异性下源序决胜）。

`tests/menu-flip.spec.tsx` 的 layout.css 契约断言扩展覆盖这三条规则。

## i18n

新增 7 key（rename / renameInvalid / delete / deleteTitle / deleteDescFile / deleteDescDir / dismiss），zh/en/ja 手写；其余 18 个已发第三语言按 `locales.spec.ts` 的 key-set-parity 门禁同步补齐。

## 测试

- `tests/fs-operations.spec.ts`：rename（文件/目录/no-op 同名/单段违规/目标已存在 409/根拒绝/缺源/symlink 行改链接不改目标）、remove（文件/目录递归/symlink 只解链目标存活/根拒绝与缺路径）。
- `tests/file-tree-rename-delete.spec.tsx`（jsdom，mock api）：菜单项出现条件（文件/目录有、根无）；重命名流（预填→Enter 提交→`fsRename`+`onPathRenamed`、Esc 取消、非法名走错误条）；删除流（弹窗文案文件/目录区分、确认→`fsRemove`+`onPathDeleted`、取消、服务端失败进错误条）。
- 真机挂载冒烟（`pnpm test:mount`）不触达这些交互，由 CI 门禁与手动验收覆盖。

## 已知限制

- 无回收站：删除即永久（fence 开关不改变这一点，只改变越界拒绝）。
- 重命名不迁移 expanded/revealed 状态：改名已展开目录后新目录折叠、reveal 高亮不跟随（一次性视觉状态，成本/收益不划算）。
- 并发窗口竞争：存在性检查与 rename/remove 之间有微小 TOCTOU 窗口（单用户侧边栏场景可忽略；服务端错误会进错误条）。
- 「在其他编辑器里改名后本树 stale」既有行为不变（refresh tick / focus 刷新机制管）。
