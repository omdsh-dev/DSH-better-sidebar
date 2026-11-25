# 线索工作台第七轮：可见导航与直接选择

2026-10-19。用户明确指出需要更彻底的 UX 重构，尤其来源／类型不应藏在下拉框里。本轮保留上小下大的融合布局及无高亮条约束，重构来源、范围与收集目标三个高频选择点。

## 交互

1. **先看见来源，再搜索**：本地文件、飞书文档／任务、GitHub Issues／Pull requests 以图标加完整名称直接展示。窄栏自动换行，不依赖下拉或横向滚动发现其他来源。主工作台与包内添加成员页共用导航。
2. **切回来源继续工作**：主工作台按来源保留未提交输入、已提交查询、分页与未保存范围草稿。恢复输入不等于提交输入；实际请求仍使用上次已提交查询。每个 Tab 最多保留 20 个来源草稿，范围在其他入口修改后旧游标和过时范围草稿失效。
3. **直接选择范围类型**：GitHub Open／Closed／All、飞书文件夹／知识库等范围类型均直接单选。必需范围缺失时自动展开表单，不再先点击一个提示才能开始填写。资源 URL／路径仍独立解析，不被浏览范围阻塞。
4. **看见收集去向**：目标包改为可搜索单选列表，显示名称和成员数；新建包在同一列表中。筛选不会清掉目标，确认区持续显示所选包名。选择本身不写入，仍由显式按钮确认；打开聚焦包搜索，返回恢复触发按钮。

源文件：[资源浏览器](../../src/client/clues/tab/browser.tsx)、[共享导航／范围字段](../../src/client/clues/tab/browser-shared.tsx)、[包内添加成员页](../../src/client/clues/windows/pack.tsx)、[样式](../../src/client/clues/tab/clues-tab.module.css)。不修改 DSH 源码，不引入新依赖、全来源后台扫描、轮询或全局缓存。

## 验证状态

- 工作台 41 项、包／分享窗口 40 项、其他 8 文件 126 项，合计 **207 项定向回归通过**（分组运行）。新增覆盖来源往返查询／游标隔离、未提交输入恢复、外部范围变更失效、范围草稿保留、可见导航、范围单选及目标筛选不丢失选择。
- 最终 `pnpm typecheck`、定向 ESLint、`pnpm build && pnpm pack` 已通过；固定确认区后的 CSS／主题 26 项复验通过（已包含在上述 207 项中，不重复计数）。
- 最终真实宿主定向挂载 **2 passed（9.8s）**，无失败、跳过或重试；使用精确 DSH `0.2.1-rc.1`，命令为 `KEEP_HOME=1 npm_config_cache="$PWD/.npm-cache-tmp" NODE_OPTIONS=--max-old-space-size=4096 DSH_CMD='npx -y --package @deepseek-ai/dsh@0.2.1-rc.1 dsh' pnpm test:mount --grep clues`。2026-10-20 完成截图核验与归档；[机器验证摘要及截图 SHA-256](assets/clues-visible-navigation/verification.json) 来自最终 Playwright HTML 报告及落盘结果，不沿用前一轮数据。
- 覆盖 320／390／640 栏宽与明暗主题、390×844 手机视口、320×240 触控分享窗、来源往返查询／未保存范围恢复、目标筛选不丢选择、打开／返回焦点、确认前无写入、新包准确包含选中成员及包区刷新，并保留帮助、包管理和分享检查。
- 目标包列表现独立收缩和滚动，标题／搜索／确认不参与列表滚动；320／390／640 两主题均通过真实几何断言，确认按钮完整位于收集区内，不能用仅存在于 DOM 的可见性检查代替。较短手机视口仍允许整体滚动使操作可达，不宣称其整个页面无滚动。
- 第一轮宿主验证暴露测试几何问题：测试强制覆盖右栏 CSS 宽度，却没有同步宿主拖动手柄位置，导致 Feishu radio 点击被旧位置的手柄拦截。测试现改为使用真实鼠标拖动调整宿主栏宽，再独立覆盖组件的 320／390／640 宽度，没有 force-click、隐藏手柄或改宿主源码绕过检查。

## 最终实际截图

以下为最终打包产物在隔离宿主中的截图，共归档 20 张；不是设计稿，也不代表当前 GUI 已安装。

- [390px 浅色完整工作台](assets/clues-visible-navigation/clues-integrated-light-390.png)：上小下大、完整来源导航位于搜索之前。
- [320px 深色工作台](assets/clues-visible-navigation/clues-integrated-dark-320.png)：来源换行展示，不隐藏在下拉或横向滚动中。
- [GitHub 状态直接单选](assets/clues-visible-navigation/clues-source-github-390.png)／[飞书范围直接单选](assets/clues-visible-navigation/clues-source-feishu-390.png)。
- [390px 目标包列表与完整确认区](assets/clues-visible-navigation/clues-selection-light-390.png)／[320px 深色确认区](assets/clues-visible-navigation/clues-selection-dark-320.png)。
- [手机视口](assets/clues-visible-navigation/clues-selection-mobile.png)／[最小触控分享窗](assets/clues-visible-navigation/clues-share-touch-320x240.png)。
- [完整 DSH 宿主](assets/clues-visible-navigation/clues-integrated-shell-dark.png)。keyless 会话可能显示宿主的 `MISSING_CREDENTIAL`，不表示插件加载失败。

## 边界

仍在 `feat/clues-uiux-refresh`，未提交、合入共享分支、发布或安装到当前 GUI。真实宿主使用精确 DSH 0.2.1-rc.1、隔离 profile 和本地 fixture。GitHub／飞书的导航与范围表单不等于账号／远端读写验证；没有真实第三方账号授权、安装或远端写入。
