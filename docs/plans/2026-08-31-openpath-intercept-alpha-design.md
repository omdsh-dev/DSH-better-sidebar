# 聊天文件打开拦截的 0.1.2-alpha 适配（openPath 漏斗迁移）

日期：2026-08-31　分支：`fix/openpath-intercept-alpha`

## 问题

0.1.2-alpha.x 宿主上，聊天里点击文件链接（工具行、产物行、正文行内代码路径）直接落到系统默认应用（Linux 即 `xdg-open`），「聊天区文件在侧边栏打开」（`interceptOpenPath`，默认开）形同虚设。

**根因**：alpha 架构把聊天打开文件的漏斗从客户端服务换成了远程调用——`ui-chat/src/client/apply.ts` 注入 ChatView 的 `openFile` 直连 `ctx.remote.session.openWorkspacePath({ path })` → 宿主 `session-controller` → `openNativePath`。插件的 `wrapOpenPath` 包的是旧漏斗 `ctx.workspaces.openPath`，而 alpha 的 `IWorkspaces`（`api/workspace-controller/src/client/service.ts`）**已删除 `openPath` 方法**——wrap 只是给 service 实例挂了个永无调用方的新属性，死代码。这是 #435/#472 适配的漏网项（挂载冒烟不点聊天文件链接，抓不到）。

**连带影响**：#158 的聊天路径/行号超链接（`owner.openFile` → openPath 假设）同样失效。（#171 的「以默认应用打开」旁路 `openPathWithSystem` 已随重构消失，现行走插件自有 `open.external` 路由，不受影响。）

**版本前提**：插件已进 alpha 通道（#472，peer `^0.1.2-alpha.2`，pre-alpha 兼容层已删）——本修复只面向 alpha 宿主，**整体替换**旧漏斗，不做双版本兼容。

## 新漏斗的事实（宿主源码核实）

1. **唯一生产调用方**：`ui-chat` apply 的 `openFile` 注入（工具行 / 产物行 / 正文提及 / 行内代码路径全部经 ChatView 的 `requestOpenFile` 汇入）。调用前路径已被 `resolveWorkspacePath(cwd, path)` 解析成绝对路径——与旧漏斗收到的形态一致。`canOpenWorkspacePath` 仅被 ui-deliverables 用于按钮可见性，无打开语义，不拦。
2. **`remote.session` 是 cordis 服务**（gateway client 的 `RemoteNamespaceService`，service key `remote.session`，经 `ctx.plugin` 注册）：
   - 方法以 `Object.defineProperty(service, method, { configurable: true, enumerable: true, get })` 安装，getter 在**访问时**读 `methods` 表返回调用闭包（因此直接赋值包装无效——无 setter）；
   - 命名空间整组方法与 service 构造在**同一同步窗口**安装——`ctx.inject(['remote.session'], cb)` 回调触发时方法必已就位；
   - contribution 卸载/重挂载时服务 dispose/重建，inject 回调随之重跑——包装天然自愈。
3. 宿主端成功返回 `{ opened: true }`；失败抛 TypertRemoteFailure（ChatView 弹错误框）。接管方必须返回同形成功值。

## 方案：`wrapOpenWorkspacePath`（沿用「包单漏斗」模式，defineProperty 版）

改写 `src/client/openpath-intercept.ts`：

```ts
// 伪代码
const descriptor = Object.getOwnPropertyDescriptor(service, 'openWorkspacePath')
const original = service.openWorkspacePath            // 访问 getter，捕获当前调用闭包
Object.defineProperty(service, 'openWorkspacePath', {
  configurable: true, enumerable: true, writable: true,
  value: (request: { path: string }, signal?: AbortSignal) => {
    if (takeover()) { /* 接管 */ return Promise.resolve({ opened: true }) }
    return original.call(service, request, signal)    // 放行 = 宿主 native open
  },
})
// dispose：descriptor 存在则原样 defineProperty 恢复，否则 delete —— HMR 安全
```

- **接管语义不变**（复用现有 deps）：`!suspended && interceptOpenPath !== false && tabsEnabled.editor !== false && 有 current session`；`isFolderRevealPath` → `revealInExplorer`；其余 → `openInSidebar`（`:line` 拆分在既有链路内，#158 功能随之恢复）。
- **进入时机**：`registerOpenPathInterception` 改为 `ctx.inject(['remote.session'], ...)` 内包装；宿主裁掉该服务时回调永不触发 = 不拦截不报错。
- **已知取舍**：包装期间若 contribution 重挂方法记录，捕获的 `original` 闭包指向旧记录（getter 访问期绑定语义决定）；session 命名空间实际常驻，可接受，代码注释记录。

## 改动清单

| 文件 | 变更 |
|------|------|
| `src/client/openpath-intercept.ts` | 重写为 `wrapOpenWorkspacePath`（defineProperty 包装/恢复）；`isFolderRevealPath` 保留 |
| `src/client/intercept.tsx` | `registerOpenPathInterception` 改走 `ctx.inject(['remote.session'], …)`；deps 不变 |
| `src/context-types.ts` | `SidebarWorkspacesService{openPath}` 替换为 `SidebarRemoteSessionService{openWorkspacePath(request): Promise<{opened: boolean}>}` |
| `src/client/index.tsx` | inject 数组移除 `'workspaces'`（全仓唯一消费者是旧拦截，typecheck 验证后删） |
| `tests/openpath-intercept.spec.ts` | 重写：getter 形态假服务、接管/放行/恢复、inject 晚到场景 |
| `docs/external-plugin-guide.md` | §10 平台陷阱补「聊天文件打开拦截走 remote.session.openWorkspacePath」一条 |
| AGENTS.md §3 | 新增一条 alpha 宿主契约记录（对齐 #463 的做法） |

## 验证

- 单测：接管 / 放行 / 文件夹揭示手势三态；dispose 恢复原 descriptor；inject 延迟出现。
- 门禁：`pnpm typecheck` → `pnpm test` → `pnpm build` → `pnpm test:mount`（alpha.2 真机 14/14 不回归；mount lane 不驱动聊天点击，拦截正确性靠单测 + 手测）。
- 真机手测：让模型在回复里输出一个工作区文件路径（行内代码）→ 点击落侧边栏编辑器；关闭「聊天区文件在侧边栏打开」后点击 → 系统默认应用；`path:line` 链接 → 侧边栏跳行（#158 回归）。

## 实施偏差记录

- **接管返回值必须是 typert `RemoteResult` 包络**（初版实现踩坑修正）：plan 中「接管返回 `{ opened: true }`」有误——gateway client 的每个 remote 方法都把业务值折叠成 `{ ok: true, value }` / `{ ok: false, error }`，ChatView 的 `openFile` 按 `result.ok` 分支、falsy 时读 `result.error.message`。初版返回裸业务值导致「文件已在侧边栏打开，但仍弹『无法打开文件: Cannot read properties of undefined (reading 'message')』」。修正为接管时返回 `{ ok: true, value: { opened: true } }`（`OpenWorkspacePathResult` 类型钉住，单测断言包络形状）。

## 不做

- pre-alpha 双版本兼容（alpha-only 通道，#472 已删兼容层）。
- `canOpenWorkspacePath` 包装（仅按钮可见性）。
- DSH 侧任何改动（仓库硬约束 §1）。
