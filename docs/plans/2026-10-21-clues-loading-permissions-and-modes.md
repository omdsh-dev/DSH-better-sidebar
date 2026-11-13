# 线索加载、权限、查看模式与统一界面基准

本轮完成用户的六项改进，并按新增要求把线索收集作为后续全站 UI/UX 的收敛起点。主栏、包管理、添加成员、详情、选包、分享与来源设置保持通栏、即时折叠、原生多彩图标和统一面板层。实现保留在 feat/clues-uiux-refresh；已更新 3080 测试 profile，未操作 3384 或 DSH 源码。

## 实现

- 全局 LoadingIndicator 统一 Notice、懒加载及线索状态行。原生图标配合 CSS 旋转，减少动态效果时静止，不增加 JS 动画定时器。
- 查询关键词使用 300ms trailing 防抖，Enter 即时执行；输入法合成、隐藏、关页或切来源取消排队。链接与路径仍显式解析。
- 目录、默认范围和查询页共用 15s／80 条 LRU 及在飞合并。调用方独立取消，最后一个消费者离开才取消底层请求。错误、正文和编辑基线不缓存；写入、导入、运行状态及注册变化失效，显式刷新绕过缓存。
- 生产 runtime 一次补全桌面进程 PATH，查找与子进程使用同一环境，覆盖 Node、用户包管理器、Homebrew 和有界 NVM；不执行 shell/rc，注入的测试环境保持确定性，托管优先级不变。
- 飞书六项权限可选，按当前来源预选只读；写入与知识库不默认。授权请求所选最小 scope 并集，部分批准可就绪，具体操作检查实际能力。GitHub 沿用其 CLI 支持的授权方式。
- 包添加页移除重复头部、置顶与取消，只留一个返回；有选择才显示添加底栏。主页重命名有改动时才出现保存/取消，保留主要插入动作。
- 资源、置顶、包架、成员及添加候选使用宿主右键菜单，支持 ContextMenu／Shift+F10。移出成员保持中性，删除集合明确确认。Escape 先由菜单/编辑器消费，再关闭顶层窗口。
- 文档采用 presentation: modes，默认预览，用 Markdown 同款分段按钮切换编辑。两面保留挂载，始终只显示一个面；草稿、选区、滚动和关闭保护保留。

## 全站收敛基准

规则记录在[接入指南 §12.3](../external-plugin-guide.md)，后续页面逐页复用现有组件与宿主控件。

- 同级面板、窗口标题/正文/底栏和预览使用或继承 bg-layer-1；实际编辑面及输入控件使用 bg-base。
- 主提交动作统一使用宿主 primary 填充/前景令牌，移除主栏业务蓝特例；来源选择与状态保留语义色。
- 独立搜索框高 30、文字 12/18、内边距 4/8、圆角 6；主栏组合外框高 30、内部 28。粗指针命中至少 44，组合外框 46。
- 资源标题 13/20、状态 12/18、次要元信息 11/16；行与图标按钮圆角 6。
- 真实浏览器发现成员标题被后置 font shorthand 重置为 12px，已从继承顺序修复，保留严格的 13px 运行时断言。

## 已验证

- 类型检查、定向 ESLint、diff 检查、构建与打包通过。
- 六项功能的完整相关回归：71 文件，1449 passed／1 skipped，29.76s；后续统一设计回归 4 文件／146 passed，字体修复后的主题与密度回归 32 passed。
- 最终完整 DSH 0.2.1-rc.1 挂载门禁：15 passed／3 skipped，3.0m。包含线索明暗/宽窄、桌面/触控、缓存、防抖、动画、菜单、模式切换、真实成员增量，以及原生入口、编辑器 chunk、页面内重载、终端和性能。3 项 Context 场景按可选插件条件跳过。
- 初次完整门禁因沙箱拒绝 posix_openpt 而无法创建 PTY；未弱化断言，同一命令获准扩大权限后真实 xterm 验收通过。
- 稳态观测 15s：闲置请求 0、闲置 cwd 读取 0；拖动 96 帧，P95 10ms、最大 11ms、宽度泄漏 0px。
- 本机只读 PATH 探针从原进程缺失的 nvm 安装目录找到现有 lark-cli，--version 返回 1.0.55，exit 0；未安装或授权真实 CLI。
- 新增权限与确认文案翻译全部 21 份词典，词典回归 29 passed。

最新[33 张截图及指标](assets/clues-unified-baseline/test-verification.json)来自最终验收包；[包散列](assets/clues-unified-baseline/package-verification.json)和旧轮次分开保留。可查看[宽屏暗色](assets/clues-unified-baseline/clues-wide-1100-dark.png)、[包管理](assets/clues-unified-baseline/clues-pack-management.png)、[查看/编辑切换](assets/clues-unified-baseline/clues-detail-window.png)和[权限选择](assets/clues-unified-baseline/clues-feishu-permissions.png)。

## 3080 交付

- 使用官方精确 RC CLI 安装独立 ui13 本地包到 sidebar-test profile；89 个变更源文件与 tar 包字节一致，实际安装的 8 个 bundle 散列均一致。
- 包 SHA-256：1f9dc05bc9725023669600b5e39d64152781b19a3221058bb9450c814d0fe16d。
- 只重启 PM2 的 dsh-sidebar-preview-3080；PID 从 86805 变为 6598，服务常驻保留。
- 实际 http://127.0.0.1:3080 选择已有项目会话，打开线索页后测得搜索框 30px、输入 12px；新权限接口返回六项可选能力，pageErrors=[]，消息发送 0、远端写入 0。
- 3384 在此前任务中断期间由外部改变过监听者。本次部署前重新取基线，部署前后均为 50833；本次没有修改或重启该服务。
- 实际站点核验时间：2026-10-21T14:42:45.647Z，详见[部署验证](assets/clues-unified-baseline/deployment-verification.json)。刷新 3080 页面可查看最终界面。

## 边界

未执行真实 GitHub／飞书 OAuth、真实 CLI 安装或远端保存。依赖缺失入口使用受控脱敏 DTO；文件与包成员写入使用隔离宿主真实 API。全仓非相关单元测试未重跑。手动可执行路径持久化为此前独立问题，本轮未扩展处理。没有提交、合并、推送或发布。
