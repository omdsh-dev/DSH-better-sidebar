# 侧边栏设置声明式化 + 内置支持"插头化"设计

**日期**：2026-08-11
**状态**：已实施（本文档含实施偏差记录）
**目标版本**：v0.4.1

## 1. 目标

1. 把 DSH 设置页的「侧边卡片」分区从硬编码 4 行改为**注册表驱动的声明式清单**：
   - 展示当前注册的所有侧边栏内容（tab 类型）与文件查看器（viewer），每项可**直接打开/关闭**；
   - 每项声明式元数据：**类型（id）、图标（SVG）、相关设置**（如子代理的"检测到子代理就自动打开"）。
2. 内置支持（资源管理 / Git / 终端 / 子代理 / 编辑器 / 差异）与 8 个文件预览器继续以**插头（descriptor）形式**注册，并在描述符上携带上述声明。

## 2. 非目标

- 不改宿主路由 / pty / tools 的 gating 语义：`agentTerminalTools` 仍是独立布尔偏好（宿主 `syncToolsGate` 零改动），只是它的**设置行渲染位置**改由终端 tab 描述符声明。
- 不做"已打开 tab 随禁用即时关闭"（保留式语义：禁用只影响新开，已打开 tab 继续渲染）。
- 不实现外部插件自定义 settings 键的动态 schema（见 §6 限制）。
- 不迁移 bundle 形态、不加依赖、不动 peerDependencies。

## 3. 现状回顾

- `SideCardSection.tsx` 硬编码 4 行：`openByDefault` / `defaultWidthPercent` / `autoOpenSubagent` / `agentTerminalTools`。
- `PrefsSchema`（`config.ts`）为扁平对象，`parsePrefs`（`client/prefs.ts`）逐字段校验。
- 内置 tab/viewer 已通过 `registerBuiltins` 走同一注册表（v0.4.0），但描述符缺少设置面元数据：viewer 无 `title`/`icon`，tab 无相关设置声明。
- 服务无启用态概念：`getTabs`/`matchFileViewer`/`openTab` 不过滤。

## 4. 设计

### 4.1 偏好扩展（`prefs-shared.ts` / `config.ts` / `client/prefs.ts`）

```ts
interface SidebarPrefs {
  openByDefault: boolean
  defaultWidthPercent: number
  autoOpenSubagent: boolean
  agentTerminalTools: boolean
  tabsEnabled: Record<string, boolean>    // 按 tab descriptor id；缺省 = 启用
  viewersEnabled: Record<string, boolean> // 按 viewer descriptor id；缺省 = 启用
}
```

- schema：`z.dict(z.boolean()).default({})`（schemastery `dict`）；旧文档自动解析为 `{}`（全开），零迁移。
- `parsePrefs`：record-of-boolean 校验（非对象/非布尔值回退 `{}` / 丢弃该键）。
- 设置页开关写入 `tabsEnabled: { ...prefs.tabsEnabled, [id]: next }`（viewers 同理）。

### 4.2 声明式描述符（`client/service.ts`）

```ts
interface SidebarSettingToggle {
  key: string                       // SidebarPrefs 字段名（'autoOpenSubagent'）
  title: string | (() => string)
  desc?: string | (() => string)
}
interface SidebarSettingsDeclaration {
  toggles?: readonly SidebarSettingToggle[]
}

// TabDescriptor 增加：
settings?: SidebarSettingsDeclaration

// FileViewerDescriptor 增加（设置清单展示用）：
title?: string | (() => string)     // 缺省回退 id
icon?: ReactNode | ((size) => ReactNode)
settings?: SidebarSettingsDeclaration
```

服务新增：
```ts
isTabEnabled(id: string): boolean      // store.getPrefs().tabsEnabled[id] !== false
isViewerEnabled(id: string): boolean
```

行为变化：
- `openTab`：类型被禁用 → no-op（`console.warn` 提示）；`matchFileViewer`：跳过禁用 viewer（文件落到下一个匹配或下载按钮）。
- `getTabs()/getFileViewers()` 仍返回**全部**注册项（设置页清单必须看到已禁用的项）。

### 4.3 内置声明（`builtins/tabs.tsx` / `builtins/viewers.tsx`）

| tab | 相关设置声明 |
|---|---|
| subagent | `toggles: [{ key: 'autoOpenSubagent', ... }]` |
| terminal | `toggles: [{ key: 'agentTerminalTools', ... }]` |
| explorer/git/editor/diff | 无（仅开关） |

8 个 viewer 全部补 `title`（locales 新增 `viewerImage`…`viewerBinary`）+ `icon`（`icons.tsx` 新增 6 个手绘 outline SVG：image/pdf/docx/xlsx/pptx/markdown；code/binary-download 复用 `IconCodeOutline16` / `IconDownloadOutline16`）。

### 4.4 Store 快照携带 prefs（`client/state.ts`）

`SidebarSnapshot` 增加 `prefs` 字段；`setPrefs` 更新快照并 `notify()`（`setSession`/`update`/`reduce` 构造快照时带上当前 prefs）。效果：+ 菜单等 `useSyncExternalStore` 消费者在设置变更后**立即**重渲染（禁用 git → + 菜单马上消失）。

`makeDefaultState(width, panelOpen, seedExplorer = true)` 增加第三参；`loadState` 在 `tabsEnabled['explorer'] === false` 时传 `false`——新会话不再预置 explorer tab（与"已存在会话保持布局"语义并列：禁用只影响新布局）。

### 4.5 消费点 gating

| 消费点 | 行为 |
|---|---|
| + 菜单（`buildNewTabOptions`） | `filter(!d.hidden && service.isTabEnabled(d.id))` |
| 子代理自动展开 effect | 追加 `isTabEnabled('subagent') === false` 早退（禁用时不展开面板） |
| agent 终端 reconcile（WS 推送） | `isTabEnabled('terminal') === false` 时忽略推送（不自动补 tab；重新启用后下一次推送自愈） |
| 产出文件拦截（`intercept.tsx` select） | `tabsEnabled['editor'] === false` 时 select 返回 null（回落默认交付行） |
| `openTab` / `matchFileViewer` | 见 §4.2 |
| 新会话默认布局 | explorer 禁用 → 空 pane |

### 4.6 设置页声明式渲染（`SideCardSection.tsx`）

- `inject: () => ({ store, service })`（`index.tsx` 闭包直接捕获 service）。
- 注册表清单：本地 state + `service.subscribe` 同步（注册变化罕见，无需 external-store）。
- 行结构：
  - **常规**：`openByDefault`、宽度（既有逻辑）。
  - **侧边栏内容**：按 `order` 升序、`hidden` 置后遍历 tabs——图标(16) + 标题 + desc=`tab.id`（类型）+ 开关；`settings.toggles` 渲染为缩进子行（仅父级启用时显示，绑定 `prefs[toggle.key]`）。
  - **文件预览**：按 priority 降序遍历 viewers——图标 + `title ?? id` + desc=`exts.join(' · ') || t('settingsViewerCatchAll')` + 开关。
- 提交机制不变：串行化 + revision 守卫 + 失败回滚 + `store.setPrefs` 同步。

## 5. 测试

- `service.spec.ts`：启用态缺省 true；`openTab` 拒绝禁用类型；`matchFileViewer` 跳过禁用 viewer（含兜底 code 被关 → undefined）。
- `builtins.spec.ts`：subagent/terminal 的 toggles 声明；全部 tab 有 icon；全部 viewer 有 title+icon。
- `unit.spec.ts`：`parsePrefs` 的 map 校验（非对象/非布尔回退）+ 新字段默认值；`loadState` explorer 禁用 → 空 pane。
- `plugin-shape.spec.ts` / `smoke.spec.ts`：schema 解析与 settings 路由断言补新字段。
- `side-card-section.spec.tsx`（新增）：`renderToString` 断言声明式行（图标/标题/id/exts/开关/嵌套开关隐藏规则）。

## 6. 限制与失败模式

- **外部插件的自定义 settings 键**：`toggles[].key` 必须是宿主 `PrefsSchema` 的字段（内置：`autoOpenSubagent` / `agentTerminalTools`）；未知键会被 settings seam 丢弃（schemastery object 非严格模式放行未知键但 schema 不含其校验）。文档注明。
- 设置路由失败 / 文档缺失：沿用既有降级（schema 默认 + 本地 state，开关默认全开）。
- 已打开 tab 的类型被禁用：tab 保留可继续使用；关闭后无法重开。
- 父级（子代理/终端）关闭时嵌套开关隐藏，其值保留在 prefs 不销毁。

## 7. 实施偏差记录

1. **嵌套开关的"父级关闭即隐藏"**：设计初稿曾考虑始终显示嵌套开关；实施决定仅在父级启用时渲染（避免"autoOpenSubagent 已开但子代理页面被关"的无效组合），值保留。
2. **宿主 `syncToolsGate` 不改**：`agentTerminalTools` 仅随自身开关走，不与 `tabsEnabled['terminal']` 联动（模型终端工具是模型面向能力，与侧边栏 UI 开关解耦）。
3. **`renderRow` 统一行渲染**：tab/viewer/嵌套开关共用一行渲染器（`sub` 参数区分缩进），CSS 新增 `.sectionHeading` / `.rowIcon` / `.titleLine` / `.subRow`。
4. **清单排序**：tabs 按 `hidden` 置后 + `order` 升序（editor/diff 殿后）；viewers 按 priority 降序（code 兜底最后）。
5. **开关改为卡片点击（v0.4.1 追加）**：清单项与嵌套相关设置、`openByDefault` 全部从"复选框行"改为**可点击卡片**——`<button aria-pressed>`，整卡即开关，视觉状态即状态（启用 = 品牌描边 + 交互选中填充 + `IconCheckOutline16` 勾选徽标；禁用 = 中性 hairline + 文字降级）。嵌套相关设置渲染为更小的缩进卡片；宽度输入保持原生设置行（它是数值不是开关）。设置导航齿轮图标为宿主 shell 硬编码（`navIcon` 按 section id 映射，无插件注入点），用户选择不改宿主，保持现状。
6. **小卡片响应式网格 + 二级设置弹窗（v0.4.1 再追加）**：清单项改为**小卡片**，置于 `repeat(auto-fill, minmax(148px, 1fr))` 响应式网格（一行自适应多个，随宽度换行）；卡片结构 = 顶行（图标 + 标题省略 + **勾选徽标钉在最右端**）+ 类型/扩展名描述行（省略号截断，`title` 属性给出完整值）。声明了 `settings.toggles` 的卡片右下角渲染**齿轮角标按钮**（`IconSettingsOutline16`，仅父级启用时显示），点击打开**原生 `Modal` 弹窗**，内含 DSH 原生设置行（标题/描述 + 品牌强调原生复选框 + hairline 分隔，末行去分隔线）——二级设置不再内嵌于网格。实现细节：Modal 采用条件挂载（`settingsFor !== null && <Modal open …>`），因为 Modal 原语无条件调用 hooks，常闭挂载在测试的 dual-react（react 18.2 server / 18.3 bundled）分裂环境下会崩；弹窗行体抽成 `FeatureSettingsRows` 供 renderToString 直测。

---

## 8. v0.12.0 设置 seam 开放记录（2026-08-14，feat/plugin-api-v012）

设计正文「key 必须是宿主 PrefsSchema 的字段」的限制在 v0.12.0 被打开（纯增量，`toggles` 的宿主 key 语义不变）：

- **持久化**：`SidebarPrefs` 增加 `pluginSettings: Record<string, Record<string, unknown>>`（开放嵌套 map，schema `z.dict(z.dict(z.any())).default({})`，按 descriptor id 分桶）——外部插件的自有设置不再需要宿主 schema 字段、不再被 settings seam 丢弃。`parsePrefs` 增加 `pluginSettingsMapOf` 校验（非对象整体回退 `{}`）。
- **声明**：`SidebarSettingsDeclaration` 增加 `pluginToggles`（声明式行，控件同 toggles 的 switch/text/number，值须 JSON 可序列化）与 `render?: (props: SidebarSettingsRenderProps) => ReactNode`（自定义面板：store/service/prefs/pluginSettings/updatePluginSetting/close；抛错被吞并显示内联错误）。
- **渲染**：齿轮弹窗体抽为 `SettingsBody`（`render` 存在时优先，否则 toggles 行 + pluginToggles 行，后者把 pluginSettings 投影到 prefs 面复用 `FeatureSettingsRows`）；`settingsFor` 状态从 `TabDescriptor | null` 扩为 `TabDescriptor | FileViewerDescriptor | null`——viewer 卡片 v0.12.0 起同样有齿轮设置弹窗（§4.6 原仅 tab）。
- **向后兼容**：旧设置文档无 `pluginSettings` 字段 → schema default `{}`；`toggles` 行为与 v0.11.0 完全一致。
