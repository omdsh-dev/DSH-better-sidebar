# DSH-better-sidebar 服务化改造设计

**日期**：2026-08-11
**状态**：已批准，待实施
**作者**：opencode + 用户
**当前版本**：v0.3.0（main `069c754`）
**目标版本**：v0.4.0

## 1. 目标

将 `dsh-better-sidebar` 从一个"纯消费方"插件改造为"服务提供者"：

1. 允许其他 DSH 插件向 better-sidebar **注册新的侧边栏页面（tab 类型）**
2. 允许其他 DSH 插件向 better-sidebar **注册文件类型预览器**
3. 把现有 5 个内置 tab 和 6 种内置文件预览器**全部迁移到新注册表**（吃自己的狗粮）

## 2. 非目标（Out of Scope）

- **不动 host 半**（`src/index.ts` 的 HTTP 路由 / pty / tools / settings）
- **不迁移到标准 bundle 形态**（不加 `cordis.patch.yml`、不弃用 `dsh.plugin.json`、不放弃 `client-registry.js`）—— 作为独立工作
- 不动 server 端 `ctx.provide`：本次纯 client 端服务

## 3. 现状回顾

### 3.1 Tab 系统硬编码点（7 处）

| 文件:行 | 用途 |
|---|---|
| `src/client/state.ts:14` | `TabType` 联合类型（5 字面量） |
| `src/client/state.ts:295-297` | `isSingle(type)` 单实例判定 |
| `src/client/state.ts:555-561` | `sanitizeNode` 白名单校验 |
| `src/client/Sidebar.tsx:56-83` | `TabContent` switch 渲染 |
| `src/client/Sidebar.tsx:87-102` | `buildNewTabOptions` + 菜单项 |
| `src/client/Sidebar.tsx:341-364` | `onNewTab` 创建分支 |
| `src/client/icons.tsx:26-33` | `tabTypeIcon` 图标 switch |

### 3.2 文件预览硬编码点

- `src/client/EditorView.tsx:58-106`：顺序 if/else 选 `load.kind`
- `src/client/EditorView.tsx:251-272`：if 链按 `load.kind` 渲染组件
- 4 个预览组件（DocxView / XlsxView / PptxView / PdfView）静态 import 在 `EditorView.tsx:22-26`
- 3 个纯函数模块（`office-types.ts` / `image-types.ts` / `pdf-types.ts`）+ `lang.ts` 已半抽象，可作为内置注册器的实现细节复用

### 3.3 服务暴露现状

- `src/index.ts` / `src/client/index.tsx` 全文搜 `ctx.provide` / `Context.service` / `extends Service` —— **零命中**
- `package.json` 的 `exports` 没有暴露任何供外部 import 的注册 API
- README:262 已承认 portal 挂载的限制（整面板 slot 不可用），但未提服务化方案

### 3.4 平台约束

- **构建期纯度门**（`tsdown.config.ts:177-180`）：client bundle 禁止 value-import 别的插件代码；**type-only import 会被擦除，不触发门禁**
- **双 cordis 实例**：外部插件解析不到 DSH monorepo 的 cordis augmentation，必须由 better-sidebar 自己导出 `declare module 'cordis'` augmentation
- **ModuleLoader 运行时支持跨 bundle require，但被构建门挡** → 协作只能走 cordis 服务或 slot

## 4. 方案选型

| 方案 | 机制 | 评估 |
|---|---|---|
| **A. `ctx.provide` + 服务对象（采纳）** | client `apply()` 内 `ctx.provide('betterSidebar', service)`，service 暴露 `registerTab/registerFileViewer` 返回 disposer | registry 语义自然；disposer 生命周期贴合 cordis fiber；precedent：`dsh/packages/client/locale/src/client/index.ts:362` |
| B. `ctx.slots.inject` 声明式 slot | 声明 `betterSidebar.tabType` 等 slot | 偏 UI 链替换，对带元数据 + disposer 的 registry 别扭 |
| C. `extends Service` 类形式 | 完整 Service 类 + Config schema | client 半不支持 `extends Service`；本次纯 client，没必要 |

**采纳方案 A**。

## 5. 服务接口设计

### 5.1 主服务接口

```ts
// 新文件 src/client/api.ts
export interface BetterSidebarService {
  /** 注册一种 tab 类型；返回 disposer */
  registerTab(descriptor: TabDescriptor): () => void
  /** 注册一种文件预览器；返回 disposer */
  registerFileViewer(descriptor: FileViewerDescriptor): () => void
  /** 运行时快照（同步，供 React useSyncExternalStore 用） */
  getTabs(): readonly TabDescriptor[]
  getFileViewers(): readonly FileViewerDescriptor[]
  /** 匹配文件的预览器（按 priority 降序、exts/includes、detect() 三段匹配） */
  matchFileViewer(path: string, head?: Uint8Array): FileViewerDescriptor | undefined
  /** 工具方法：让外部 tab 也能开/关 tab */
  openTab(tab: { type: string; title: string; path?: string }): void
  closeTab(tabId: string): void
  /** 订阅 registry 变化（注册/卸载时触发） */
  subscribe(listener: () => void): () => void
}
```

### 5.2 TabDescriptor

```ts
export interface TabDescriptor {
  id: string                              // 唯一，如 'explorer' / 'my-plugin:db'
  title: string | (() => string)          // i18n 友好
  icon?: ReactNode | ((size: number) => ReactNode)
  order?: number                          // + 菜单排序，默认 100
  single?: boolean                        // 单实例（explorer/git/subagent）
  hidden?: boolean                        // 不出现在 + 菜单（editor 用）
  available?: (ctx: Context, scope: SessionScope) => boolean
  component: (props: TabComponentProps) => ReactNode
}

export interface TabComponentProps {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  tab: SidebarTab
}
```

### 5.3 FileViewerDescriptor

```ts
export interface FileViewerDescriptor {
  id: string                              // 'image' / 'pdf' / 'my-plugin:csv'
  exts: readonly string[]                 // 小写无点，如 ['png','jpg']
  priority?: number                       // 高优先；默认 0；内置默认 0；兜底 code 用 -100
  fetchStrategy: 'none' | 'fsRead' | 'mediaUrl' | 'custom' | 'binary-download'
  detect?: (path: string, head: Uint8Array) => boolean  // 内容嗅探（覆盖 exts）
  load?: (path: string, scope: SessionScope) => Promise<unknown>  // fetchStrategy='custom' 时
  component: (props: FileViewerProps) => ReactNode
}

export interface FileViewerProps {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  path: string
  title: string
  content?: string                        // fetchStrategy='fsRead' 时
  truncated?: boolean
  mediaUrl?: string                       // fetchStrategy='mediaUrl' 时
  customData?: unknown                    // fetchStrategy='custom' 时 load() 的返回值
}
```

## 6. Cordis 类型合并 outlet

```ts
// 新文件 src/types.ts (纯类型)
import type { BetterSidebarService } from './client/api'

declare module 'cordis' {
  interface Context {
    betterSidebar: BetterSidebarService
  }
}
```

通过 `src/index.ts` 的 `export type * from './types.ts'` re-export 到主入口。Consumer 插件 `import type {} from 'dsh-better-sidebar'` 触发合并。

## 7. package.json exports 新增

```jsonc
"exports": {
  ".": { ... },
  "./invariant": { ... },
  "./client": { ... },
  "./client/api": {                          // 新增，纯类型导出
    "types": "./lib/types/client/api.d.ts",
    "default": "./lib/client.js"             // 运行时落点回到 client bundle（不会被 value import）
  },
  "./src/*": "./src/*",
  "./package.json": "./package.json"
}
```

`files` 字段相应加 `lib/types/client/api.d.ts`。

## 8. 内置 tab 自我注册（吃狗粮）

`src/client/index.tsx` 的 `apply()` 内：

```ts
const service = createBetterSidebarService(store)
ctx.provide('betterSidebar', service)
registerBuiltins(service)  // 5 个内置 tab + 内置 viewer 全部用 service.registerTab/registerFileViewer
```

### 8.1 5 个内置 tab

| id | order | single | hidden | available | 组件 |
|---|---|---|---|---|---|
| `editor` | -1 | false | true | always | `EditorView`（由 open-file 流程触发，不在 + 菜单） |
| `explorer` | 10 | true | false | always | `ExplorerView` |
| `git` | 20 | true | false | 检查 `.git` 存在 | `GitView` |
| `subagent` | 30 | true | false | always | `SubagentView` |
| `terminal` | 40 | false | false | 检查 terminal 配额 | `TerminalView` |

### 8.2 内置 file viewer

| id | exts | priority | fetchStrategy | 组件 |
|---|---|---|---|---|
| `image` | png/jpg/jpeg/gif/webp/svg/bmp/ico/avif | 0 | mediaUrl | `<img>` |
| `pdf` | pdf | 0 | mediaUrl | `PdfView` |
| `docx` | docx | 0 | mediaUrl | `DocxView` |
| `xlsx` | xlsx | 0 | mediaUrl | `XlsxView` |
| `pptx` | pptx | 0 | mediaUrl | `PptxView` |
| `markdown` | md/markdown | 0 | fsRead | `<MarkdownText>` |
| `code` | []（兜底） | -100 | fsRead | CodeMirror |
| `binary-download` | doc/xls/ppt + NUL 探测为 binary | -50 | binary-download | 下载按钮 |

`matchFileViewer(path, head?)` 算法：
1. 按 `priority` 降序遍历
2. 若 `descriptor.detect` 提供且 `head` 可用 → 调 `detect(path, head)`，true 则命中
3. 否则匹配 `exts`（小写无点）
4. 全部 miss → 返回 `undefined`（caller 走兜底 `binary-download`）

## 9. 7 处硬编码 switch 改造点

| 文件:行 | 原状 | 改造后 |
|---|---|---|
| `src/client/state.ts:14` | `TabType` 联合 5 字面量 | `type TabType = string`；保留 `SIDEBAR_BUILTIN_TAB_TYPES` 常量数组供向后兼容 |
| `src/client/state.ts:295-297` `isSingle` | switch 5 字面量 | `(type) => service.getTabs().find(t => t.id === type)?.single ?? false`；store 持有 service 引用 |
| `src/client/state.ts:555-561` `sanitizeNode` | 白名单 5 type | 未注册 type 标记 `orphaned: true` 不丢弃，渲染占位卡 |
| `src/client/Sidebar.tsx:56-83` `TabContent` | switch 5 分支 | 查 `service.getTabs().find(t => t.id === tab.type)`，调 `descriptor.component(props)`；未找到渲染 `<OrphanedTab/>` |
| `src/client/Sidebar.tsx:87-102` `buildNewTabOptions` | 硬编码 4 项 | `service.getTabs().filter(t => !t.hidden && (t.available?.(ctx, scope) ?? true)).sort(byOrder).map(...)` |
| `src/client/Sidebar.tsx:341-364` `onNewTab` | if optionId === 'explorer' 等 | `service.openTab({ type: optionId, title: descriptor.title() })` |
| `src/client/icons.tsx:26-33` `tabTypeIcon` | switch 5 分支 | 废弃；调用方直接读 `descriptor.icon` |

## 10. 文件预览路由改造

### 10.1 `src/client/EditorView.tsx:58-106`（选预览器）

```ts
const viewer = service.matchFileViewer(path, head?)
if (!viewer || viewer.fetchStrategy === 'binary-download') {
  setLoad({ status: 'binary' })
  return
}
switch (viewer.fetchStrategy) {
  case 'mediaUrl': setLoad({ status: 'ready', kind: 'mediaUrl' }); break
  case 'fsRead':
    api.fsRead(scope, path).then(({ content, truncated }) =>
      setLoad({ status: 'ready', kind: 'fsRead', content, truncated })
    )
    break
  case 'custom':
    viewer.load(path, scope).then(data =>
      setLoad({ status: 'ready', kind: 'custom', customData: data })
    )
    break
  case 'none': setLoad({ status: 'ready', kind: 'none' }); break
}
```

### 10.2 `src/client/EditorView.tsx:251-272`（渲染）

```ts
const viewer = service.matchFileViewer(path)
if (!viewer) return <BinaryDownload ... />
return <viewer.component {...props} />
```

4 个内置预览组件（DocxView/XlsxView/PptxView/PdfView）从 `EditorView.tsx` 静态 import 移到 `registerBuiltins` 内部 import + 注册。

## 11. 持久化与降级

- localStorage 里 `orphaned` tab：渲染 `<OrphanedTab title="..." hint="Plugin not loaded: ${tab.type}"/>` + 关闭按钮
- `sanitizeState` / `sanitizeNode` 不再丢弃未识别 type，改为标记 `orphaned`，保留 `title/path` 以备插件恢复时复用

## 12. Consumer 插件使用范例

### 12.1 Consumer `package.json`

```jsonc
{
  "peerDependencies": {
    "cordis": "^4.0.0-rc.8",
    "dsh-better-sidebar": "workspace:*"
  },
  "peerDependenciesMeta": {
    "dsh-better-sidebar": { "optional": true }
  }
}
```

### 12.2 Consumer client half

```ts
// my-plugin/src/client/index.tsx
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并

export const inject = ['betterSidebar', 'slots']

export function apply(ctx: Context): void {
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'my-plugin:db',
      title: () => 'Database',
      icon: <DbIcon />,
      order: 50,
      component: ({ scope, store, tab }) => <DbView scope={scope} />,
    })
  )

  ctx.effect(() =>
    ctx.betterSidebar.registerFileViewer({
      id: 'my-plugin:csv',
      exts: ['csv'],
      fetchStrategy: 'custom',
      load: async (path, scope) => parseCsv(await fetchCsv(scope, path)),
      component: ({ customData, path }) => <CsvGrid data={customData} path={path} />,
    })
  )
}
```

## 13. 测试策略

### 13.1 单元测试

- `tests/service.spec.ts`：`createBetterSidebarService` 的 register/dispose/subscribe 生命周期
- `tests/match-file-viewer.spec.ts`：`matchFileViewer` 的 priority + exts + detect 三段匹配算法
- `tests/builtins.spec.ts`：5 个内置 tab + 8 个内置 viewer 都正确注册
- 现有 `tests/state.spec.ts` / `tests/office-types.spec.ts` / `tests/image-types.spec.ts` 保持通过

### 13.2 集成测试

- `tests/orphaned-tab.spec.ts`：localStorage 里有未注册 type 的 tab → 渲染 `<OrphanedTab/>`，注册后恢复

### 13.3 现有 manifest 守卫

- `tests/manifest-consistency.spec.ts` 的 `contributes.tools/skills` 空数组守卫保持通过
- `CLIENT_EXTERNALS` 列表守卫保持通过（不新增外部 value import）

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 双 cordis 实例导致 consumer 拿不到 `ctx.betterSidebar` 类型 | 由 dsh-better-sidebar 自己 `declare module 'cordis'`，consumer `import type {}` 触发合并 |
| 注册顺序：consumer 在 better-sidebar 之前激活导致 inject 等待 | cordis `inject` 自带就绪等待，consumer 不会在服务就绪前激活 |
| HMR 时 disposer 漏调导致注册项残留 | `ctx.effect(() => disposer)` 挂到 fiber，卸载时自动调 |
| localStorage 里旧版本的 `TabType` 字面量 tab | `sanitizeNode` 改为标记 `orphaned` 不丢弃，向后兼容 |
| `EditorView` 的 `kind` 字段类型从联合字面量变成 string | 内部 `load` 状态类型加 `kind: string` + `customData?: unknown`，TypeScript 收窄在渲染层做 |
| 兜底 `code` viewer priority -100 与外部 `binary-download` -50 冲突 | `matchFileViewer` 先尝试 `detect`（NUL 探测为 binary），再走 exts；外部 `binary-download` 的 `exts: ['doc','xls','ppt']` 优先于兜底 `code` 的 `exts: []` |

## 15. 版本与发布

- 版本号：`v0.4.0`（破坏性：`TabType` 从联合字面量改 string）
- peerDependencies 不变（不加新依赖）
- `dsh.plugin.json` 的 `version` 同步更新到 `0.4.0`
- 重建 `lib/` + 推送 main + profile 更新

## 16. 实施顺序（高层）

1. 拉取 main v0.3.0 到工作分支
2. 新建 `src/client/api.ts`（类型 + `createBetterSidebarService` 工厂）
3. 新建 `src/types.ts`（`declare module 'cordis'` augmentation）+ `src/index.ts` re-export
4. `src/client/index.tsx` 改造：`ctx.provide('betterSidebar', service)` + `registerBuiltins(service)`
5. 抽 `registerBuiltins.ts`：5 个内置 tab + 8 个内置 viewer 注册
6. 改造 7 处硬编码 switch（state.ts / Sidebar.tsx / icons.tsx）
7. 改造 `EditorView.tsx` 的选预览器 + 渲染两段
8. `package.json` 加 `./client/api` exports + `files` 字段
9. 加 `<OrphanedTab/>` 组件 + sanitize 降级
10. 写测试（service / matchFileViewer / builtins / orphaned）
11. typecheck + test + build 三件套
12. 重建 lib/，提交，推送，更新 profile web

详细实施计划由 writing-plans skill 生成。

---

## 17. 实施偏差记录（2026-08-11，feat/modular-registry）

实现（PR #3 + 本分支）与上文设计有意或被迫不同的点，逐条记录。文档以本节为准。

### 17.1 去重机制：`dedupeKey` 为唯一机制，`single` 是其语法糖

§5.2 的 `single?: boolean` 与实现的 `dedupeKey` 合并为单一机制：
- `dedupeKey?: (tab) => string | undefined` 是唯一去重规则（单实例 `() => id`、按 path、按 id 三种旧策略统一表达）；
- `single: true` ≡ `dedupeKey: () => id`（语法糖，显式 dedupeKey 优先）。

### 17.2 `available` 三参签名

§5.2 的 `available?: (ctx, scope) => boolean` 实现为 `(ctx, scope, state) => boolean`（state 用于 terminal 配额等 UI 状态判定，是设计签名的超集）。

### 17.3 匹配算法：单趟 per-descriptor，非三趟全局

§8.2 的算法（priority 降序逐 descriptor，detect 或 exts 二选一）为准；实现确认单趟，并补充一条规则：**`exts: []` + `detect` 是纯嗅探模式**——无 head 时不认领任何文件（避免 magic-sniffer 吞掉图片/PDF 等真实 viewer 的文件），有 head 时只认领 detect 命中的。盲 catch-all（无 detect）行为不变。

### 17.4 编辑器拆分：EditorHost + TextEditor（code/markdown 成为注册 viewer）

§10 的 EditorView 职责一分为二：
- `EditorHost`（'editor' tab 组件）：标题栏 + `matchFileViewer` → 按 fetchStrategy 分发（纯逻辑在 `editor-load.ts` 的 `planFirstMatch`/`planFsReadOutcome`）→ 渲染 viewer.component；binary 无匹配渲染共享 `BinaryDownload`；
- `TextEditor`（viewer 组件）：code/markdown 的 CodeMirror 编辑 + md 预览/编辑切换 + 保存/脏点，内容由 host 经 fsRead 传入，按 `viewerId === 'markdown'` 分支。
- 代码/保存按钮从标题行移到内容区第二行（VSCode 式工具栏，有意 UX 变更）。

### 17.5 `fs.read` 增加 `head` 字段（唯一 host 触碰）

§8.2/§14 的 detect 机制需要 head 字节：host `fs.read` 对二进制响应附加 `head`（base64，前 4KB，常量 `READ_HEAD_LIMIT`）。客户端在 fsRead 结果为二进制时用 head 重匹配一次（无额外 IO），NUL 探测因此成立。向后兼容（新字段）。纯文本文件不触发重匹配（文本嗅探请用 exts 或 custom 策略）。

### 17.6 导出路径：`./client/service` 为主，`./client/api` 为别名

§7 要求 `./client/api`，但 `api.ts` 已被既有的 fetch 助手占用；package.json exports 增加 `"./client/api"` 别名指向 `lib/types/client/service.d.ts`，公共导入路径满足设计，内部文件名不变。

### 17.7 + 菜单：disabled 行而非 filter

§9 的 `filter(!hidden && available)` 实现为"available 返回 false 显示 disabled 行"（与 v0.3.0 旧 UX 一致；终端配额满时用户能看到选项为何不可用）。行为有意保留，文档更新为现状。

### 17.8 保留的 store 级操作（非注册表职责）

- `openDiffTab`（state reducer）：diff 的 split 树放置手术（粘性 diff pane、首次拆分下方），保留；其按 id 去重与 diff descriptor 的 `dedupeKey: (tab) => tab.id` 同规则（测试断言两者一致）。
- `reconcileAgentTerminals`：agent 终端列表同步（host 推送驱动），直接落 state（`openTabInActivePane`），不经过 service（terminal 的 createTab 语义不适用）。
- 命名：state.ts 的 `openTab` reducer 改名 `openTabInActivePane`（与 `service.openTab` 区分）。

### 17.9 内置清单

- tab 6 个不变（editor/explorer/git/subagent/terminal/diff），explorer/git/subagent 改用 `single: true`。
- viewer 8 个：image/pdf/docx/xlsx/pptx（mediaUrl）+ markdown（fsRead）+ code（fsRead，catch-all -100）+ binary-download（-50，exts doc/xls/ppt + NUL detect）。
- `SIDEBAR_BUILTIN_TAB_TYPES` 常量删除（零引用）；`tabTypeIcon` 删除（图标归 descriptor.icon）。

### 17.10 测试

新增 `tests/builtins.spec.ts`（内置注册清单）、`tests/orphaned-tab.spec.tsx`（sanitize 保留未注册类型 + 占位渲染）、`tests/editor-load.spec.ts`（策略分发纯函数）；`tests/browser-globals.ts` 为拉入 xterm/CodeMirror 的 spec 提供模块求值期浏览器全局 mock。`matchFileViewer` 相关断言按 17.3 语义重写。

---

## 18. v0.12.0 基座化扩展记录（2026-08-14，feat/plugin-api-v012）

§5 的服务接口在 v0.12.0 做了**纯增量**扩展（无任何签名删除 / 语义变更，向上兼容），全部记录于此，文档以本节为准：

- **类型导出补齐**：`./client/service` 入口 re-export 公共状态词汇——`SidebarTab` / `SidebarState` / `SidebarStore` / `SidebarSnapshot` / `SidebarDiffRef` / `TabType` / `SessionScope` / `SidebarPrefs` / `OpenTabSeed` / `SidebarSettingsRenderProps`。此前消费者无法命名这些类型（TS2459），只能靠推断。
- **client 声明图零 Node 依赖**：`context-types.ts` 的 `SidebarWebRoute` / `SidebarWebUpgradeRoute` 改用结构镜像类型（`SidebarHttpRequest` / `SidebarHttpResponse` / `SidebarUpgradeSocket` / `SidebarUpgradeHead`），宿主在 ws 边界显式转型（`src/index.ts` 两处）。外部消费插件无需 `@types/node`、`skipLibCheck: false` 也能编译（`scripts/check-consumer-types.sh` 双层校验守护）。
- **新服务方法**：`version` / `features`（单调能力清单，只增不删）；`getSnapshot` / `subscribeState`（状态订阅，委托 store）；`updateTab(tabId, patch)`（title/path/meta）；`activateTab(tabId)`（跨树激活，tab 栏点击路径）；`openFile(scope, path, title?)`（editor 打开，id 按路径派生与内置拦截一致）；`openTab(seed, scope?)`（定向到指定 session：`SidebarStore.reduceFor` 加载/变更/持久化目标 session 而不切换 snapshot，UI 不扰动；scope 指向当前 session 时走原 reduce 路径保证 notify）。
- **新 descriptor 字段**：`badge`（tab 角标：number 计数 99+ 封顶 / string 文本 / null 不显示，每次 tab 栏渲染调用，抛错吞掉）；`onOpen` / `onActivate` / `onClose`（生命周期回调，service 路径派发——dedupe/id 安全网聚焦触发 onActivate 而非 onOpen；内置 diff 拆分与 agent 终端 reconcile 直接改 state 不触发，但只作用于内置类型；回调抛错只 console.error）；`SidebarTab.meta`（JSON 可序列化自定义状态，`sanitizeNode` 宽松保留，跨刷新原样恢复）。
- **设置 seam 开放**：`PrefsSchema` 增加 `pluginSettings: z.dict(z.dict(z.any())).default({})` 开放嵌套 map；`settings.pluginToggles`（插件自有声明式行）与 `settings.render`（自定义面板，props 见 §5）替代「自定义 key 被 seam 丢弃」的限制；viewer 卡片 v0.12.0 起同样有齿轮设置弹窗。
- **`FileViewerDescriptor.load` 第三参 `signal?: AbortSignal`**：EditorHost 在卸载/重匹配时 abort（忽略 signal 的 load 照常工作）。
- 测试：`tests/consumer-types.ts`（消费面编译门）、`tests/api-surface.spec.ts`（client 图零 node 依赖守护 + 能力常量）、`tests/service.spec.ts` 新增生命周期 / 定向打开 / updateTab / activateTab / openFile / meta 持久化用例、`tests/unit.spec.ts` 新增 `reduceFor` 与 sanitize meta 用例。

实现偏差：§5.1 的 `openTab(seed)` 单参签名保留为 `openTab(seed, scope?)` 的可选参数（非破坏）；`SidebarSnapshot` 类型 re-export 自 `./client/service` 而非新建独立文件。
