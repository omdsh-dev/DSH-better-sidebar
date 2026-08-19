# 外链点击路由到插件 tab（urlTarget）+ 浏览器 HTTP/HTTPS 二级设置

**日期**：2026-08-15
**状态**：已实施（本文档含实施偏差记录）
**目标版本**：v0.13.0（API 兼容层，版本号未随本变更 bump，见 §7）

## 1. 目标

基于 [PR #74](https://github.com/omdsh-dev/DSH-better-sidebar/pull/74)（聊天区外链开关颗粒度讨论）向前兼容地拓展服务化 API：

1. **插件声明「点击打开的类型」**：`TabDescriptor` 新增可选 `urlTarget?: (url: URL) => boolean`——聊天区外链被拦截时，路由到第一个声明的、命中的、未被设置禁用的插件 tab 类型（`openTab({ type, url, title: hostname })`，URL 即全部载荷），内置浏览器 tab 退居隐式兜底。
2. **浏览器链接设置改为二级菜单**（浏览器卡片齿轮弹窗内）：
   - 侧边打开 HTTP 网页（默认开）
   - 侧边打开 HTTPS 网页（默认关）
   - `browserInterceptLinks` 保留为**总闸**（默认开，零迁移：旧文档显式 false 语义完整保留）。

## 2. 非目标

- 不实施 PR #74 的「外链开关提升到常规区」（用户确认：二级设置留在浏览器卡片齿轮弹窗，常规区不加行）。
- 不做 per-host / per-domain 路由规则（只有 per-protocol 开关 + 插件谓词）。
- 不改 + 菜单、不改手动打开的浏览器 tab、不改同源/修饰键点击放行规则。
- 不改 host 半逻辑（仅 PrefsSchema 加字段）；不修改 DSH 源码。
- 不做版本号 bump（发布时决定；向前兼容机制 = `SIDEBAR_FEATURES` 追加 `'urlTarget'`）。

## 3. 现状回顾

- `link-intercept.ts` 的 `registerLinkInterception` 无参 `takeoverEnabled()` 只做布尔门；`index.tsx` 硬编码 `openTab({ type: 'browser', url, title: hostname })`。
- `browserInterceptLinks`（默认 true）与 `browserNoSandbox` 并列于浏览器卡片的 `settings.toggles`；拦截 gating = 该 pref && `tabsEnabled['browser']`。
- `openTab` seed 已有 `url` 字段（新建 tab 的 path 预填），插件 tab 无需新渲染管道。

## 4. 设计

### 4.1 Prefs（`prefs-shared.ts` / `config.ts` / `client/prefs.ts`）

```ts
interface SidebarPrefs {
  // …
  browserInterceptLinks: boolean   // 总闸，默认 true（保留，零迁移）
  browserInterceptHttp: boolean    // HTTP 外链侧边栏接管，默认 true
  browserInterceptHttps: boolean   // HTTPS 外链侧边栏接管，默认 false
}
```

三处同步维护（类型 + schemastery 默认 + parsePrefs 校验），旧文档无需迁移：总闸保留使显式关闭过的用户升级后仍不拦截。

### 4.2 服务 API（`service.ts`）

```ts
interface TabDescriptor {
  // …
  urlTarget?: (url: URL) => boolean
}

/** 注册顺序先到先得；谓词抛错吞掉（console.error）继续；返回 undefined 由调用方回退 browser。 */
export function matchUrlTarget(tabs: readonly TabDescriptor[], url: URL): TabDescriptor | undefined
```

- 匹配函数为**模块级纯函数**（不进 `BetterSidebarService` 接口，KISS：不扩公开面）；启用态过滤由调用方（`index.tsx`）按 `tabsEnabled` 过滤后传入。
- 内置 browser 不声明 `urlTarget`，永远不可能遮蔽插件声明；插件多 URL 并存需用 `createTab` 铸造 per-URL id（browser 同款模式），否则 id 安全网聚焦既有 tab 不覆写 path。
- `SIDEBAR_FEATURES` 追加 `'urlTarget'`（消费者按能力 gate）。

### 4.3 拦截管线（`link-intercept.ts` / `index.tsx`）

- `shouldInterceptLink` 签名不变（协议/同源纯判定）；`takeoverEnabled` 改为 `(url: URL) => boolean`，onClick 顺序：纯判定 → gate（持 URL）→ preventDefault → open。
- `index.tsx` gate：总闸 `browserInterceptLinks` → 协议开关（https 读 `browserInterceptHttps`，否则读 `browserInterceptHttp`）→ 目标可开（插件命中即目标，否则 browser 的 `tabsEnabled`）。open 时再次解析目标并 `openTab({ type, url, title: hostname })`。

### 4.4 设置 UI（`builtins/tabs.tsx` / `locales.ts`）

浏览器卡片 `settings.toggles` 收敛为四行：`browserNoSandbox` / `browserInterceptLinks`（总闸）/ `browserInterceptHttp` / `browserInterceptHttps`；新增 zh/en 文案（HTTP 默认开、HTTPS 默认关及理由）。

## 5. 行为变化

- 默认设置下：HTTP 外链 → 侧边栏（不变）；**HTTPS 外链 → 系统浏览器新窗口（变化，符合「默认关闭」）**。
- 声明 `urlTarget` 的插件 tab 认领被拦截的链接（优先于浏览器兜底）；插件被禁用/谓词抛错时跳过。
- 总闸关闭 → 一律不拦截（旧文档语义保留）。

## 6. 测试

- `tests/builtins.spec.ts`：浏览器 toggles 断言收敛为四行 + 各行 title/desc 存在。
- `tests/service.spec.ts`：`matchUrlTarget`（无声明 → undefined / 注册顺序 / 抛错吞掉 / browser 永不命中）。
- `tests/link-intercept.spec.ts`（新增 jsdom）：`takeoverEnabled(url)` 收到解析后的 URL、gate 决定是否接管、同源/非 http(s) 不 consult gate、修饰键绕过。
- `tests/unit.spec.ts`：parsePrefs 新字段默认值（http true / https false / 非法回退）；总闸与协议开关相互独立。
- `tests/plugin-shape.spec.ts` / `tests/smoke.spec.ts`：全默认字面量补两个字段。

## 7. 实施偏差记录

- 计划曾考虑把 `matchUrlTarget` 作为 `BetterSidebarService` 接口方法（镜像 `matchFileViewer`）；按 KISS 收敛为**模块级导出纯函数**，启用态过滤由调用方完成（匹配函数不感知 prefs），公开 API 面只剩 `urlTarget` 字段 + `'urlTarget'` feature 字符串。
- 版本号未 bump（保持 0.12.1）：`SIDEBAR_SERVICE_VERSION` 与 `package.json` 的配对断言继续成立；`'urlTarget'` feature 已入 `SIDEBAR_FEATURES`，发布时再决定版本。
- PR #74 的 diff（常规区移动 + 其测试改动）被本方案取代，未合入。
