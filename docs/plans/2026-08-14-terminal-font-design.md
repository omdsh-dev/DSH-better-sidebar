# 终端自定义字体（设置页二级设置）设计

**日期**：2026-08-14
**状态**：已实施（本文档含实施偏差记录）
**目标版本**：v0.11.0

## 1. 目标

在 DSH 设置页「侧边卡片」分区中，终端 tab 卡片的二级设置弹窗（齿轮按钮，README 所称"终端卡片二级设置"）新增两行：

1. **终端字体**（text 输入）：自定义 CSS font-family stack，如 `"JetBrains Mono", monospace`；留空 = 跟随主题等宽字体（`--ds-font-family-code` token）。
2. **终端字号**（number 输入）：9–32px，默认 13，带 `px` 后缀。

配置持久化到 `SidebarPrefs`（`dsh-better-sidebar` 命名空间，host 侧 PrefsSchema 校验），对**所有已打开终端实时生效**（UI tab 与 agent tab 共用 TerminalView）：设置页提交 → `store.setPrefs` 通知 → xterm `options.fontFamily/fontSize` 更新 + 重排网格。

## 2. 非目标

- 不在终端视图内加菜单/按钮（用户明确选择仅设置页齿轮弹窗）。
- 不做 per-tab / per-terminal 隔离（全局偏好，与 SidebarPrefs 现有语义一致）。
- 不自动给字体族加引号、不做字体合法性嗅探（用户负责合法 CSS font-family；placeholder 示范格式）。
- 不改 pty / WS / 终端连接生命周期：字体变化不重连、不重启 shell。

## 3. 现状回顾

- 终端描述符（`builtins/tabs.tsx`）的 `settings.toggles` 只支持**布尔开关**（`SidebarSettingToggle` 无类型字段），`FeatureSettingsRows`（`SideCardSection.tsx`）只渲染 Switch 行。
- `SidebarPrefs` / `PrefsSchema` / `parsePrefs` 三处同步维护（`prefs-shared.ts` / `config.ts` / `client/prefs.ts`）。
- `TerminalView` 硬编码 `fontSize: 13` + `fontFamily: tokenValue('--ds-font-family-code') || 内置栈`，且不响应偏好变化。

## 4. 设计

### 4.1 偏好扩展（`prefs-shared.ts` / `config.ts` / `client/prefs.ts`）

```ts
interface SidebarPrefs {
  // …
  terminalFontFamily: string   // '' = 跟随主题等宽字体
  terminalFontSize: number     // 9–32，默认 13
}

// prefs-shared.ts
export const TERMINAL_FONT_SIZE_MIN = 9
export const TERMINAL_FONT_SIZE_MAX = 32
export const TERMINAL_FONT_SIZE_DEFAULT = 13
export function clampTerminalFontSize(value: number): number // round + clamp（仿 clampWidthPercent）
```

- `PrefsSchema`：`terminalFontFamily: z.string().default('')`、`terminalFontSize: z.number().step(1).min(9).max(32).default(13)` —— 旧文档解析自动补默认，无迁移。
- `parsePrefs`：family 需 string 否则默认；size 需有限数并 `clampTerminalFontSize` 否则默认。

### 4.2 声明式 API 扩展（`client/service.ts`，向后兼容）

```ts
type SidebarSettingToggleType = 'switch' | 'text' | 'number'

interface SidebarSettingToggle {
  key: string
  title: string | (() => string)
  desc?: string | (() => string)
  type?: SidebarSettingToggleType   // 缺省 'switch'，外部插件现有用法不变
  min?: number                      // number 行的下限（提交时钳制）
  max?: number                      // number 行的上限
  placeholder?: string              // text 行的占位符
  unit?: string                     // 输入框后的单位后缀（如 'px'）
}
```

### 4.3 终端描述符声明（`builtins/tabs.tsx`）

`settings.toggles` 追加两行：`{ key: 'terminalFontFamily', type: 'text', placeholder: … }` 与 `{ key: 'terminalFontSize', type: 'number', min: 9, max: 32, unit: 'px' }`（标题/描述走 locales）。

### 4.4 设置行渲染（`SideCardSection.tsx` + CSS）

- `FeatureSettingsRows` 按 `toggle.type` 分支：`switch` 走现有 Switch 行；`text`/`number` 走新 `TypedRow`（局部 draft state，`Input` 原语，blur/Enter 提交，number 行带 unit 后缀）。
- `TypedRow` 的 `key` 含**已提交值**：提交失败 → prefs 回滚 → key 变化 → 行重挂载为存储值（输入中 draft 不因 key 变化被打断，因为 key 只随已提交值变）。
- 父级 `onCommitSetting(toggle, raw): string`：number 解析+钳制（非法/空 → 走 `Number('')=0` 钳到下限，与宽度行 `commitWidth` 先例一致）；text 原样；乐观 `setPrefs` → `commit` → 失败 `applyOutcome` 回滚（复用既有 `applyPref` 管道，原 `togglePref` 更名）。

### 4.5 终端消费（`client/terminal-font.ts` 新模块 + `TerminalView.tsx`）

```ts
// terminal-font.ts（纯函数，可单测）
export const DEFAULT_TERMINAL_FONT_FAMILY = '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
export function resolveTerminalFont(prefs, themeFontFamily):
  { fontFamily: 非空用户值 ?? themeFontFamily ?? 内置栈, fontSize: clampTerminalFontSize(prefs.terminalFontSize) }
```

- `TerminalView` 构造 Terminal 时用解析值；主 effect 内 `store.subscribe` 回调 diff `term.options.fontFamily/fontSize`，变化则更新 options + `fit.fit()` + `sendResize()`（网格尺寸随字体变化）；cleanup 退订。懒加载 chunk 无新增依赖（store 为运行时 prop）。

### 4.6 i18n（`locales.ts`）

zh/en 各新增：`settingsFontFamilyTitle/Desc/Placeholder`、`settingsFontSizeTitle/Desc/Suffix`（px）。

## 5. 测试

- `tests/unit.spec.ts`：`parsePrefs`/`loadPrefs` 新字段（合法 string 直通、越界钳制 9/32、非 number 回退、缺省默认）；全等字面量补字段。
- `tests/plugin-shape.spec.ts`：PrefsSchema 默认值 + overridden 全等。
- `tests/builtins.spec.ts`：终端 toggles keys = 4 个，后两个 type/min/max 断言。
- `tests/smoke.spec.ts`：settings.get 全默认字面量补字段。
- `tests/side-card-section.spec.tsx`（SSR）：text/number 行渲染（value/min/max/placeholder/unit，非 checkbox）。
- `tests/side-card-section-rows.spec.tsx`（新，jsdom + createRoot）：blur 提交回调、number 钳制、空输入钳到下限、提交失败回滚草稿（key 重挂载）。
- `tests/terminal-font.spec.ts`（新）：`resolveTerminalFont` 回退链 + `clampTerminalFontSize`。

## 6. 限制与取舍

- 外部插件的自定义 toggle key 照旧被 host PrefsSchema 校验丢弃（现有 seam 行为）；`type: 'text'/'number'` 是公开 API 扩展，外部插件可用但 key 仍须是宿主 schema 字段。
- number 输入的"非法值"在浏览器里只会以空串出现（number input 拒绝非数字字符），因此 `Number('')=0 → 钳到下限` 是唯一可达路径，与宽度行先例一致。
- 字号实时生效依赖 xterm 的 options setter + re-fit；若未来 xterm 版本行为变化，回退方案是重建 Terminal（不推荐，会丢滚动缓冲）。

## 7. 实施偏差记录

- 计划中的"非法输入回退当前存储值"用例在实现中发现不可达（浏览器 number input 的值清洗），改为断言"空输入钳到下限"（与宽度行一致）。
- `togglePref` 更名为 `applyPref`（它本就接受任意 patch，不只是布尔翻转）。
