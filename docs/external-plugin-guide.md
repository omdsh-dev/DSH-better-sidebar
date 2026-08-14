# 外部插件接入指南：基于 dsh-better-sidebar 实现新页面

> 面向 **消费插件开发者**：如何让你的插件向 better-sidebar 注册新的侧边栏页面（tab）和文件类型预览器。
>
> 适用版本：**v0.4.0+**（`ctx.betterSidebar` 服务）；声明式设置部分需要 **v0.4.1+**。当前版本 v0.4.3。
> 权威代码：`src/client/service.ts`（服务实现）、`src/client/builtins/`（内置 6 tab + 8 viewer 参考实现）、`lib/types/client/service.d.ts`（类型声明）。

---

## 1. 总览：你能扩展什么

better-sidebar 从 v0.4.0 起把自己改造成一个**注册表服务**：

- **新页面（tab）**：注册一种新的侧边栏 tab 类型，出现在侧边栏 `+` 菜单里，用户点击后在自己的分栏里打开你的 React 页面；
- **文件预览器（file viewer）**：注册一种文件类型预览器，让用户在侧边栏打开文件时走你的渲染组件（覆盖或补充内置的 image/pdf/code 等）。

内置的 6 个 tab（explorer / git / subagent / terminal / editor / diff）和 8 个 viewer（image / pdf / docx / xlsx / pptx / markdown / code / binary-download）**自己也是通过同一套 API 注册的**（吃自己的狗粮），所以外部插件的能力与内置功能完全对等。

关键机制一句话：better-sidebar 的 client half 在 `apply()` 开头执行 `ctx.provide('betterSidebar', service)`（`src/client/index.tsx`），消费插件在 `inject` 里声明 `'betterSidebar'`，Cordis 保证服务就绪后才激活你的插件，然后你调用 `ctx.betterSidebar.registerTab(...)` / `registerFileViewer(...)` 完成注册，返回的 disposer 由 Cordis fiber 在卸载（HMR / 禁用）时自动调用。

> ⚠️ **服务只在 client half**：`ctx.betterSidebar` 只存在于浏览器侧。你的插件 **host 半没有这个服务**；host 半需要读 better-sidebar 状态时，走它自己的 HTTP/WS 路由（`/sidebar/api/*`、`/sidebar/file`、`/sidebar/ws/*`），不走服务。

---

## 2. 前置：类型合并与依赖声明

### 2.1 双 cordis 实例问题

外部插件在 DSH monorepo 之外解析，拿不到官方 cordis 的 augmentation，因此 `ctx.betterSidebar` 不会自动出现在你的 `Context` 类型上。解法由 better-sidebar 自己提供：

```ts
import type {} from 'dsh-better-sidebar'  // 触发 declare module 'cordis' 类型合并
```

这个 **type-only import** 在编译时被擦除，不产生任何运行时依赖，也不会触发构建纯度门（见 §9）。

### 2.2 package.json 声明

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

- `dsh-better-sidebar` 必须是 **peerDependency**（不是 dependency），避免两份实例；
- `optional: true`：better-sidebar 未安装时你的插件照常加载，注册代码因为 `ctx.betterSidebar` 为 undefined 而安全跳过。

### 2.3 类型导入路径

```ts
// 方式一：主入口（推荐，src/index.ts 已 re-export 全部描述符类型）
import type {
  BetterSidebarService,
  TabDescriptor,
  TabComponentProps,
  FileViewerDescriptor,
  FileViewerProps,
  FileFetchStrategy,
} from 'dsh-better-sidebar'

// 方式二：子路径（与主入口等价）
import type { TabDescriptor } from 'dsh-better-sidebar/client/service'  // 别名 ./client/api
```

---

## 3. 最小骨架（client half）

```ts
// my-plugin/src/client/index.ts
import type {} from 'dsh-better-sidebar'          // 触发 ctx.betterSidebar 类型合并
import type { Context } from 'cordis'

export const inject = ['betterSidebar', 'slots']   // 声明服务依赖（slots 可选，按需）

export function apply(ctx: Context): void {
  // 注册一个 sidebar tab：ctx.effect 包裹 → 卸载时自动撤销注册（HMR-safe）
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'my-plugin:db',
      title: () => 'Database',
      icon: <DbIcon />,
      order: 50,
      component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
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

要点：

- **注册必须包在 `ctx.effect(...)` 里**。`registerTab` / `registerFileViewer` 返回 `() => void` disposer，Cordis fiber 卸载时自动调用；不包 effect，HMR / 插件禁用后注册残留，下次激活会抛 `"already registered"`。
- `inject = ['betterSidebar']` 让 Cordis 在 better-sidebar 激活后才激活你的插件，注册时机无忧（顺序无关）。
- 注册在 `apply` 内任意时刻都行；服务在 better-sidebar 的 `apply()` 开头就绪。

---

## 4. 新页面（Tab）注册 API

### 4.1 `TabDescriptor` 完整字段

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
  dedupeKey?: (tab: SidebarTab) => string | undefined
  /**
   * 自定义 tab 创建（minting SidebarTab + 状态 patch）。
   * 返回 null 拒绝创建。terminal 用它生成 terminal:<n> id 并递增 nextTerminal。
   * 省略时用默认 { id, type, title } + seed 里的 path/diff。
   */
  createTab?: (state: SidebarState) => { tab: SidebarTab; patch?: Partial<SidebarState> } | null
  /**
   * 声明式设置（v0.4.1+）：见 §7。
   */
  settings?: {
    toggles?: readonly {
      key: string
      title: string | (() => string)
      desc?: string | (() => string)
    }[]
  }
  /** 渲染函数 */
  component: (props: TabComponentProps) => ReactNode
}
```

### 4.2 `TabComponentProps`（你的页面组件收到的 props）

```ts
interface TabComponentProps {
  ctx: Context                 // client cordis context
  store: SidebarStore          // better-sidebar 的状态 store（可调 reduce 等）
  scope: SessionScope          // { sessionId, cwd? } —— 会话标识，调用 /sidebar API 必带
  tab: SidebarTab              // 当前 tab 实例（含 id/type/title/path?/diff?）
  visible: boolean             // 是否当前激活 tab 且面板打开（不可见时暂停轮询等）
  // 以下由内置 tab 使用，外部 tab 可忽略：
  expanded?: string[]          // explorer 的展开目录集
  onToggleDir?: (path: string) => void
  onReferenceFile?: (path: string) => void
  onOpenFile?: (path: string) => void
  onOpenDiff?: (tab: SidebarTab) => void
  onSubagentJump?: (childSessionId: string) => void
}
```

实践建议：

- **用 `visible` 做性能门**：subagent 内置页在 `visible === false` 时暂停轮询；你的页面若有轮询/订阅，同样处理。
- **用 `scope.sessionId`（+ `scope.cwd`）访问会话数据**：所有 `/sidebar/api/*` 请求都要带这两个字段（见 §6）。

### 4.3 注册示例

**最简单实例 tab**（+ 菜单可见）：

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

**多实例 tab + 外部触发打开**（每次新开，带自定义 id）：

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
// 外部触发打开（你的插件其他流程、甚至用户操作）：
ctx.betterSidebar.openTab({ type: 'my-plugin:doc', title: 'Spec.md', id: 'doc:spec' })
```

**条件可见**（仅满足条件时 + 菜单可用；返回 false 显示为 disabled 行而非隐藏）：

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:commits',
    title: 'Commits',
    icon: <CommitIcon />,
    order: 70,
    available: (ctx, scope, state) => hasGitRepo(state),
    dedupeKey: () => 'my-plugin:commits',
    component: ({ scope }) => <CommitsView sessionId={scope.sessionId} />,
  })
)
```

**自定义创建**（mint 自增 id，terminal 内置页同款）：

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:console',
    title: 'Console',
    order: 80,
    createTab: (state) => ({
      tab: { id: `console:${state.nextTerminal}`, type: 'my-plugin:console', title: `Console ${state.nextTerminal}` },
      patch: { nextTerminal: state.nextTerminal + 1 },  // 借内置计数器；也可自建 state 字段
    }),
    component: ({ tab, scope }) => <ConsoleView tabId={tab.id} sessionId={scope.sessionId} />,
  })
)
```

### 4.4 内置 tab 清单（不可重复注册）

| id | order | single | hidden | 用途 |
|---|---|---|---|---|
| `editor` | -1 | 否（按 path 去重） | 是 | 文件编辑/预览（由 openSidebarFile 触发） |
| `explorer` | 10 | 是 | 否 | 文件资源管理器 |
| `git` | 20 | 是 | 否 | Git 面板 |
| `subagent` | 30 | 是 | 否 | 子代理拓扑 |
| `terminal` | 40 | 否（createTab 自增） | 否 | 终端（配额 3） |
| `diff` | -1 | 否（按 id 去重） | 是 | 差异查看（由 GitView 触发） |

你的 `id` 不可与上述重复，否则 `registerTab` 抛 `"tab type \"X\" already registered"`。

---

## 5. 文件预览器（FileViewer）注册 API

### 5.1 `FileViewerDescriptor` 完整字段

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
  /** fetchStrategy='custom' 时的加载函数 */
  load?: (path: string, scope: SessionScope) => Promise<unknown>
  /** 声明式设置（v0.4.1+）：形状同 TabDescriptor.settings */
  settings?: { toggles?: readonly { key: string; title: string | (() => string); desc?: string | (() => string) }[] }
  /** 渲染函数 */
  component: (props: FileViewerProps) => ReactNode
}
```

### 5.2 `FileViewerProps`

```ts
interface FileViewerProps {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  path: string
  title: string
  viewerId: string         // 命中 viewer 的 id（如 'code' / 'my-plugin:csv'）
  content?: string         // fetchStrategy='fsRead' 时
  truncated?: boolean      // fetchStrategy='fsRead' 时
  mediaUrl?: string        // fetchStrategy='mediaUrl' 时
  customData?: unknown     // fetchStrategy='custom' 时（load() 的返回值）
}
```

### 5.3 `fetchStrategy` 对照

| 策略 | 字节来源 | 传给 component 的字段 | 适用 |
|---|---|---|---|
| `none` | 不需要字节 | （无） | 自渲染（如纯 UI） |
| `fsRead` | `/sidebar/api` 的 `fs.read` | `content`, `truncated` | 文本类（CSV/JSON/XML） |
| `mediaUrl` | `/sidebar/file` 媒体路由 URL | `mediaUrl` | 图片/PDF/Office（viewer 自己 fetch 字节） |
| `custom` | viewer 的 `load()` 函数 | `customData` | 自定义协议（如远程拉取） |
| `binary-download` | 不预览，显示下载按钮 | （无） | 无客户端渲染器的二进制格式 |

### 5.4 匹配算法（`matchFileViewer`）

`matchFileViewer(path, head?)` **单趟**按 priority 降序（稳定排序，相同 priority 按注册顺序）遍历每个 descriptor：

1. 若 `head` 字节可用且该 descriptor 有 `detect` → 调 `detect(path, head)`，true 则命中；**miss 且是 catch-all（`exts: []`）则本轮放弃**（纯嗅探型不得盲认领）；
2. 否则匹配 `exts`（小写无点；`exts: []` 且无 `detect` 是盲 catch-all，直接命中）。

即：**priority 高的 descriptor 先获得裁决权**（其 detect 或 exts 任一命中即赢），低 priority 的 detect 不会越过高 priority 的 exts 匹配。`exts: []` + `detect` 的组合是"纯嗅探"：无 head 时不认领任何文件（不会吞掉图片/PDF 等真实 viewer 的文件），有 head 时只认领 detect 命中的。全部 miss 返回 `undefined`（编辑器显示下载按钮）。

> **head 字节从哪来**：第一次匹配（纯扩展名）没有 head。`fsRead` 策略读取后若文件为二进制，host 的 `fs.read` 响应会带 `head` 字段（base64，前 4KB，`src/index.ts` 的 `READ_HEAD_LIMIT`），编辑器会用它对 `detect` viewer **重匹配一次**——所以 detect 型 viewer 的实际触发场景是"扩展名匹配落空/二进制文件"。文本文件的 detect 嗅探不在内置流程内（用 `exts` 或 `custom` 策略替代）。

> **内置 viewer**（不可重复注册，全部 8 个）：image(0) / pdf(0) / docx(0) / xlsx(0) / pptx(0) / markdown(0, fsRead) / code(-100, catch-all, fsRead) / binary-download(-50, exts doc/xls/ppt + NUL detect)。
> code 是兜底 viewer：任何其他 viewer 未认领的文件都会落到 code（CodeMirror 文本编辑）；二进制文件经 head 重匹配被 binary-download 的 NUL detect 认领（下载按钮）。外部 viewer 注册同扩展名 + 更高 priority 即可覆盖。

### 5.5 注册示例

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

**覆盖内置 image viewer**（如自定义 SVG 优化渲染）：

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

## 6. 页面内如何访问数据（/sidebar API）

你的 tab / viewer 组件运行在浏览器里，与内置视图同源同权。访问文件/会话数据直接 `fetch` better-sidebar 的 JSON API（内置 `src/client/api.ts` 的封装就是干这个的，你可以在自己插件里复制这个 fetch 模式）：

```ts
// POST /sidebar/api/<method>，body 带 sessionId + cwd（可选）
const res = await fetch('/sidebar/api/fs.read', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: scope.sessionId, path }),
})
const { value } = await res.json()   // 错误时 { ok: false, error: { code, message } }
```

常用方法（完整清单见 `src/client/api.ts`）：

| 方法 | 说明 |
|---|---|
| `session.cwd` | 会话权威 cwd（`{ cwd, root, parent }`） |
| `fs.tree` | 目录列表（`{ path, entries: FsEntry[], truncated }`） |
| `fs.read` | 读文件：文本返回 `{ kind: 'text', content, truncated }`；二进制返回 `{ kind: 'binary', size, truncated, head }`（head = base64 前 4KB） |
| `fs.write` | 原子写文件 |
| `git.status` / `git.diff` / `git.log` 等 | 全套 Git 只读 + 写操作 |
| `pty.close` / `agent-pty.close` | 释放终端（外部 tab 一般用不到） |
| `settings.get` / `settings.update` | 侧边栏偏好读写（revision 守卫） |

媒体/下载字节走 `/sidebar/file` 路由（`?sessionId=&path=&cwd=&download=1`）：

```ts
// 媒体 URL（图片等直接 <img src>）：/sidebar/file?sessionId=...&path=...
const url = `/sidebar/file?${new URLSearchParams({ sessionId: scope.sessionId, path })}`
```

> 注：内置的 `api.ts` 是 better-sidebar 内部模块，外部插件 **不要** value-import 它（构建纯度门会挡）；按上表模式自己 fetch 即可。所有路由带与 `/api` 相同的 Host 头信任围栏，浏览器同源访问天然通过。

---

## 7. 服务方法完整清单

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
   * 被设置禁用的类型是 no-op（console.warn 提示）。
   */
  openTab(seed: { type: string; title?: string; path?: string; diff?: SidebarTab['diff']; id?: string }): void
  /** 关闭一个 tab */
  closeTab(tabId: string): void
  /** 订阅注册表变化（register/dispose 时触发） */
  subscribe(listener: () => void): () => void
}
```

---

## 8. 声明式设置（v0.4.1+）

每个注册的 tab / viewer **自动**出现在 DSH 设置页「侧边卡片」分区（`SideCardSection` 按注册表驱动渲染，无硬编码）：

- 展示：小卡片网格（图标 + 标题 + 类型 id），**高亮 = 启用**，勾选徽标钉在卡片最右端；viewer 卡片额外显示扩展名。
- 持久化：开关写入 `SidebarPrefs.tabsEnabled / viewersEnabled`（开放 map，**缺省 = 启用**，显式 `false` 才禁用）。
- 关闭语义：tab 从 `+` 菜单消失、`openTab` 拒绝新开（`console.warn`）、派生流程（子代理自动展开、agent 终端自动补 tab）停止，**已打开的 tab 保留**；viewer 被 `matchFileViewer` 跳过，文件落到下一个匹配。
- `settings.toggles`（可选）：在卡片行下追加**嵌套开关**（仅父级启用时显示），绑定 `SidebarPrefs` 字段；通过卡片右下角齿轮按钮在原生弹窗中编辑（复选框行）。内置示例：subagent tab 的 `autoOpenSubagent`、terminal tab 的 `agentTerminalTools`。

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:db',
    title: 'Database',
    order: 50,
    settings: {
      toggles: [{
        key: 'myPluginAutoConnect',   // ⚠️ 必须是宿主 PrefsSchema 的字段，见下
        title: 'Auto connect',
        desc: 'Connect on open',
      }],
    },
    component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  })
)
```

> ⚠️ **key 必须是宿主 PrefsSchema 的字段**（内置键：`autoOpenSubagent` / `agentTerminalTools`）。外部插件的自定义键会被 settings seam 丢弃——当前版本嵌套开关只支持宿主预置的布尔偏好；想给用户暴露你自己的设置，走 DSH 自己的 settings 服务（`ctx.settings`），不要依赖这里的 `toggles`。

---

## 9. 生命周期与 HMR

- **disposer 必须返回并被 fiber 持有**：`registerTab` / `registerFileViewer` 返回 `() => void`，Cordis fiber 卸载时自动调用。**务必**用 `ctx.effect(() => register(...))` 包裹，否则 fiber 卸载（HMR / 插件禁用）时不会撤销注册，导致下次激活时 `"already registered"` 错误。
- **注册时机**：better-sidebar 在 `apply()` 开头 `ctx.provide('betterSidebar', service)`，你的 `inject = ['betterSidebar']` 保证你激活时服务已就绪；注册顺序无关紧要。
- **持久化降级**：localStorage 里持久化的 tab 若其 type 未注册（你的插件未加载），渲染为 `<OrphanedTab/>` 占位卡（"插件未加载" + 关闭按钮）；你的插件加载后下次渲染自动恢复（`sanitizeNode` 保留未注册类型而非丢弃）。
- **`visible` 语义**：面板折叠或非激活 tab 的 `visible` 为 false；你的页面应借此暂停轮询/订阅，激活时恢复。

---

## 10. 平台约束与陷阱

| 陷阱 | 说明 |
|---|---|
| **构建纯度门** | client bundle 禁止 value-import `@dsh-external/*` 或非白名单的 `@deepseek-ai/*`（`tsdown.config.ts` 的 `dsh-client-bundle-purity` 插件）；**类型 `import type {}` 会被擦除，不触发门禁**——类型可自由共享，运行时符号不行。所有跨插件交互走 `ctx.betterSidebar` 方法调用 |
| **双 cordis 实例** | 外部插件解析不到 DSH monorepo 的 cordis augmentation；better-sidebar 自己重述了 `interface Context { betterSidebar: ... }`（`src/context-types.ts`），你 `import type {} from 'dsh-better-sidebar'` 即拿到类型 |
| **ModuleLoader 不跨插件** | 运行时 `require()` 虽支持跨 bundle，但被构建门挡；所有交互走 `ctx.betterSidebar` 方法调用 |
| **host 半无此服务** | `ctx.betterSidebar` 只在 client 侧存在；host 半需要 better-sidebar 数据走 `/sidebar/api/*` HTTP 路由 |
| **portal 限制** | 整面板 slot 由 ui-layout 独占，外部 tab 只能进入 better-sidebar 的 portal 内部，无法全屏替换整个面板 |
| **id 冲突** | `registerTab` / `registerFileViewer` 对重复 id 抛错；建议用包前缀（`my-plugin:xxx`） |
| **不要 value-import `dsh-better-sidebar`** | 即使是 `./client/service` 子路径，运行时落点也是 client bundle；只做 type-only import |

---

## 11. 完整最小示例

假设插件 `my-plugin` 要加一个 "Database 浏览器" tab + `.csv` 文件预览器。

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
  // Database tab（单实例，+ 菜单可见）
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'my-plugin:db',
      title: () => 'Database',
      order: 50,
      dedupeKey: () => 'my-plugin:db',
      component: ({ scope }) => createElement(DbView, { sessionId: scope.sessionId }),
    })
  )

  // CSV viewer（custom 策略：自己拉字节 + 解析）
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

**注册到 profile**：

1. `~/.dsh/profiles/web/package.json` 的 `dependencies` 加 `"my-plugin": "link:<你的插件路径>"`；
2. `~/.dsh/profiles/web/cordis.patch.yml` 追加挂载行（`- insert: - id: my-plugin / name: 'my-plugin'`）；
3. 在 profile 目录 `pnpm install`；
4. 浏览器硬刷新（Cmd/Ctrl+Shift+R）即可看到效果（DSH 对 client 改动热加载，无需重启 `dsh web`；仅 host 半改动需要重启）。

---

## 12. 参考实现与调试

better-sidebar 的内置 tab 和 viewer 就是参考实现（"吃狗粮"）：

- **`src/client/builtins/`**：6 个内置 tab（tabs.tsx）+ 8 个内置 viewer（viewers.tsx）的注册代码 + 聚合与 disposer 生命周期（index.ts）
- **`src/client/service.ts`**：`BetterSidebarService` 接口 + `createBetterSidebarService` 工厂实现（含匹配算法、dedupe、createTab、启用态 gating）
- **`src/client/Sidebar.tsx`**：`TabContent` 分发（查 `getTab` → 调 descriptor.component；未注册 → `<OrphanedTab/>`）、`+` 菜单构建（order 排序 + available disabled + 禁用过滤）
- **`src/client/SideCardSection.tsx`**：声明式设置页（注册表驱动清单 + `settings.toggles` 嵌套开关 + 开关持久化）
- **`src/client/api.ts`**：`/sidebar` API 的封装（复制其 fetch 模式到你的插件）
- **`tests/service.spec.ts`**：注册表生命周期 / 匹配算法 / dedupe / createTab / 启用态 gating 测试
- **`tests/builtins.spec.ts`**：内置注册清单断言（6 tab + 8 viewer + 声明式元数据）
- **`docs/plans/2026-08-11-service-registry-design.md`** / **`docs/plans/2026-08-11-declarative-sidebar-settings-design.md`**：设计文档（§17 含实施偏差记录，以现状为准）

调试时直接读这些文件即可看到所有 API 的真实用法。
