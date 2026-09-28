/**
 * 宿主公开客户端终端面的最小镜像（`ctx.webTerminals`，由
 * `@deepseek-ai/dsh-api-terminal-controller` 的客户端半区提供）。
 *
 * 本插件不再自带 PTY：底部工作台的终端只是**视图**，进程分配、会话归属、
 * 外壳选择、断线重连、刷新恢复与关闭清理全部由宿主的这个服务负责。这里只
 * 镜像本插件实际使用到的字段，保持结构探测（服务缺失时整块类型不参与运行）。
 *
 * 契约细节（0.1.7 宿主实现核对）：
 * - `view(sessionId, key, contentId, terminalId?, shellPath?)` 以 `(sessionId,
 *   key)` 缓存视图，重复调用返回同一实例；`contentId` 是跨刷新稳定的内容
 *   身份，`terminalId` 是宿主终端身份（恢复已存在终端时传入，缺省表示新建）。
 * - `state` 是可订阅快照，`render` 携带待确认的屏幕帧：`frame.type ===
 *   'snapshot'` 时用 `frame.screen`（并先把列宽行高对齐 `frame.info`），否则
 *   用增量 `frame.data`；模拟器写完后必须 `acknowledge(revision)` 才会收到
 *   下一帧。
 * - `retainTabs` 是宿主「窗口保留」登记：宿主按 `(sessionId, contentId)`
 *   反查绑定，未登记且静默超时的终端会被宿主回收。
 */

/** 终端进程元数据（宿主 `TerminalInfo`）。 */
export interface TerminalInfo {
  id: string
  title?: string
  cols: number
  rows: number
}

/** 终端所在环境的上限（宿主 `environment`）。 */
export interface TerminalEnvironment {
  maxCols: number
  maxRows: number
  maxInputBytes?: number
}

/** 一帧待渲染的屏幕数据（宿主把远端流原样交给模拟器）。 */
export interface TerminalRenderFrame {
  /** `'snapshot'` 表示整屏重放，其余视为增量数据帧。 */
  type: string
  /** `type === 'snapshot'` 时的整屏内容。 */
  screen?: string
  /** 增量帧的字节。 */
  data?: string
  /** `type === 'snapshot'` 时的列宽行高。 */
  info?: { cols: number; rows: number }
}

/** 一帧加载了修订号的屏幕数据。 */
export interface TerminalRender {
  revision: number
  frame: TerminalRenderFrame
}

/** 终端视图的可观察状态。 */
export interface TerminalState {
  /** `idle` / `loading` / `creating` / `connecting` / `disconnected` 等宿主阶段。 */
  phase: string
  /** 当前是否可写（不可写时输入与尺寸回执都要跳过）。 */
  writable: boolean
  info?: TerminalInfo
  environment?: TerminalEnvironment
  title?: string
  render?: TerminalRender
  error?: unknown
  issue?: unknown
}

/** 宿主客户端快照存储的最小子集。 */
export interface TerminalStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 宿主终端视图（本插件只用到这些方法）。 */
export interface TerminalViewFace {
  /** 宿主终端身份；新建后写入 tab.meta，刷新时据此重连同一进程。 */
  readonly id: string
  readonly state: TerminalStore<TerminalState>
  /** 绑定 DOM 生命周期并启动/恢复进程；返回的 detach 保留进程。 */
  mount(): () => void
  /** 把模拟器输入发给远端 PTY。 */
  write(data: string): void
  /** 把测得的列宽行高告诉远端（宿主会按环境上限裁剪）。 */
  resize(cols: number, rows: number): void
  /** 确认已渲染的帧，放行下一帧。 */
  acknowledge(revision: number): void
}

/** 宿主发现的可用外壳。 */
export interface TerminalShellChoice {
  name: string
  path: string
  args?: readonly string[]
}

/** 窗口保留登记项：宿主 `reconcileHolds` 以 `(sessionId, contentId)` 反查。 */
export interface RetainedTerminalTab {
  sessionId: string
  /** 本插件的视图键（底部 tab id，或宿主右侧栏的原生 tab id）。 */
  tabId: string
  /** 与 `view()` 传入值一致的内容身份。 */
  contentId: string
  kind: string
}

/** `ctx.webTerminals` 的镜像面。 */
export interface WebTerminalsFace {
  view(sessionId: string, key: string, contentId: string, terminalId?: string, shellPath?: string): TerminalViewFace
  launchShells(sessionId: string, signal?: AbortSignal): Promise<{ shells: readonly TerminalShellChoice[]; selectedShell?: string }>
  selectShell(path: string): void
  close(sessionId: string, key: string, contentId: string, terminalId?: string): void
  recover(sessionId: string): Promise<readonly { id: string; title?: string }[]>
  retainTabs(tabs: readonly RetainedTerminalTab[]): void
}

/**
 * 本插件底部终端 tab 的 `meta`（随布局持久化，刷新后原样恢复）：
 * `contentId` 是宿主终端的稳定内容身份，`hostId` 是宿主进程身份——
 * 两者都在首次挂载时写入，之后刷新即重连同一个进程。
 */
export interface TerminalTabMeta {
  contentId?: string
  hostId?: string
}
