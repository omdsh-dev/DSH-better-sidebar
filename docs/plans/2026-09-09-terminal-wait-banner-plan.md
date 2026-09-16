# 终端等待 banner + 跳过等待 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 阻塞在 `terminal_wait_for` 时，对应终端卡片顶部显示「Agent 正在等待 {needle}」banner（右侧「跳过等待」按钮），tab 标题加 ⏳ 徽章；跳过后工具返回新增的 `{kind:'skipped'}`。

**Architecture:** 等待状态登记在 `AgentPtyRegistry` 的 handle 上，随现有 `/sidebar/ws/agent-terminals` 推送快照（`waiting` 字段）自然下发；跳过走新增 `/sidebar/api/agent-pty.skip-wait` 路由。客户端把推送镜像进 `state.agentWaits`，banner 组件与 tab 徽章从 store 读。

**Tech Stack:** TypeScript / React 18 / vitest（node 环境 pty 测试 + jsdom Sidebar 壳测试）/ ws 推送 / CSS Modules（皮肤令牌）。

**Spec:** `docs/plans/2026-09-09-terminal-wait-banner-design.md`（与本计划同分支，执行者两份都读）。

## Global Constraints

- 分支：`feat/wait-banner`（已含设计文档提交 `4a6a77a`）；所有代码改动走该分支 → PR，禁止直推 main（分支保护）。
- 皮肤契约：新增 CSS 只允许 `--dsw-alias-*` / `--dsw-font-*` / `--ds-*` 令牌；本项目复用现成 warn 对 `--dsw-alias-state-warn-label` / `--dsw-alias-state-warn-tertiary`（仓库 CSS 无 state-info 令牌，已核实）。
- i18n：新增 zh key 必须同步 en 词典与 `src/client/locales-ja.ts` 的 ja 翻译。
- client bundle 纯度门：新文件只准 import 本插件模块（locales / css / api），禁止 value-import `@dsh-external/*` 或非白名单 `@deepseek-ai/*`。
- 不改 `src/client/service.ts` / `docs/external-plugin-guide.md`（⏳ 徽章走 shell 层特例，不动 TabDescriptor API）。
- 上游测试（含 win32 已知 27 个非回归失败）一律不改。
- 每个任务用 `pnpm exec vitest run <file>` 验证；最终任务必须 `pnpm lint` + `pnpm typecheck` + `pnpm test` + `pnpm build` 全绿才 push（CI 曾因漏 lint 挂过）。
- 提交信息风格：`feat(terminal): ...` / `test(...)`，仓库惯例小写 scope。

---

### Task 1: Registry 等待登记 + `skipped` 结果 + `waiting` 快照

**Files:**
- Modify: `src/agent-pty.ts`
- Test: `tests/agent-pty.spec.ts`

**Interfaces:**
- Consumes: 现有 `AgentPtyRegistry.waitFor` / `notify` / `subscribe` / `snapshotOf`。
- Produces:
  - `type AgentTerminalActiveWait = { needle: string; since: number; skipped: boolean }`
  - `AgentTerminalHandle.waits: AgentTerminalActiveWait[]`（create 时初始化为 `[]`）
  - `AgentTerminalSnapshot.waiting?: { needle: string; since: number }`（最新一条活动等待）
  - `AgentTerminalWaitResult` 新增 `{ kind: 'skipped'; needle: string }` 变体
  - `registry.skipWait(uuid: string): number`（标记全部活动等待，返回条数；未知 uuid 抛 not-found）

- [ ] **Step 1: 写失败测试（4 个新用例，加在 `describe('AgentPtyRegistry')` 内、现有 `waitFor` 用例之后）**

在 `tests/agent-pty.spec.ts` 的 import 块不需要新增（`AgentPtyRegistry` / `snapshotOf` 已导入）。追加用例：

```ts
  it('waitFor returns skipped when the user skips from the sidebar', async () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'skip-test', 'echo skip-ready', process.cwd(), 80, 24)
      await waitForTranscript(registry, uuid, 'skip-ready')
      // waitFor registers its record synchronously (before the first poll
      // await), so the skip can fire immediately after the call.
      const waitPromise = registry.waitFor(uuid, 'NEVER_APPEARS_XYZ', 30_000)
      expect(await registry.skipWait(uuid)).toBe(1)
      const result = await waitPromise
      expect(result.kind).toBe('skipped')
      if (result.kind === 'skipped') expect(result.needle).toBe('NEVER_APPEARS_XYZ')
      // Idempotent: nothing left to skip once the wait resolved.
      expect(registry.skipWait(uuid)).toBe(0)
    } finally {
      registry.disposeAll()
    }
  })

  it('snapshot exposes waiting while a wait is active and clears after it ends', async () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'wait-snap', 'echo snap-ready', process.cwd(), 80, 24)
      await waitForTranscript(registry, uuid, 'snap-ready')
      const waitPromise = registry.waitFor(uuid, 'LATER_MARK_9', 30_000)
      // Registration happens synchronously before waitFor's first await.
      expect(registry.list('s1')[0]?.waiting?.needle).toBe('LATER_MARK_9')
      expect(typeof registry.list('s1')[0]?.waiting?.since).toBe('number')
      expect(registry.skipWait(uuid)).toBe(1)
      const result = await waitPromise
      expect(result.kind).toBe('skipped')
      expect(registry.list('s1')[0]?.waiting).toBeUndefined()
    } finally {
      registry.disposeAll()
    }
  })

  it('fires change listeners when a wait starts and ends', async () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'watched-wait', 'echo notify-ready', process.cwd(), 80, 24)
      await waitForTranscript(registry, uuid, 'notify-ready')
      let changes = 0
      const unsubscribe = registry.subscribe(() => { changes += 1 })
      const waitPromise = registry.waitFor(uuid, 'NEVER_NOTIFY_1', 30_000)
      const afterStart = changes
      expect(afterStart).toBeGreaterThanOrEqual(1)
      expect(await registry.skipWait(uuid)).toBe(1)
      expect(await waitPromise).toEqual({ kind: 'skipped', needle: 'NEVER_NOTIFY_1' })
      expect(changes).toBeGreaterThan(afterStart)
      unsubscribe()
    } finally {
      registry.disposeAll()
    }
  })

  it('skipWait rejects an unknown uuid with not-found', () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      expect(() => registry.skipWait('missing-uuid')).toThrow(/not found/)
    } finally {
      registry.disposeAll()
    }
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/agent-pty.spec.ts`
Expected: FAIL — `waiting` 为 undefined、`skipWait` 不存在、skipped 分支不存在（TS 编译错误或断言失败）。

- [ ] **Step 3: 实现 `src/agent-pty.ts`**

(a) 在 `AgentTerminalReadResult` 之后、`AgentTerminalWaitResult` 之前新增：

```ts
/** One active wait_for registration on a handle (banner + skip bookkeeping). */
export interface AgentTerminalActiveWait {
  /** The needle being awaited (shown on the sidebar wait banner). */
  needle: string
  /** Epoch ms when the wait registered (age display / debugging). */
  since: number
  /** Flipped by `skipWait()`; the waiting poll returns `skipped` within one tick. */
  skipped: boolean
}
```

(b) `AgentTerminalWaitResult` union 末尾追加变体：

```ts
  | {
    /** The user skipped the wait from the sidebar banner. */
    kind: 'skipped'
    /** The needle that was awaited. */
    needle: string
  }
```

(c) `AgentTerminalSnapshot` 追加字段（`exitSignal` 之后）：

```ts
  /**
   * The model's active `terminal_wait_for` on this terminal (the sidebar
   * renders the wait banner from it). Present only while a wait is
   * registered; carries the LATEST wait when several overlap.
   */
  waiting?: { needle: string; since: number }
```

(d) `AgentTerminalHandle` 追加字段（`exitSignal` 之后）：

```ts
  /** Active wait_for registrations (skip bookkeeping; empty while idle). */
  waits: AgentTerminalActiveWait[]
```

(e) `create()` 的 handle 字面量中 `exited: false,` 之后加 `waits: [],`。

(f) `snapshotOf` 在 `return out` 前追加：

```ts
  const active = handle.waits.at(-1)
  if (active !== undefined) out.waiting = { needle: active.needle, since: active.since }
```

(g) 新方法（放在 `waitFor` 之后）：

```ts
  /**
   * Mark every active wait on one terminal as skipped (the sidebar banner's
   * skip button). Each waiting poll loop observes its record's flag within
   * one 50ms tick and returns `{kind:'skipped'}`. Idempotent: 0 when nothing
   * is waiting (a stale banner racing a wait that already resolved).
   * @returns the number of waits that transitioned to skipped.
   */
  skipWait(uuid: string): number {
    const handle = this.expect(uuid)
    let count = 0
    for (const record of handle.waits) {
      if (!record.skipped) {
        record.skipped = true
        count += 1
      }
    }
    return count
  }
```

(h) 重写 `waitFor` 中段（`const firstHit = ...` 快速路径之后到方法结尾），登记记录 + 轮询检查 + `finally` 清理：

```ts
    const firstHit = locateNeedle(handle.transcript, needle, re)
    if (firstHit !== undefined) {
      return { kind: 'found', needle, line: firstHit.line, column: firstHit.column, match: firstHit.match, elapsedMs: Date.now() - start }
    }
    // Register the active wait so the sidebar can show the wait banner (the
    // snapshot's `waiting` field rides the agent-terminals push). Registered
    // only after the fast paths: a wait that resolves instantly never
    // flashes the banner. The notify() makes every push subscriber (the
    // sidebar view) converge on the new waiting state immediately.
    const record: AgentTerminalActiveWait = { needle, since: start, skipped: false }
    handle.waits.push(record)
    this.notify()
    try {
      while (true) {
        if (signal?.aborted) signal.throwIfAborted()
        if (handle.exited) {
          return { kind: 'exited', needle, exitCode: handle.exitCode ?? null, exitSignal: signalNameOf(handle.exitSignal) }
        }
        if (record.skipped) {
          return { kind: 'skipped', needle }
        }
        const hit = locateNeedle(handle.transcript, needle, re)
        if (hit !== undefined) {
          return { kind: 'found', needle, line: hit.line, column: hit.column, match: hit.match, elapsedMs: Date.now() - start }
        }
        if (Date.now() >= deadline) {
          return { kind: 'timeout', needle, timeoutMs: timeout, totalLines: handle.transcript.split('\n').length }
        }
        await new Promise(resolve => {
          const t = setTimeout(resolve, 50)
          // Allow the Node process to exit even if the timer is pending.
          if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref()
        })
      }
    } finally {
      const index = handle.waits.indexOf(record)
      if (index !== -1) handle.waits.splice(index, 1)
      this.notify()
    }
```

(i) `waitFor` 的 JSDoc：`@returns one of `found` / `timeout` / `exited`.` 改为 `@returns one of `found` / `timeout` / `exited` / `skipped`.`；并在 `@param signal` 行后补一行 `* A wait can also be skipped by the user from the sidebar banner (`skipWait`), which resolves it with `{kind:'skipped'}`.`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/agent-pty.spec.ts`
Expected: PASS（全部用例，含既有 425 行文件内的用例）。

- [ ] **Step 5: Commit**

```bash
git add src/agent-pty.ts tests/agent-pty.spec.ts
git commit -m "feat(terminal): registry 支持等待登记、skipWait 与 skipped 结果"
```

---

### Task 2: 工具层 `skipped` 分支 + 宿主 `agent-pty.skip-wait` 路由

**Files:**
- Modify: `src/tools.ts`（terminal_wait_for 定义，约 287-377 行）
- Modify: `src/index.ts`（buildApi 表，`'agent-pty.close'` 之后，约 545 行）
- Test: `tests/tools.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `AgentTerminalWaitResult` skipped 变体、`registry.skipWait(uuid): number`。
- Produces: `/sidebar/api/agent-pty.skip-wait` 路由（payload `{uuid}` → `{ok:true, skipped:number}`）；工具 output schema 第四分支；Task 4 的客户端 `api.agentSkipWait` 调它。

- [ ] **Step 1: 写失败测试**

`tests/tools.spec.ts`：(a) `FakeRegistry` 增加注入口 —— 在 `readonly terminals = ...` 行后加属性，并把 `waitFor` 改为：

```ts
  /** When set, waitFor resolves with the skipped shape instead of the found default. */
  nextWaitResult: { kind: 'skipped' } | undefined

  waitFor(_uuid: string, needle: string): Promise<
    { kind: 'found'; needle: string; line: number; column: number; match: string; elapsedMs: number }
    | { kind: 'skipped'; needle: string }
  > {
    // Mirrors the registry's empty-needle rejection (the tool layer no
    // longer duplicates this check).
    if (needle === '') return Promise.reject(new Error('needle must be a non-empty string'))
    if (this.nextWaitResult !== undefined) return Promise.resolve({ kind: 'skipped', needle })
    return Promise.resolve({ kind: 'found', needle, line: 0, column: 0, match: needle, elapsedMs: 1 })
  }
```

(b) 在 `describe('agent terminal tools')` 内、现有 `terminal_wait_for returns the registry result...` 用例后追加：

```ts
  it('terminal_wait_for returns skipped (schema-valid) when the registry reports a user skip', async () => {
    const { captured, registry } = mount()
    const tool = toolOf(captured, 'terminal_wait_for')
    registry.nextWaitResult = { kind: 'skipped' }
    const value = await tool.execute({ uuid: 'uuid-1', needle: 'BUILD_OK', timeout_ms: 1000 }, exec('s1'))
    expect(value).toEqual({ kind: 'skipped', needle: 'BUILD_OK' })
    expect(validateJsonSchemaValue(tool.output.schema, value, 'value')).toEqual([])
  })

  it('terminal_wait_for render describes the user skip and the needle', () => {
    const { captured } = mount()
    const tool = toolOf(captured, 'terminal_wait_for')
    const blocks = tool.output.render({}, { kind: 'skipped', needle: 'BUILD_OK' }) as Array<{ type: string; text: string }>
    expect(blocks[0]!.type).toBe('text')
    expect(blocks[0]!.text).toContain('Skipped by user')
    expect(blocks[0]!.text).toContain('BUILD_OK')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/tools.spec.ts`
Expected: FAIL（schema 拒绝 skipped / render 走到 exited 分支输出不符）。

- [ ] **Step 3: 实现**

(a) `src/tools.ts` terminal_wait_for：

描述末尾（`'The wait is cooperative: ...'` 句之后）追加一句：

```ts
      + 'The user can skip the wait from the sidebar ( a banner on the terminal\'s tab shows the needle and a skip button ) — the tool then returns `skipped`.',
```

output.schema 的 `oneOf` 数组末尾（exited 分支对象之后）追加：

```ts
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'skipped' },
              needle: { type: 'string', required: true },
            },
          },
```

render 的 value 类型与分支 —— `const v = value as { kind: 'found' | 'timeout' | 'exited' | 'skipped'; ... }`（原行加 `'skipped'`），并在 timeout 分支后插入：

```ts
        if (v.kind === 'skipped') {
          return [{ type: 'text', text: `Skipped by user while waiting for "${v.needle}" — the wait ended early. Call terminal_read to inspect the transcript and decide how to proceed.` }]
        }
```

(b) `src/index.ts` buildApi 表，`'agent-pty.close'` 条目（约 541-545 行）之后追加：

```ts
    // The sidebar wait banner's skip button: abort every active
    // terminal_wait_for on one agent terminal. Idempotent — 0 when nothing
    // is waiting (a stale banner racing a wait that already resolved).
    // Degraded mode (node-pty unavailable) has no registry and no waits: an
    // honest ok.
    'agent-pty.skip-wait': (payload) => {
      const uuid = requireString(payload, 'uuid')
      return { ok: true, skipped: agentPtyRegistry?.skipWait(uuid) ?? 0 }
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/tools.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/index.ts tests/tools.spec.ts
git commit -m "feat(terminal): terminal_wait_for 增 skipped 结果与 agent-pty.skip-wait 路由"
```

---

### Task 3: 客户端状态 `agentWaits` 镜像 + 推送类型

**Files:**
- Modify: `src/client/state.ts`（SidebarState 接口 ~121 行、makeDefaultState ~221 行、sanitizeState ~1283 行、reconcileAgentTerminals ~1017 行）
- Modify: `src/client/sidebar/use-host-feeds.ts`（~66 行解析类型）
- Test: `tests/agent-terminal-reconcile.spec.ts`

**Interfaces:**
- Consumes: 宿主推送数组（Task 1 的 snapshot 含 `waiting`）。
- Produces:
  - `SidebarState.agentWaits: Record<string, { needle: string; since: number }>`（uuid → 活动等待；瞬态，不持久化）
  - `reconcileAgentTerminals(state, list)` 的 list 元素增 `waiting?: { needle: string; since: number } | null`，并把等待状态镜像进 `agentWaits`（仅等待变化也产出新状态）。

- [ ] **Step 1: 写失败测试**

`tests/agent-terminal-reconcile.spec.ts` 追加两个用例（沿用文件现有 import，无需新增）：

```ts
  it('mirrors the pushed waiting state into agentWaits and clears it when it ends', () => {
    let s = makeDefaultState()
    s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'busy', waiting: { needle: 'READY_1', since: 42 } }])
    expect(s.agentWaits['aaa-111']).toEqual({ needle: 'READY_1', since: 42 })
    // The next push without waiting drops the entry (the push is authoritative).
    s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'stable' }])
    expect(s.agentWaits['aaa-111']).toBeUndefined()
  })

  it('produces a new state when ONLY the wait state changes (no tab add/remove)', () => {
    let s = makeDefaultState()
    s = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'stable' }])
    const before = s
    const next = reconcileAgentTerminals(s, [{ uuid: 'aaa-111', title: 'stable', waiting: { needle: 'N', since: 1 } }])
    expect(next).not.toBe(before)
    expect(next.agentWaits['aaa-111']).toBeDefined()
    // Idempotent: the same push again returns the same reference.
    expect(reconcileAgentTerminals(next, [{ uuid: 'aaa-111', title: 'stable', waiting: { needle: 'N', since: 1 } }])).toBe(next)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/agent-terminal-reconcile.spec.ts`
Expected: FAIL（`agentWaits` 不存在 → TS 错误 / 断言失败）。

- [ ] **Step 3: 实现**

(a) `SidebarState` 接口 `floats: FloatWindow[]` 之后追加：

```ts
  /**
   * Live agent-terminal wait state (uuid → the wait the model currently
   * blocks on in `terminal_wait_for`), mirrored from the host's
   * agent-terminals push. Transient by design: sanitizeState never restores
   * it, so a reload starts clean and the next push (sent immediately on WS
   * attach) repopulates it.
   */
  agentWaits: Record<string, { needle: string; since: number }>
```

(b) `makeDefaultState` 的返回字面量 `floats: [],` 之后加 `agentWaits: {},`。

(c) `sanitizeState` 的返回字面量 `floats,` 之后加（带注释）：

```ts
    // The agent wait state is TRANSIENT (like revealed): never restored from
    // storage — the host's first push after attach repopulates it.
    agentWaits: {},
```

(d) `reconcileAgentTerminals`：参数类型改为

```ts
  agentTerminals: ReadonlyArray<{ uuid: string; title: string; waiting?: { needle: string; since: number } | null }>,
```

在 `const toRemove = ...` 之后、`if (toAdd.length === 0 && toRemove.length === 0) return state` 处，替换为：

```ts
  // Mirror the live wait state from the push (authoritative: a vanished
  // waiting field simply drops the entry). A waits-only change must still
  // produce a new state — the tab add/remove no-change check alone would
  // swallow banner updates.
  const serverWaits: Record<string, { needle: string; since: number }> = {}
  for (const terminal of agentTerminals) {
    if (terminal.waiting !== undefined && terminal.waiting !== null) {
      serverWaits[terminal.uuid] = { needle: terminal.waiting.needle, since: terminal.waiting.since }
    }
  }
  if (toAdd.length === 0 && toRemove.length === 0 && sameAgentWaits(state.agentWaits, serverWaits)) return state
```

文件末尾的 `return next` 改为 `return { ...next, agentWaits: serverWaits }`。

在 `reconcileAgentTerminals` 前方新增辅助函数：

```ts
/** Shallow equality of two agent-wait maps (same keys, same needle+since). */
function sameAgentWaits(
  a: SidebarState['agentWaits'] | undefined,
  b: Record<string, { needle: string; since: number }>,
): boolean {
  if (a === undefined) return Object.keys(b).length === 0
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    const av = a[key]
    const bv = b[key]
    if (av === undefined || bv === undefined) return false
    if (av.needle !== bv.needle || av.since !== bv.since) return false
  }
  return true
}
```

(e) `src/client/sidebar/use-host-feeds.ts` 66 行的解析类型改为：

```ts
          const list = JSON.parse(event.data) as Array<{ uuid: string; title: string; command: string; exited: boolean; waiting?: { needle: string; since: number } | null }>
```

- [ ] **Step 4: 跑测试确认通过 + 全仓 typecheck（状态字段新增会暴露遗漏的构造点）**

Run: `pnpm exec vitest run tests/agent-terminal-reconcile.spec.ts && pnpm typecheck`
Expected: PASS。若 typecheck 报其他 `SidebarState` 字面量缺 `agentWaits`（tests 里的手搓状态），补 `agentWaits: {}` —— **只许改测试里测试自己构造的字面量，不许改上游断言逻辑**。

- [ ] **Step 5: Commit**

```bash
git add src/client/state.ts src/client/sidebar/use-host-feeds.ts tests/agent-terminal-reconcile.spec.ts
git commit -m "feat(sidebar): 镜像 agent 终端等待状态到 agentWaits（瞬态）"
```

---

### Task 4: 等待 banner 组件 + TerminalView 接线 + api 方法 + i18n + CSS

**Files:**
- Create: `src/client/TerminalWaitBanner.tsx`
- Modify: `src/client/TerminalView.tsx`（render 区 ~387-408 行 + 组件顶部订阅）
- Modify: `src/client/api.ts`（`agentPtyClose` 之后 ~348 行）
- Modify: `src/client/locales.ts`（zh ~117 / en ~567，紧随 `terminalRetry`）
- Modify: `src/client/locales-ja.ts`（~105，紧随 `terminalRetry`）
- Modify: `src/client/sidebar.module.css`（`.terminalBanner` 块之后 ~2202 行）
- Test: `tests/terminal-wait-banner.spec.tsx`（新建）

**Interfaces:**
- Consumes: Task 2 的 `agent-pty.skip-wait` 路由；Task 3 的 `state.agentWaits`；`api` 对象、`t()`、`css` module。
- Produces: `TerminalWaitBanner({ needle: string; onSkip: () => void })` + `truncateNeedle(needle: string): string`（80 字符截断）；词典键 `terminalWaitBanner` / `terminalSkipWait`。

- [ ] **Step 1: 写失败测试（新文件 `tests/terminal-wait-banner.spec.tsx`）**

```tsx
/**
 * TerminalWaitBanner unit tests: localized text with the needle, the skip
 * button wiring, and the long-needle display cap (full text stays on the
 * title attribute). The component imports no xterm — renderable in plain
 * jsdom (the repo's jsdom pattern, see bottom-auto-terminal.spec.tsx head).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { TerminalWaitBanner } from '../src/client/TerminalWaitBanner.tsx'

describe('TerminalWaitBanner', () => {
  const mounted: Array<{ root: Root; container: HTMLDivElement }> = []
  function mount(needle: string, onSkip: () => void): HTMLDivElement {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(TerminalWaitBanner, { needle, onSkip })) })
    mounted.push({ root, container })
    return container
  }
  afterEach(() => {
    for (const { root, container } of mounted.splice(0)) {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('shows the localized waiting text with the needle and a working skip button', () => {
    let skipped = 0
    const container = mount('BUILD_OK', () => { skipped += 1 })
    // jsdom navigator.language is en-US → the en dictionary applies.
    expect(container.textContent).toContain('Agent is waiting for')
    expect(container.textContent).toContain('BUILD_OK')
    expect(container.textContent).toContain('Skip wait')
    const button = container.querySelector('button')
    expect(button).not.toBeNull()
    act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(skipped).toBe(1)
  })

  it('truncates a long needle for display but keeps the full text on the title', () => {
    const long = 'X'.repeat(200)
    const container = mount(long, () => {})
    const span = container.querySelector('span[title]')
    expect(span).not.toBeNull()
    expect(span!.getAttribute('title')).toBe(long)
    expect((span!.textContent ?? '').length).toBeLessThanOrEqual(80)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/terminal-wait-banner.spec.tsx`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

(a) 新建 `src/client/TerminalWaitBanner.tsx`：

```tsx
/**
 * The "Agent 正在等待 {needle}" wait banner: rendered at the top of an
 * agent-owned terminal's view while the model blocks in terminal_wait_for.
 * The skip button asks the host to abort every active wait on the terminal
 * (`agent-pty.skip-wait`); the banner disappears when the host's next
 * agent-terminals push drops the waiting field — no optimistic UI. Kept in
 * its own module (no xterm imports) so jsdom tests can render it directly.
 */
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Cap the needle shown inline; the full text rides the title tooltip. */
const NEEDLE_DISPLAY_CAP = 80

/** Truncate one needle for inline display (title attr carries the full text). */
export function truncateNeedle(needle: string): string {
  return needle.length > NEEDLE_DISPLAY_CAP ? `${needle.slice(0, NEEDLE_DISPLAY_CAP - 1)}…` : needle
}

export function TerminalWaitBanner(props: { needle: string; onSkip: () => void }) {
  const { needle, onSkip } = props
  return (
    <div className={css.terminalWaitBanner}>
      <span className={css.terminalWaitNeedle} title={needle}>
        {t('terminalWaitBanner', { needle: truncateNeedle(needle) })}
      </span>
      <button type="button" className={css.terminalRetry} onClick={onSkip}>
        {t('terminalSkipWait')}
      </button>
    </div>
  )
}
```

(b) `src/client/api.ts`：`agentPtyClose` 条目之后追加：

```ts
  /** Skip every active terminal_wait_for on one agent terminal (the wait
   *  banner's skip button). Idempotent: {skipped:0} when none is active. */
  agentSkipWait: (uuid: string) =>
    call<{ ok: true; skipped: number }>('agent-pty.skip-wait', { uuid }),
```

(c) `src/client/locales.ts`：zh 词典 `terminalRetry: '重试',` 行后加：

```ts
  terminalWaitBanner: 'Agent 正在等待 {needle}',
  terminalSkipWait: '跳过等待',
```

en 词典 `terminalRetry: 'Retry',` 行后加：

```ts
  terminalWaitBanner: 'Agent is waiting for {needle}',
  terminalSkipWait: 'Skip wait',
```

(d) `src/client/locales-ja.ts`：`terminalRetry: '再試行',` 行后加（仓库规则：新 zh 键必须同步 ja）：

```ts
  terminalWaitBanner: 'エージェントが {needle} を待機中',
  terminalSkipWait: '待機をスキップ',
```

(e) `src/client/sidebar.module.css`：`.terminalBannerUrl` 块之后加：

```css
/* The "Agent 正在等待 {needle}" wait banner: a warn-toned strip above the
   terminal surface while the model blocks in terminal_wait_for; the needle
   ellipsizes inline and the full text rides the title tooltip. */
.terminalWaitBanner {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  font: var(--dsw-font-xxxs-11);
  color: var(--dsw-alias-state-warn-label);
  background: var(--dsw-alias-state-warn-tertiary);
}

.terminalWaitNeedle {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

(f) `src/client/TerminalView.tsx`：

imports 区追加：

```ts
import { TerminalWaitBanner } from './TerminalWaitBanner.tsx'
```

组件体内（`const [lastUrl, setLastUrl] = ...` 之后）加等待订阅：

```ts
  // Agent terminals only: the model's active terminal_wait_for (mirrored
  // from the host's agent-terminals push into the store) drives the wait
  // banner. Read + subscribe like the font prefs above; the banner vanishes
  // when the host's push drops the waiting field (skip / exit / abort all
  // converge through the same push). getSnapshot() is {sessionId, state?,
  // prefs} — the state may be briefly undefined around session switches.
  const agentUuid = isAgentTabId(tabId) ? agentUuidOf(tabId) : null
  const [waiting, setWaiting] = useState<{ needle: string; since: number } | undefined>(undefined)
  useEffect(() => {
    if (agentUuid === null) return
    const read = (): void => {
      const next = store.getSnapshot().state?.agentWaits?.[agentUuid]
      setWaiting(prev => {
        const nextValue = next === undefined ? undefined : { needle: next.needle, since: next.since }
        if (prev?.needle === nextValue?.needle && prev?.since === nextValue?.since) return prev
        return nextValue
      })
    }
    read()
    return store.subscribe(read)
  }, [agentUuid, store])
```

return JSX 中 `<div className={css.terminalWrap}>` 的第一个子元素位置（`depsFatal` 条目之前）加：

```tsx
      {agentUuid !== null && waiting !== undefined && (
        <TerminalWaitBanner
          needle={waiting.needle}
          onSkip={() => { void api.agentSkipWait(agentUuid).catch(() => { /* 跳过失败时 banner 留存，可重试 */ }) }}
        />
      )}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/terminal-wait-banner.spec.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/client/TerminalWaitBanner.tsx src/client/TerminalView.tsx src/client/api.ts src/client/locales.ts src/client/locales-ja.ts src/client/sidebar.module.css tests/terminal-wait-banner.spec.tsx
git commit -m "feat(sidebar): agent 终端等待 banner（needle + 跳过等待按钮）"
```

---

### Task 5: tab 标题 ⏳ 徽章（shell 层特例）+ jsdom 链路测试

**Files:**
- Modify: `src/client/Sidebar.tsx`（`tabBadgeOf` ~828-841 行）
- Test: `tests/agent-wait-badge.spec.tsx`（新文件，harness 照抄 `tests/bottom-auto-terminal.spec.tsx` 1-97 行的模式）

**Interfaces:**
- Consumes: Task 3 的 `state.agentWaits`；`isAgentTabId` / `agentUuidOf`（Sidebar.tsx 已 import，第 38-39 行）。
- Produces: agent tab 的 ⏳ 徽章 pill（复用 `css.tabBadge`）；推送 → 状态 → 徽章全链路。

- [ ] **Step 1: 写失败测试（新文件 `tests/agent-wait-badge.spec.tsx`）**

完整文件（FakeWebSocket 记录 url 与实例，驱动 `/sidebar/ws/agent-terminals` 推送；`registerStubTerminal` 防止懒加载 chunk 在 jsdom 里拉真实 bundle）：

```tsx
/**
 * The agent-terminal wait badge chain, end to end in jsdom: the host's
 * agent-terminals push (mirroring the real /sidebar/ws/agent-terminals
 * frames) reconciles tabs AND the wait map; the shell's tabBadgeOf renders
 * the hourglass pill on the agent tab while a wait is live and drops it
 * when the push clears. Harness mirrors tests/bottom-auto-terminal.spec.tsx
 * (real Sidebar shell + fake context + stubbed WebSocket).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { Sidebar } from '../src/client/Sidebar.tsx'
import { createSidebarStore, openTabInActivePane } from '../src/client/state.ts'
import { createBetterSidebarService, type BetterSidebarService } from '../src/client/service.ts'

/** jsdom has no WebSocket; the agent-terminals push effect constructs one on mount. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = (): void => {}
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
}

let sessionSeq = 0

function mountSidebar(): { container: HTMLDivElement; store: ReturnType<typeof createSidebarStore>; service: BetterSidebarService; unmount: () => void } {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  FakeWebSocket.instances = []
  const container = document.createElement('div')
  document.body.append(container)
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // Replace the terminal descriptor with a stub: the real one lazy-loads the
  // xterm chunk, which jsdom cannot fetch — the badge under test renders in
  // the TAB STRIP, independent of the view component.
  service.registerTab({
    id: 'terminal',
    title: () => 'Terminal',
    component: () => null,
  })
  const sessionId = `s1-${++sessionSeq}`
  store.setSession(sessionId)
  // Stub the terminal descriptor: the real one lazy-loads the xterm chunk,
  // which jsdom cannot fetch (the bottom-auto-terminal harness does the same).
  service.registerTab({
    id: 'terminal',
    title: () => 'Terminal',
    component: () => null,
  })
  const localeSnapshot = { active: 'en' }
  const sessionsSnapshot = {
    current: sessionId,
    byId: { [sessionId]: { cwd: '/tmp' } },
  }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  }
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx: ctx as never, store })) })
  return {
    container,
    store,
    service,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

let sessionSeq = 0

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  vi.unstubAllGlobals()
})

/** The agent-terminals push socket the shell opened for the current session. */
function feedsSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.find(candidate => candidate.url.includes('/sidebar/ws/agent-terminals'))
  if (socket === undefined) throw new Error('agent-terminals socket not connected')
  return socket
}

describe('agent terminal wait badge (push → state → tab pill)', () => {
  it('shows ⏳ on the agent tab while a wait is active and drops it when it ends', () => {
    const { container } = mountSidebar()
    const terminal = { uuid: 'u1', title: 'dev server', command: '', exited: false }
    // First push: the agent tab lands in the active pane.
    act(() => { feedsSocket().onmessage?.({ data: JSON.stringify([terminal]) }) })
    expect(container.textContent).toContain('dev server')
    expect(container.textContent).not.toContain('⏳')
    // Second push carries a live wait → the hourglass pill appears.
    act(() => { feedsSocket().onmessage?.({ data: JSON.stringify([{ ...terminal, waiting: { needle: 'READY_1', since: 1 } }]) }) })
    expect(container.textContent).toContain('⏳')
    // The wait resolved (skip/exit/abort all converge to a waiting-less push).
    act(() => { feedsSocket().onmessage?.({ data: JSON.stringify([terminal]) }) })
    expect(container.textContent).not.toContain('⏳')
  })

  it('shows ⏳ only on agent tabs, never on UI-owned terminal tabs', () => {
    const { container, store } = mountSidebar()
    // A UI-owned terminal tab (id NOT agent:) lives in the strip too; the
    // badge lookup keys on the agent uuid, so it never badges.
    act(() => { store.reduce(s => openTabInActivePane(s, { id: 'terminal:manual-1', type: 'terminal', title: 'UI terminal' })) })
    const terminal = { uuid: 'u1', title: 'dev server', command: '', exited: false }
    act(() => { feedsSocket().onmessage?.({ data: JSON.stringify([{ ...terminal, waiting: { needle: 'READY_1', since: 1 } }]) }) })
    // Exactly ONE hourglass: the agent tab. (Counted from textContent — CSS
    // module class names are not stable under the test transform.)
    expect((container.textContent.match(/⏳/g) ?? []).length).toBe(1)
    // The wait resolved → the pill disappears entirely.
    act(() => { feedsSocket().onmessage?.({ data: JSON.stringify([terminal]) }) })
    expect(container.textContent).not.toContain('⏳')
  })
})
```

> 实现注意：`sessionSeq` 声明放 `mountSidebar` 之前（与 bottom-auto-terminal.spec.tsx 相同的模块级写法）；`createSidebarStore` 返回类型直接用 `ReturnType<typeof createSidebarStore>`，勿手写接口。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run tests/agent-wait-badge.spec.tsx`
Expected: FAIL（⏳ 从不出现）。

- [ ] **Step 3: 实现 Sidebar.tsx 的 `tabBadgeOf` 特例**

`src/client/Sidebar.tsx` 828 行 `const tabBadgeOf = (tab: SidebarTab): ReactNode => {` 函数体开头（descriptor 查找之前）插入：

```ts
    // Agent-terminal wait indicator (sidebar-internal, deliberately NOT a
    // TabDescriptor.badge — that API is type-keyed and shared with external
    // plugins, and cannot address one tab): the agent-terminals push mirrors
    // the model's live terminal_wait_for into state.agentWaits; an agent tab
    // whose uuid is waiting shows the hourglass pill.
    if (isAgentTabId(tab.id)) {
      const wait = state.agentWaits?.[agentUuidOf(tab.id)]
      if (wait !== undefined) return <span className={css.tabBadge}>{'⏳'}</span>
    }
```

（`isAgentTabId` / `agentUuidOf` 已在 38-39 行 import；`css` / `state` 均在作用域内。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run tests/agent-wait-badge.spec.tsx`
Expected: PASS（2 个用例）。

- [ ] **Step 5: Commit**

```bash
git add src/client/Sidebar.tsx tests/agent-wait-badge.spec.tsx
git commit -m "feat(sidebar): agent 终端 tab 标题在等待时显示 ⏳ 徽章"
```

---

### Task 6: 设计文档偏差记录 + 全量验证 + 推送 + PR

**Files:**
- Modify: `docs/plans/2026-09-09-terminal-wait-banner-design.md`（实施偏差记录节）
- 无代码改动。

- [ ] **Step 1: 更新设计文档**

在 `docs/plans/2026-09-09-terminal-wait-banner-design.md` 末尾追加：

```markdown

## 实施偏差记录

- **⏳ tab 徽章不走 `TabDescriptor.badge`**：实现时核实该 API 是 type-keyed
  （`badge(ctx, scope, state)`，无 tab 参数，external 插件共享），无法定位单个
  tab。改为 Sidebar 壳层 `tabBadgeOf` 的 sidebar-internal 特例（agent: tab 前缀
  判断 + `state.agentWaits` 查表），`service.ts` 与 external-plugin-guide.md
  零改动。
- **banner 抽为独立组件 `TerminalWaitBanner.tsx`**：设计原文写在
  TerminalView.tsx 内；抽出后无 xterm 依赖，可直接被 jsdom 单测渲染
  （TerminalView 仍负责订阅 store 并接线 onSkip → api.agentSkipWait）。
- **设计文档随 feat 分支进 PR**：main 受分支保护，纯文档直推被 hook 拒绝
  （`4a6a77a` 随本分支合并）。
- **banner 配色**：仓库 CSS 无 state-info 令牌，沿用 `.terminalBanner` 的
  warn 对（`--dsw-alias-state-warn-label/-tertiary`），符合皮肤契约。
```

- [ ] **Step 2: 全量验证**

Run（依次，全绿才继续）：
`pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build`

Expected:
- lint: 0 error（历史上 CI 因 no-useless-assignment 挂过——新代码避免「先声明后必然覆盖」的写法）；
- test: 除已知的 win32 非回归失败集（bottom-auto-terminal / free-window / sidebar-auto-activation / sidebar-crash 等既有失败，对照 main 基线）外全绿，新增 spec 全部 PASS；
- build: lib/ 产物含新 chunk `client.js` 变化（TerminalWaitBanner 打进 client bundle）。

- [ ] **Step 3: 提交并推送**

```bash
git add docs/plans/2026-09-09-terminal-wait-banner-design.md
git commit -m "docs(plans): 终端等待 banner 实施偏差记录"
git push -u origin feat/wait-banner
```

- [ ] **Step 4: 建 PR**

```bash
gh pr create --repo omdsh-dev/DSH-better-sidebar --base main --head feat/wait-banner \
  --title "feat(terminal): 等待 banner + 跳过等待（terminal_wait_for skipped）" \
  --body "设计：docs/plans/2026-09-09-terminal-wait-banner-design.md（随本 PR）。agent 阻塞在 terminal_wait_for 时：对应终端卡片顶部显示「Agent 正在等待 {needle}」banner，右侧跳过按钮走 agent-pty.skip-wait；tab 标题 ⏳ 徽章；工具新增 {kind:'skipped'} 返回。"
```

- [ ] **Step 5: 等待 CI（用 terminal_wait_for 盯 `(ci|ci-windows|plugin-mount).*\((pass|fail)\)` 之类的多结局 needle，勿 sleep）**

Expected: 三个 job 全 pass。
