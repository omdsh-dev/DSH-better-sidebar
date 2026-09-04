# 外部插件接入指南：基于 dsh-better-sidebar 实现新页面

> 面向 **消费插件开发者**：如何让你的插件向 better-sidebar 注册新的侧边栏页面（tab）和文件类型预览器。
>
> 适用版本：**v0.4.0+**（`ctx.betterSidebar` 服务）；声明式设置 **v0.4.1+**；text/number 设置行 **v0.11.0+**；badge/生命周期/定向打开/插件设置/版本探测 **v0.12.0+**；select 设置行（`settingSelect`）与外链认领（`urlTarget`）**v0.13.0+**；统一 `@deepseek-ai/cordis` 类型基底 **v0.15.2+**；自由窗口（`floatWindows`）**v0.16.0+**；终端固定（pin）**v0.17.0+**。当前版本 **v0.18.0**（正式版，仅支持 DSH 0.1.2-rc.1+；旧宿主 stable 线为 v0.17.1）。
> 权威代码：`src/client/service.ts`（服务实现）、`src/client/builtins/`（内置 8 tab + 6 viewer 参考实现）、`lib/types/client/service.d.ts`（类型声明）。
> 仓库开发规则（硬约束 / CI / 发版）见 [AGENTS.md](../AGENTS.md)。

---

## 1. 总览：你能扩展什么

better-sidebar 从 v0.4.0 起把自己改造成一个**注册表服务**：

- **新页面（tab）**：注册一种新的侧边栏 tab 类型，出现在侧边栏 `+` 菜单里，用户点击后在自己的分栏里打开你的 React 页面；
- **文件预览器（file viewer）**：注册一种文件类型预览器，让用户在侧边栏打开文件时走你的渲染组件（覆盖或补充内置的 image/pdf/code 等）。

内置的 7 个 tab（editor / git——「文件变动」统一 tab（Git 视角 + 本轮文件视角）/ subagent / sidechat / terminal / browser / diff）和 6 个 viewer（image / pdf / markdown / html / code / binary-download）**自己也是通过同一套 API 注册的**（吃自己的狗粮），所以外部插件的能力与内置功能完全对等。

关键机制一句话：better-sidebar 的 client half 在 `apply()` 开头执行 `ctx.provide('betterSidebar', service)`（`src/client/index.tsx`），消费插件在 `inject` 里声明 `'betterSidebar'`，Cordis 保证服务就绪后才激活你的插件，然后你调用 `ctx.betterSidebar.registerTab(...)` / `registerFileViewer(...)` 完成注册，返回的 disposer 由 Cordis fiber 在卸载（HMR / 禁用）时自动调用。

> ⚠️ **服务只在 client half**：`ctx.betterSidebar` 只存在于浏览器侧。你的插件 **host 半没有这个服务**；host 半需要读 better-sidebar 状态时，走它自己的 HTTP/WS 路由（`/sidebar/api/*`、`/sidebar/file`、`/sidebar/ws/*`），不走服务。

---

## 2. 前置：类型合并与依赖声明

### 2.1 类型合并（统一 `@deepseek-ai/cordis`）

DSH 运行时和生态的类型正主是 vendored `@deepseek-ai/cordis`。你的插件解析到它的 `Context` 时，`ctx.betterSidebar` 不会自动出现——由 better-sidebar 用 `declare module '@deepseek-ai/cordis'` 补上：

```ts
import type {} from 'dsh-better-sidebar'  // 触发 declare module '@deepseek-ai/cordis' 类型合并
```

这个 **type-only import** 在编译时被擦除，不产生任何运行时依赖，也不会触发构建纯度门（见 §10）。

### 2.2 package.json 声明

```jsonc
{
  "name": "my-plugin",
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "dsh-better-sidebar": "workspace:*"
  },
  "peerDependenciesMeta": {
    "dsh-better-sidebar": { "optional": true }
  }
}
```

- `dsh-better-sidebar` 必须是 **peerDependency**（不是 dependency），避免两份实例；
- `optional: true`：better-sidebar 未安装时你的插件照常加载，注册代码因为 `ctx.betterSidebar` 为 undefined 而安全跳过。

> ⚠️ **计划上架 DSH 插件市场**的插件还须遵守市场 manifest 约束（`dependencies`/`peerDependencies`/`optionalDependencies` 一律不得出现 `cordis`、`scripts` 不得含 install 类钩子），详见 [AGENTS.md](../AGENTS.md) 硬约束一节。

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

v0.12.0 起，服务模块还 re-export 了完整的状态词汇表，消费者可以直接命名（不再只能靠推断）：

```ts
import type {
  SidebarTab, SidebarState, SidebarStore, SidebarSnapshot, SidebarDiffRef, TabType,
  SessionScope, SidebarPrefs, OpenTabSeed, SidebarSettingsRenderProps,
} from 'dsh-better-sidebar/client/service'
```

> 💡 **类型合并触发路径**：`import type {} from 'dsh-better-sidebar/client/service'` 同样会加载 `Context` 的 augmentation（`declare module '@deepseek-ai/cordis'` 在 context-types.d.ts 中）——**纯浏览器侧插件建议走 `client/service` 路径**，避免拉进宿主半的 Node 类型图（主入口 `dsh-better-sidebar` 的声明面含宿主代码；宿主消费者本就处于 Node 环境则无所谓）。client 可达声明图（`client/*` + context-types + html-route + prefs-shared）自 v0.12.0 起**零 Node 依赖**（`scripts/check-consumer-types.sh` 守护），没有 `@types/node`、`skipLibCheck: false` 也能编译。

---

## 3. 最小骨架（client half）

```ts
// my-plugin/src/client/index.ts
import type {} from 'dsh-better-sidebar'          // 触发 ctx.betterSidebar 类型合并
import type { Context } from '@deepseek-ai/cordis'

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
// 设置行控件形状（settings.toggles / settings.pluginToggles 共用；text/number v0.11.0+，select v0.13.0+）：
interface SettingRow {
  key: string                              // toggles: SidebarPrefs 字段名；pluginToggles: 插件局部 key
  title: string | (() => string)
  desc?: string | (() => string)
  type?: 'switch' | 'text' | 'number' | 'select'  // 缺省 'switch'
  min?: number; max?: number               // number 行提交钳制
  placeholder?: string; unit?: string      // text 行占位符 / 单位后缀（如 'px'）
  options?: readonly {                     // select 行选项
    value: string | number | boolean
    title: string | (() => string)
    desc?: string | (() => string)
    icon?: ReactNode | ((size: number) => ReactNode)
  }[]
  multi?: boolean                          // select 多选（缺省 false；存 value 数组，按 options 顺序提交）
}
// text/number 行 blur/Enter 提交；select 任一项带 icon 时渲染大图标选项卡，否则单行文本。

interface TabDescriptor {
  /** 唯一 id；也是 SidebarTab.type 的值。建议带包前缀：'my-plugin:db'。 */
  id: string
  /** 标题（i18n 友好：传字符串或返回字符串的函数） */
  title: string | (() => string)
  /** 图标：ReactNode 或 (size: number) => ReactNode */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** + 菜单排序（升序）；默认 100。内置：editor=10, git=20, subagent=30, sidechat=35, terminal=40, browser=50 */
  order?: number
  /** 从 + 菜单隐藏（editor/diff 用：由其他流程触发打开，不在菜单里） */
  hidden?: boolean
  /** + 菜单禁用判定（如 terminal 配额满）。返回 false 只影响菜单 disabled，不拦截 openTab（只有设置页禁用开关会）。 */
  available?: (ctx: Context, scope: SessionScope, state: SidebarState) => boolean
  /**
   * 单实例语法糖：`single: true` ≡ `dedupeKey: () => id`（打开时聚焦既有
   * 同类型 tab 而非新开）。显式给出 dedupeKey 时优先于 single。
   */
  single?: boolean
  /**
   * 去重键：openTab 时若已存在 dedupeKey 相同的 tab，则聚焦而非新开。
   * 返回 undefined 表示不去重（每次都新开，但同 id 会被 id 安全网聚焦）。
   * 内置策略：git/subagent 用 single；editor 用 tab.path；diff 用 tab.id。
   * 必须纯函数：每次 open 求值两次，抛错向外传播。
   */
  dedupeKey?: (tab: SidebarTab) => string | undefined
  /**
   * 自定义 tab 创建（minting SidebarTab + 状态 patch）。
   * 返回 null 拒绝创建。terminal 用它生成 terminal:<n> id 并递增 nextTerminal。
   * 省略时用默认 { id, type, title } + seed 里的 path/diff。
   */
  createTab?: (state: SidebarState) => { tab: SidebarTab; patch?: Partial<SidebarState> } | null
  /**
   * 外链认领（v0.13.0+，`features.includes('urlTarget')` gate）：外链被接管
   * （`browserInterceptLinks` 总闸 + 协议开关均开）时，第一个 urlTarget 命中且未禁用的
   * 类型以 openTab({ type, url, title: hostname }) 打开，URL 预填 tab.path。先到先得；
   * 谓词抛错被吞。内置 browser 不声明、永远隐式兜底。
   * 多 URL 并存需 createTab 铸造 per-URL id，否则二次点击被 id 安全网聚焦、不覆写 path。
   */
  urlTarget?: (url: URL) => boolean
  /**
   * 声明式设置（v0.4.1+）：见 §8。v0.12.0 起增加 `pluginToggles`（插件自有
   * 设置行，key 无需宿主 schema 字段）与 `render`（自定义设置面板）。
   */
  settings?: SidebarSettingsDeclaration
  /**
   * tab 角标（v0.12.0+）：tab 图标旁的小圆角 pill。number 渲染计数（99+ 封顶），
   * string 原样文本，null/undefined 不显示。每次 tab 栏渲染都会调用——保持廉价；
   * 抛错会被吞掉（不显示角标，不影响渲染）。
   */
  badge?: (ctx: Context, scope: SessionScope, state: SidebarState) => string | number | null | undefined
  /**
   * 生命周期回调（v0.12.0+），只由 SERVICE 路径触发：
   * - onOpen：openTab 真正**新建** tab 后（dedupe/id 安全网聚焦不算打开）；
   * - onActivate：tab 被聚焦时（dedupe 聚焦、id 安全网聚焦、tab 栏点击激活）；
   * - onClose：closeTab 关闭 tab 后。
   * 内置专属流程（diff 拆分放置、agent 终端 reconcile）直接改 state，不触发
   * 回调——但它们只作用于内置类型（diff/terminal），外部插件的 tab 永远走
   * service 路径。回调抛错只 console.error，绝不打断打开/关闭流程。
   * openTab 回调 scope 携带调用者传入的 { sessionId, cwd? }；
   * closeTab/activateTab 仅显式传 scope 时带 cwd。
   */
  onOpen?: (tab: SidebarTab, scope: SessionScope) => void
  onActivate?: (tab: SidebarTab, scope: SessionScope) => void
  onClose?: (tab: SidebarTab, scope: SessionScope) => void
  /** 渲染函数 */
  component: (props: TabComponentProps) => ReactNode
}

/** 声明式设置声明（行控件形状见上方 SettingRow）。 */
interface SidebarSettingsDeclaration {
  /** 宿主 prefs 字段行（key 必须是宿主 PrefsSchema 的字段，内置键清单见 §8）。 */
  toggles?: readonly SettingRow[]
  /** 插件自有设置行（v0.12.0+）：key 插件局部，
   *  持久化在 pluginSettings[<descriptor id>]，无需宿主 schema 字段。 */
  pluginToggles?: readonly SettingRow[]
  /** 自定义设置面板（v0.12.0+）：追加渲染在行列表之后，可单独存在；
   *  抛错被吞并显示内联错误。 */
  render?: (props: SidebarSettingsRenderProps) => ReactNode
}

/** settings.render 收到的 props（v0.12.0+）。 */
interface SidebarSettingsRenderProps {
  store: SidebarStore
  service: BetterSidebarService
  prefs: SidebarPrefs
  /** 本 descriptor 自己的持久化设置 blob（pluginSettings[id]）。 */
  pluginSettings: Record<string, unknown>
  /** 持久化一条本 descriptor 的插件设置（值须 JSON 可序列化）。 */
  updatePluginSetting(key: string, value: unknown): void
  /** 关闭设置弹窗。 */
  close(): void
}
```

### 4.2 `TabComponentProps`（你的页面组件收到的 props）

```ts
interface TabComponentProps {
  ctx: Context                 // client cordis context
  store: SidebarStore          // better-sidebar 的状态 store（可调 reduce 等）
  scope: SessionScope          // { sessionId, cwd? } —— 会话标识，调用 /sidebar API 必带
  tab: SidebarTab              // 当前 tab 实例（含 id/type/title/path?/diff?/meta?）
  visible: boolean             // 是否当前激活 tab 且面板打开（不可见时暂停轮询等）
  // 以下由内置 tab 使用，外部 tab 可忽略：
  expanded?: string[]          // 文件树的展开目录集
  onToggleDir?: (path: string) => void
  // 在会话 composer 插入一条 @ 引用。isDir=true 为目录：纯文本 `@dir/`，
  // 保留宿主文件夹装饰与补全；false 为文件：走宿主结构化引用 chip
  // （显示 @basename、序列化为完整 @path），宿主拒绝时回退纯文本。
  onReferenceFile?: (path: string, isDir: boolean) => void
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

**认领外链点击**（v0.13.0+，`urlTarget` + `createTab` 组合）：

```ts
ctx.effect(() => {
  if (!ctx.betterSidebar.features.includes('urlTarget')) return  // 老版本优雅降级
  return ctx.betterSidebar.registerTab({
    id: 'my-plugin:web-docs',
    title: () => 'Docs',
    order: 80,
    urlTarget: (url) => url.hostname === 'docs.my-site.com',
    createTab: (state) => ({  // per-URL id，多 URL 并存
      tab: { id: `my-plugin:web-docs:${state.nextBrowser}`, type: 'my-plugin:web-docs', title: 'Docs' },
      patch: { nextBrowser: state.nextBrowser + 1 },
    }),
    component: ({ tab, scope }) => <WebDocsView url={tab.path} sessionId={scope.sessionId} />,
  })
})
```

### 4.4 内置 tab 清单（不可重复注册）

| id | order | single | hidden | 用途 |
|---|---|---|---|---|
| `editor` | 10 | 否（按 path 去重） | 否 | 唯一「文件窗口」（编辑/预览 + 资源管理）。chrome 恒合并形态：路径输入框 + 编辑器控件 + 可开关内嵌文件树（全局搜索 `fs.search`；状态存 `tab.meta.treeOpen/treeWidth`）。`editorExplorer`：关（默认）= 按 path 新开，无路径窗口 = 纯资源管理器；开 = 树点击/Enter 经 `updateTab` 原地切换（id/meta 不变），无路径窗口 = 带 chrome 空窗口。树右键「在新 Tab 中打开」「在侧边打开」（pane 右侧 split）。新会话 seed 空文件窗口（`title:'Files'`）；旧 `explorer` tab 经 `sanitizeState` 迁移 |
| `git` | 20 | 是 | 是（本轮文件操作数） | 「文件变动」统一 tab（id 保留 `git` 以兼容持久化布局）：**Git 视角**（原 Git 面板：staged/unstaged / 提交 / 历史 / worktree·子仓库选择）+ **本轮文件视角**（原 file-trace：模型读/写/编辑实时折叠，按文件分组、类型筛选）；会话事件经插件自有宿主路由 `changes.ops` 供给（live 日志优先、冷会话回放持久化记录，`afterSeq` 增量），badge 读 tab 轮询写入的同步缓存。两视角共用底部可拖拽预览面板（`tab.meta.lens/previewH` 持久化），diff 渲染统一走 `src/client/diff/`（`DiffRows`/`DiffFiles`：mod 配对 + 行内高亮 + 语法着色 + 上下文折叠）；Git 目标可展开为独立 diff tab——落点由二级设置 `changesDiffFloat` 决定（默认**自由浮窗**居中弹出，可选面板下半 split），设置项见 tab descriptor 的 `settings.toggles` select |
| `subagent` | 30 | 是 | 否 | 子代理拓扑 |
| `sidechat` | 35 | 否（`sidechat:<uuid>`，按 `meta.threadId` 去重） | 否 | 侧边对话（每对话一 Tab）：打开即建空线程（首条消息赢得标签并同步标题）；线程 = 插件自建子会话（种子继承父会话上下文，进行中回合以 `interrupted` 闭合；种子带合法 `subagent/descriptor`，SubagentView 按 `Side: ` 前缀过滤），`origin:'subagent'` 隐藏于主列表；走 `/sidebar/api/sidechat.*` 路由；头部菜单切换/重开（`parkSidechatReopen` + 确定性 id），关 Tab 释放 live agent；重开经 `collectOwnEvents` 回源到种子边界；「保存为新会话」= `session.fork`（`this` 敏感）。[设计文档](plans/2026-08-20-sidechat-tab-design.md) |
| `terminal` | 40 | 否（`terminal:<n>`） | 否 | 终端。v0.17.0+ 右键「固定到工作区/全局」：跨会话不消失，TabBar 内联虚拟 Tab（`pinned:<homeSessionId>:<tabId>`），就地按 home scope 连 PTY；global 全会话可见、workspace 仅同 cwd；`tab.pin = { scope, homeCwd? }` 随会话持久化，渲染期解析（`collectPinnedTabs` → `createPinnedVirtualTab` → `injectPinnedIntoTree`） |
| `browser` | 50 | 否（`browser:<n>`） | 否 | 内嵌浏览器（沙箱 iframe，可设置关沙箱） |
| `diff` | -1 | 否（按 id 去重） | 是 | 差异查看（changes tab 的预览面板「展开为独立页签」触发，同一渲染栈） |

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
  /** 小写无点的扩展名数组：['png','jpg']。[] = catch-all（仅最低优先级盲命中有效） */
  exts: readonly string[]
  /** 优先级（高优先）；默认 0。内置：image/pdf/markdown/html=0，binary-download=-50，code=-100 */
  priority?: number
  /** 字节获取策略 */
  fetchStrategy: 'none' | 'fsRead' | 'mediaUrl' | 'custom' | 'binary-download'
  /** 内容嗅探（覆盖 exts）：head 字节可用时，第一个 detect 返回 true 的 viewer 命中 */
  detect?: (path: string, head: Uint8Array) => boolean
  /** fetchStrategy='custom' 时的加载函数；v0.12.0+ 第三参 signal 在 viewer
   *  卸载/重匹配时中止（忽略 signal 的 load 也照常工作） */
  load?: (path: string, scope: SessionScope, signal?: AbortSignal) => Promise<unknown>
  /** 声明式设置（v0.4.1+）：形状同 TabDescriptor.settings（§4.1 的
   *  toggles/pluginToggles/render；v0.12.0 起 viewer 卡片也有齿轮按钮） */
  settings?: SidebarSettingsDeclaration
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
  // 以下为内置文本编辑器与 EditorHost 内部协作字段，外部 viewer 忽略：
  toolbar?: 'self' | 'host'
  onToolbarState?: (state: EditorToolbarState) => void
  onToolbarControls?: (controls: EditorToolbarControls | null) => void
}
```

### 5.3 `fetchStrategy` 对照

| 策略 | 字节来源 | 传给 component 的字段 | 适用 |
|---|---|---|---|
| `none` | 不需要字节 | （无） | 自渲染（如纯 UI） |
| `fsRead` | `/sidebar/api` 的 `fs.read` | `content`, `truncated` | 文本类（CSV/JSON/XML） |
| `mediaUrl` | `/sidebar/file` 媒体路由 URL | `mediaUrl` | 图片/PDF（viewer 自己 fetch 字节） |
| `custom` | viewer 的 `load()` 函数 | `customData` | 自定义协议（如远程拉取） |
| `binary-download` | 不预览，显示下载按钮 | （无） | 无客户端渲染器的二进制格式 |

### 5.4 匹配算法（`matchFileViewer`）

`matchFileViewer(path, head?)` **单趟**按 priority 降序（稳定排序，相同 priority 按注册顺序）遍历每个 descriptor：

1. 若 `head` 字节可用且该 descriptor 有 `detect` → 调 `detect(path, head)`，true 则命中；**miss 且是 catch-all（`exts: []`）则本轮放弃**（纯嗅探型不得盲认领）；
2. 否则匹配 `exts`（小写无点；`exts: []` 且无 `detect` 是盲 catch-all，直接命中）。

即：**priority 高的 descriptor 先获得裁决权**（其 detect 或 exts 任一命中即赢），低 priority 的 detect 不会越过高 priority 的 exts 匹配。`exts: []` + `detect` 的组合是"纯嗅探"：无 head 时不认领任何文件（不会吞掉图片/PDF 等真实 viewer 的文件），有 head 时只认领 detect 命中的。全部 miss 返回 `undefined`（编辑器显示下载按钮）。

> **head 字节从哪来**：第一次匹配（纯扩展名）没有 head。`fsRead` 策略读取后若文件为二进制，host 的 `fs.read` 响应会带 `head` 字段（base64，前 4KB，`src/index.ts` 的 `READ_HEAD_LIMIT`），编辑器会用它对 `detect` viewer **重匹配一次**——所以 detect 型 viewer 的实际触发场景是"扩展名匹配落空/二进制文件"。文本文件的 detect 嗅探不在内置流程内（用 `exts` 或 `custom` 策略替代）。

> **内置 viewer**（不可重复注册，全部 6 个）：image(0) / pdf(0) / markdown(0, fsRead；内嵌 HTML 支持：DOMPurify 白名单消毒、`<details>` 跨段嵌套、本地媒体 src 重写走 `/sidebar/file`；≥3 标题时浮动目录大纲。实现 `markdown-html.ts` / `MarkdownHtml.tsx` / `md-toc.tsx`，[设计文档](plans/2026-08-24-markdown-html-toc-design.md)) / html(0, fsRead, 沙箱 iframe 预览) / code(-100, catch-all, fsRead) / binary-download(-50, exts doc/xls/ppt + NUL detect)。Office 三件套预览（.docx/.xlsx/.pptx）**不再内置**——已迁至推荐插件（设置页「添加插件」→ 文件预览弹窗里的 Office 预览插件），以相同 id 注册。
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
| `fs.tree` | 目录列表（`{ path, entries: FsEntry[], truncated }`；FsEntry 含 `isSymlink`/`broken`，目录软链接的 `isDir` 按目标类型） |
| `fs.read` | 读文件：文本返回 `{ kind: 'text', content, truncated }`；二进制返回 `{ kind: 'binary', size, truncated, head }`（head = base64 前 4KB） |
| `fs.write` | 原子写文件 |
| `git.status` / `git.diff` / `git.log` 等 | 全套 Git 只读 + 写操作 |
| `pty.close` / `agent-pty.close` | 释放终端（外部 tab 一般用不到） |
| `settings.get` / `settings.update` | 侧边栏偏好读写（revision 守卫） |

> **文件路径安全边界**：`fs.tree`、`fs.read`、`fs.write`、`/sidebar/file`、`/sidebar/html` 和 `/sidebar/upload` 都以请求对应 session 的权威 `cwd` 作为 workspace 根目录。路径会按真实文件系统路径检查，越界绝对路径、`..` 解析结果和指向 workspace 外部的符号链接都会被拒绝；消费插件不应把 `cwd` 当作可由用户扩大权限范围的参数。

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
   * url 可选：把**新建** tab 的 path 预填为 URL（侧边栏浏览器导航种子）；
   * 聚焦既有 tab 时 url 不会覆写其 path。
   * 被设置禁用的类型是 no-op（console.warn 提示）。注意：available 不拦截 openTab。
   * scope（v0.12.0+）定向到指定 session：给出且非当前 session 时，打开落在
   * 该 session 的侧边栏状态里（没有则按 prefs 新建），不切换 UI 的激活 session；
   * 定向打开不自动展开目标 session 的面板；缺省或指向当前 session 时行为
   * 与之前完全一致。
   * 内容型打开（带 path/url seed）在落点面板折叠时自动展开，保证落点可见；
   * 类型型打开（+ 菜单等）不展开。
   */
  openTab(seed: OpenTabSeed, scope?: SessionScope): void
  /** 关闭一个 tab（未知 id 严格 no-op，无状态搅动）；scope（v0.12.0+）
   *  随回调传递（含可选 cwd），缺省为 { sessionId: 当前 } */
  closeTab(tabId: string, scope?: SessionScope): void
  /** 订阅注册表变化（register/dispose 时触发） */
  subscribe(listener: () => void): () => void
  // ── v0.12.0+ ──────────────────────────────────────────────────────────
  /** 插件版本（如 '0.17.1'；与 package.json 同步，测试守护） */
  readonly version: string
  /** 单调能力清单（只增不删）：'badge' | 'tabLifecycle' | 'updateTab' |
   *  'openFile' | 'targetedOpen' | 'stateSubscription' | 'tabMeta' |
   *  'pluginSettings' | 'urlTarget' | 'settingSelect' | 'floatWindows'
   *  ——用 `features.includes('xxx')` 按能力 gate。 */
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
   *  id 按路径派生（`editor:` + path），与内置 open-path 拦截一致，不同文件可并排打开）。
   *  注意：path 派生 id 只对 openFile/openSidebarFile 成立；editorExplorer 合并模式的
   *  原地切换经 updateTab 重写 path/title，tab id 保持稳定、不再对应 path。 */
  openFile(scope: SessionScope, path: string, title?: string): void
}

/** openTab 的 seed（v0.12.0 起导出命名类型）。 */
interface OpenTabSeed {
  type: string
  title?: string
  path?: string
  diff?: SidebarTab['diff']
  id?: string
  url?: string
  /** JSON 可序列化的自定义状态，随 tab 持久化（刷新后原样恢复）；
   *  undefined = 不改，null = 显式清除 */
  meta?: unknown
}
```

**版本与能力探测**（v0.12.0+）：消费插件先查能力再使用新 API，老版本（或旧 DSH）下优雅降级：

```ts
if (ctx.betterSidebar.features.includes('badge')) {
  // 使用 TabDescriptor.badge
}
if (ctx.betterSidebar.version >= '0.12.0') { /* 字符串比较即可：minor 只增 */ }
```

**生命周期示例**（v0.12.0+）：打开时启动资源、关闭时释放——组件卸载 ≠ tab 关闭（会话切换也会卸载），所以释放资源要用 `onClose`：

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:db',
    title: 'Database',
    single: true,
    badge: (_ctx, _scope, state) => /* 比如打开的连接数，每次 tab 栏渲染调用，保持廉价 */,
    onOpen: (tab, scope) => { startWatcher(scope.sessionId) },
    onClose: (tab, scope) => { stopWatcher(scope.sessionId) },
    component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  })
)
```

---

## 8. 声明式设置（v0.4.1+）

每个注册的 tab / viewer **自动**出现在 DSH 设置页「侧边卡片」分区（`SideCardSection` 按注册表驱动渲染，无硬编码）：

- 展示：小卡片网格（图标 + 标题 + 类型 id），**高亮 = 启用**，勾选徽标钉在卡片最右端；viewer 卡片额外显示扩展名。
- 持久化：开关写入 `SidebarPrefs.tabsEnabled / viewersEnabled`（开放 map，**缺省 = 启用**，显式 `false` 才禁用）。
- 关闭语义：tab 从 `+` 菜单消失、`openTab` 拒绝新开（`console.warn`）、派生流程（子代理自动展开、agent 终端自动补 tab）停止，**已打开的 tab 保留**；viewer 被 `matchFileViewer` 跳过，文件落到下一个匹配。
- `settings.toggles`（可选）：在卡片行下追加**嵌套设置行**（仅父级启用时显示），绑定 `SidebarPrefs` 字段；通过卡片底部「功能设置」条在原生弹窗中编辑。行控件形状见 §4.1 的 `SettingRow`：`type: 'switch' | 'text' | 'number'`（v0.11.0+；text/number 行 blur/Enter 提交，number 行按 min/max 钳制，unit 渲染单位后缀）与 `type: 'select'`（v0.13.0+；`options` 支持 value/title/desc/icon，`multi` 多选存数组并按 options 顺序提交；任一项带 icon 时渲染大图标选项卡）。内置示例：subagent tab 的 `autoOpenSubagent`、terminal tab 的 `agentTerminalTools` + 自定义字体行、editor tab 的 `editorExplorer` 图标化下拉与 `workspaceFence` 开关（工作区路径围栏，见 §8.1）。
- `settings.pluginToggles`（可选，v0.12.0+）：**插件自有设置行**，行控件与 toggles 相同，但 key 是插件局部的——持久化在 prefs 文档的 `pluginSettings[<descriptor id>]`（开放 map，无需宿主 schema 字段）。tab 与 viewer 都可用（v0.12.0 起 viewer 卡片也有设置条）。
- `settings.render`（可选，v0.12.0+）：**自定义设置面板**——追加渲染在行列表之后，可单独存在。props 含 store/service/prefs、本 descriptor 的 `pluginSettings` blob、`updatePluginSetting(key, value)` 与 `close()`；抛错会被吞掉并显示内联错误。

```ts
ctx.effect(() =>
  ctx.betterSidebar.registerTab({
    id: 'my-plugin:db',
    title: 'Database',
    order: 50,
    settings: {
      // 宿主 prefs 字段行：key 必须是宿主 PrefsSchema 的字段（仅此限制）
      toggles: [{
        key: 'autoOpenSubagent',   // 宿主内置键
        title: 'Auto-open',
        desc: 'Open when a subagent appears',
      }],
      // 插件自有设置行：key 插件局部，持久化在 pluginSettings['my-plugin:db']
      pluginToggles: [{
        key: 'pageSize',
        title: 'Page size',
        type: 'number',
        min: 1,
        max: 100,
        unit: 'rows',
      }],
      // 或完全自定义面板（追加在行列表之后）
      render: ({ store, service, prefs, pluginSettings, updatePluginSetting, close }) => (
        <MySettingsPanel
          values={pluginSettings}
          onChange={(key, value) => { updatePluginSetting(key, value) }}
          onDone={close}
        />
      ),
    },
    component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  })
)
```

> ⚠️ **`toggles` 的 key 必须是宿主 PrefsSchema 的字段**（内置键：`autoOpenSubagent` / `agentTerminalTools` / `agentOpenTools` / `terminalFontFamily` / `terminalFontSize` / `editorExplorer` / `workspaceFence` / `htmlViewerNoSandbox` / `htmlViewerDefaultUnsafe` / `browserNoSandbox` / `browserInterceptLinks` / `browserInterceptHttp` / `browserInterceptHttps` / `changesDiffFloat`）。**v0.12.0 起设置 seam 已开放**：你自己的设置走 `pluginToggles`（声明式行）或 `render`（自定义面板），值持久化在 `pluginSettings[id]`——不再需要宿主 schema 字段，也不再被 seam 丢弃。值须 JSON 可序列化（行控件只产出 string/number/boolean；自定义面板自行负责）。

### 8.1 内置键 `workspaceFence`（工作区路径围栏）

所有侧栏文件系统路由（`fs.tree` / `fs.read` / `fs.write` / `/sidebar/file` 媒体 / `/sidebar/html` 预览 / `/sidebar/upload`）默认强制**工作区包含检查**：客户端提供的路径经 realpath 解析后必须落在会话工作区内，否则 403（wire 错误码 `forbidden`，消息 `path "..." is outside workspace`）。`workspaceFence: false`（默认 `true`）解除该包含检查——路径仍会解析符号链接得到 canonical 路径，但不再拒绝工作区外的目标（如全局 `~/.dsh/AGENTS.md`、会话 cwd 之外的 linked worktree）。

- 开关位置：设置页「文件」卡片 →「功能设置」二级弹窗；编辑器加载失败与文件树列目录失败两个错误面在触发围栏拒绝时会显示原因 + 一键全局关闭按钮（`FenceErrorNotice`，写 `workspaceFence: false` 后自动重试失败的操作）。
- ⚠️ **安全代价**：关闭期间，页面内任意同源脚本（**包括第三方消费插件**）都能通过上述路由读写主机上任意文件——开关文案已明示该风险，用完建议重新打开。

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
| **统一 cordis 分支（v0.15.2+）** | 类型基底与 augmentation 全部在 DSH 运行时正主 `@deepseek-ai/cordis` 上（`src/context-types.ts`：真实 cordis `Context` 与结构化服务面做**交集**，不再重述 `declare module 'cordis'`——host/client 包对同名成员声明不同会 TS2717）。消费者 `import type {} from 'dsh-better-sidebar'` 即拿到 `ctx.betterSidebar`，或直接 `import type { Context } from 'dsh-better-sidebar'`。公开版 `cordis` 不再被依赖 |
| **ModuleLoader 不跨插件** | 运行时 `require()` 虽支持跨 bundle，但被构建门挡；所有交互走 `ctx.betterSidebar` 方法调用 |
| **host 半无此服务** | `ctx.betterSidebar` 只在 client 侧存在；host 半需要 better-sidebar 数据走 `/sidebar/api/*` HTTP 路由 |
| **portal 限制** | 整面板 slot 由 ui-layout 独占，外部 tab 只能进入 better-sidebar 的 portal 内部，无法全屏替换整个面板 |
| **id 冲突** | `registerTab` / `registerFileViewer` 对重复 id 抛错；建议用包前缀（`my-plugin:xxx`） |
| **不要 value-import `dsh-better-sidebar`** | 即使是 `./client/service` 子路径，运行时落点也是 client bundle；只做 type-only import |
| **client 声明图零 Node 依赖（v0.12.0+）** | `dsh-better-sidebar/client/service` 的可达声明面（含 `Context`）不引用 `node:*` / `Buffer`——纯浏览器侧插件无需 `@types/node`，`skipLibCheck: false` 也能编译（`scripts/check-consumer-types.sh` 守护；主入口含宿主声明，宿主消费者本就处于 Node 环境） |
| **家族右面板互斥（v0.13.0+）** | `aionui-panel` 设置的 `rightPanel` 解析为 `'aionui-panel'` 时整个侧边栏不挂载（`settings.get` 返回 `externalDisable: true`，挂载门 + 接管停用；`settings/document-updated` 推送实时生效，无 `remote` 服务回退启动时判定）。未安装 aionui 不受影响 |
| **i18n 跟随** | 文案跟随 DSH `ctx.locale`（词典在 `betterSidebar` 命名空间；Host-backed `locale.preference` 优先于浏览器语言并实时切换；缺失回退浏览器）。消费插件**不要**依赖内部 `t()`——标题传字符串或 `() => string` |
| **第三语言覆盖（ja 等）** | 可选 peer `@huanlin/dsh-plugin-better-locale`（optional）提供 ja/ko 覆盖，**借用 DSH 英文槽位**（仅 DSH=en 时生效，zh 下惰性）。经 `ctx.get('betterLocale')` 注入 `t()`；未安装整段 no-op |
| **懒加载 chunk** | 重依赖（xterm/CodeMirror）在独立 bundle（`lib/client-<name>.js`），经 `/sidebar/bundle` 按需下发；factory 赋到 `globalThis.__dshChunks__[<name>]`，由 `src/client/chunk-loader.ts` 物化，**不经** `__ModuleLoader__`。对消费插件透明 |
| **聊天文件打开漏斗（alpha 宿主）** | 聊天里一切文件打开（工具行 / 产物行 / 正文提及 / 行内代码路径）汇入 `ctx.remote.session.openWorkspacePath`（Typert remote 命名空间，cordis 服务 key `remote.session`，方法为 **accessor 属性**、异步挂载）。better-sidebar 的「聊天区文件在侧边栏打开」即在 `ctx.inject(['remote.session'], …)` 内以 defineProperty 遮蔽该方法（`src/client/openpath-intercept.ts`）。你的插件若要观测/旁路聊天文件打开，走同一服务；不要假设 pre-alpha 的 `ctx.workspaces.openPath` 存在（alpha 的 `IWorkspaces` 已无此方法） |

---

## 11. 自由窗口（v0.16.0，`features` 含 `'floatWindows'`）

任意 tab（含你注册的）可拖出侧边栏成为悬浮**自由窗口**——对你的组件基本透明，只需知道以下语义：

- **拖出**：tab 拖到主会话区域（conversation 列）松开即浮动（`floatTab`：移入 `SidebarState.floats`，默认 390×780 按视口钳制居中，清空 pane 折叠）。检测在 `Sidebar.tsx`（`body[data-dsh-tab-dragging]` 门控）；窄视口禁用。右键「移动到自由窗口」始终可用。
- **窗口操作**（`src/client/FreeWindow.tsx`，`[data-dsh-panel-host]` 内、z-42）：头部拖动移动；拖到 pane（`[data-dsh-pane]`）松开**停靠**（`dockFloat`）；右下角缩放（最小 320×200）；点击置顶（层叠 = `floats` 数组序）；X = `closeTab`（触发 `onClose`、释放终端）。
- **持久化**：`floats` 随会话进 localStorage（`dsh-sidebar:v1:<sessionId>`）；`sanitizeState` 宽容校验（非法条目单独丢弃、几何钳入视口、diff/ephemeral 不持久化）。
- **服务语义**：`openTab` 聚焦命中浮动 tab = 置顶窗口（不重复开）；`closeTab`/`activateTab` 关窗/置顶并触发回调；agent 终端 reconcile 移除已消失的浮动窗口。**浮窗内你的组件 `visible` 恒 true**。
- **稳定寻址面**：`[data-dsh-float-window]` / `[data-dsh-float-id]` / `[data-dsh-pane]` / `[data-dsh-float-dock-over]` / `[class*='floatDropHint']`；全令牌驱动，头部 `-webkit-app-region: no-drag`。
- **⚠️ portal 事件劫持陷阱**：拖拽表面子树含 portal 覆盖层时（如你的组件在 tab 头部区域渲染弹层），portal 后代合成事件**沿 React 树冒泡**回 `onPointerDown`，会被误判为拖拽开始（吞点击 + 抢 pointer，菜单/X 失灵；jsdom 不走此路径，只有 e2e 能抓）。拖拽起点必须带**同源守卫**：`event.currentTarget.contains(event.target)` 为假或目标在 `button` 内时直接返回（回归：`tests/free-window.spec.tsx` portaled-menu 用例）。

---

## 12. 皮肤兼容（令牌驱动）

> better-sidebar 所有视觉值消费 DSH 的 `--dsw-alias-*` / `--dsw-font-*` / `--ds-*` 令牌（无硬编码颜色），**不做每皮肤适配**。已与 dsh-web-ui 皮肤中心兼容（10 款皮肤全覆盖 `--dsw-alias-*` 层；`tests/theme.spec.ts` 守护）。你的 tab/viewer 组件遵循同样的令牌规则即可自动兼容全部皮肤。

### 12.1 规则

- **面板表面**：右/底面板背景 = `var(--dsw-alias-bg-layer-1)`。**绝不消费 `--dsw-specific-sidebar-fill`**（宿主左导航专属，皮肤按左导航语义覆盖它，面板消费会失去填充）。换面板表面 = 覆写 `--dsw-alias-bg-layer-1`。
- **终端/编辑器表面**：`effectiveTokenValue` 读 `--dsw-alias-bg-base`——`transparent` 与 alpha < 0.9 的半透明值回退不透明底色（文字不叠背景画，issue #90）；≥ 0.9 放行。
- **根锚点**：宿主 div 带 `data-dsh-better-sidebar`（append 到 body）；其内**面板宿主层** `[data-dsh-panel-host]`（`fixed; inset:0; z-25; pointer-events:none; overflow:hidden+clip`，v0.13.1+），面板/开关簇 absolute 定位，免疫中间层 transform 劫持；页面级 transform 触发 `data-dsh-panel-host-degraded` 降级。`overflow` 级联是**契约**（`hidden` 兜底 + `clip` 收尾，`tests/panel-host-css.spec.ts` 守护）：`hidden` 盒子仍是滚动容器，脚本滚动或浏览器 scroll-into-view 修正（焦点移入视口外区域、嵌套 iframe/工作台加载时抢焦点、面板滑出动画中 focus() 落点）会沿最近可滚祖先滚走整层——面板与开关簇集体偏离视口角（computed left/right 仍"正确"，偏移藏在盒子自身 scroll offset 里）；`clip` 裁剪语义相同但不产生滚动盒，任何路径都滚不动这层。皮肤作用域覆盖限定在 `[data-dsh-better-sidebar]` 内。
- **布局变量**（`<html>` 上，面板打开时有效）：`--dsh-sidebar-width` / `--dsh-sidebar-height`。右面板宽度 = AppFrame 的 `padding-right` 预留（新版 `#root [data-dsh-frame]` / rc.8 `#root > [data-slot="root"] > div` 双锚点），AppFrame border box 保持完整桌面视口宽度（Harness 以此判定桌面/窄屏布局，避免插件面板展开误入窄屏）；AppFrame 的 details 拖拽手柄按同一变量向左平移贴合列边缘。底部面板仍走 centerCol `margin-bottom`；centerCol 锚点 = **JS 标注**（禁止 `nth-child`）：侧栏 shell 的定位器给测得的 centerCol 节点打 `[data-dsh-center-col]` 标签（`Sidebar.tsx` locate，节点更换/HMR 时随 ref 迁移），`layout.css` 用 `#root [data-dsh-center-col]` 选中（`drag-layout.e2e.ts` 断言恰一节点且为 `[data-slot="conversation"]` 的父级；frame 宽度与桌面 Session Log 由 `desktop-layout.e2e.ts` 断言）。
- **桌面信号与标题栏**（v0.14.1+ 四方案模型 `SidebarPrefs.titleBarScheme`，唯一决策点 `src/client/titlebar-strip.ts` 纯函数）：
  - 壳信号（只读，不自动触发修改）：URL `dsh-desktop-mode` / `dsh-desktop-platform` / 可选 `dsh-desktop-titlebar-inset`（0–120 clamp）。
  - **strip 取值链**：⓪ `web` 方案强制 0；① `navigator.windowControlsOverlay` 真实几何（`wco.ts` 订阅 `geometrychange`，**为 0 也权威**，`visible=false` 幽灵 API 视为缺失）；② URL inset；③ 壳预设 `stripFor`（仅 `preset`）；④ 手动 `titleBarStripPx`（仅 `custom`）；⑤ 0。驱动 `body[data-dsh-title-bar-compat]` + `--dsh-title-bar-strip`。
  - **四方案**：`auto`（默认，只信 WCO——"为某壳做的兼容在另一个壳会再坏"，核心不做壳专属分支）/ `web`（强制 0）/ `preset`（`src/client/shell-presets.ts`，准入：issue/PR 提及且 GitHub ⭐>100；命中环境显示「已检测」后缀，绝不自动启用）/ `custom`（用户 CSS + 手动 px，齿轮弹窗）。
  - **迁移**：`titleBarScheme` 无默认值；旧文档已有值（`titleBarCompat === true` 或 `titleBarStripPx` 非 40）→ 迁 `custom`；干净文档 → `auto`。
  - **用户空间 CSS**：预设/自定义 css 注入 `<style data-dsh-preset-css|data-dsh-custom-css>` 到 head 末尾（后写胜出；覆盖 JS 内联需 `!important`），fiber 卸载即移除。稳定寻址面：`[data-dsh-toggle-cluster]` / `[data-dsh-panel]` / `[data-dsh-bottom-panel]`。
  - **拖拽区退出**：交互 chrome（`.toggleCluster` / `.toggleButton` / `.tabBar`）统一 `-webkit-app-region: no-drag`（无边框壳拖拽带吞点击，#103/#111）。
- **z-index**：面板宿主层 25、按钮簇 45——低于 DSH ui-cordis 插件面板（30）与浮层栈（100/1000+），浮层天然盖住侧边栏。

### 12.2 注意事项

- 类名是 CSS Modules 哈希，**不是契约**；精确命中用 `[data-dsh-better-sidebar]` + 子串类名（`[class*='panel']`）或 DOM 结构。
- 改动本契约必须同步本文档、设计文档与 `tests/theme.spec.ts`。

---

## 13. 完整最小示例

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
    "@deepseek-ai/cordis": "^4.0.1",
    "dsh-better-sidebar": "workspace:*",
    "react": "^18.2.0"
  },
  "peerDependenciesMeta": {
    "dsh-better-sidebar": { "optional": true }
  }
}
```

**`my-plugin/src/client/index.tsx`**（CSV viewer 的 `custom` load 直取 `/sidebar/api/fs.read`，注意响应 envelope 是 `{ value }`）：

```tsx
import { createElement } from 'react'
import type {} from 'dsh-better-sidebar'  // 触发 ctx.betterSidebar 类型合并
import type { Context } from '@deepseek-ai/cordis'

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

## 14. 参考实现与调试

better-sidebar 的内置 tab 和 viewer 就是参考实现（"吃狗粮"），调试时直接读：

- **`src/client/builtins/`**：7 个内置 tab（tabs.tsx）+ 6 个内置 viewer（viewers.tsx）的注册代码 + 聚合与 disposer 生命周期（index.ts）；Office 预览见 plugins-viewers.ts
- **`src/client/service.ts`**：`BetterSidebarService` 接口 + `createBetterSidebarService` 工厂实现（含匹配算法、dedupe、createTab、启用态 gating）
- **`src/client/Sidebar.tsx`**：`TabContent` 分发（查 `getTab` → 调 descriptor.component；未注册 → `<OrphanedTab/>`）、`+` 菜单构建（order 排序 + available disabled + 禁用过滤）、自由窗口拖拽检测
- **`src/client/FreeWindow.tsx`**：自由窗口（移动/停靠/缩放/置顶，§11）
- **`src/client/SideCardSection.tsx`**：声明式设置页（注册表驱动清单 + 嵌套设置行 + 开关持久化）
- **`src/client/api.ts`**：`/sidebar` API 的封装（复制其 fetch 模式到你的插件）
- **`src/client/plugins-tabs.ts`** / **`plugins-viewers.ts`**：推荐插件目录（「添加插件」弹窗数据源；加一条数据即上架，`tests/plugin-list.spec.ts` 守护）
- **`src/client/FileTree.tsx`** / **`TreePanel.tsx`** / **`src/fs-search.ts`**：文件树 / 树面板 / host 文件名搜索（`fs.search`；`tests/fs-search.spec.ts`）
- **`src/client/markdown-html.ts`** / **`MarkdownHtml.tsx`** / **`md-toc.tsx`**：markdown 内嵌 HTML 管线与目录大纲（注意 `md-toc.tsx` 头注释的「子组件读父 ref 为 null」时序陷阱）
- **`src/agent-opens.ts`** / **`/sidebar/ws/agent-opens`**：模型主动打开（`sidebar_open` 工具 + `agentOpenTools` 设置，默认关闭）；文件夹窗口 = `meta.dir: true` 的 editor tab（[设计文档](plans/2026-08-23-agent-open-tools-design.md)）
- **`tests/service.spec.ts`** / **`tests/builtins.spec.ts`**：注册表生命周期 / 匹配算法 / dedupe / createTab / 启用态 gating；内置清单断言（7 tab + 6 viewer + 声明式元数据）
- **`docs/plans/`**：逐特性设计文档（含实施偏差记录，以现状为准）；入口如 `2026-08-11-service-registry-design.md` / `2026-08-11-declarative-sidebar-settings-design.md`

---

## 15. 真实接入案例

第一个通过 `ctx.betterSidebar` 接入的三方插件：[dsh-sentinel](https://github.com/fuhefei/dsh-sentinel) —— 条件驱动的 agent 唤醒系统（文件/进程/端口/HTTP/命令/webhook 传感器，条件达成自动唤醒休眠会话）。

- **接入方式**：可选软依赖——client half 本地重述最小服务契约（`registerTab`），未安装 better-sidebar 时注册静默跳过，插件原有表面不受影响；
- **注册内容**：`dsh-sentinel:watches` tab（order 60，单实例）：全服务器监控表 + 最近触发历史；
- **类型处理**：未 value-import `dsh-better-sidebar`，构建零耦合；与 §2 的 `import type {}` 方案可互换；
- **实测**：v0.3.0 起，真实 web profile 验证通过。

通过 `ctx.betterSidebar` 的三方插件 [dsh-sidebar-qa](https://github.com/ChenRuoT/dsh-sidebar-qa) —— 基于 better-sidebar 的划选提问：对话划选 → 右侧面板提问 → 同工作区独立追问会话（❓追问·主题）；快速无思考模型压缩主对话上下文后与引文一起注入，不打断主对话；追问可嵌套、可继续、可归档。

更多插件接入后欢迎在此登记（一句话 + 链接）。
