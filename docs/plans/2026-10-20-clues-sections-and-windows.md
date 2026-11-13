# 线索工作台第十轮：横栏折叠、连续滚动与任务浮窗

## 用户要求

用户提供 VS Code「大纲／时间线」的箭头横栏截图，并明确要求：充分使用已有浮窗；纵向滚动与懒加载替代点击翻页；改进丑陋的文本 @ 图标；横栏展开机制做成可复用实现，供后续所有 Tab 改造。

本轮优先于[第九轮](2026-10-20-clues-native-color.md)中仍存在的分页与内联收集形式。保留其原生多彩图标、紧凑上下布局、完整来源可见和无高亮条；不修改 DSH 源码，不引入 UI 依赖。

## 设计与实现

- **通用横栏**：新增 `WorkbenchSection`（插件全局 UI 目录），左侧真实右／下箭头，标题、计数、独立工具动作。标题按钮与动作是兄弟节点，操作不会误触折叠。原生 button 支持 Enter／Space，`aria-expanded` 与 `aria-controls` 对应同一保活 body。折叠仅 hidden，不卸载草稿；请求是否继续由所属页面的可见性控制。本轮用在线索包、资源、置顶及浮窗选择复核区，不擅自改其他 Tab。
- **资源连续浏览**：去掉页码和 Previous／Next；尾部哨兵接近滚动视口时请求下一游标并追加，按来源／类型／locator 去重，已加载行与选中项继续存在。查询／来源／范围变化取消旧请求、重置列表；隐藏／折叠停止自动读取与观察者。续页失败保留已有行，底部 Retry 明确重试，禁止自动重试风暴；缺失下一游标停止，循环游标显式报错。包管理浮窗的添加成员页也采用相同方式。
- **包库连续显示**：已有 `packsList` 一次传输整个工作区快照，没有服务端 cursor；本轮只按滚动逐批渲染，每批 12 条。这是本地渐进显示，不宣称解决包库全量传输成本。包目录有独立滚动视口，横栏固定；折叠资源区时可把空间还给包列表。
- **范围任务窗**：来源切换仍是主栏可见导航；范围表单通过明确的「选择范围」动作打开已有窗口宿主。缺范围只显示行动入口，不自动弹窗。关闭／重开保留未应用草稿，保存才持久化并刷新资源。
- **收集任务窗**：主栏选择后只出现紧凑数量与动作条；所选资源复核、可搜索目标列表、新包名称与最终确认都移入可拖动／缩放／最大化的集合浮窗。筛选不丢目标，关窗不丢选择／输入，选择本身不写入，部分失败保留未完成项。父组件继续拥有草稿，通过 `HostedWindow` portal 交给现有窗口框架呈现，不另造 overlay。
- **新建包任务窗**：从目录工具栏显式打开紧凑窗口，工作区稳定身份重复打开只聚焦；确认前不写入；创建中阻止关闭与重复提交，失败保留名称与错误，成功先关闭再刷新目录。
- **引用图标**：所有线索条目／包／置顶／批量引用的裸文本 @ 换成宿主 `IconContextInjectionOutlineRegular`，明确尺寸，保留标签／提示和「只插入草稿、不发送」语义。
- **焦点源头修复**：真实任务窗回归发现异步完成关窗时宿主无条件恢复 opener，可能夺走外部控件焦点。现在关窗只在焦点仍属于该窗／opener 时恢复，且 opener 必须可见；用户已经转到其他控件则保持原焦点。窗口增加具体 owner 标识，不按模糊标题猜测。

## 验收标准

1. 线索包与资源都可通过箭头横栏折叠／展开；工具按钮独立；折叠保留查询／选择，停止自动读取。
2. 主页面及添加成员页无 Previous／Next／页码；真实滚动自动追加并保留旧行；无下一游标不再请求；错误可重试而不清列表。
3. 引用按钮为宿主 SVG glyph，无手写 @；单击仍只插入草稿。
4. 真实宿主完成范围窗、新建包窗、收集确认窗的开／关／草稿／确认流程，并验证窗口实际缩放与最小宽度。
5. 320／390／640 明暗主题保持来源完整、无横向溢出、有色图标与内容密度；粗指针仍至少 44px。
6. 定向回归、类型、lint、构建打包和精确 DSH 0.2.1-rc.1 隔离挂载，最终截图单独归档。

## 审查与验证过程

- 聚焦审查发现两处任务归属风险：portal owner 因工作区／会话切换卸载会丢选择／范围草稿；独立新建窗回调可能更新已卸载目录。现将任务打开状态报给工作台，窗口打开期间固定其工作区，关闭再跟随会话；真实双工作区组件回归证明相同表单节点与新包名称保留，关闭后新工作区接管。真正销毁原生 Tab 的边界仍见下方，不虚称跨销毁保活。
- 包区改为 flex 容器，使短高限制真正收缩内部滚动视口；额外加入 400px 高＋展开搜索＋滚底最后一包的完整矩形断言。两个横栏同时折叠必须相邻，避免剩余 flex 空间把它们拉开。
- 第一轮宿主挂载在缩放断言停止：测试从手柄中心拖到窗边的算法遗漏 4px 偏移，得到 324px。按实际起点修正位移，保持 320px 宽度阈值，未放宽验收。
- 第二轮通过 320px 长名任务窗，但入包数量断言发现测试目标预先包含选中资源，服务正确幂等后仍为 4 条。调整为目标种子排除所选两条，提交前先断言 ID 不在包内，提交后核对数量与实际 ID；409 模拟也等待真实失败响应后再解除，保证重试测试确实经历失败。

## 最终验证与实际效果

- 类型检查、定向 ESLint、构建与打包通过；归档时逐字节比对 16 份关键实现／样式与最终 tarball 中的源码一致，确保截图对应当前交付实现。
- **14 文件／230 项定向回归通过**：工作台 53、包／分享窗口 43、新建任务窗 6、横栏 5、滚动 hook 6、窗口 host 17、导航／焦点 17、窗口服务 3、几何 13、格式 14、浮窗 19、布局 CSS 8、主题 22、primitive 导出 4。不同轮次覆盖范围不同，不累加历史数字；未运行完整仓库测试。
- 精确 **DSH 0.2.1-rc.1** 最终隔离挂载 **2 passed（12.9s）**，无失败／flaky／跳过。主页面真实滚底由 25 行追加到 30 行，仅多一次 list 请求；前 25 行及首行 DOM、查询和滚动位置继续保留，末尾再次滚动不再请求。折叠横栏使用真实 Enter／Space，收起后两栏间距不超过 2px。
- 六组明暗／栏宽密度与实际颜色断言通过。正常 862px Tab 高：包区 198px（23%）；320／390／640px 的资源滚动视口分别为 446／476／506px（51.7%／55.2%／58.7%），桌面行高 36px。首次资源底边分别为 457／427／397px，均满足预设预算。
- 400px 短 Tab 展开包搜索后，滚底最后一包的四边完整落在内部滚动视口内，横栏和搜索仍可见；不是仅通过 DOM 可见性猜测。
- 范围草稿、浮窗任务、真实置顶／取消置顶、关闭重开保目标与名称、409 后恢复并添加两条原本不存在的成员均通过。新建窗提交前确认包不存在，提交后目录与 API 出现空包；长名收集窗通过实际手势缩到 320px，确认按钮完整；触控动作至少 44px，分享 320×240 仍可达。
- 最终截图已核对明暗工作台、相邻折叠栏、短高搜索、范围窗、集合窗、320px 长名窗与独立新建窗。未宣称完整无障碍审计或所有第三方皮肤均运行验证。
- [机器摘要及构建／源码／截图 SHA-256](assets/clues-sections-and-windows/verification.json)、[六组布局实测](assets/clues-sections-and-windows/clues-layout-metrics.json)、[真实 SVG 颜色](assets/clues-sections-and-windows/clues-color-metrics.json)均来自最终通过产物。

### 最终宿主截图

共独立归档 **26 张**，不覆盖此前轮次：

- [390px 浅色工作台](assets/clues-sections-and-windows/clues-integrated-light-390.png)／[390px 深色工作台](assets/clues-sections-and-windows/clues-integrated-dark-390.png)。
- [两个相邻折叠横栏](assets/clues-sections-and-windows/clues-sections-collapsed.png)／[只收起包区](assets/clues-sections-and-windows/clues-sections-collapsed-packs.png)／[只收起资源区](assets/clues-sections-and-windows/clues-sections-collapsed-browser.png)。
- [集合任务窗](assets/clues-sections-and-windows/clues-collection-window.png)／[320px 长名确认](assets/clues-sections-and-windows/clues-collection-long-name-320.png)／[独立新建任务窗](assets/clues-sections-and-windows/clues-pack-create-window.png)。
- [GitHub 范围窗](assets/clues-sections-and-windows/clues-scope-github.png)／[飞书范围窗](assets/clues-sections-and-windows/clues-scope-feishu.png)。
- [400px 高展开搜索并滚底](assets/clues-sections-and-windows/clues-short-height-search.png)／[触控选择动作](assets/clues-sections-and-windows/clues-selection-actions-touch.png)。
- [完整工作台](assets/clues-sections-and-windows/clues-workbench-overview.png)／[宿主集成](assets/clues-sections-and-windows/clues-integrated-shell-dark.png)。

### 后续 Tab 复用

全局 UI 入口导出 [WorkbenchSection](../../src/client/ui/WorkbenchSection.tsx) 和 [useScrollLoad](../../src/client/ui/use-scroll-load.ts)。横栏只接收受控 open、onOpenChange、title、icon、count、actions、children；业务页继续拥有草稿和数据。滚动 hook 只判断接近末尾，业务页拥有 cursor／去重／同步在飞锁，错误状态通过 hasMore 门控，避免把来源协议固化进 UI 组件。

## 交付边界

仍在 `feat/clues-uiux-refresh`，保留此前未提交改动，未提交／合入共享分支／发布／安装到当前 GUI。第三方真实 GitHub／飞书账号及远端写入未验证。公用横栏已实际接入本轮线索页面，但其他 Tab 的迁移是后续工作，不在本轮冒充完成。
