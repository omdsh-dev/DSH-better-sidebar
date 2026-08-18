# 皮肤兼容（令牌驱动）：面板表面、终端透明度回退与独立 CSS 修复

**日期**：2026-08-15
**状态**：已实施（本文档含实施偏差记录）
**目标版本**：随发布 bump（本 PR 不改版本号、不更新 README——发布流程统一处理）

## 1. 目标

让 better-sidebar 与 **dsh-web-ui 的皮肤中心**兼容：用户切换皮肤时侧边栏自动跟随换肤，零每皮肤适配（KISS：不做 aionui 式"每款皮肤 remap 一套令牌"的重活）。附带修复同批 CSS 问题（[#52](https://github.com/omdsh-dev/DSH-better-sidebar/issues/52) 弹出框遮挡、[#57](https://github.com/omdsh-dev/DSH-better-sidebar/issues/57) 前半图标尺寸、[#92](https://github.com/omdsh-dev/DSH-better-sidebar/issues/92) 拖拽回归防护），并覆盖 [#60](https://github.com/omdsh-dev/DSH-better-sidebar/issues/60)/[#105](https://github.com/omdsh-dev/DSH-better-sidebar/issues/105)/[#90](https://github.com/omdsh-dev/DSH-better-sidebar/issues/90) 的相关诉求。

## 2. 调研结论

dsh-web-ui（`zhu1090093659/dsh-web-ui`）的皮肤机制：

- 皮肤 = cordis 插件（`ui-skin-<id>`），皮肤中心通过 `cordis.patch.yml` 切换激活；皮肤插件 client half 在 `document.body` 上打 `data-dsh-<skin>` 属性并注入 CSS。
- **10 款皮肤全部覆盖两层令牌**：`--dsw-static-*` 基础色板 + `--dsw-alias-*` 语义层（`--dsw-alias-bg-layer-1`、`--dsw-alias-bg-base` 等做成半透明玻璃 rgba 0.16–0.7，`--dsw-specific-sidebar-fill` 也全部覆盖）。
- dsh-web-ui 自家右侧面板（aionui）用独立 `--aion-*` 令牌，每款皮肤单独 remap——**重**。

结论：better-sidebar 只要**消费 DSH 标准令牌**（alias 层），换肤就自动跟随，不需要任何每皮肤适配。此前围绕第三方皮肤插件（Aqua/deep-whale）设计的类名改名与 `data-bs-*` 语义钩子按 KISS 原则**全部回退**（见 §6）。

## 3. 设计

### 3.1 面板表面（`sidebar.module.css`）

```css
.panel        { background: var(--dsw-alias-bg-layer-1); }
.bottomPanel  { background: var(--dsw-alias-bg-layer-1); }
```

- 直接消费通用卡片表面令牌，**不新增自有令牌、不加属性钩子**。
- **绝不消费 `--dsw-specific-sidebar-fill`**：那是宿主左侧导航列专属令牌，皮肤系统按左导航语义覆盖它（dsh-web-ui 半透明玻璃/主题色、Aqua `transparent`），面板消费它会失去填充或与标签令牌冲突。
- stock 外观色阶变化仅 ±8 RGB（bluish-50→75 / 900→875），视觉无差；dsh-web-ui 换肤后面板获得与宿主一致的玻璃效果。

### 3.2 终端/编辑器透明度回退（`theme.ts` / `TerminalView.tsx`）

`effectiveTokenValue` 现在把以下值视为"未设置"（触发调用方 `||` 回退）：

- 空串与 CSS 重置关键字（`transparent`/`initial`/`inherit`/`unset`）；
- **alpha < 0.9 的半透明颜色**（dsh-web-ui 皮肤的 `--dsw-alias-bg-base` 是 rgba 0.16–0.7 玻璃）。

新增 `colorAlpha()` 解析 computed 颜色（rgb()/rgba()/hsl()/hsla() 逗号与空格语法、`#rgb/#rgba/#rrggbb/#rrggbbaa`）；无法解析的格式（命名色、`color()`）视为不透明放行。阈值 0.9：≥ 0.9 的近不透明值（如皮肤作用域内 0.96 瓷器玻璃）放行，皮肤仍能控制终端表面。

### 3.3 独立修复（与皮肤兼容无关，保留）

- **z-index（#52）**：`.toggleCluster` 55→45、`.panel`/`.bottomPanel` 50→40；角手柄移入面板后为面板内局部 `z-index: 2`。依据：DSH 浮层栈为 100（Menu/HoverCard/Tooltip/PopupSelect/Modal=1000），30–99 无任何 DSH 元素。
- **角手柄几何 CSS 化**：移入右面板 DOM，`position: absolute; left: -6px; bottom: calc(var(--dsh-sidebar-height, 0px) + 6px)`——复用拖拽逐帧写入的布局变量，删除 `cornerRef` JS 内联坐标。
- **刷新图标统一 `size={14}`（#57 前半）**：Explorer/Git/Diff 的 `IconRefreshOutline16` 显式 14px，与 Subagent/Browser 一致。
- **拖拽逐帧回归 e2e（#92）**：`tests/e2e/drag-layout.e2e.ts` rAF 采样，断言拖拽期间 `data-dsh-sidebar-dragging` 存在、`#root` transition 为 none、会话列与面板边单调 1:1 跟随（实测通过）。拖条以 `cursor: col-resize` 语义定位（无属性钩子可依赖）。

## 4. 测试

- `tests/theme.spec.ts`：`colorAlpha`（hex/rgb/hsl/不可解析）与 `effectiveTokenValue`（transparent/关键词/半透明回退/0.96 放行/缺失）。
- `tests/e2e/mount.e2e.ts`：追加 `--dsh-sidebar-width` 布局变量随面板挂载生效的断言（令牌驱动契约的挂载级守护）。
- `tests/e2e/drag-layout.e2e.ts`：拖拽逐帧回归。
- 门禁：`pnpm typecheck && pnpm test && pnpm build && pnpm pack && pnpm test:mount`。

## 5. 文档

- AGENTS.md §8「皮肤兼容（令牌驱动）」：面板表面令牌、透明度阈值、z-index 层级、根锚点 `[data-dsh-better-sidebar]`、类名非契约。
- README 不在本批更新（发布时随版本条目更新）。

## 6. 实施偏差记录

- **首版契约（已回退）**：初版围绕第三方皮肤插件设计了 `--dsh-sidebar-surface`/`--dsh-resize-strip-offset` 自有令牌（review 后已删）、panel 家族类名 kebab-case 改名（breaking）与 `data-bs-*` 语义钩子。确认主目标是 dsh-web-ui 皮肤中心后，按 KISS 全部回退：令牌驱动下这些都不需要，改名还引入无谓 breaking。最终契约 = 消费标准令牌 + 透明度阈值，无自有概念。
- **角手柄 `z-index` 语义变化**：移入面板后 z-index 为面板内层叠（2，与拖条一致），对外绝对层级由面板（40）决定；两面板同开时手柄盒与底面板上沿无重叠（≥6px 间隙），行为不变。
- **拖拽禁用断言修正**：`transition: none` 的 computed 值为 `transition-property: none`（非 `all`），已按实测修正。
- **面板默认表面色阶微调**：±8 RGB，未做像素级补偿（e2e 不依赖具体颜色）。
