# 线索工作台第九轮：DSH 原生多彩内容语言

## 用户反馈与修订

用户指出上一版「图标和 UI 太素」，要求参考 DSH 原生插件的多彩设计。本轮优先于[第八轮的全中性来源反馈](2026-10-20-clues-editor-workbench.md)，但不推翻已经通过验收的紧凑布局与交互：上小下大、完整来源直接可见、无高亮条、固定分页与显式收集确认继续保留。

## 原生参考与关键发现

只读检查 DSH 发布包中的原生 Plugins／Discover 页面、PluginArtwork、GuideArtwork、FileTypeIcon 与主题别名；没有修改宿主。当前本机运行时为 rc.2，而项目安装的 primitives 为精确 0.2.1-rc.1；本轮部署验证仍使用仓库基线 0.2.1-rc.1，不把本机当前 GUI 的版本混作验收版本。

- 原生 Plugins 的丰富感来自中性框架中的彩色 artwork：主形、错位后层、折角或负空间符号；不是给整个面板增加彩色背景。
- 原生文件列表直接消费 FileTypeIcon 的类别色。插件复用组件，不复制其调色板或文件扩展名数据。
- `--dsw-alias-brand-primary` 默认是墨色，不能当成蓝色。插件自绘彩色层改用实际有色的 business、success、warn 别名，由宿主皮肤控制。
- 不拷贝原生 artwork 内的固定 hex、渐变或 static 令牌；自绘图标的颜色全部经 CSS `color` → SVG `currentColor`，无需动态 ID、滤镜或新依赖。

## 连贯改动

| 角色 | 实现 |
| --- | --- |
| 线索集合 | 暖色后页＋蓝色前页＋折角／文字负空间；同一 artwork 用于入口、包目录、空态、目标列表及集合设置，不随机轮换包颜色 |
| 本地来源 | 来源入口用宿主文件夹；资源结果、选择清单、置顶、包成员与添加候选按 locator.path 使用宿主文件类型图标；目录明确用 folder；外部来源图标注册仍优先 |
| 飞书文档 | 蓝色填充文档、绿色折角、表面色文本；不再是灰色细轮廓 |
| 飞书任务 | 琥珀实体、表面描边与清晰对勾；与文档保持不同轮廓 |
| GitHub Issues | 绿色环、实体中心点及轻底层；颜色只表示来源身份，不冒充候选当前状态 |
| GitHub Pull requests | 蓝色分支与绿色节点；颜色不代表其已合并或已通过 |
| 来源选中 | 保留完整标签，轻业务蓝填充＋均匀细边框；没有左条、下划线、阴影或伪元素 |
| 收集主路径 | 新建入口与数量小面积点缀，主要收集／创建确认使用主题业务蓝；与主题前景配对，不改变显式写入语义 |
| 已置顶 | 琥珀图钉与文字；普通操作仍保持可见的中性次级权重 |

行高、边距、来源按钮文字宽度、包每页数量、触控目标、分页节点及网络／缓存机制不因增加色彩而更改。资源选中仍使用中性交互面，避免长列表变成彩色条纹。

## 验收方式

- 图标单测覆盖四个来源的层次、decorative 语义、size／factory／className 契约；集合 artwork 与本地资源解析另有专项回归。
- 主题守卫覆盖新的图标模块，禁止字面量／static 调色板；明确允许用户本轮要求的轻彩色来源选中，继续禁止高亮条与大面板染色。
- 真实宿主除原有密度／键盘／置顶／收集／触控流程外，在 320／390／640 明暗主题中采样实际 SVG fill／stroke：五个来源均必须出现非灰色，集合至少两个色层，本地资源确实呈现类型色；避免「CSS 写了 brand，但运行时仍是灰色」再次漏过。
- 真实截图检查文字对比、小图标轮廓、层次和密度；最终数字与新截图在验证结束后补录，不沿用第八轮证据。

## 最终验证

- 类型检查、定向 ESLint、构建与打包通过，`git diff --check` 无空白错误。
- **16 文件／293 项定向回归通过**：工作台 47、包／分享窗口 40、设置配置 45、主题 22、飞书客户端 41、GitHub 客户端 9、来源图标 8、集合 artwork／资源解析 8、设置来源 19、设置语言 3、设置布局 5、线索文案 5、客户端集成 3、布局 CSS 8、内置注册 26、宿主 primitive 导出 4。
- 最终精确 **DSH 0.2.1-rc.1** 隔离挂载 **2 passed（11.3s）**，无失败／flaky／跳过。真实置顶／取消置顶、键盘翻页焦点、来源草稿、收集确认、200 字包名、触控批量按钮和最小分享窗均保持通过。
- **六组真实颜色断言通过**：320／390／640px × 明暗主题，五个来源均解析为实际非灰色；集合有两个彩色主层，本地资源是宿主类型色。[颜色实测](assets/clues-native-color/clues-color-metrics.json)记录的是浏览器实际计算的 fill／stroke，不是设计假值。
- **布局实测与上一轮逐项相同**：320／390／640px 在 862px Tab 高下，包区为 161／161／145px，结果区为 445／475／521px；桌面行高 36px。没有为彩色图标增加工具栏或压缩内容空间。[布局实测](assets/clues-native-color/clues-layout-metrics.json)与第八轮证据逐项比对相等。
- 已目视核对 390px 明暗工作台、收集区、置顶区、320px 长名目标与窄栏、触控批量动作和包管理截图：颜色清楚而面板中性，主要确认完整可见。此处不是完整 WCAG 审核，也未声称第三方皮肤均实测。
- [机器摘要与构建／截图校验值](assets/clues-native-color/verification.json)记录最终产物，共 24 张新截图，未覆盖历史证据。

### 最终实际效果

- [390px 浅色工作台](assets/clues-native-color/clues-integrated-light-390.png)／[390px 深色工作台](assets/clues-native-color/clues-integrated-dark-390.png)。
- [浅色收集区](assets/clues-native-color/clues-selection-light-390.png)／[双色目标与长名称](assets/clues-native-color/clues-destination-long-name-320.png)。
- [琥珀置顶](assets/clues-native-color/clues-pinned-390.png)／[320px 窄栏](assets/clues-native-color/clues-integrated-dark-320.png)。
- [包成员的宿主文件图标](assets/clues-native-color/clues-pack-management.png)／[触控操作区](assets/clues-native-color/clues-selection-actions-touch.png)。
- [完整宿主集成](assets/clues-native-color/clues-integrated-shell-dark.png)。

## 交付边界

改动在 `feat/clues-uiux-refresh`，未提交、合并或发布，未安装到当前 GUI。没有修改 DSH 源码／公共 API／依赖，也没有在真实第三方账号上授权或写入；不宣称完整仓库测试或完整挂载 lane 通过。第三方 GitHub／飞书和 lark-cli 的真实安装／登录仍未验证。构建器弃用提示、宿主 primitive 缺 source map 与既有 jsdom／act 警告不影响本轮通过，但未伪装成这些警告已经修复。
