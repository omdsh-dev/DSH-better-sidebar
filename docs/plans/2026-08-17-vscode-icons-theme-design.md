# Explorer VSCode 图标主题（vscode-icons 渲染模式）设计

> 日期:2026-08-17
> 状态:已实现
> 范围:`dsh-better-sidebar` 插件的侧边栏 Explorer（+ 编辑器 tab），图标渲染模式迁移自 VSCode

## 1. 背景与问题

改造前 Explorer 行内文件/文件夹图标是 DSH primitives 的**通用轮廓字形**（`IconFolderOpen16` / `IconFolderClose16` / `IconCodeOutline16` @14px）——所有文件一个图标、所有文件夹一种形状，行内无法区分 `package.json` / `index.ts` / `Dockerfile`，视觉上与 VSCode 的资源管理器差距明显。

**目标**：把 VSCode 的 file-icon-theme「渲染模式」搬进侧边栏——文件名/扩展名精确匹配（含多段扩展名、大小写兜底）、文件夹开合区分、暗/亮色变体自动跟随、编辑器 tab 同步显示文件真实图标——图标集直接复用上游 **vscode-icons** 扩展（MIT，1400+ 文件/文件夹 SVG）。

**约束**：插件构建必须自包含（CI 没有兄弟 checkout），图标作为静态资源随 npm 包发布；不修改 VSCode 或 DSH 源码，只在插件内实现同等语义。

## 2. 总体结构

```
vscode-icons checkout（开发期唯一来源）
        │  scripts/gen-icons.mjs（提交时手工执行，产物提交）
        ▼
icons/                        ← 1427 个 SVG（file_type_*/folder_type_*/default_*，含 light 变体）
src/client/icons-manifest.generated.ts  ← 图标主题映射（fileNames/fileExtensions/folderNames(+open)/light + defaults）
        │
src/icons-route.ts            ← /sidebar/icons 路由（宿主导出，信任栅栏 + ETag 缓存）
        ▼
src/client/icons-theme.tsx    ← 主题引擎：解析 entry → 图标文件名 + <img> 渲染组件
        ▼
src/client/ExplorerView.tsx / Sidebar.tsx ← 行内 <img> 16px / tab 14px
```

### 2.1 生成器 `scripts/gen-icons.mjs`

- 从兄弟 `../vscode-icons` checkout 读取 `supportedExtensions.ts` / `supportedFolders.ts` / `languages.ts`，**transpile+eval**（type-strip 掉 import 行，`FileFormat`/`languages` 以全局注入），零运行期依赖。
- 按默认 preset 过滤 `disabled` 条目，按 icon 名排序后折叠成 VSCode file-icon-theme 形状：文件 `fileNames` / `fileExtensions`（含 light），文件夹 `folderNames` / `folderNamesOpen`（含 light，仅上游有变体的条目）。
- `filename: true` 条目进 `fileNames`（带前导点，如 `.envrc`）；`filenamesGlob × extensionsGlob` 用 `.` 连接展开（`compose` × `yaml` → `compose.yaml`），与上游 `Utils.combine` 一致。
- 把**所有被引用**的 SVG 拷进 `icons/`（缺文件即报错退出），生成 manifest 模块：每键一行、键排序，保证重复生成 diff 稳定。产物**提交入库**。

### 2.2 静态路由 `src/icons-route.ts`

- `/sidebar/icons/<name>.svg`，与其它 sidebar 路由同一信任栅栏；文件名白名单 `/^[a-z0-9_]+\.svg$/i`（无路径穿越、无多余点）。
- 缓存契约同懒加载 chunk：`cache-control: no-cache` + ETag（按 mtime/size 记忆化内容哈希），`If-None-Match` 命中 304——浏览器每次取用前重验证，图标字节不重下。
- `lib/../icons` 即发布包根 `icons/`，dev 树与打包产物同一解析路径。

### 2.3 主题引擎 `src/client/icons-theme.tsx`

匹配语义照搬 VSCode `fileIconTheme.ts`：

- **文件**：精确 basename → 宽松（忽略大小写）basename → 扩展名候选（basename 的每个点到末尾后缀，`archive.tar.gz` → `['gz','tar.gz']`，**从最长开始**逐个先精确后宽松）。侧边栏无语言服务，languageIds 由生成器在构建期折叠进 maps（与上游 manifestBuilder 相同）。
- **文件夹**：仅按 basename 匹配 `folderNames` / `folderNamesOpen`（依开合状态取 map），精确 → 宽松，永不误用文件 maps（`node_modules` 目录不会取文件 `node_modules` 图标）。
- **亮色**：light map 命中取 light 文件，未命中逐项回退暗色文件（上游 light theme 的继承语义）；`default_*` 无 light 变体，直接共享。
- 大小写索引按 manifest 声明序取首个原始键（生成文件有序，确定性稳定）。

### 2.4 渲染

- `<img>`（`alt=""` / `draggable={false}` / `decoding="async"` / `loading="lazy"`，`display:block` + `user-select:none`）——SVG `preserveAspectRatio` 自行等比缩放，非 32×32 viewBox 的少数图标不失真。
- **颜色方案实时跟随**：`useColorScheme` 是模块级共享 store（单个 MutationObserver 监听 `body[data-ds-dark-theme]`，`useSyncExternalStore` 订阅）——深树上百个图标只挂一个 observer，换肤时全部就地切到 light 变体。
- 尺寸由调用方内联指定：Explorer 行 16px（32px viewBox 在 2× 屏恰为整数倍渲染，锐利），编辑器 tab 14px 与其它 tab 字形齐高。
- **编辑器 tab**（`Sidebar.tabIconOf`）：`type === 'editor'` 且带 path 时显示文件真实图标（`baseName(path)` 查主题），无 path 回退描述符的通用 code 字形。

## 3. 命名与一致性

| 层面 | 规则 |
|---|---|
| 资源 | `icons/*.svg`，与上游同名；仅被 maps 引用的 SVG 才会发布（复制前先收集 referenced 集合） |
| manifest | `icons-manifest.generated.ts` 头注「GENERATED FILE」，值恒为图标文件 basename |
| 测试 | `icons-route.spec.ts`（白名单/方法/栅栏/ETag/304）、`icons-theme.spec.ts`（匹配语义 + manifest↔assets 一致性：每个被引用 SVG 存在且非空、light 子集）、`unit.spec.ts` 补 `baseName`、`smoke.spec.ts` 路由清单、`mount.e2e.ts` 直接 fetch 打包包 `/sidebar/icons/default_file.svg` 断言 200 + 行内 `<img>` 引用图标路由 |

## 4. 实施偏差记录

- 生成器最初考虑直接内联 SVG 为 React 组件（免路由）；否决——1427 个组件使 client bundle 膨胀且无法按需，静态路由 + `<img>` 与 VSCode 的资源加载形态一致。
- `useColorScheme` 初版为每个图标实例一个 `useEffect`+MutationObserver；深目录场景实例数百，改为共享 observer 的 `useSyncExternalStore` store（公共 API 不变）。
- `baseName` 原为 ExplorerView 私有函数，提升到 `paths.ts` 供 Explorer 与 Sidebar 共用（含 `\` 分割与尾部分隔符裁剪，Windows 路径安全）。
- DSH 自身聊天区/产物列表等展示文件的地方属于宿主，不在本插件范围内（不修改 DSH 源码）。若后续宿主侧也想复用，可直接引用本包的 vscode-icons 主题数据。
- `mount.e2e.ts` 图标断言初版用 `waitForResponse(/sidebar/icons/)` 注册在「重开 Explorer」之后——但 Explorer 已在 + 菜单 sweep 中渲染并取过图标，Dedupe 聚焦**不会**产生新图标请求，响应等待必然超时。改为确定性断言：直接 `fetch` 打包包内图标路由断言 200 + 断言 seed 文件行 `<img src*="/sidebar/icons/">` 存在于 DOM。