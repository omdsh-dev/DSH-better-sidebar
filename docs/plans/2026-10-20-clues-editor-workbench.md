# 线索工作台第八轮：编辑器式整体 UIUX

## 目标与方向

用户要求整体更现代、美观，可参考 Codex Desktop、VS Code、Zed。本轮不重做上一轮已经确定的业务流程，而是把界面收敛为一套克制的编辑器工作台语言：安静的工具栏、紧凑的集合目录、内容优先的资源列表、稳定的底部收集区。

保留上小下大的融合布局、直接可见的完整来源名称、直接范围选择、显式写入确认和无高亮条。所有表面／文字／交互颜色继续使用 DSH 令牌，不引入 shadcn/Tailwind 或新的 UI 依赖，不修改 DSH 源码。

设计参考入口：[Codex app](https://openai.com/index/introducing-the-codex-app/)、[VS Code Views UX](https://code.visualstudio.com/api/ux-guidelines/views)、[Zed Appearance](https://zed.dev/docs/visual-customization)。参考其产品方向，不声称逐像素复制。当前环境网页正文抓取受限；具体实现依据本仓库契约与真实宿主截图。

## 连贯改造

1. **表面层级**：工作台顶部与包目录使用浅一层的中性 chrome，资源内容使用基础表面；用 hairline 和排版区分区域，不用卡片堆叠、渐变或装饰色条。
2. **紧凑包目录**：包行加入统一集合 glyph，减少行内留白；分页回到标题工具栏，不再独占整行。包名仍管理，独立 @ 仍只插入草稿。
3. **来源工具带**：完整名称按内容宽度自然换行，不再以等宽大块网格占据浏览空间；选中以轻量中性填充区分，键盘焦点独立可辨。
4. **命令式查找**：统一搜索、提交与清除的高度和边界，范围摘要作为轻量路径栏；不添加未实现的快捷键提示。
5. **编辑器式列表**：桌面行高以 32–36px 为基准，主标题优先，次要动作降低视觉重量但保持可见；触控目标仍至少 44px，不以桌面密度牺牲触控。
6. **统一收集区**：返回、目标标题、已选数量合并为同一标题行，把空间还给可搜索目标列表；确认始终独立于滚动内容，状态与错误不得把确认挤出容器。

## 验收

- 上区仍小于下区，来源五项在 320／390／640 栏宽均完整可达，无来源下拉、无横向溢出。
- 来源导航在搜索之前；来源往返查询／分页／范围草稿、筛选目标保留和显式确认语义保持。
- 真实宿主比较上一轮与本轮的包区高度、首条结果位置、结果可用高度；检查明暗主题、目标列表、手机及触控分享窗。
- 更新组件／样式／主题回归；类型检查、定向 lint、构建打包后使用精确 DSH 0.2.1-rc.1 隔离挂载。

## 验证过程与源头修复

- 第一轮真实挂载 1 failed／1 passed：320px 下结果区 408px，低于预设的 48%（413.76px）。截图发现目录工具栏换成两行、固定分页中的数量限制提示被挤成三行。已收紧目录工具按钮（触控仍 44px），限制提示回到结果末端；没有降低密度阈值。
- 内部审查额外发现并修复：翻页切 loading 会卸载获焦按钮；合法 200 字目标包名可撑高 footer 并裁切确认；触控批量按钮的高优先级 32px 规则覆盖 44px。分别以持久分页节点＋事件守护 aria-disabled、长名称有界显示、显式触控选择器覆盖修复，补充 deferred 焦点回归与真实几何检查。
- 第二轮真实挂载通过六组密度／主题和键盘／触控检查，但新增 Pin 流程失败。trace 确认 `pins.list` revision 18 → `ensure` 推进到 19 → 复用 18 的 `pins.add` 返回 409。客户端现于显式操作的 ensure 之后读取最新 revision，再提交 CAS；没有跳过校验或自动重试。另以本地库的来源／类型／locator 关联候选，修复来源列表不携带 clueId 时无法显示 Unpin 的问题。保持原真实按钮验收，不改成 API 预置来绕过。

## 最终验证

- 最终 `pnpm typecheck`、定向 ESLint、`pnpm build && pnpm pack` 通过。
- **10 文件／196 项定向回归通过**：工作台 47、包／分享窗口 40、主题 21、布局 CSS 8、设置配置 45、设置来源 19、设置布局 5、设置语言 3、线索文案 5、客户端集成 3。与历史轮次的文件选取不同，数字不累加；未重跑完整仓库测试。
- 精确 **DSH 0.2.1-rc.1** 隔离 profile 定向挂载 **2 passed（10.3s）**，最终报告无失败、跳过或 flaky。覆盖完整来源导航、范围单选与来源草稿恢复、独立滚动／固定分页、真实键盘往返翻页、真实 Pin／Unpin、目标筛选／显式创建、200 字目标包名、触控批量按钮、帮助／包管理／分享及 320×240 最小分享窗。
- 最终截图核对 390px 明暗主题、收集区、长名称、置顶、手机视口和触控操作区；无高亮条，操作入口未改为 hover-only。较短视口保留整体滚动兜底，不宣称所有尺寸均完全无滚动。
- [机器验证摘要及构建／截图 SHA-256](assets/clues-editor-workbench/verification.json)、[六组布局实测](assets/clues-editor-workbench/clues-layout-metrics.json) 均来自本轮最终产物。

### 正常桌面栏高 862px 的实测

明暗主题结果相同；表中首条位置为该行底边相对 Tab 顶部，不是浏览器绝对坐标。

| 栏宽 | 上方包目录 | 结果滚动区 | 结果占 Tab | 来源工具带 | 首条结果底边 |
| --- | --- | --- | --- | --- | --- |
| 320px | 161px | 445px | 51.6% | 88px | 417px |
| 390px | 161px | 475px | 55.1% | 58px | 387px |
| 640px | 145px | 521px | 60.4% | 28px | 341px |

桌面资源行均为 36px；包目录占 Tab 的 16.8%–18.7%。完整来源在窄栏自然换行，不用隐藏名称或横向滚动换空间。

## 最终实际截图

共归档 24 张；以下均为最终打包产物在真实隔离宿主中的渲染，不是设计稿。

- [390px 浅色工作台](assets/clues-editor-workbench/clues-integrated-light-390.png)／[390px 深色工作台](assets/clues-editor-workbench/clues-integrated-dark-390.png)。
- [320px 深色工作台](assets/clues-editor-workbench/clues-integrated-dark-320.png)／[640px 工作台](assets/clues-editor-workbench/clues-integrated-light-640.png)。
- [收集目标与固定确认区](assets/clues-editor-workbench/clues-selection-light-390.png)／[200 字目标包名](assets/clues-editor-workbench/clues-destination-long-name-320.png)。
- [置顶内容受控滚动](assets/clues-editor-workbench/clues-pinned-390.png)／[手机视口](assets/clues-editor-workbench/clues-selection-mobile.png)。
- [触控空包目录](assets/clues-editor-workbench/clues-empty-packs-touch.png)／[44px 触控批量按钮](assets/clues-editor-workbench/clues-selection-actions-touch.png)／[最小触控分享窗](assets/clues-editor-workbench/clues-share-touch-320x240.png)。
- [GitHub 范围](assets/clues-editor-workbench/clues-source-github-390.png)／[飞书范围](assets/clues-editor-workbench/clues-source-feishu-390.png)／[完整 DSH 宿主](assets/clues-editor-workbench/clues-integrated-shell-dark.png)。

## 交付边界

当前 GUI 未安装本轮改动；仍在 `feat/clues-uiux-refresh`，未提交、合入共享分支或发布。隔离 profile 使用本地 fixture，不代表真实 GitHub／飞书账号、lark-cli 安装与授权或远端写入已验证。keyless 宿主会话可能显示 `MISSING_CREDENTIAL`，不是插件加载失败。未运行完整挂载 lane，也不修改 DSH 源码、公共后端 API、依赖或轮询机制。
