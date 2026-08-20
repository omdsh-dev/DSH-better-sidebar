# 桌面端兼容统一方案：四选项下拉（自动检测 / DSH官方Web / 壳预设 / 自定义 CSS）

> 2026-08-20 · 对应分支 `feat/desktop-scheme-settings` · 关联 issue #257、#208、#103/#111；外部 PR #82/#89/#111/#153/#226/#243 处置见文末。

## 背景与问题

better-sidebar 的桌面端适配历史上是"每壳一条补丁"：右上角开关簇与原生标题栏按钮重叠（#87/#101）、点击被拖拽区吞掉（#103/#111）、推挤锚点随 DSH DOM 版本漂移（#208/#226/#262）、WCO 高度硬编码 32px 与实际不符（#257，Electron 版本间 32/36px 不一）。这些补丁全部针对**具体某个壳的 DOM/类名/数值**，换一个壳（Tauri、Pake、新壳）就失效或出错。

**全仓证据盘点**（121 issues + 159 PRs 全量 + 三个候选壳克隆取证）：

| 壳 | ⭐ | issue/PR 提及 | 形态 | 需要什么 |
|---|---|---|---|---|
| anywhere-labs/deepseek-harness-desktop | 16.3K | ✅ 大量 | Electron；advanced: win32 WCO 32px / darwin caption 20px；compat 原生框 | win32 已被标准 WCO 覆盖；darwin 20px 让位 |
| dataelement/dsh-desktop | 1.3K | ❌ 零提及 | Electron；win32 WCO 36px | 已被标准 WCO 覆盖 |
| Deepseek-Harness-EAC | 1.0K | ❌ 零提及 | Electron Win-only；自绘 36px 玻璃栏（私有标记 `data-dsh-title-bar-height`） | 无 WCO，需 36px 让位（文档示例） |
| hairyf Tauri 版 | 715 | ✅ pr#229 | Tauri2；44px 导航栏在 iframe **之上** | **无冲突**，无需适配 |

平台分布结论：兼容问题**不是 Windows 独有**（macOS 6 条、Web 3 条），但当前 main 上未闭环的 chrome 兼容基本就是 **Windows 顶栏**（WCO 几何 + 通用 no-drag 兜底）；macOS 的坏 bug（#25/#208）已修复。

## 决策

1. **核心只留 Web 标准机制**：WCO（`navigator.windowControlsOverlay` + `geometrychange`）是唯一"不是适配、是标准"的信号；`-webkit-app-region: no-drag` 是标准属性（普通浏览器/无拖拽区壳惰性无害）。核心代码 grep 不到任何壳类名。
2. **壳专属适配进用户空间**：「位置兼容模式」升级为**主行下拉**四选项：**自动检测（默认，保守，web 零修改）/ DSH官方Web（显式零适配）/ 壳兼容方案（内置预设，opt-in）/ 自定义方案（自由 CSS + 下移 px，保留齿轮弹窗）**。
3. **预设准入规则**：issue/PR 中被提及（链接或明确名称）且 GitHub ⭐>100 的壳；v1 仅 anywhere-labs（唯一同时满足者）。预设只做**标题栏 strip 让位**，不做布局推挤/壳类名（尊重"不特意兼容 DSH Desktop 高级模式"）。Tauri 无冲突只写文档；EAC 未提及但提供 custom CSS 示例。
4. 不向 anywhere-labs 提跨仓库 PR；不修改 DSH 源码。

## 实施

### prefs 模型（`src/prefs-shared.ts` / `src/config.ts` / `src/client/prefs.ts`）

- 新增 `titleBarScheme: 'auto' | 'web' | 'preset' | 'custom'`（默认 `'auto'`）、`titleBarPresetId: string`、`customCss: string`。`web` = 显式「DSH官方Web」，取值链最优先强制 0（连 WCO 也不适用）。
- schema 中三个新字段**无 default**（schemastery 验证：缺失字段不出现在解析结果里）→ `parsePrefs` 在字段缺失时由旧 `titleBarCompat` 派生：`true` → `custom`（保留 `titleBarStripPx`）；`false`/缺失 → `auto`。写路径镜像写旧字段（`titleBarCompat = scheme !== 'auto'`）供降级。

### 标准件（`src/client/wco.ts` + `src/client/titlebar-strip.ts`）

- `wco.ts`：模块级反应式 store（subscribe/getSnapshot，`useSyncExternalStore` 消费），特性检测 `navigator.windowControlsOverlay`，订阅 `geometrychange` 重读矩形（最大化/还原实时更新）；最后订阅者退订时解绑原生监听；`setWcoSourceForTests` 注入测试源。API 抛错视为 present+0（绝不崩布局）。
- `titlebar-strip.ts`（唯一决策点，纯函数）：**⓪ `web` 方案强制 0 → ① WCO 真实高度（权威，0 也权威；`visible=false` 幽灵 API 视为缺失）→ ② URL `dsh-desktop-titlebar-inset`（0–120 clamp）→ ③ 预设 `stripFor`（仅 preset 方案）→ ④ 手动 `titleBarStripPx`（仅 custom 方案）→ ⑤ 0**。结果驱动 `body[data-dsh-title-bar-compat]` + `--dsh-title-bar-strip`（CSS 契约不变）。
- `desktop-env.ts`：只做环境报告（desktop/mode/platform/titlebarInset），SSR 安全；移除旧 `win32OverlayTop` 硬编码。

### 预设与用户 CSS（`src/client/shell-presets.ts` + `Sidebar.tsx` effect）

- `ShellPreset { id; title; desc; stripFor?; css?; detect? }`；v1 一条 `dsh-desktop`：darwin advanced 20px、win32 advanced 32px（无 WCO 兜底）、其余 undefined；`detect` 仅用于设置页「已检测」徽标。
- 注入：预设 css → `<style data-dsh-preset-css="<id>">`；自定义 css → `<style data-dsh-custom-css="custom">`；追加到 `document.head` 末尾（后写胜出），fiber 卸载/变更即移除。
- 稳定寻址面：`[data-dsh-toggle-cluster]`、`[data-dsh-panel]`、`[data-dsh-bottom-panel]` data 属性。

### no-drag 兜底（`sidebar.module.css`）

`.toggleCluster` / `.toggleButton` / `.tabBar` 统一 `-webkit-app-region: no-drag`（吸收 #111/#153，补 #103 插件侧缺口）。

### Web 推挤锚点加固（`layout.css`）

复合选择器（同元素双保险）：`#root [data-dsh-frame] > [data-pane="conversation"]` 与 `#root :has(> [data-slot="conversation"])`；拖拽过渡/prefers-reduced-motion 同步；`drag-layout.e2e.ts` 新增两选择器同元素断言。

### 设置 UI（`SideCardSection.tsx` + locales）

「位置兼容模式」行改为**主行下拉**：自动检测（默认）/ DSH官方Web / 各壳预设（命中环境带「已检测」后缀，仅提示）/ 自定义方案（选中后行内出现齿轮，弹窗 = 下移距离 + CSS textarea（Cmd/Ctrl+Enter 提交））。

### 测试

- 单测：`wco.spec.ts`（7 例：检测/读取/取整/geometrychange 通知/抛错降级/换源）、`titlebar-strip.spec.ts`（取值链 5 例）、`shell-presets.spec.ts`（注册表完整性 + dsh-desktop strip 值）、`desktop-env.spec.ts`（重写：inset 参数 clamp + 移除 win32 硬编码）、`prefs.spec.ts`（新字段 + 旧字段迁移）、`plugin-shape.spec.ts`（schema 无默认值语义）、`smoke.spec.ts`（解析结果不含新字段）。
- e2e（`mount.e2e.ts` 重写桌面场景）：保守 auto（stamp 不触发修改 + data 属性 + no-drag 规则存在）、WCO mock 驱动 strip 且 geometrychange 反应、预设注入（settings.update 写入 scheme=preset → 32px + style 标签）、自定义 CSS 注入（marker 生效）；`drag-layout.e2e.ts` 复合锚点。

## 验证

- `pnpm typecheck` / `pnpm test`（691 passed）/ `pnpm test:mount` 全绿。
- 普通浏览器零行为变化（auto 无 WCO → 无 strip）。
- Electron WCO win32（mock 实测）：strip=真实高度（32/36），最大化/还原跟随。
- anywhere-labs darwin advanced：启用预设后 20px 让位。
- 核心代码 grep 无壳类名（`.dshDesktopFrame` 等仅存在于预设数据字符串与测试断言之外——v1 预设无 CSS，纯 strip 数据）。

## 实施偏差记录

- 无。计划与实施一致；仅补充：schema 新字段必须无 default 才能让旧文档迁移（否则 settings 服务会把 default 填进解析结果、吞掉迁移），`plugin-shape.spec.ts` 断言了这一点。

## 存量 PR/issue 处置（合并后执行，均含哲学声明）

- 实现后关闭：#257（WCO 标准件）。
- 关闭：#111/#153（no-drag 吸收）、#226（复合锚点吸收，main 已修）、#243（布局推挤不采纳；标题栏部分进 dsh-desktop 预设）、#108（#232 已吸收 + WCO）、#82/#89/#138（不采纳，指向自定义 CSS/预设路径）。
- 回复：#208（已修+回归）、#221（自定义 CSS 可微调）、#233（git.ts windowsHide 独立问题）、#167/#240（非 chrome 范畴/文档已有）。
