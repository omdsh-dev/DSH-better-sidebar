# 移除 titleBar 让位机制（位置兼容模式四方案 / strip 取值链 / 壳预设）

日期：2026-10-05　分支：`chore/430-drop-titlebar-strip`

关联 issue：[#430](https://github.com/omdsh-dev/DSH-better-sidebar/issues/430)（`ctx.desktopWindow` 几何优先读取，已随本机制一并移除）、[#864](https://github.com/omdsh-dev/DSH-better-sidebar/issues/864)（同一契约的第二处症状：壳已把页面放到自己的 frame 之下，插件又让位一次）、[#257](https://github.com/omdsh-dev/DSH-better-sidebar/issues/257)（WCO 几何让位，机制的第一来源）

## 结论

**整套删除**，不留兼容层。删除前先做了完整消费者普查（见下）：这套机制在插件内部**没有任何消费者**，唯一效果是「改设置 → 写变量 → 没人读 → 什么都不动」，而设置项的描述（「标题栏条带高度：侧边栏按钮与内容下移的像素数」）与现实不符。

## 机制原貌（v0.14.1 引入）

- 偏好：`SidebarPrefs.titleBarScheme`（`auto` / `web` / `preset` / `custom`）+ `titleBarPresetId` + ~~`titleBarCompat`~~ / ~~`titleBarStripPx`~~（后两个自四方案模型起只做读迁移与降级镜像）。
- 唯一决策点：`src/client/titlebar-strip.ts` 的纯函数 `computeTitleBarStrip`，取值链 ⓪ `web` 强制 0 → ① 壳自带 `ctx.desktopWindow.safeAreaInsets.top`（#864 插入）→ ② `navigator.windowControlsOverlay` 真实几何（`wco.ts`）→ ③ URL `dsh-desktop-titlebar-inset` → ④ 壳预设 `stripFor`（`shell-presets.ts`）→ ⑤ 手动 px → ⑥ 0。
- 输出：`src/client/Sidebar.tsx` 的 `useEffect` 写 `body[data-dsh-title-bar-compat]` + `document.documentElement.style['--dsh-title-bar-strip']`。
- 设置界面：常规行的方案下拉 + 「自定义方案」齿轮弹窗（下移距离 + 自定义 CSS）。

## 为什么删（证据）

1. **没有消费者**：`223b254`（v0.19.0「顶部自绘 chrome 交还宿主」，`git tag --contains 223b254` 首现 v0.19.0）把那三条读 strip 的规则（`top: calc(var(--dsh-title-bar-strip, 40px) + 3px)` / 右面板 `padding-top: var(--dsh-title-bar-strip, 40px)` / 折叠态 `+14px`）连同自绘 chrome 一起删掉了。删除前全仓 grep：`src/**/*.css` 里对该变量**零命中**，只剩一条注释提到它（本次一并删除）。
2. **宿主不读这条契约**：在本机 DSH checkout（`~/.dsh/source/current`，私有快照 `7b9644f2`，54 个 `packages/*`、5786 个 `*.ts/tsx/js/css/json`）整树 grep `windowControlsOverlay|dsh-desktop-titlebar-inset|titlebarInset|title-bar-strip|title-bar-compat` **零命中**，连 `desktopWindow` 也零命中——那个客户端服务是第三方 Electron 壳（anywhere-labs/dsh-desktop）提供的，DSH 核心既不提供也不消费。用户期望被移动的「侧边栏按钮」是**宿主原生**右侧栏控件，插件没有它的位置 API。
3. **#430 / #864 的症状本身**就是「两套几何来源互相打架」：壳提供了 `ctx.desktopWindow`（权威）时插件还得手动降级到 URL 戳记，而两条路的差值就是「多让位 36px」。把让位机制整体去掉后这类症状在结构上不可能再出现。

## 消费者普查与去留

| 符号 / 文件 | 引用方（删除前） | 处置 |
| --- | --- | --- |
| `computeTitleBarStrip` / `src/client/titlebar-strip.ts` | `Sidebar.tsx`（唯一）、`tests/titlebar-strip.spec.ts` | **删除**（文件 + spec） |
| `shell-presets.ts`（`getShellPreset(s)` / `presetStripFor` / `ShellPreset`） | `Sidebar.tsx`、`SideCardSection.tsx`、`titlebar-strip.ts`、`tests/shell-presets.spec.ts` | **删除**（文件 + spec）：全部消费者都在本机制内 |
| `wco.ts`（`getWcoSnapshot` / `subscribeWco` / `setWcoSourceForTests`） | `Sidebar.tsx`、`titlebar-strip.ts`、`tests/wco.spec.ts` | **删除**（文件 + spec）：取值链 ②，机制外零消费者 |
| `parseDesktopEnv` / `DesktopEnv` / `DesktopMode` / `probeDesktopWindow` / `resetDesktopEnvForTests`（`desktop-env.ts`） | `Sidebar.tsx`、`SideCardSection.tsx`（预设「已检测」徽标）、上述 spec | **删除这些导出**；**文件保留**——同文件的 `hostTransportBase()` 另有 3 个消费者（`host-route-url.ts`、`TextEditor.tsx`、`changes/DiffPane.tsx`），是反向代理前缀与 `dsh-app://` 自定义 scheme 的解析基准，与本机制无关 |
| `SidebarDesktopWindowService` / `…Insets` / `…DragRegion`（`context-types.ts`） | `desktop-env.ts` 的 `probeDesktopWindow`、`titlebar-strip.ts`、`tests/{titlebar-strip,desktop-window-strip,desktop-env}` | **删除**三个接口（只服务这条链） |
| `titleBarScheme` / `titleBarPresetId` / `titleBarCompat` / `titleBarStripPx`（`prefs-shared.ts` + `config.ts` + `client/prefs.ts`） | 设置界面、Sidebar、e2e | **删除**（含 `TITLE_BAR_STRIP_{MIN,MAX,DEFAULT}`、`TITLE_BAR_SCHEMES`、`TitleBarScheme`、`clampTitleBarStrip` 与 `prefs.ts` 的读迁移） |
| `customCss`（自定义 CSS 注入） | `Sidebar.tsx` 的注入 effect、设置界面 | **保留**（逃生口）：去掉 scheme 门控，**非空即生效**；设置界面从「自定义方案」弹窗搬到独立的「自定义 CSS」分组 |
| `rowGear` 样式 | 只被那条方案行使用 | **删除**（`SideCardSection.module.css` 的规则 + focus-visible + reduced-motion 条目） |
| 词典 key ×12（`settingsTitleBar*` / `settingsScheme*` / `presetDshDesktopDesc`） | 只服务这些设置 | **删除**（21 份词典同步：`locales.ts` 的 zh + en，19 个 `locales-*.ts`）；`settingsCustomCss*` 保留，示例文案改为 `[data-dsh-bottom-panel]` + `--dsw-font-mono`（不再引用已删变量） |

## 迁移安全

已保存的偏好里仍可能有这四个键（read-migration / 降级镜像写过它们）：

- **宿主 schema 是 OPEN 的**（`PrefsSchema` / `Config`），未知键原样解析、不报错、不写回（`tests/plugin-shape.spec.ts` 钉住「带已删 key 的载荷仍能解析，且同文档的其余字段照常解析」）；
- **客户端 `parsePrefs` 只按声明字段构造结果**，四个键在类型层就被丢弃、永不进入 UI（`tests/prefs.spec.ts` 的 `IGNORES the retired title-bar keys`）；
- **一次性 legacy `settings.yaml` 回迁**按 `Config.dict` 的声明字段过滤，已删的键被丢弃而不是转发（转发未知键会整份 patch 被拒 → 丢光该节偏好）：`tests/smoke.spec.ts` 的迁移用例现在就用 `titleBarStripPx` / `titleBarScheme` 当「已删键」样本。

## 影响面

- 设置页不再出现「位置兼容模式」行与下移距离；`customCss` 仍有独立入口（只写 CSS，不再需要先选「自定义方案」）。
- 插件的顶部行为不变：**本来就没有任何自绘 chrome**，删掉的只是一条没人读的写路径。
- 消费插件：不要再引用这四个偏好键，也不要写 `--dsh-title-bar-strip` / `body[data-dsh-title-bar-compat]`（无人消费）；指南 §12.1 已记这条。
- **不受影响**：自定义 CSS 注入、皮肤契约其余部分（颜色令牌）、底部工作台开关（走宿主 `conversation.session.header.utilities` 槽，文档流内定位）、拖拽区退出（`-webkit-app-region`，#103/#111/#772）。
