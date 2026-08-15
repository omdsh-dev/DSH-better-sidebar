# 资源管理器：按模式排除文件/目录（issue #18）

**日期**：2026-08-14
**状态**：已实施（PR 待合）
**目标版本**：v0.11.0（待定）

## 1. 目标

让资源管理器可以像常见 IDE 一样按规则**隐藏**不需要的文件/目录（issue #18 的 Unity 场景：过滤 `.meta` 这类系统生成文件）。用户通过设置页为 explorer tab 维护一组「排除模式」，匹配的条目在树中不显示。

## 2. 非目标

- **不做 glob 全量支持**（`**`、`?`、`{a,b}`、`[x]` 等）：无依赖优先，单 `*` 通配足够覆盖 `.meta` / `node_modules` / `build` 场景；需要更强模式时后续再加。
- **不默认过滤任何东西**：`explorerExclude` 默认 `[]`，行为与现状完全一致（符合项目「缺席 = 默认启用」惯例）。
- **不碰 host 半**：过滤是纯显示层偏好，host 的 `fs.tree` 路由、`listDirectory`、其他消费者（git/editor 等）全部不动。目录超大（>1000 项）时 `truncated` 计数可能把本可显示的行挤掉——可接受，文档已知限制记录。
- **不做 .gitignore 解析 / 内置噪声规则预设**：保持可预期，规则完全由用户显式声明。

## 3. 现状回顾

- `ExplorerView`（`src/client/ExplorerView.tsx`）懒加载目录树：`api.fsTree` → `fs.tree` 路由 → host `listDirectory` 返回 `SidebarFsEntry[]`（`name/path/isDir/hidden`），client 渲染时目录优先排序，dotfile 变暗显示。
- 设置体系：`SidebarPrefs`（`prefs-shared.ts` 共享类型 + `config.ts` schemastery schema + `client/prefs.ts` parsePrefs 校验 + `SidebarStore` 持有 + `/sidebar/settings` RPC 持久化）。设置页 `SideCardSection` 按注册表渲染 tab/viewer 卡片，卡片齿轮弹窗渲染 `settings.toggles`（目前仅布尔复选框行）。
- explorer tab 在 `builtins/tabs.tsx` 注册，`component` 收到 `{ ctx, store, scope, expanded, onToggleDir, onReferenceFile }`，`store` 是 `SidebarStore`（`getPrefs()` / `subscribe()` 可用）。

## 4. 设计

### 4.1 模式匹配（新 `src/exclude-patterns.ts`，纯函数、零依赖）

```ts
/** 单模式匹配：单个 '*' 通配 0+ 字符；无 '*' = 精确名称匹配；大小写不敏感。 */
export function matchesExcludePattern(name: string, pattern: string): boolean

/** 任一模式命中（空模式/空白串忽略）。 */
export function isExcludedName(name: string, patterns: readonly string[]): boolean
```

- 匹配对象是**条目名**（`entry.name`），不是完整路径——目录和文件一视同仁（`node_modules`、`build`、`*.meta` 都自然成立），且不需要从 client 向 host 传 cwd 相关逻辑。
- 大小写不敏感：跨平台一致（Windows/macOS 文件系统本身不敏感），用户心智中 `.meta` 与 `.META` 是同一文件。
- 实现：无 `*` 时直接 `toLowerCase()` 相等；有 `*` 时把模式转正则（其余字符 `RegExp.escape` 语义手写转义），`*` → `.*`，锚定 `^...$`。支持 `*.meta`、`build*`、`*.min.js`、`foo*bar`。
- 放 `src/` 根级共享（host/client 都能 import，当前只用 client；对齐 `prefs-shared.ts` 位置）。

### 4.2 偏好字段（三处同步）

`SidebarPrefs` 新增：

```ts
/** 资源管理器排除模式列表：匹配（条目名，单 '*' 通配，大小写不敏感）的条目在树中隐藏。 */
explorerExclude: string[]
```

- `prefs-shared.ts`：接口 + `SIDEBAR_PREFS_DEFAULTS.explorerExclude = []`
- `config.ts` `PrefsSchema`：`explorerExclude: z.array(z.string()).default([])`
- `client/prefs.ts` `parsePrefs`：新增 `stringArrayOf(record.explorerExclude)`——非数组回退 `[]`；数组过滤出非空 string、trim、去重、保序（对齐 `booleanMapOf` 的防御风格）。

### 4.3 设置 UI：声明式「文本行」

现有 `settings.toggles` 只支持布尔。扩展 `SidebarSettingsDeclaration` 增加**文本行**（多行文本框，每行一个模式）：

```ts
/** 声明式文本设置：多行文本框（每行一个值），失焦/Enter 提交到 SidebarPrefs 数组字段。 */
export interface SidebarSettingText {
  key: string                 // SidebarPrefs 数组字段名（'explorerExclude'）
  title: string | (() => string)
  desc?: string | (() => string)
  placeholder?: string | (() => string)
}

export interface SidebarSettingsDeclaration {
  toggles?: readonly SidebarSettingToggle[]
  texts?: readonly SidebarSettingText[]      // 新增
}
```

- 弹窗 `FeatureSettingsRows` 支持两种行：复选框行（现逻辑不变）+ 文本行（新组件 `TextSettingRow`：textarea + title/desc/placeholder）。
- 文本行交互：focus 时从 `prefs[key]` 初始化 draft；编辑为本地 state；blur（或 Enter，非 Shift）时 trim 行 → 去空 → 去重 → `commit({ [key]: lines })`；提交成功/失败后 `applyOutcome` 更新 prefs，draft 随 prefs 同步（`useEffect` 监听外部变化，避免并发写后残留）。
- 弹窗宽度/样式沿用现有 `popupRows`；textarea 样式新增（多行、等宽字体、行间紧凑）。

### 4.4 explorer tab 声明

`builtins/tabs.tsx` explorer 描述符加：

```ts
settings: {
  texts: [{
    key: 'explorerExclude',
    title: () => t('settingsExplorerExcludeTitle'),
    desc: () => t('settingsExplorerExcludeDesc'),
    placeholder: () => t('settingsExplorerExcludePlaceholder'),
  }],
}
```

卡片齿轮按钮的显隐条件 `(tab.settings?.toggles?.length ?? 0) > 0` 扩展为 `> 0 || texts > 0`。

### 4.5 ExplorerView 过滤

- `ExplorerView` 新增 prop `exclude: string[]`，由 `builtins/tabs.tsx` 传入 `store.getPrefs().explorerExclude`。
- `ExplorerView` 内部订阅 prefs 变更（新 prop `store` 传入，`useEffect(() => store.subscribe(...))` + useState 快照），排除规则变化即时生效。
- `renderLevel` 渲染前 `entries.filter(e => !isExcludedName(e.name, exclude))`。被过滤目录不渲染；`expanded` 中残留被过滤目录的路径时照常 loadDir（数据无害），仅不渲染。
- 现有能力不变：被过滤文件不显示，因此右键复制路径 / 打开 / @引用对它们不可达（符合「隐藏」语义）。

### 4.6 i18n

`locales.ts` zh/en 各加 3 条：

| key | zh | en |
|---|---|---|
| settingsExplorerExcludeTitle | 排除模式 | Exclude patterns |
| settingsExplorerExcludeDesc | 匹配（名称，* 通配，大小写不敏感）的条目在树中隐藏，每行一个 | Entries whose name matches (single `*` wildcard, case-insensitive) are hidden from the tree; one per line |
| settingsExplorerExcludePlaceholder | 例如：\*.meta、.DS_Store、node_modules | e.g. \*.meta, .DS_Store, node_modules |

## 5. 测试计划

1. `tests/exclude-patterns.spec.ts`：精确名、`*` 前缀/后缀/中间、大小写、空模式/空白串、正则特殊字符转义（`foo[bar]`、`a+b`）。
2. `tests/unit.spec.ts` 追加 `parsePrefs` 的 `explorerExclude` 用例：缺省/非法值回退 `[]`、过滤非 string/空串、trim、去重保序。
3. `tests/side-card-section.spec.tsx` 追加：声明 `texts` 的 tab 卡片有齿轮；`FeatureSettingsRows` 渲染文本行（title/desc/placeholder 出现、textarea 值 = 模式 join('\n')）；`onCommitText` 提交解析后的行。
4. `tests/builtins.spec.ts` 追加：explorer 描述符声明 `settings.texts` 且 key 为 `explorerExclude`。
5. ExplorerView 过滤渲染测试（`tests/` 新增或并入现有）：mock `api.fsTree` 返回含 `.meta` 的 entries，`exclude: ['*.meta']` 时渲染不含该行；空规则时全部渲染。

## 6. 文档

- `README.md` 功能一览「资源管理器」补一句：支持按模式隐藏文件/目录（设置页可配，如 `*.meta`）；「已知限制」补：过滤是显示层，超大目录（>1000 项）的截断计数在过滤后可能偏少。
- `README_EN.md` 同步。
