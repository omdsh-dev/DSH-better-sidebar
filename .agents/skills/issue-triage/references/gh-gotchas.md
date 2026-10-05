# GitHub API / gh CLI 的坑（本仓库踩过的，均已实测）

## 权限与 scope

- **Projects v2 需要 `project` scope**：`gh auth refresh -s project`。这是浏览器设备码流程，**只能人点**——不要让 agent 起流程后轮询干等，直接请维护者点一次。
- **已废弃的 classic projects 走不通**：`GET /repos/{o}/{r}/projects` 现在 404，`repo` scope 绕不过去。
- **组织项目的可见性只能组织 owner 改**：`updateProjectV2(public: true)` 对 member 会报 `FORBIDDEN: Viewer not authorized to change project visibility`——连 `public: false` 的空写也一样报，所以是角色问题而不是「组织禁用了公开项目」。请 owner 在项目 `⋯ → Settings → Visibility` 里点一次。
- 组织项目里谁可以改可见性：`gh api "orgs/<org>/members?role=admin" --jq '.[].login'`；自己的角色：`gh api user/memberships/orgs/<org> --jq .role`。

## 视图（view）

- `createProjectV2View` / `updateProjectV2View` / `deleteProjectV2View` **存在**，可以建视图、改名（按名字列视图：`projectV2.views`）。
- **但分组设不了**：`ProjectV2ViewConfigurationInput` 只有 `visibleFieldIds`，group-by 不在公开 schema 里 → `Group by → 批次/Status` 必须人在 UI 点一次。
- 排查时别用 `grep -i view | head` 判断 mutation 是否存在（字母序会让 review 系列先占满 head）——直接对 `__schema.mutationType.fields` 全量过滤。

## 字段与选项

- **`updateProjectV2Field(singleSelectOptions: [...])` 是整体替换**：被替换掉的选项 id 失效、`Status` 值会掉；想改选项就把**全部**目标选项一次列全（name/color/description 三个字段都是必填），改完**重新给条目写一遍值**。
- option id 会随替换变化 → 脚本每次运行都按**名字**重新解析 id，不要硬编码。
- `ProjectV2SingleSelectFieldOptionInput` 三个字段全 `NON_NULL`：`name` / `color`（枚举 `GRAY BLUE GREEN YELLOW ORANGE RED PINK PURPLE`）/ `description`（可空串）。

## 批量与限流

- 同一份 GraphQL document 里用别名批量发同种 mutation（实测 16 条/次稳定），比逐条 `gh project item-edit` 快一个量级。
- 嵌套连接会触发 `MAX_NODE_LIMIT_EXCEEDED`（上限 50 万节点）：`items(first:100)` 里再套 `fieldValues(first:20)` 是 2k 节点没问题，别把 `first` 写成三位数拼接（踩过 `first:100100`）。
- 单次往返里的 GraphQL 语法错误消息是 `Expected NAME, actual: (none)` —— 通常是**少了一个右花括号**，别去怀疑字段名。

## 数据读写的坑

- **`gh project item-list --format json` 会把非 ASCII 字段名写成乱码**（`批次` → `���次`，字节层是 U+FFFD）。GitHub 上存的是对的，**回读校验一律走 GraphQL**，不要被 CLI 输出吓到、也不要据此去改名。
- `gh project item-list` 的 key 是字段中文名，`fieldValues` 才是 GraphQL 的形状；两套不要混用。
- 加标签用 `--add-label` **不会**移除旧标签：批量改优先级后必须回读断言「一条 issue 只有一个 P 标签」。
- `gh issue close --reason completed|not planned --comment "…"` 一次到位；用 `not planned` 表示「不再适用/重复/第三方」，`completed` 表示「已修/已答」。

## 关闭与自动关闭

- 只有 merge 到默认分支的 PR 正文里写 `Fixes #N` / `Closes #N`（或落地提交消息里带 `Fixes #N`）才会自动关 issue。
- merge train 的惯用形态：train PR 正文列出全部 `Fixes #…`，车上成员 PR 有些会被标记为 `CLOSED`（**移植提交**，内容以新载体落地）——这是正常的，不是丢改动。
- 自动关闭**不会**覆盖 train 没声明的条目：合完要拿 train 正文的 `Fixes` 清单跟 open issue 对一遍，把漏的单独复核后手动关。

## 看板条目的生命周期

- issue/PR 关闭后**条目仍留在看板上**（GitHub 的模型如此）。所以 `board items > 期望条目数` 是正常的，只有 `missing` / `mismatched` 才算失败——别为了「数量对齐」去删条目。
- 想清场用 `archiveProjectV2Item`（可逆），或干脆按状态切片看（`Status:等待审核`）。看板里出现已关闭的条目 ≠ 脚本出 bug。
