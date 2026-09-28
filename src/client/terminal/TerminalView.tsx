/**
 * 底部工作台的终端视图（懒加载 chunk 内，xterm 只进这个 chunk）。
 *
 * 本插件不再自带 PTY：这里只是**视图**，进程分配/恢复、外壳、重连、关闭清理
 * 全部走宿主公开的客户端服务 `ctx.webTerminals`（见 terminal/types.ts 里对
 * 契约的说明）。视图负责三件事：
 * 1. 把宿主送来的屏幕帧喂给 xterm，并按修订号确认（`acknowledge`）后才会收到
 *    下一帧；
 * 2. 把模拟器输入/尺寸变化回传给远端 PTY；
 * 3. 维护「进程身份」：首次挂载把宿主动分配的终端 id 写进 tab.meta（随布局
 *    持久化），刷新后按它重连同一进程；tab 真被关掉时才调 `close()` 收尾。
 *
 * 为什么要有 `visible`/`tabOpen` 这两件事：底部工作台卸载一个 tab 视图的原因
 * 可能是「会话切换/面板重挂载」（应保留进程），也可能是「用户关掉了 tab」
 * （应结束进程）。宿主侧同样以 `visible` 控制何时测量尺寸，这里照同一套语义。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TabComponentProps } from '../service.ts'
import { mintTabId, patchTab } from '../state.ts'
import { subscribeColorScheme } from '../theme.ts'
import { t } from '../locales.ts'
import { terminalTheme } from './theme.ts'
import type { TerminalState, TerminalTabMeta, TerminalViewFace, WebTerminalsFace } from './types.ts'
import css from './terminal.module.css'

/** 宿主要是这段 CSS 拿不到 code 字体时的兜底栈。 */
const FALLBACK_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** 计算后的代码字体栈（xterm 用 canvas 量字宽，CSS var() 在里面不生效）。 */
function codeFontFamily(): string {
  if (typeof document === 'undefined') return FALLBACK_FONT
  const token = getComputedStyle(document.documentElement).getPropertyValue('--ds-font-family-code').trim()
  return token === '' ? FALLBACK_FONT : `${token}, ${FALLBACK_FONT}`
}

/** 视图外壳需要展示的最小状态（变化时才 setState，避免帧率被 React 追上）。 */
interface Chrome {
  phase: string
  error?: string
}

/** 从宿主状态里的任意错误值提取可读文本。 */
function errorTextOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  const message = (value as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}

/** 宿主状态 → 视图外壳状态。 */
function chromeOf(state: TerminalState): Chrome {
  return { phase: state.phase, error: errorTextOf(state.error) }
}

/** 是否需要重画外壳（相位或错误文本变化）。 */
function sameChrome(a: Chrome, b: Chrome): boolean {
  return a.phase === b.phase && a.error === b.error
}

/** 终端是否处于可用/可写的稳定态。 */
function settled(state: { phase: string }): boolean {
  return state.phase === 'connected' || state.phase === 'disconnected'
}

/**
 * 底部终端正文。由描述符经 lazy-chunk 包装挂载，`props` 即 TabComponentProps。
 */
export function TerminalBody({ ctx, store, scope, tab, visible }: TabComponentProps): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<((state: TerminalState) => void) | null>(null)
  const liveRef = useRef<{ view: TerminalViewFace; contentId: string } | null>(null)
  const visibleRef = useRef(visible)
  // tab.meta 只在挂载时读一次（读进 effect 依赖会与 effect 内的持久化互相触发），
  // 重试时会先把它换成新的内容身份。
  const metaRef = useRef<TerminalTabMeta>((tab.meta ?? {}) as TerminalTabMeta)
  const [attempt, setAttempt] = useState(0)
  const [chrome, setChrome] = useState<Chrome>({ phase: 'idle' })

  useEffect(() => {
    const terminals = ctx.get('webTerminals') as unknown as WebTerminalsFace | undefined
    const host = hostRef.current
    if (terminals === undefined || typeof terminals.view !== 'function' || host === null) {
      setChrome({ phase: 'unavailable' })
      measureRef.current = null
      liveRef.current = null
      return
    }

    /** tab.meta 的持久化（宿主动分配的终端身份 + 内容身份）。 */
    const persist = (meta: TerminalTabMeta): void => {
      store.reduceFor(scope.sessionId, (state) => patchTab(state, tab.id, { meta }))
    }

    const meta = metaRef.current
    const contentId = meta.contentId ?? mintTabId()
    if (meta.contentId === undefined) persist({ contentId })
    // 传回宿主动身份时它会尝试重连那个进程（不存在则进入错误态，由重试按钮换新）。
    const view = terminals.view(scope.sessionId, tab.id, contentId, meta.hostId)
    liveRef.current = { view, contentId }
    if (meta.hostId !== view.id) {
      metaRef.current = { contentId, hostId: view.id }
      persist(metaRef.current)
    }

    const term = new Terminal({
      fontFamily: codeFontFamily(),
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5_000,
      cursorBlink: true,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    const offTheme = subscribeColorScheme(() => { term.options.theme = terminalTheme() })

    /** 可见且可写时才重新测量；不可写时对齐宿主给定的列宽行高。 */
    const measure = (state: TerminalState): void => {
      if (state.writable && visibleRef.current && host.clientWidth > 0 && host.clientHeight > 0) {
        fit.fit()
        view.resize(term.cols, term.rows)
        return
      }
      if (state.info !== undefined && !state.writable) term.resize(state.info.cols, state.info.rows)
    }
    measureRef.current = measure

    let lastRevision = -1
    const apply = (): void => {
      const state = view.state.getSnapshot()
      const render = state.render
      if (render !== undefined && render.revision > lastRevision) {
        lastRevision = render.revision
        const { frame } = render
        if (frame.type === 'snapshot') {
          term.reset()
          if (frame.info !== undefined) term.resize(frame.info.cols, frame.info.rows)
          term.write(frame.screen ?? '', () => { view.acknowledge(render.revision) })
        } else {
          term.write(frame.data ?? '', () => { view.acknowledge(render.revision) })
        }
      }
      // 未连接时禁用 stdin，避免把按键排进一个还没起来的 PTY。
      term.options.disableStdin = !state.writable
      measure(state)
      setChrome((prev) => (sameChrome(prev, chromeOf(state)) ? prev : chromeOf(state)))
    }

    const offState = view.state.subscribe(apply)
    const offData = term.onData((data) => { view.write(data) })
    const observer = new ResizeObserver(() => { measure(view.state.getSnapshot()) })
    observer.observe(host)
    // mount() 启动/恢复进程；detach() 只解除 DOM 生命周期，进程留在宿主那里。
    const detach = view.mount()
    apply()

    return () => {
      measureRef.current = null
      liveRef.current = null
      offState()
      offData.dispose()
      observer.disconnect()
      offTheme()
      detach()
      term.dispose()
      // 视图卸载 ≠ tab 关闭：会话切换/面板重挂载时进程与输出必须保留，
      // 只有布局里真的没有这个 tab 了才结束进程。
      if (!store.tabOpen(scope.sessionId, tab.id)) {
        terminals.close(scope.sessionId, tab.id, contentId, view.id)
      }
    }
  }, [ctx, store, scope.sessionId, tab.id, attempt])

  // 面板从折叠/后台回到前台时补一次测量（xterm 的尺寸只在有布局时才能算）。
  useEffect(() => {
    visibleRef.current = visible
    const live = liveRef.current
    if (visible && live !== null) measureRef.current?.(live.view.state.getSnapshot())
  }, [visible])

  /** 重试：结束失败的那个宿主终端，换一个内容身份让宿主分配新终端。 */
  const retry = (): void => {
    const terminals = ctx.get('webTerminals') as unknown as WebTerminalsFace | undefined
    const live = liveRef.current
    if (terminals !== undefined && live !== null) {
      terminals.close(scope.sessionId, tab.id, live.contentId, live.view.id)
    }
    // 先换掉 ref 里的内容身份（effect 会在下一轮按它重新 view()），再持久化并重挂。
    metaRef.current = { contentId: mintTabId() }
    store.reduceFor(scope.sessionId, (state) => patchTab(state, tab.id, { meta: metaRef.current }))
    setAttempt((current) => current + 1)
  }

  // 两种非正常态：失败（给重试）与建立中（只给文案）。连接成功且可写时状态行消失。
  const failed = chrome.phase === 'unavailable' || chrome.error !== undefined
  const busy = !failed && !settled(chrome)
  const statusText = chrome.error ?? (chrome.phase === 'unavailable' ? t('terminalError') : t('loading'))

  return (
    <div className={css.root}>
      <div ref={hostRef} className={css.host} />
      {failed ? (
        <div className={css.status}>
          <span className={`${css.statusText} ${css.error}`}>{statusText}</span>
          <button type="button" className={css.retry} onClick={retry}>{t('terminalRetry')}</button>
        </div>
      ) : null}
      {busy ? (
        <div className={css.status}><span className={css.statusText}>{t('loading')}</span></div>
      ) : null}
    </div>
  )
}


