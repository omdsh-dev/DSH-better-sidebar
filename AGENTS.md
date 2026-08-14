# dsh-better-sidebar 插件接入文档

> 面向**消费插件开发者**：如何让你的插件向 better-sidebar 注册新的侧边栏页面（tab）和文件类型预览器。

better-sidebar 从 v0.4.0 起暴露 `ctx.betterSidebar` 服务（Cordis context 属性），其他插件通过 `registerTab` / `registerFileViewer` 注册扩展点，返回 disposer 由 Cordis fiber 自动管理生命周期（HMR-safe）。

---

## 0. 仓库硬约束（所有本仓库插件必须遵守）

- **禁止修改 DeepSeek Harness (DSH) 源码**：对官方源码 checkout（`~/.dsh/source/current`）零写入——不得改 harness 包、不得把 harness 改动提交到它的分支。
- **挂载只走 `cordis.patch.yml` + profile 机制**（`~/.dsh/profiles/<profile>/`），插件永远作为独立包被 profile 引用，不反向侵入 DSH。
- 需要 harness 没有的能力时，用 DSH **现成的只读/公开 API** 或插件自有路由实现（参考 §7 的 `jobs.output` 事件回放：读会话事件日志而非动注册表）；如果确实做不到，先向用户说明取舍，而不是直接改 DSH。

---

## 1. 服务定位

- **服务名**：`betterSidebar`（即 `ctx.betterSidebar`）
- **发布侧**：better-sidebar 的 client half（`src/client/index.tsx`，通过 `ctx.provide('betterSidebar', service)` 发布）
- **消费侧**：你的插件的 client half（`inject = ['betterSidebar', ...]`，然后 `ctx.betterSidebar.registerTab(...)`）
- **类型合并**：`declare module 'cordis' { interface Context { betterSidebar: BetterSidebarService } }` 由 `dsh-better-sidebar` 包导出；消费插件 `import type {} from 'dsh-better-sidebar'` 即触发类型合并

> ⚠️ **host 半不发布此服务**：`ctx.betterSidebar` 只在 client 侧存在。如果你的插件 host 半需要读 better-sidebar 状态，走 better-sidebar 自己的 HTTP/WS 路由（`/sidebar/api/*`），不走服务。

---

## 2. 消费插件的最小骨架

### 2.1 `package.json`

```jsonc
{
  "name": "my-plugin",
  "peerDependencies": {
    "cordis": "^4.0.0-rc.7",
    "dsh-better-sidebar": "workspace:*"
  },
  "peerDependenciesMeta": {
    "dsh-better-sidebar": { "optional": true }
  }
}
```

- `dsh-better-sidebar` 必须声明为 **peerDependency**（不是 dependency，避免重复实例化）
- 标记 `optional: true` 让你的插件在 better-sidebar 未安装时也能加载（注册代码会因为 `ctx.betterSidebar` 为 undefined 而跳过）

### 2.2 client half 入口

```ts
// my-plugin/src/client/index.ts
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并

export const inject = ['betterSidebar', 'slots']  // 声明服务依赖

export function apply(ctx: Context): void {
  // 注册一个 sidebar tab
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'my-plugin:db',
      title: () => 'Database',
      icon: <DbIcon />,
      order: 50,
      component: ({ ctx, scope, tab }) => <DbView sessionId={scope.sessionId} />,
    })
  )

  // 注册一个文件预览器
  ctx.effect(() =>
    ctx.betterSidebar.registerFileViewer({
      id: 'my-plugin:csv',
      exts: ['csv'],
      fetchStrategy: 'custom',
      load: async (path, scope) => parseCsv(await fetchCsvBytes(scope, path)),
      component: ({ customData, path }) => <CsvGrid data={customData} path={path} />,
    })
  )
}
```

> ⚠️ **构建期纯度门**：client bundle 禁止 value-import 别的插件代码（`tsdown.config.ts` 的纯度门会挡）。`import type {}` 会被擦除，**不触发门禁**——所以类型可以自由共享，运行时符号不行。所有运行时交互必须走 `ctx.betterSidebar` 的方法调用。

### 2.3 类型导入

```ts
import type { TabDescriptor, FileViewerDescriptor, BetterSidebarService } from 'dsh-better-sidebar'
```

类型定义在 `lib/types/client/service.d.ts`，通过 `package.json` 的 `./client/service`（别名 `./client/api`）exports 子路径暴露。v0.12.0 起服务模块还 re-export 了完整的状态词汇表，消费者可以直接命名（不再只能靠推断）：

```ts
import type {
  SidebarTab, SidebarState, SidebarStore, SidebarSnapshot, SidebarDiffRef, TabType,
  SessionScope, SidebarPrefs, OpenTabSeed, SidebarSettingsRenderProps,
} from 'dsh-better-sidebar/client/service'
```

> 💡 **类型合并触发路径**：`import type {} from 'dsh-better-sidebar/client/service'` 同样会加载 `Context` 的 augmentation（`declare module 'cordis'` 在 context-types.d.ts 中，service 声明会拉入它）——纯浏览器侧插件建议走 `client/service` 路径，避免拉进宿主半的 Node 类型图（主入口 `dsh-better-sidebar` 的声明面含宿主代码，宿主消费者本就处于 Node 环境）。client 可达声明图（`client/*` + context-types + html-route + prefs-shared）自 v0.12.0 起**零 Node 依赖**（`scripts/check-consumer-types.sh` 守护），无 `@types/node`、`skipLibCheck: false` 也能编译。

---

## 3. Tab 注册 API

### 3.1 `TabDescriptor` 完整字段

```ts
interface TabDescriptor {
  /** 唯一 id；也是 SidebarTab.type 的值。建议带包前缀：'my-plugin:db'。 */
  id: string
  /** 标题（i18n 友好：传字符串或返回字符串的函数） */
  title: string | (() => string)
  /** 图标：ReactNode 或 (size: number) => ReactNode */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** + 菜单排序（升序）；默认 100。内置：explorer=10, git=20, subagent=30, terminal=40 */
  order?: number
  /** 从 + 菜单隐藏（editor/diff 用：由其他流程触发打开，不在菜单里） */
  hidden?: boolean
  /** + 菜单禁用判定（如 terminal 配额满）。三参：ctx、会话 scope、当前状态 */
  available?: (ctx: Context, scope: SessionScope, state: SidebarState) => boolean
  /**
   * 单实例语法糖：`single: true` ≡ `dedupeKey: () => id`（打开时聚焦既有
   * 同类型 tab 而非新开）。显式给出 dedupeKey 时优先于 single。
   */
  single?: boolean
  /**
   * 去重键：openTab 时若已存在 dedupeKey 相同的 tab，则聚焦而非新开。
   * 返回 undefined 表示不去重（每次都新开，但同 id 会被 id 安全网聚焦）。
   * 内置策略：explorer/git/subagent 用 single: true；editor 用 tab => tab.path；diff 用 tab => tab.id。
   */
  dedupeKey?: (tab: SidebarTab) => string | undefined  // 必须保持纯函数：每次 open 会求值两次，抛错会向外传播
  /**
   * 自定义 tab 创建（minting SidebarTab + 状态 patch）。
   * 返回 null 拒绝创建。terminal 用它生成 terminal:<n> id 并递增 nextTerminal。
   * 省略时用默认 { id, type, title } + seed 里的 path/diff。
   */
  createTab?: (state: SidebarState) => { tab: SidebarTab; patch?: Partial<SidebarState> } | null
  /**
   * 声明式设置（v0.4.1+）：每个注册的 tab 都会在 Side card 设置页获得一行
   * 开关（图标 + 标题 + 类型 id），`settings.toggles` 在其行下追加嵌套设置行，
   * 绑定 SidebarPrefs 字段。嵌套设置仅父级启用时显示（v0.11.0 起行控件不限于
   * 布尔开关：`type: 'switch' | 'text' | 'number'`，缺省 'switch'；text/number
   * 行 blur/Enter 提交，number 行按 min/max 钳制，unit 渲染单位后缀）。
   * v0.12.0 起增加两个插件自有扩展（详见 §5 声明式设置）：
   * `pluginToggles`（插件自有 key，持久化在 pluginSettings[id]，无需宿主 schema 字段）
   * 与 `render`（自定义设置面板，替代行列表）。
   */
  settings?: {
    toggles?: readonly {
      /** SidebarPrefs 字段名（内置键：'autoOpenSubagent' / 'agentTerminalTools' / 'terminalFontFamily' / 'htmlViewerNoSandbox' / 'htmlViewerDefaultUnsafe' / 'browserNoSandbox' / 'browserInterceptLinks'） */
      key: string
      title: string | (() => string)
      desc?: string | (() => string)
      /** 行控件类型；缺省 'switch'（向后兼容）。 */
      type?: 'switch' | 'text' | 'number'
      /** number 行的提交钳制下限。 */
      min?: number
      /** number 行的提交钳制上限。 */
      max?: number
      /** text 行的输入占位符。 */
      placeholder?: string
      /** 输入框后的单位后缀（如 'px'）。 */
      unit?: string
    }[]
    /** 插件自有设置行（v0.12.0+）：形状同 toggles，但 key 是插件局部的，
     *  持久化在 `pluginSettings[<descriptor id>]`——不需要宿主 PrefsSchema 字段。 */
    pluginToggles?: readonly {
      key: string
      title: string | (() => string)
      desc?: string | (() => string)
      type?: 'switch' | 'text' | 'number'
      min?: number
      max?: number
      placeholder?: string
      unit?: string
    }[]
    /** 自定义设置面板（v0.12.0+）：给出时齿轮弹窗渲染它而非行列表。
     *  props 含 store/service/prefs、本 descriptor 的 pluginSettings blob、
     *  updatePluginSetting(key, value) 与 close()。抛错会被吞掉并显示内联错误。 */
    render?: (props: {
      store: SidebarStore
      service: BetterSidebarService
      prefs: SidebarPrefs
      pluginSettings: Record<string, unknown>
      updatePluginSetting: (key: string, value: unknown) => void
      close: () => void
    }) => ReactNode
  }
  /**
   * tab 角标（v0.12.0+）：tab 图标旁的小圆角 pill。number 渲染计数（99+ 封顶），
   * string 原样文本，null/undefined 不显示。每次 tab 栏渲染都会调用——保持廉价；
   * 抛错会被吞掉（不显示角标，不影响渲染）。
   */
  badge?: (ctx: Context, scope: SessionScope, state: SidebarState) => string | number | null | undefined
  /**
   * 生命周期回调（v0.12.0+），只由 SERVICE 路径触发：
   * - onOpen：openTab 真正**新建** tab 后（dedupe/id 安全网聚焦**不算**打开）；
   * - onActivate：tab 被聚焦时（dedupe 聚焦、id 安全网聚焦、tab 栏点击激活）；
   * - onClose：closeTab 关闭 tab 后。
   * 内置专属流程（diff 拆分放置、agent 终端 reconcile）直接改 state，不触发回调——
   * 但它们只作用于内置类型（diff/terminal），外部插件的 tab 永远走 service 路径。
   * 回调抛错只 console.error，绝不打断打开/关闭流程。openTab 的回调 scope
   * 携带调用者传入的 { sessionId, cwd? }（+ 菜单路径带 cwd；无 scope 的自动
   * 打开路径只有 sessionId）；closeTab/activateTab 的回调 scope 只在显式传入
   * scope 参数时带 cwd。
   */
  onOpen?: (tab: SidebarTab, scope: SessionScope) => void
  onActivate?: (tab: SidebarTab, scope: SessionScope) => void
  onClose?: (tab: SidebarTab, scope: SessionScope) => void
  /** 渲染函数 */
  component: (props: TabComponentProps) => ReactNode
}
```

### 3.2 `TabComponentProps`

```ts
interface TabComponentProps {
  ctx: Context                 // client cordis context
  store: SidebarStore          // better-sidebar 的状态 store（可调 reduce 等）
  scope: SessionScope          // { sessionId, cwd? }
  tab: SidebarTab              // 当前 tab 实例（含 id/type/title/path?/diff?）
  visible: boolean             // 是否是当前激活 tab 且面板打开（不可见时暂停轮询等）
  // 以下由内置 tab 使用，外部 tab 可忽略：
  expanded?: string[]          // explorer 的展开目录集
  onToggleDir?: (path: string) => void
  onReferenceFile?: (path: string) => void
  onOpenFile?: (path: string) => void
  onOpenDiff?: (tab: SidebarTab) => void
  onSubagentJump?: (childSessionId: string) => void
}
```

### 3.3 注册示例

**最简 tab**（单实例、+ 菜单可见）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:notes',
    title: 'Notes',
    icon: <NoteIcon />,
    order: 50,
    single: true,  // ≡ dedupeKey: () => 'my-plugin:notes'
    component: ({ scope }) => <NotesView sessionId={scope.sessionId} />,
  })
)
```

**多实例 tab**（每次新开、带自定义 id）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:doc',
    title: 'Doc',
    icon: <DocIcon />,
    order: 60,
    // 不设 dedupeKey：每次 openTab 都新开
    component: ({ tab, scope }) => <DocView docId={tab.id} sessionId={scope.sessionId} />,
  })
)
// 外部触发打开：
ctx.betterSidebar.openTab({ type: 'my-plugin:doc', title: 'Spec.md', id: 'doc:spec' })
```

**条件可见**（仅 git 仓库时显示）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:commits',
    title: 'Commits',
    icon: <CommitIcon />,
    order: 70,
    available: (ctx, scope, state) => hasGitRepo(state),  // 三参 (ctx, scope, state)；返回 false 时 + 菜单显示为 disabled
    // 注意：available 只影响 + 菜单的 disabled 状态，不会拒绝 openTab（只有设置页的禁用开关会）。
    dedupeKey: () => 'my-plugin:commits',
    component: ({ scope }) => <CommitsView sessionId={scope.sessionId} />,
  })
)
```

### 3.4 内置 tab（不可重复注册）

| id | order | single | hidden | 用途 |
|---|---|---|---|---|
| `editor` | -1 | 否（按 path 去重） | 是 | 文件编辑/预览（由 openSidebarFile 触发） |
| `explorer` | 10 | 是 | 否 | 文件资源管理器 |
| `git` | 20 | 是 | 否 | Git 面板 |
| `github` | 25 | 是 | 否 | GitHub 收件箱（未读通知/类别过滤/审查动作/Merge 门控；首个使用 badge 的内置 tab） |
| `subagent` | 30 | 是 | 否 | 子代理拓扑 |
| `terminal` | 40 | 否 | 否 | 终端（nextTerminal 自增） |
| `browser` | 50 | 否（createTab 铸造 browser:`<n>`，nextBrowser 自增） | 否 | 内嵌网页浏览器（沙箱 iframe；可设置关闭沙箱） |
| `diff` | -1 | 否（按 id 去重） | 是 | 差异查看（由 GitView 触发） |

你的 `id` 不可与上述重复，否则 `registerTab` 抛 `"tab type \"X\" already registered"`。

---

## 4. FileViewer 注册 API

### 4.1 `FileViewerDescriptor` 完整字段

```ts
interface FileViewerDescriptor {
  /** 唯一 id：'image' / 'pdf' / 'my-plugin:csv' */
  id: string
  /** 设置清单展示名（v0.4.1+，i18n 友好）；缺省回退到 id */
  title?: string | (() => string)
  /** 设置清单图标（v0.4.1+）：ReactNode 或 (size: number) => ReactNode */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** 小写无点的扩展名数组：['png','jpg']。[] = catch-all（仅最低优先级有效） */
  exts: readonly string[]
  /** 优先级（高优先）；默认 0。内置默认 0；catch-all code 用 -100；binary-download 用 -50 */
  priority?: number
  /** 字节获取策略 */
  fetchStrategy: 'none' | 'fsRead' | 'mediaUrl' | 'custom' | 'binary-download'
  /** 内容嗅探（覆盖 exts）：head 字节可用时，第一个 detect 返回 true 的 viewer 命中 */
  detect?: (path: string, head: Uint8Array) => boolean
  /** fetchStrategy='custom' 时的加载函数；v0.12.0+ 第三参 signal 在 viewer
   *  卸载/重匹配时中止（忽略 signal 的 load 也照常工作） */
  load?: (path: string, scope: SessionScope, signal?: AbortSignal) => Promise<unknown>
  /** 声明式设置（v0.4.1+）：形状同 TabDescriptor.settings */
  settings?: { toggles?: readonly { key: string; title: string | (() => string); desc?: string | (() => string) }[] }
  /** 渲染函数 */
  component: (props: FileViewerProps) => ReactNode
}
```

### 4.2 `FileViewerProps`

```ts
interface FileViewerProps {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  path: string
  title: string
  viewerId: string         // 命中 viewer 的 id（如 'code' / 'my-plugin:csv'）
  content?: string        // fetchStrategy='fsRead' 时
  truncated?: boolean     // fetchStrategy='fsRead' 时
  mediaUrl?: string       // fetchStrategy='mediaUrl' 时
  customData?: unknown    // fetchStrategy='custom' 时（load() 的返回值）
}
```

### 4.3 `fetchStrategy` 对照

| 策略 | 字节来源 | 传给 component 的字段 | 适用 |
|---|---|---|---|
| `none` | 不需要字节 | （无） | 自渲染（如纯 UI） |
| `fsRead` | `/sidebar/api` 的 `fs.read` | `content`, `truncated` | 文本类（CSV/JSON/XML） |
| `mediaUrl` | `/sidebar/file` 媒体路由 URL | `mediaUrl` | 图片/PDF（viewer 自己 fetch 字节） |
| `custom` | viewer 的 `load()` 函数 | `customData` | 自定义协议（如远程拉取） |
| `binary-download` | 不预览，显示下载按钮 | （无） | 无客户端渲染器的二进制格式 |

### 4.4 匹配算法

`matchFileViewer(path, head?)` **单趟**按 priority 降序（稳定排序，相同 priority 按注册顺序）遍历每个 descriptor：

1. 若 `head` 字节可用且该 descriptor 有 `detect` → 调 `detect(path, head)`，true 则命中；**miss 且是 catch-all（`exts: []`）则本轮放弃**（纯嗅探型不得盲认领）
2. 否则匹配 `exts`（小写无点；`exts: []` 且无 `detect` 是盲 catch-all，直接命中）

即：**priority 高的 descriptor 先获得裁决权**（其 detect 或 exts 任一命中即赢），低 priority 的 detect 不会越过高 priority 的 exts 匹配。`exts: []` + `detect` 的组合是"纯嗅探"：无 head 时不认领任何文件（不会吞掉图片/PDF 等真实 viewer 的文件），有 head 时只认领 detect 命中的。全部 miss 返回 `undefined`（编辑器显示下载按钮）。

> **head 字节从哪来**：第一次匹配（纯扩展名）没有 head。`fsRead` 策略读取后若文件为二进制，host 的 `fs.read` 响应会带 `head` 字段（base64，前 4KB），编辑器会用它对 `detect` viewer **重匹配一次**——所以 detect 型 viewer 的实际触发场景是"扩展名匹配落空/二进制文件"。文本文件的 detect 嗅探不在内置流程内（用 `exts` 或 `custom` 策略替代）。

> **内置 viewer**（不可重复注册，全部 6 个）：image(0) / pdf(0) / markdown(0, fsRead) / html(0, fsRead, 沙箱 iframe 预览) / code(-100, catch-all, fsRead) / binary-download(-50, exts doc/xls/ppt + NUL detect)。Office 三件套预览（.docx/.xlsx/.pptx）**不再内置**——已迁至推荐插件（设置页「添加插件」→ 文件预览弹窗里的 Office 预览插件），该插件以相同 id 经 `ctx.betterSidebar.registerFileViewer` 注册。
> code 是兜底 viewer：任何其他 viewer 未认领的文件都会落到 code（CodeMirror 文本编辑）；二进制文件经 head 重匹配被 binary-download 的 NUL detect 认领（下载按钮）。外部 viewer 注册同扩展名 + 更高 priority 即可覆盖。

### 4.5 注册示例

**CSV 预览器**（自定义加载 + 渲染）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:csv',
    exts: ['csv'],
    fetchStrategy: 'custom',
    load: async (path, scope) => {
      const text = await fetchText(scope, path)
      return parseCsv(text)
    },
    component: ({ customData, path }) => <CsvGrid rows={customData as string[][]} path={path} />,
  })
)
```

**覆盖内置 image viewer**（如想用自定义的 SVG 优化渲染）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:svg-pro',
    exts: ['svg'],
    priority: 10,  // 高于内置 image 的 0
    fetchStrategy: 'mediaUrl',
    component: ({ mediaUrl }) => <OptimizedSvg src={mediaUrl} />,
  })
)
```

**内容嗅探**（按 magic bytes 路由，忽略扩展名）：
```ts
ctx.effect(() =>
  ctx.betterSidebar.registerFileViewer({
    id: 'my-plugin:magic-parquet',
    exts: [],  // catch-all，但 priority 高 + detect 精确命中
    priority: 100,
    fetchStrategy: 'custom',
    detect: (_path, head) => head.length >= 4
      && head[0] === 0x50 && head[1] === 0x41
      && head[2] === 0x52 && head[3] === 0x31,  // 'PAR1'
    load: async (path, scope) => parseParquet(await fetchBytes(scope, path)),
    component: ({ customData }) => <ParquetTable data={customData} />,
  })
)
```

---

## 5. 服务方法完整清单

```ts
interface BetterSidebarService {
  /** 注册 tab 类型；返回 disposer */
  registerTab(descriptor: TabDescriptor): () => void
  /** 注册文件预览器；返回 disposer */
  registerFileViewer(descriptor: FileViewerDescriptor): () => void
  /** 当前已注册的 tab 描述符快照（同步，供 useSyncExternalStore 用；含被设置页禁用的类型） */
  getTabs(): readonly TabDescriptor[]
  /** 当前已注册的 file viewer 描述符快照（含被设置页禁用的 viewer） */
  getFileViewers(): readonly FileViewerDescriptor[]
  /** 按 id 查 tab 描述符 */
  getTab(id: string): TabDescriptor | undefined
  /** 某个 tab 类型是否在 Side card 设置中启用（v0.4.1+；缺省 = 启用） */
  isTabEnabled(id: string): boolean
  /** 某个 file viewer 是否在 Side card 设置中启用（v0.4.1+；缺省 = 启用） */
  isViewerEnabled(id: string): boolean
  /** 按 path 匹配 file viewer（priority 降序单趟：detect → exts；跳过硬禁用 viewer） */
  matchFileViewer(path: string, head?: Uint8Array): FileViewerDescriptor | undefined
  /**
   * 打开一个 tab（+ 菜单和外部触发都用它；走 descriptor.dedupeKey 去重）。
   * title 可选：给出时优先于 descriptor.title（editor 显示文件名）；
   * 有 createTab 的 descriptor（terminal）会忽略 title/path/id。
   * url 可选：把**新建** tab 的 path 预填为 URL（侧边栏浏览器导航种子，
   * 通常配合 hostname title；对 createTab 铸造的 tab 同样生效）。聚焦既有
   * tab 时 url 不会覆写其 path。
   * 被设置禁用的类型是 no-op（console.warn 提示）。
   * scope（v0.12.0+）定向到指定 session：给出且非当前 session 时，打开落在
   * 该 session 的侧边栏状态里（没有则按 prefs 新建），不切换 UI 的激活 session；
   * 定向打开**不自动展开**目标 session 的面板（用户看不见，展开无意义）；
   * 缺省或指向当前 session 时行为与之前完全一致。注意：available 不拦截 openTab。
   * 内容型打开（带 path/url seed）必须落在视野内：承载落点 pane 的面板
   * 折叠时自动展开（右侧面板；落点 pane 在底部树则展开底部面板；窄视口
   * 展开合并抽屉）；类型型打开（+ 菜单、agent 终端自动补 tab）不展开。
   */
  openTab(seed: OpenTabSeed, scope?: SessionScope): void
  /** 关闭一个 tab（未知 id 严格 no-op，无状态搅动）；scope（v0.12.0+）
   *  随回调传递（含可选 cwd），缺省为 { sessionId: 当前 } */
  closeTab(tabId: string, scope?: SessionScope): void
  /** 订阅注册表变化（register/dispose 时触发） */
  subscribe(listener: () => void): () => void
  // ── v0.12.0+ ──────────────────────────────────────────────────────────
  /** 插件版本（如 '0.12.0'；与 package.json 同步，测试守护） */
  readonly version: string
  /** 单调能力清单（只增不删）：'badge' | 'tabLifecycle' | 'updateTab' |
   *  'openFile' | 'targetedOpen' | 'stateSubscription' | 'tabMeta' |
   *  'pluginSettings'——消费插件用 `features.includes('xxx')` 按能力 gate。 */
  readonly features: readonly string[]
  /** 当前快照：激活 sessionId + 其状态（面板几何/打开的 tabs/展开集）+ prefs。
   *  session 未激活时 state/sessionId 为 undefined。 */
  getSnapshot(): SidebarSnapshot
  /** 订阅快照变化（会话切换/状态变更/prefs 写入）；返回 disposer */
  subscribeState(listener: () => void): () => void
  /** 更新一个已打开 tab 的显示字段（title/path/meta）；tab 不存在时 no-op */
  updateTab(tabId: string, patch: { title?: string; path?: string; meta?: unknown }): void
  /** 激活一个已打开的 tab（tab 栏点击路径；触发 descriptor.onActivate；
   *  未知 id 严格 no-op）；scope（v0.12.0+）随回调传递，同 closeTab */
  activateTab(tabId: string, scope?: SessionScope): void
  /** 在 scope.sessionId 的侧边栏编辑器打开一个文件（title 缺省为文件名；
   *  id 按路径派生，与内置 open-path 拦截一致，不同文件可并排打开） */
  openFile(scope: SessionScope, path: string, title?: string): void
}

/** openTab 的 seed（v0.12.0 起导出命名类型） */
interface OpenTabSeed {
  type: string
  title?: string
  path?: string
  diff?: SidebarTab['diff']
  id?: string
  url?: string
  /** JSON 可序列化的自定义状态，随 tab 持久化（刷新后原样恢复）；
   *  updateTab/seed 传 undefined 表示「不改」，传 null 可显式清除 */
  meta?: unknown
}
```

> **声明式设置（v0.4.1+）**：每个注册的 tab/viewer 自动出现在 DSH 设置页「侧边卡片」分区的清单里——响应式网格中的**小卡片**（图标 + 标题 + 类型 id + **高亮 = 启用**，勾选徽标钉在卡片最右端，viewer 卡片还显示扩展名），开关持久化到 `SidebarPrefs.tabsEnabled / viewersEnabled`（开放 map，缺省 = 启用）。关闭语义：tab 从 `+` 菜单消失、`openTab` 拒绝新开、子代理自动展开 / agent 终端自动补 tab 等派生流程停止，**已打开的 tab 保留**；viewer 被 `matchFileViewer` 跳过，文件落到下一个匹配。`settings.toggles` 声明的相关设置（如子代理的 `autoOpenSubagent`、终端的 `terminalFontFamily`/`terminalFontSize`）通过卡片右下角的齿轮按钮在**原生弹窗**中编辑——`type: 'switch'` 行是复选框，`type: 'text'`/`'number'` 行是输入框（v0.11.0+）——父级卡片关闭时齿轮隐藏；`settings.toggles` 的 **key 必须是宿主 PrefsSchema 的字段**（内置键：`autoOpenSubagent` / `agentTerminalTools` / `terminalFontFamily` / `terminalFontSize` / `htmlViewerNoSandbox` / `htmlViewerDefaultUnsafe` / `browserNoSandbox` / `browserInterceptLinks`）。**v0.12.0 起设置 seam 已开放**：外部插件用 `settings.pluginToggles`（同款行控件，key 插件局部）或 `settings.render`（自定义面板）声明自己的设置，值持久化在 prefs 文档的 `pluginSettings[<descriptor id>]`（开放 map，宿主 schema 已有字段，无需注册）——齿轮弹窗对 tab 与 viewer 都可用（viewer 卡片 v0.12.0 起也有齿轮）。

---

## 6. 生命周期与 HMR

- **disposer 必须返回**：`registerTab` / `registerFileViewer` 返回 `() => void`，Cordis fiber 卸载时自动调用。**务必**用 `ctx.effect(() => register(...))` 包裹，否则 fiber 卸载（HMR / 插件禁用）时不会撤销注册，导致下次激活时 `"already registered"` 错误。
- **注册时机**：better-sidebar 在 `apply()` 开头 `ctx.provide('betterSidebar', service)`，所以你的插件 `inject = ['betterSidebar']` 时，better-sidebar 已经就绪。
- **顺序无关**：Cordis 的 `inject` 保证服务就绪后才激活你的插件；你的插件可在 `apply` 内任意时刻注册。
- **持久化降级**：localStorage 里持久化的 tab 若其 type 未注册（你的插件未加载），渲染为 `<OrphanedTab/>` 占位卡（显示 "插件未加载" + 关闭按钮）；你的插件加载后下次渲染自动恢复。

---

## 7. 平台约束与陷阱

| 陷阱 | 说明 |
|---|---|
| **构建纯度门** | client bundle 禁止 value-import `@dsh-external/*` 或非白名单的 `@deepseek-ai/*`；类型 `import type {}` 会被擦除，不触发门禁 |
| **双 cordis 实例** | 外部插件解析不到 DSH monorepo 的 cordis augmentation；better-sidebar 自己重述了 `interface Context { betterSidebar: ... }`，你 `import type {}` 即拿到类型 |
| **ModuleLoader 不跨插件** | 运行时 `require()` 虽支持跨 bundle，但被构建门挡；所有交互走 `ctx.betterSidebar` 方法调用 |
| **host 半无此服务** | `ctx.betterSidebar` 只在 client 侧存在；host 半需要 better-sidebar 数据走 `/sidebar/api/*` HTTP 路由 |
| **portal 限制** | 整面板 slot 由 ui-layout 独占，外部 tab 只能进入 better-sidebar 的 portal 内部，无法全屏替换 |
| **id 冲突** | `registerTab` / `registerFileViewer` 对重复 id 抛错；建议用包前缀（`my-plugin:xxx`） |
| **i18n 跟随** | 侧边栏界面文案跟随 DSH 的 `ctx.locale`（`@deepseek-ai/dsh-client-locale`）：词典注册在 `betterSidebar` 命名空间，语言偏好（Host-backed `locale.preference`）与浏览器语言不一致时以 DSH 为准并实时切换；locale 服务缺失时回退浏览器语言。插件自身的 `t()`（`src/client/locales.ts`）由 `apply()` 挂接服务；消费插件**不要**依赖此内部函数——标题等字段传字符串或 `() => string` 即可（i18n 友好）。⚠️ 渲染 DSH 的 `MarkdownText` 时必须传 `codeLabels={{ copyLabel: t('copy'), copiedLabel: t('copied') }}`——该组件 cordis-free，漏传则代码块复制按钮回退硬编码中文 |
| **懒加载 chunk** | 内置重依赖（xterm/CodeMirror）在独立 bundle（`lib/client-<name>.js`）中，经 `/sidebar/bundle` 路由按需下发；每个脚本把 factory 赋到插件自有全局注册表 `globalThis.__dshChunks__[<name>]`，由 `src/client/chunk-loader.ts` 用自定义 require（externals 经 `__DSH_MODULES__` seed 分支解析）物化——**不经过** `__ModuleLoader__` 注册；**核心 bundle 禁止静态 import `src/client/chunks/*`**（会把库拖回启动路径）；对消费插件透明——懒加载只作用于内置 descriptor，`component` 契约（`(props) => ReactNode` 纯渲染函数）不变 |

---

## 8. 完整最小示例

> 假设插件 `my-plugin` 要加一个"Database 浏览器" tab + `.csv` 文件预览器。

**`my-plugin/package.json`**：
```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "peerDependencies": {
    "cordis": "^4.0.0-rc.7",
    "dsh-better-sidebar": "workspace:*",
    "@deepseek-ai/dsh-client-runtime": "^0.0.1",
    "react": "^18.2.0"
  },
  "peerDependenciesMeta": {
    "dsh-better-sidebar": { "optional": true }
  }
}
```

**`my-plugin/src/client/index.tsx`**：
```tsx
import { createElement } from 'react'
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并
import type { Context } from 'cordis'

export const inject = ['betterSidebar']

export function apply(ctx: Context): void {
  // Database tab
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'my-plugin:db',
      title: () => 'Database',
      order: 50,
      dedupeKey: () => 'my-plugin:db',
      component: ({ scope }) => createElement(DbView, { sessionId: scope.sessionId }),
    })
  )

  // CSV viewer
  ctx.effect(() =>
    ctx.betterSidebar.registerFileViewer({
      id: 'my-plugin:csv',
      exts: ['csv'],
      fetchStrategy: 'custom',
      load: async (path, scope) => {
        const res = await fetch('/sidebar/api/fs.read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: scope.sessionId, path }),
        })
        const { value } = await res.json()
        return parseCsv(value.content)
      },
      component: ({ customData, path }) =>
        createElement(CsvGrid, { rows: customData as string[][], path }),
    })
  )
}

function DbView(props: { sessionId: string }): React.ReactNode { /* ... */ }
function CsvGrid(props: { rows: string[][]; path: string }): React.ReactNode { /* ... */ }
function parseCsv(text: string): string[][] { /* ... */ }
```

**注册到 profile**：在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 加 `"my-plugin": "link:<你的插件路径>"`，在 `cordis.patch.yml` 加挂载行，`pnpm install`，浏览器硬刷新即可（DSH 对 client 改动热加载，无需重启 `dsh web`；仅 host 半改动需要重启）。

---

## 9. 参考实现

better-sidebar 自己的内置 tab 和 viewer 就是参考实现（"吃狗粮"）：

- **`src/client/builtins/`**：8 个内置 tab（explorer/git/github/subagent/terminal/browser/editor/diff）+ 6 个内置 viewer（image/pdf/markdown/html/code/binary-download）的注册代码（tabs.tsx / viewers.tsx / index.ts；Office 预览已迁至推荐插件，见 plugins-viewers.ts）
- **`src/client/service.ts`**：`BetterSidebarService` 接口 + `createBetterSidebarService` 工厂实现
- **`src/client/SideCardSection.tsx`**：声明式设置页（注册表驱动清单 + `settings.toggles` 嵌套设置行：switch/text/number + 持久化）
- **`tests/service.spec.ts`**：注册表生命周期 / 匹配算法 / dedupe / createTab / 启用态 gating 测试
- **`tests/builtins.spec.ts`**：内置注册清单断言（8 tab + 6 viewer + 声明式元数据）
- **`src/client/plugins-tabs.ts`** / **`src/client/plugins-viewers.ts`**：推荐插件目录（名字/url/简介/安装脚本，分别对应 Tab 注册与文件预览注册），在设置页两个「添加插件」弹窗展示（共享类型在 `plugins-shared.ts`）；插件作者可按扩展点加一条数据（弹窗内「跳转」直达仓库、「复制」把安装命令写入剪贴板，粘贴到 DSH 所在环境的终端执行）——数据完整性由 `tests/plugin-list.spec.ts` 守护
- **`docs/plans/2026-08-11-service-registry-design.md`** / **`docs/plans/2026-08-11-declarative-sidebar-settings-design.md`** / **`docs/plans/2026-08-14-add-plugins-modal-design.md`**：设计文档（含实施偏差记录）

调试时直接读这些文件即可看到所有 API 的真实用法。
