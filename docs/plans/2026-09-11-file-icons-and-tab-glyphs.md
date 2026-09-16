# 文件图标与彩色 Tab 图标（v0.19.1，#531 + #594 合并后的重做）

日期：2026-09-11　分支：`feat/dsh-0.1.5-rc.2`（并入 PR [#626](https://github.com/omdsh-dev/DSH-better-sidebar/pull/626)）

## 背景与决策

[#611](https://github.com/omdsh-dev/DSH-better-sidebar/issues/611) 希望文件树按类型显示图标（「仿照官方做法」），[#429](https://github.com/omdsh-dev/DSH-better-sidebar/pull/429)（@fenter）为此做了 563 条彩色图标数据，落成两个叠着的 PR：

- [#531](https://github.com/omdsh-dev/DSH-better-sidebar/pull/531)（`feat/file-icons-api`，base=main）：文件树/文件 tab 按扩展名分图标 + 对外 `registerFileIcon` API；
- [#594](https://github.com/omdsh-dev/DSH-better-sidebar/pull/594)（`feat/file-icon-theme`，base=#531 分支）：在其上叠「内置单色 / 彩色品牌图标」可选主题，彩色数据做成懒加载 chunk（255 kB）+ 设置页开关。

两者在 2026-09-08 都绿，但都基于 v0.18.1、落后 main 55 个 commit，且与 DSH 0.1.5-rc.2 的一个新事实冲突：**rc.2 的 `ui-primitives` 已经导出官方文件类型图形** `FileTypeIcon` / `CodeFileIcon`（48 类全彩代码/配置图形 + 12 类类目色板图形 + `classifyFileType` 分类器）。也就是 #611 想要的东西上游自己做了。

用户决策（2026-09-11）：**两个 PR 都合、并进 v0.19.1 一个 PR；文件图标改用宿主官方 `FileTypeIcon`；内置 tab 图标彩色 + 原生右侧栏芯片也加图标；删掉主题开关，彩色即唯一行为。**

## 上游事实（实测，非推断）

| 事实 | 证据 |
|---|---|
| 宿主导出官方图形 | `@deepseek-ai/dsh-client-ui-primitives@0.1.5-rc.2` 的 `lib/types/index.d.ts` 导出 `FileTypeIcon`、`classifyFileType`、`fileExtension`、`CodeFileIcon`、`isCodeFileType` 与 `CodeFileType` 类型；`FileTypeIcon` 声明 `size` 默认 28 并透传给内部 `FileGlyph`/`CodeFileIcon`（14px 树行可用） |
| 全彩图形保留自己的调色板 | `CodeFileIcon.d.ts` 的文档原话「its identifying palette intact」；`kind:'folder'` 落宿主的 `IconFolderClose16`（单色，随 `currentColor`） |
| 分类器不返回文件夹 | `classifyFileType` 只走 `classifyCodeFileType ?? NAME_TYPES ?? EXTENSION_TYPES ?? 'other'`，`'folder'` 只能由调用方以 `kind` 显式指定 |
| 官方图形在 rc.1 就有 | `npm pack @deepseek-ai/dsh-client-ui-primitives@0.1.5-rc.1` 的 tarball 内含 `lib/FileTypeIcon.module.css` 与 `lib/types/{FileTypeIcon,CodeFileIcon,code-file-types}.d.ts`（rc.2 只是把 SVG 数据拆进 `code-file-icon-artwork.ts`） |
| 原生 tab 定义没有 icon 字段 | `dsh-client-ui-sidebar-right` 的 `SidebarRightTabDefinition` 只有 `id/kind/patterns/priority/canOpen/title/guide`；`icon` 只在 `SidebarRightGuideEntry` 上 |
| 但 title 槽就是芯片内容 | 宿主 `contract/slots.d.ts`：`'sidebar.right.pane.tab.title'` —— 「A tab's title as its chip (and a floating panel's header) shows it」 |

## 合并（3 处冲突，均为注释/列表并集）

| 文件 | 冲突 | 解法 |
|---|---|---|
| `src/client/service.ts` | ① import 区（main 保留 `extOf`，PR 侧已改成 `baseName, extOf` + 自己的 `isNarrowWidth`）② `SIDEBAR_FEATURES` 注释与列表（main 写「v0.19.0 删除了 floatWindows」，PR 侧在旧清单上加 `'fileIcons'`） | ① 取 `baseName, extOf`：`isNarrowWidth` 属于 PR 自己的「新建会话按视口折叠」逻辑，main 已把那套 seeding 重写掉，合并后该 import 是死代码（实测 grep 确认后删除）。② 并集：保留「已移除 floatWindows」措辞 + 追加 `'fileIcons'` |
| `src/client/Sidebar.tsx` | `tabIconOf` 上方注释（两侧各改一句） | 并集：保留 main 的「The tab icon from the tab-type registry.」并补 PR 侧「带 path 的编辑器 tab 显示文件图标」的说明 |
| `docs/external-plugin-guide.md` | `features` 清单注释 | 并集：main 的新措辞（只增不删，唯一例外 v0.19.0 删除 floatWindows）+ `'fileIcons'` |

#594 的其余冲突（`tests/plugin-shape.spec.ts`、`tests/prefs.spec.ts`）**取本线一侧**：main 已删除这两个文件里的 store-seeding 用例并重写了 schema 断言（`SIDEBAR_PREFS_DEFAULTS` 解构），PR 侧重新加回的块描述的是 main 不再存在的行为——把旧块带回来只会测到死代码。

## 重做（把 #594 的彩色实现换成宿主官方图形）

### 删除

- `src/client/chunks/file-icons.tsx`（563 条数据）、`src/client/file-icon-theme.ts`（chunk loader）、`tests/file-icon-theme.spec.tsx`；
- `fileIconTheme` pref 三处（`prefs-shared.ts` / `src/config.ts` / `src/client/prefs.ts`）、设置页「文件图标」select 行、20 份词典里的 6 个 `settingsFileIconTheme*` key（共 126 行）；
- chunk 注册三处（`src/bundle-route.ts` 的 `CHUNK_NAMES`、`src/client/chunk-loader.ts` 的 `ChunkName`、`tsdown.config.ts` 的 `CHUNKS` 与 react-icons alias）与对应测试期望（`bundle-route.spec.ts` / `manifest-consistency.spec.ts`）；
- `src/client/index.tsx` 里驱动主题 loader 的 effect。

### 新增/改写

| 位置 | 内容 |
|---|---|
| `src/client/file-icons.tsx` | `builtinFileIcon(path, size)` → `<FileTypeIcon path size />`；`builtinFolderIcon` → `<FileTypeIcon kind="folder" size />`（宿主只有一个文件夹图形，开/合两态不另画）；`fallbackFileIcon(size)` → `<FileTypeIcon kind="other" size />` |
| `src/client/service.ts` 的 `fileIcon` 链 | 具体注册 → **catch-all 全局默认 → 宿主图形**（原先 built-in map 排在 catch-all 之前） |
| `src/client/builtins/tab-icons.tsx` + `.module.css` | 六个内置类型 + diff 视图的彩色 glyph；颜色全部 `var(--dsw-alias-*)`（files=brand、changes=success、tasks=warn、sidechat/browser=business、terminal=label-primary，各带 fallback 链） |
| `src/client/native/tab-adapter.tsx` 的 `NativeTabTitle` | 渲染 `[glyph][title]`：编辑器 tab 带 path 时用 `service.fileIcon(path, 14)`，其余用 `descriptor.icon(14)`；glyph `aria-hidden`；`NativeTitleInjected` 增加 `service` 与 `descriptorId`，`registerSlots` 的 title 注入同步 |
| `src/client/sidebar.module.css` | 新增 `.chipIcon`（芯片 glyph 的排版，颜色继承） |
| `tests/theme.spec.ts` | 豁免段整体删除，改为三条守护：图标模块零颜色字面量、`tab-icons.module.css` 里每条 `color` 都解析到 `var(--dsw-`、`src/client/chunks/*` 不含 6 位颜色字面量（图标数据不得再做回 chunk） |
| `tests/file-icons.spec.tsx` | 内置断言从 codicon 身份改为宿主 `FileTypeIcon`；新增「path/size 透传」「文件夹用 `kind:'folder'`」；catch-all 用例改写为「注册了 catch-all 就接管全部未具体命中的行」 |
| `tests/native-surface.spec.ts` | 新增 3 例芯片 glyph：descriptor glyph 在标题前、编辑器 tab 用文件图标而非类型图标、类型注销后只剩标题 |

## 语义后果（必须写进文档）

**宿主分类器覆盖任意路径**，因此「插件自己已经能画这个扩展名」不再是拦住 catch-all 的理由：注册 `exts: []` 的插件现在会接管所有未具体命中的文件行（原先会被内置 map 拦下）。旧版彩色主题那种「整表注册、靠内置 map 兜底」的形态不再成立——只想补几个类型的插件用 `exts`/`names`。已写进 [指南 §7](../external-plugin-guide.md) 与 [AGENTS.md](../../AGENTS.md) §5。

## 验证

**已执行（macOS arm64，DSH 0.1.5-rc.2 钉版）**

- `pnpm typecheck` / `pnpm lint` / `pnpm check:consumer-types` 全绿；
- `pnpm test` = **127 files / 1343 passed / 9 skipped**（v0.19.1 基线 126/1312 + 合并与新增的 31 例，失败数 0；返工后 +1 例 glyph 身份断言）；
- `pnpm build`：`lib/client.js` **0.85 → 0.86 MB**（+10 kB），**没有** `lib/client-file-icons.js`；核心 bundle 内不含图标数据（只有 6 个被引用的 glyph 组件）；
- 真机挂载冒烟（`DSH_CMD` 指向 `@deepseek-ai/dsh@0.1.5-rc.2`）：`pnpm test:mount` **7 passed**（含 guide 深扫、tab 体填充断言、mermaid/README 预览、sidechat 路由），`pnpm test:mount:aggregate` 通过。

### 真机反馈的两处返工（用户人工验证后）

| 反馈 | 结论与改动 |
|---|---|
| 「任务管理」图标不对——该页是 subagent + 后台 jobs，不是 todo | `VscTasklist`（清单）→ **`VscLayers`**（多层堆叠 = 后台在跑的工作）。`tests/builtins.spec.ts` 用 glyph 身份把这条读法钉住 |
| 终端图标「非常怪」 | 根因是**观感权重**：`VscTerminal` 是整套里最宽的实心矩形，在 14px 下比邻座重。**只缩小一档**（`0.85 × size`，下限 10px）——形状与绘制方式保持图标集原样 |
| 追加反馈：上一版给全部 tab glyph 加的 `currentColor` 发丝描边（`strokeWidth: 1` + `non-scaling-stroke`）「太粗」 | **整体回退**：不描边，glyph 只用包裹类的令牌着色。“描边”是我对「怪」的过度解读，反馈的本意只是终端尺寸。`tests/builtins.spec.ts` 现在同时钉住「终端尺寸更小」与「glyph 不带 style 覆盖」，防止描边再溜回来 |

### 真实 CI（已收敛）

`ci` / `plugin-mount` 每轮都绿；`ci-windows` 的 worker 回收竞态在 `--maxWorkers=1`（单 fork、零回收）下**连续三次全绿**：run [34575721734](https://github.com/omdsh-dev/DSH-better-sidebar/actions/runs/34575721734)、[34576146970](https://github.com/omdsh-dev/DSH-better-sidebar/actions/runs/34576146970)、[34576493202](https://github.com/omdsh-dev/DSH-better-sidebar/actions/runs/34576493202)，均 **127 files / 0 errors**。两轮迭代（`--maxWorkers=2` 被真实结果证否）的取证见 [rc.2 计划 §B](./2026-09-10-dsh-0.1.5-rc.2-adaptation.md)。

**待验证**

- 3080 人工验证（返工后第二轮）：树行与编辑器 tab 的彩色图标、指南六行彩色、原生右侧栏芯片图标、14px 下官方 48 类图形的可读性、以及这次返工后的任务/终端两个图标（用户此前明确选择用官方图形；若细节折损不可接受，回退方案是「树行用官方图形、编辑器 tab 保留插件 glyph 着色」，改动只在 `file-icons.tsx` 一处）。

## 不做

- 不改 DSH 源码；不把 #429 的 563 条数据搬回仓库（要走按需加载也应按懒加载 chunk 走，而不是常驻数据）；
- 不为彩色图标新增皮肤契约豁免（插件侧零硬编码颜色）；
- 不恢复 `floatWindows`；不动已合入的 rc.2 基线结论与 CI 修复。
