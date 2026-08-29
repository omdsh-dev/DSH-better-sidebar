# Edge 151 无端口 Origin 导致的侧边栏 403 forbidden 修复

日期：2026-08-17

## 现象

Windows + Edge 151（151.0.4129.86）下，`dsh web` 主应用一切正常，但 better-sidebar 的文件管理（Explorer / 文件树）显示 `forbidden`。抓包确认：`POST /sidebar/api/fs.tree` 返回 `403`，响应体为 `{"ok":false,"error":{"code":"forbidden","message":"forbidden"}}`——命中插件自身信任栅栏的拒绝分支，而不是业务错误。

## 根因

`src/trust-fence.ts` 是 DSH `/api` 网关信任栅栏（`@deepseek-ai/dsh-client-connection` 的 `api-request-trust.ts`）的行为镜像。Origin 校验一段，镜像版仍按 `host`（含端口）比较：

```ts
return new URL(origin).host === hostUrl.host
```

DSH 官方栅栏后来修复为按 `hostname` 比较，理由是：**部分 Chromium 构建（Edge 151）会把非默认端口 loopback 页面的 Origin 序列化为不带端口的形式**（`http://127.0.0.1:3080` 的页面，fetch 携带 `Origin: http://127.0.0.1`）。

于是 Edge 151 下：

- 页面 `http://127.0.0.1:3080` 发出的请求，`Origin: http://127.0.0.1`，`Host: 127.0.0.1:3080`；
- 镜像栅栏比较 `new URL('http://127.0.0.1').host`（= `127.0.0.1`）与 Host `127.0.0.1:3080` → 不等 → 403；
- DSH 自己的 `/api` 栅栏比较 hostname → 相等 → 放行，所以主应用正常，只有 `/sidebar/*` 全部 403。

镜像与官方行为漂移，正好打破镜像文件头声明的「behaviorally identical」契约。

## 证据

- 本机 Edge 版本 151.0.4129.86（DSH 注释点名的构建）。
- curl 实测（对运行中的 `dsh web`，`/sidebar/api/fs.list` 用错方法名以区分 403 与方法分发）：
  - `Origin: http://127.0.0.1:3080`（带端口）→ 200 `unknown sidebar API method`（过了栅栏）；
  - `Origin: http://127.0.0.1`（Edge 151 形式）→ 403 `forbidden`。
- DSH 修复参考：`packages/client/connection/src/api-request-trust.ts`（注释点名 Edge 151）及测试 `tests/api-request-trust.host.spec.ts` 的「accepts an Origin that names the Host hostname without its port (Edge 151 serialization)」。

## 方案

1. `src/trust-fence.ts` 的 Origin 校验改为 `new URL(origin).hostname === hostUrl.hostname`，注释写明与 DSH 官方栅栏保持一致的语义与理由（Host 栅栏已绑定 authority，端口不再重决信任）。
2. `tests/trusted-hosts.spec.ts` 增加回归用例：loopback Host + 不带端口的 Origin → 200；同时保留带端口与跨域拒绝用例。

行为语义变化（有意为之，与 DSH 一致）：Origin 与 Host 的 hostname 相同即认为同源，端口差异不再拒绝。安全前提不变：Host 栅栏仍要求 Host 为 loopback 或 `webRuntime.trustedHosts` 授权项，`sec-fetch-site: cross-site` 仍一律拒绝。

## 验证

1. `pnpm test`（vitest）新增用例通过，既有 trusted-hosts 用例不回归。
2. `pnpm typecheck`。
3. 本地挂载：`pnpm build` 后覆盖 web profile 的 node_modules 产物，重启 `dsh web`，curl 以 `Origin: http://127.0.0.1`（无端口）请求 `/sidebar/api/*` 应进入方法分发（404 unknown method）而非 403；浏览器硬刷新后文件管理恢复。

## 发布

按仓库 §0 流程：`fix/*` 分支 → PR → review 合并 → bump 版本打 tag 走 release workflow。即时修复可先本地覆盖 profile 产物验证，正式生效待 0.13.1 发布后 `dsh plugin add dsh-better-sidebar@latest`。
