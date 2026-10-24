# 页签等宽（Chrome 式条带几何）

- 日期：2026-10-24
- 触发：用户反馈（`DSH-better-sidebar` v0.28.0）——「每一个 tab 的宽度似乎都是不同的，非常不利于操作。例如用户希望连续关闭一些 tab，就要每个 tab 都手动寻找关闭按钮在哪里。Chrome 浏览器的 tab 宽度都是一样的，而且会根据总打开的标签页数量自动变化。」

## 1. 改动前的事实

底部工作台的条带（`TabBar` + `sidebar.module.css`）里，`.tab` 是**内容宽**：

```css
.tab { flex: none; max-width: 160px; min-width: 64px; }
```

`flex: none` 意味着宽度由标题长度决定，`max-width` 只做「长标题封顶、省略号截断」。真实 Chromium 实测（条带 380px，4 个页签，标题分别为 `README.md` / `AGENTS.md` / `sidebar.module.css` / `TabBar.tsx`）：宽度 `[128.3, 126.4, 159.7, 113]`，关闭按钮的横坐标 `[122, 249, 408, 521]`——**每个 × 都在不同位置**，第 4 个甚至已经滚出视口。用户要连关几个页签，就得每次重新找 ×，这正是反馈里的痛点。

同一反馈里提到的「右键关闭其他 / 关闭右侧」**不是缺失功能**：标签页右键菜单（关闭 / 关闭其他 / 关闭左侧 / 关闭右侧 / 关闭全部 / 在资源管理器中定位）自 v0.15.x 起就在（提交 `d3c0f22`），v0.28.0 的产物里六个条目齐全（`tests/tab-bar-context-menu.spec.tsx` 13 例守护）。本次不动它，只修宽度。

## 2. 决定：`flex-basis: 0` 的等分，纯 CSS

```css
.tab { flex: 1 1 0; min-width: 64px; max-width: 160px; }
```

`flex-basis: 0` 让每个页签「先声明自己不需要宽度」，再把剩余空间**按份均分**（grow 1 / shrink 1）。于是 n 个页签同时渲染成同一个宽度，而宽度只由条带可用宽决定：

```
渲染宽度(外框) = clamp(64 + 15, 可用宽度 / n, 160 + 15)
                 其中 15 = 左右内边距 14 + 右边框 1（box-sizing: content-box）
```

- **等宽**：同一行内所有页签宽度完全一致（实测 40 组，极差 ≤ 0.02px）。
- **随数量变化**：n 变了、条带拖宽了，浏览器自己重算，插件没有任何 JS、没有测量、没有状态。
- **到下限就滚动**：`min-width` 把页签挡在 64px 内容宽（外框 79px），更窄的情况由 `.tabList` 的 `overflow-x: auto` 接管——不把 label 压成 0、也不把 × 挤出页签。
- **到上限就留白**：`max-width` 160 内容宽（外框 175px），页签少时条带右侧留空，和 Chrome 一致。

这是**纯样式改动**：DOM、`TabBar` 的交互（拖拽 / 中键关闭 / 右键菜单 / 滚轮横向滚动）、`TAB_MAX_WIDTH` 常量、接入 API 全部不变。

## 3. 实测（真实 Chromium，本仓库 `sidebar.module.css` 的规则原样抽取）

条带 380px（≈ 窄态右栏；其中 40px 由 `.bottomPanel .tabBar` 的 `padding-right` 留给面板控件，34px 是 `+` 按钮）：

| 页签数 | 每签外框 | 每签内容 | label 可用宽 | 行为 |
|---|---|---|---|---|
| 1 | 175 | 160（上限） | 118 | 右侧留白 |
| 2 | 153 | 138 | 96 | |
| 3 | 102 | 87 | 45 | |
| 4 | 79（下限） | 64 | 22 | 4×79+34 = 350 > 340 → 开始横向滚动 |
| 6 | 79 | 64 | 22 | 全部等宽，超出部分滚出视口 |

5 种条带宽度（260 / 320 / 380 / 460 / 640）× 8 种页签数（1/2/3/4/5/6/8/12）= **40 组**：组内极差全部 0（最大 0.02px），且 40 组全部等于上面那条闭环公式。关闭按钮的横坐标：改前 `[122, 249, 408, 521]`，改后 `[147, 300]`（2 个）/ `[96, 198, 300]`（3 个）/ `[73, 152, 231, 310, …]`（6 个）——等距。

## 4. 权衡与刻意不做

- **保留下限 64px（外框 79px）**：它是「图标 + × + 几个字」的最小可用宽。代价是窄条带下第 4 个页签起 label 只剩 2–3 字（改前三四个页签是 100–160px、5–7 字但**宽度不等**）。想把 label 拉回来的两个旋钮都留作后续决定，本次不同批改：① 下限抬到 ~88px（label 4–5 字，但可见页签少一个）；② 压缩固定开销（左内边距 10、图标 16、两处 gap 4、× 18 = 58px，占 79px 下限的 73%）。
- **不做设置开关**：等宽是 Chrome 的默认心智，用户已经用「不利于操作」描述现状；先给一个默认正确的行为，而不是再加一个偏好项。
- **不做「hover 才显示 ×」**：那会让「连关几个」多一次 hover，与本次要解决的痛点相反。
- **不按内容宽回落**（例如「只有一两个页签时用内容宽」）：那会让宽度的来源重新变得不可预测，回到原点。

## 5. 门禁

- `tests/tab-strip-equal-width.spec.ts`（新增）：jsdom 不做 flex 布局，所以钉的是**产生几何的声明**——`.tab` 必须是 grow 1 / shrink 1 / basis 0、不得声明 `width`、`max-width` 必须等于 `TAB_MAX_WIDTH`、`min-width` 必须为正且小于上限；同时钉住 `.tabList` 仍是 `overflow-x: auto` 的滚动容器（下限以下靠它）与 `.tabTitle` 的省略号三件套（等宽让截断成为常态，省略号变成承重件）。把 `flex: 1 1 0` 退回 `flex: none` 这条用例当场红。
- 真实浏览器量测：见 §3（一次性验证，不进 CI 套件——CI 里没有稳定的 Chromium 量测位置，且 flex 几何由 `tests/tab-strip-equal-width.spec.ts` 的声明契约守）。

## 6. 第二排：宿主原生条（dockkit chip）

右上角那排页签不是这个插件画的——它由宿主的 docking kit 渲染，插件只往 chip 里塞标题内容（`sidebar.right.pane.tab.title` 槽）。chip 的宽度是宿主 CSS 的（`.tab { flex: 0 1 auto; min-width: 80px; max-width: 170px }`），**宿主没有给插件任何"设置 chip 几何"的 API**。

按 `make-dsh-plugin` 的口径（06 §7「不要锚官方 CSS Module 的哈希类名；给视图挂稳定 `data-*` 属性定位」＋ 四条铁律「能复用官方控件就复用，不抄第二份」），这里采用**最小面的宿主 DOM 调整**：三条声明，只锚宿主自己机器可读的语义属性，限定作用域，失效即静默回退。

```css
/* src/client/layout.css */
[data-sidebar-right-panel] [data-dockkit-strip-tabs] { flex: 1 1 0; }
[data-sidebar-right-panel] [data-dockkit-strip-fill] { flex: 0 0 0; }
[data-sidebar-right-panel] [data-dockkit-tab] { flex: 1 1 0; }
```

三条各自都是必需的：

1. `strip-tabs` 必须是 `1 1 0`——它原本是 `flex: 0 1 auto`（内容宽），单改 chip 只会在"内容宽的行"内部等分，页签簇不会去吃条带余量（实测 2 个页签时停在 115.2 而不是 190）。
2. `strip-fill` 必须让位——它原本也是 `flex: 1 1 0`，会和 `strip-tabs` **对半分**剩余空间（实测 4 个页签只剩 146.5 的一半宽度、页签簇偏在左半边）。
3. chip 本身 `1 1 0`——等分；宿主自己的 `min-width: 80 / max-width: 170` 原样保留，所以下限以下仍然横向滚动，上限仍然 170。

**作用域是契约的一半**：浮动窗的浮层头复用同一批类（`.tab.floatTitle`、`.stripFill`），但它们没有 `data-dockkit-tab` / `data-dockkit-strip-tabs`。规则**永不点类名**，所以浮层头碰不到——实测浮层头标题宽度在加规则前后都是 100px。

**实测**（真实 Chromium，宿主 `dockkit.module.css` 的规则原样抽取 + 上面三条）：

| 条带 | 改前（4 个页签） | 改后（4 个页签） |
|---|---|---|
| 700px | `[100, 116.3, 150.3, 100]`（极差 50.3） | `146.5 × 4`（极差 0） |

4 种条带宽度（380 / 460 / 560 / 700）× 6 种页签数 = **24 组全部等宽**；上限/下限照旧：1 个 190（170 + padding），700px 下 6 个 → 100 + 横向滚动。**与样式表顺序无关**：两条属性的选择器（0,2,0）压过宿主的单类（0,1,0），插件 CSS 先注入还是后注入都是 146.5。

**已知边界（刻意接受）**：这是版本敏感的耦合——宿主哪天改名 `data-dockkit-*` 或换掉条带布局模型，三条规则**静默失效**，chip 退回宿主自己的内容宽：不报错、不破版式、不留死 UI。`tests/native-tab-strip-width.spec.ts` 钉的是「声明 + 作用域 + 不点类名 + 不用 `!important`」，也就是**我们绝不越界**这条不变量，而不是「永远等宽」。

## 7. 原生条右键菜单：关闭其他 / 左侧 / 右侧 / 全部

宿主 kit 的页签菜单只有自带的「关闭」，没有邻居关闭。这四项通过宿主的**公开槽** `sidebar.right.tab.menu.item` 贡献（list slot，owner 只有 `{ tab, dismiss }`），kit 自己的「关闭」保留、我们的行排在它后面，行内自己调 `dismiss()`（菜单是 kit 的，只对自家动作自动关闭）。

**缺口与补法**：槽不给 pane、也不给条带顺序——`TabRecord` 是 `{ id, kind, contentId, title }`，`tabsIn()` 是 `Object.values(layout.tabs)`（记录顺序）。而"关闭邻居"只有相对**同一条带**才有意义，所以顺序从 kit 自己的 chip 读：`[data-dockkit-tab]` ⊂ `[data-dockkit-strip-tabs]`——与等宽规则同一批稳定语义属性，**不点类名**。分屏是两个 strip，所以用被点 chip 的 `closest()` 定位它自己那条带，而不是页面里第一个 strip。

**失效模式**：解析不到条带（宿主改名、chip 不在条带里）→ **一行都不渲染**。kit 自己的「关闭」还在，菜单不会出现死行；也**不猜作用域**（会话级「关闭其他」会误关另一栏的页签）。

**关闭动作走宿主公开面**：`sidebarRight.close(tabId)`。它对不可关闭的页签（唯一的 docked guide）是 no-op——`closeIn` 里有 `canCloseTab` 守卫——所以「关闭全部」不会把栏关空，不需要插件自己判断。

**可读性**（后来补的）：四行都以「关闭 / Close」开头，用户必须逐行读到中段才分得出——所以每行加了一颗**前置图形**（⊗ 其他 / ‹ 左 / › 右 / ×× 全部；前 3 颗取自宿主图标集，「全部」用双叉自绘——垃圾桶会读成「删除」，而关页签不删任何东西；14px、随禁用态变淡），并用细分隔线与 kit 自带的「关闭」分组；英文文案缩短成 `Close others / Close left / Close right / Close all`，中文去掉「页签」后缀。图形给作用域、文字做确认，换语言也不失效（词序不影响图形）。

**样式**：这些行渲染在 kit 的 `<div role="menu">` 里，所以量度复刻 kit 自己的 `.menuItem`（`padding: 4px 7px`、`13px - 1px`、`--dsw-radius-md`、hover 用 `--dsw-alias-interactive-bg-hover`），颜色全走令牌；没有可复用的官方导出件（kit 的菜单项没有导出）。禁用态保留行本身（只置灰），避免不同页签的菜单项数/高度跳变。

**测试**：`tests/native-tab-menu.spec.tsx` 7 例——四项顺序与文案、切片（其他/左/右/全部）、`dismiss` 先于关闭、单页签时前三项禁用而「全部」可用、双 pane 只动被点那条带、解析失败一行不渲染、`stripOrderOf` 纯函数。

## 8. 真机挂载验证（独立实例）抓到的两件事

按 skill 纪律 11 起了独立实例（新 `DSH_HOME` + `--port 0` + `dsh plugin add <tarball>`）之后，两件事只有真挂载才暴露：

1. **`list` 槽必须给 `options.id`**：`ctx.slots.register({ name: 'sidebar.right.tab.menu.item' })` 在真实 registry 上抛 `list slot "…" requires options.id`（keyed 槽要 `key`、list 槽要 `id`、chain 槽要 `select`）。假 ctx 只镜像了 `name`，所以 6 个单测全绿也照样炸；修复是补 `id: 'dsh-better-sidebar:close-family'`，并把假 ctx **升级成会拒绝无 id 的 list 注册**（`tests/native-registration.spec.ts` 新增一条「注册确实带 id」的正向断言）。
2. **`layout.css` 的 `@media (prefers-reduced-motion: reduce)` 块从未闭合**（v0.26.0 起）：后续所有规则都落在这个 media 块里，普通浏览器不生效。真机里 `getComputedStyle(chip).flex` 仍是 `0 1 auto`、页面里却有我们的 `<style>`，就是这条的指纹。补上 `}` 后同一次量测变成 `1 1 0px`、两个 chip 各 190px（上限）、极差 0；并加了块结构门禁（见 CHANGELOG）。

真机复测（1440×900 视口，右栏宽 675px，2 个页签）：`chipFlex = 1 1 0px`、两签各 190px、右键菜单 = 宿主的 Close + 我们的 Close Other Tabs / Close Tabs to the Left / Close Tabs to the Right（末位签时禁用）/ Close All Tabs，控制台零报错。

## 9. 关闭时不立刻重排：指针还在条带里就冻结宽度

**问题**：等宽之后，每关一个页签存活的页签都会变宽——鼠标还停在原地，下一个 × 已经挪走了。于是「连关几个」变成每关一次重新找 ×。Chrome 的做法是：**只要指针还在标签条上，宽度就不变**，指针离开时才重排。

**两排都要**（同一份体验），但机制不同：

- **插件自己的条（底部工作台，`TabBar`）**：React 内的状态。关闭手势（×、中键、右键菜单的行）先把当前签宽量下来（`contentWidthOf`：border box 减去 padding/border，因为 content-box 的 `flex-basis` 是内容宽），给条带挂 `data-frozen` + `--dsh-tab-frozen-width`；`onPointerLeave` 清掉。CSS 一条 `.tabBar[data-frozen] .tab { flex: 0 0 var(--dsh-tab-frozen-width) }`。
- **宿主原生条**：没有 React 树可用，而且**宿主在关闭时会重建条带的 DOM**（真机实测：`[data-dockkit-strip]` 节点被整个换掉，所以挂在条带元素上的属性/观察者全部失效——第一版就是死在这）。最终做法是把冻结状态放在 **`<html>`** 上：
  - **触发用「关闭手势」而不是「DOM 变化」**：`pointerdown` 落在宿主自己的关闭控件 `[data-dockkit-tab-close]`（或中键按在 chip 上）时，立刻量宽并把 `data-dsh-tabs-frozen` + `--dsh-tab-frozen-width` 写到根上——量的是**关闭前**的宽度，正是需要的那个值；换 DOM 也不影响。
  - **释放按「指针是否还在那条带上」**：`pointerout` 的 relatedTarget 在带内 → 不动；不在 → 下一个 task 用 `elementFromPoint` 复核（关掉被 hover 的那个 chip 时浏览器会发 `relatedTarget: null` 的 `pointerout`，不能当成「离开」）；`pointerover` 落到带外也释放。
  - CSS：`html[data-dsh-tabs-frozen] [data-sidebar-right-panel] [data-dockkit-tab] { flex: 0 0 var(--dsh-tab-frozen-width) }`。

**真机实测**（1440×900，右栏 675px）：4 个页签各 115.3 → 关掉一个（指针停在条带里）**仍是 115.3**（`pin: true`、`--dsh-tab-frozen-width: 95.25px`）→ 再关一个**仍是 115.3** → 指针移出条带后才变成 **190**（三个变两个、回到 170 上限）。全程零控制台错误。

**只对关闭生效**：新建页签、拖动、点选页签都不冻结（没有关闭手势就不挂 pin），所以「打开文件时收窄」仍然是即时的。

**测试**：`tests/native-strip-freeze.spec.ts`（10 例：手势 pin/中键/普通按下不 pin/宿主重建 DOM 后仍有效/显式离开/停在空尾不释放/`relatedTarget: null` 的歧义两种结果/条带被移除/未知 DOM 不动）；`tests/tab-bar-freeze.spec.tsx`（5 例：× 冻结、带外点击不冻结、连关保持同值、中键冻结、离开释放）。
