# 客户端懒加载分块（lazy chunks）设计

> 日期:2026-08-12
> 状态:已实现
> 范围:`dsh-better-sidebar` 插件,客户端 bundle 拆分

## 1. 背景与问题

改造前客户端是单文件 bundle(`lib/client.js`,约 24.6MB),页面启动时全部**下载 + 解析 + 执行**。实测构成(按 sourcemap 源字节):

| 依赖 | 体积 | 用途 |
|---|---|---|
| `@univerjs/*` 全家桶 + echarts/zrender 等 | ~18MB | .xlsx 预览 |
| `@codemirror/*` + `@lezer/*` | ~1.9MB | 文本编辑器高亮 |
| `xlsx`(SheetJS) | ~0.6MB | .xlsx 解析 |
| `@aiden0z/pptx-renderer` | ~0.5MB | .pptx 预览 |
| `xterm` | ~0.3MB | 终端 |
| `docx-preview` + `jszip` | ~0.2MB | .docx 预览 |
| 插件自身代码 | ~0.35MB | — |

虽然 `office-view.tsx` 用了动态 `import()`,但 `codeSplitting: false` 只保证**延迟执行**(`Promise.resolve().then(() => (init_docx_preview(), ...))`),下载与解析成本仍在启动时;且 `xlsx-to-univer.ts` 对 `@univerjs/presets` 的静态 value-import 让 Univer 核心实际在启动时执行。

**目标**:重依赖拆成独立脚本,首次打开对应功能才下载/解析/执行;启动只拉核心(~325KB)。

## 2. 机制

chunk 脚本**不经过** `window.__ModuleLoader__` / `ClientModuleSystem.import()` 的物化路径——模块系统的 import() 只解析 seed word / shell-own 模块 / 已注册 factory / boot graph row,chunk id 四者皆非,解析行为依赖 DSH 版本(实测某些版本在 factory 已注册时仍抛 "cannot resolve")。因此改为插件自有的全局 factory 注册表:

1. **构建期**:每个 chunk 是独立 tsdown 浏览器 bundle(`lib/client-<name>.js`),脚本首行为:
   ```js
   globalThis.__dshChunks__ = globalThis.__dshChunks__ || {};
   globalThis.__dshChunks__["terminal"] = (require) => { /* CJS 闭包体 */ };
   ```
   与主 bundle 相同的 externals(react 等走 module table)、纯度门、CSS 内联管线;`codeSplitting: false` 保持单文件。
2. **运行期** `loadChunk(name)`:
   - 注入 `<script src="/sidebar/bundle/<name>.js">`(经典同源脚本;官方 `/plugins/<id>/client.js` 路由的路径白名单无法服务任意文件名,故走插件自有路由);
   - 从 `globalThis.__dshChunks__[name]` 读取 factory(脚本执行即赋值,幂等——重复执行覆盖槽位,无 "duplicate factory registration" 错误类);
   - 用**自定义 require** 物化:externals(CLIENT_EXTERNALS 清单)经 `__DSH_MODULES__.import(spec)` 的 **seed 分支**逐一解析(页面级记忆化;解析失败的 spec 标记未解析,仅当 chunk 实际 require 时才报错)——seed 分支是模块系统最稳定、跨版本一致的部分。

## 3. 分块清单

| chunk 名 | 入口 | 内容 | 构建产物 | 触发 |
|---|---|---|---|---|
| `xlsx` | `src/client/chunks/xlsx.tsx` | `XlsxView` + Univer 全家桶 + xlsx + Univer CSS | lib/client-xlsx.js(~20MB) | 打开 .xlsx |
| `docx` | `src/client/chunks/docx.tsx` | `DocxView` + docx-preview + jszip | lib/client-docx.js(~330KB) | 打开 .docx |
| `pptx` | `src/client/chunks/pptx.tsx` | `PptxView` + pptx-renderer | lib/client-pptx.js(~2.4MB) | 打开 .pptx |
| `terminal` | `src/client/chunks/terminal.tsx` | `TerminalView` + xterm + addon-fit + xterm.css | lib/client-terminal.js(~450KB) | 打开终端 tab |
| `editor` | `src/client/chunks/editor.tsx` | `TextEditor` + @codemirror/* + lang.ts + cm-themes | lib/client-editor.js(~1.6MB) | 打开 code/md/html 文件 |
| `mermaid` | `src/client/chunks/mermaid.tsx` | `MermaidBlocks` + mermaid + d3/dagre/cytoscape | lib/client-mermaid.js(~7MB) | 预览含 mermaid fence 的 md |
| 核心 | `src/client/index.tsx` | 其余全部 | lib/client.js(~325KB) | 启动 |

关键拆分:**`office-view.tsx` 拆为 `docx-view.tsx` + `xlsx-view.tsx` + `office-shared.tsx`**(共享 `LoadState`/`BinaryFallback`)。若不拆,docx chunk 会经共享文件静态拖入 `xlsx-to-univer` → Univer 14.5MB。原路径 `office-view.tsx` 保留为 re-export 垫片,兼容 `./src/*` 深导入。

## 4. 缓存契约(三层,各带失败路径)

| 层 | 机制 | 失败路径 |
|---|---|---|
| 内存 | `loadChunk` 每 chunk 一个 in-flight promise,并发去重,常驻到 `resetChunks` | 失败删除缓存项 → 下次调用重试 |
| 执行 | 脚本执行即覆盖全局注册表槽位(赋值幂等) | 物化失败清缓存 → 重试重新注入 + 重新执行脚本 |
| HTTP | `/sidebar/bundle` 路由 `cache-control: no-cache` + ETag(内容哈希,按 mtime/size 记忆化),`If-None-Match` 命中返回 304 | 页面刷新/HMR 重激活时 304 免重下载 17MB;文件变化 ETag 轮转返回 200 |

**HMR**:`apply()` 每次激活调用 `resetChunks()`(清内存缓存 + externals 记忆),热更新后重新拉取新代码。chunk 源码单独改动需手动刷新页面(HMR 轮询只盯 client.js)。

## 5. 对外 API 兼容性(硬约束)

- `ctx.betterSidebar` 服务方法签名与行为零变化;懒加载只作用于**内置** descriptor,外部插件注册的原样存储/渲染。
- `component` 契约 `(props) => ReactNode` 保持:懒包装是**纯渲染函数**(函数体无 hooks,hooks 在内部 `LazyChunkView`),兼容 Sidebar 的函数式调用与 EditorHost 的 `createElement` 渲染两种风格。
- 内置 viewer/tab 的 id、exts、priority、detect、icon、title、settings 全部不变 → `matchFileViewer` 语义、外部插件同扩展名高优先级覆盖、设置页清单不变。
- 公开类型面(`./client/service`、`./client/api`)不变;无新增 peerDeps。
- 契约测试:`tests/lazy-chunk.spec.tsx` 钉住"component 可直接函数调用不抛错"。

## 6. 边界与失败模式

- chunk 加载/执行/物化失败 → 视图级错误 + 重试 UI(`css.editorError` + `css.terminalRetry`),面板其余部分不受影响;
- host 旧版本无 `/sidebar/bundle` 路由(404) → 同样的错误 + 重试,升级 host 后重试即可;
- `window.__DSH_MODULES__` 缺失(异常环境) → 明确报错,不触网;
- chunk 注册 id 恒定 `dsh-better-sidebar/<name>`,两渠道共用(每页只活一个渠道——双渠道并存本就双挂载,属既有破损组合);
- 跨 chunk 复用:`t()`/`api.ts`/`SandboxStatusBar`/`clsx`/`sidebar.module.css` 等无状态小模块允许在各 chunk 内联(几十 KB 级重复),避免 chunk→主 bundle require 的脆弱耦合;
- CSS:`sidebar.module.css` 的 tagId 与官方渠道核心一致 → 幂等跳过注入;registry 渠道会多注入一份同内容样式(数据标签差异,无功能影响);xterm.css/Univer.css 随各自 chunk 注入。

## 7. 实施偏差记录

- 原设想 React.lazy + Suspense 被否决:错误处理需 error boundary,重试语义差;改用有状态包装组件(loading/error/retry 三态),与本库"每个视图自带 loading/error/retry"风格一致。
- 原设想 chunk 注册 id 按渠道区分(`__DSH_PLUGIN_ID__` define)被否决:chunk 文件两渠道共用,恒定槽位即可;避免重复构建 6 份产物。
- `resetChunks` 同时清空测试注册表(测试隔离需要)。
- `lazy-chunk.tsx` 内部渲染用 `ComponentType<any>` 状态成员规避 React 18 createElement 泛型重载限制(仅内部一处显式 any)。
- **v2(运行时修复)**:最初实现经 `window.__ModuleLoader__.load({id})` 注册 chunk factory、再 `__DSH_MODULES__.import(id)` 物化——真实环境报 `client-modules: cannot resolve "dsh-better-sidebar/terminal"`(某 DSH 版本的 import() 不解析已注册的非 boot 图 id)。改为全局 factory 注册表(`globalThis.__dshChunks__`) + 自定义 externals require(seed 分支),彻底不依赖模块系统的 factory 解析行为;`resetChunks` 不再需要 invalidate。
- **v3(运行时修复)**:terminal 懒包装把整个 `TabComponentProps` 原样透传,但 `TerminalView` 的 props 是 `{ scope, tabId, store }` 而 `TabComponentProps` 只有 `tab` 对象、没有 `tabId` → `tabId` 为 undefined → `isAgentTabId` 里 `undefined.startsWith` 崩溃(`dsh-better-sidebar: Cannot read properties of undefined (reading 'startsWith')`)。修复:descriptor 显式映射 `tabId={tab.id}`,懒包装的 props 泛型 = TerminalView 真实签名(`{ scope, tabId, store }`);回归测试钉住映射(lazy-chunk.spec.tsx)。**教训:懒包装的 props 泛型必须等于目标组件真实 props,而非描述符 props 全集**。
- **v2 附加**:bundled 产物经真实 `ClientModuleSystem`(带真实 react seed)端到端验证——5 个 chunk 均能物化出真实 React 组件;产物契约由 `tests/chunk-artifact.spec.ts` 长期钉住(脚本执行赋值槽位 + factory 可被 externals require 物化)。
