/**
 * 让「终端字体」偏好也作用于 **DSH 自己的**终端（右侧栏那个 `ui-sidebar-terminal`）。
 *
 * 为什么需要它：宿主的终端把 `fontFamily` **写死**成 `monospace` / `ui-monospace, …`，
 * 没有任何字体设置项（0.2.0-rc.1 实读其 client bundle），所以插件无法通过 API 配置它 ——
 * 结果就是同一个 p10k/Powerline 提示符在底部工作台终端里正常、在右侧栏终端里是 tofu。
 *
 * 可行性来自渲染器：宿主终端用的是 xterm 的 **DOM 渲染器**（`DomRenderer`，无 webgl/canvas
 * addon），字体经 CSS 生效，因此一条 `!important` 规则可以覆盖它（canvas 渲染器就读不到了）。
 *
 * 生效范围与开关：
 * - 规则只读 CSS 变量 `--dsh-better-sidebar-terminal-font`；偏好为空时**不设置**该变量，
 *   整条声明失效 → 完全回落到宿主自己的字体（零副作用）；
 * - 偏好非空 → 变量带上同一套兜底栈，`.xterm-rows` / `.xterm-screen` 一起换字体，本插件的
 *   底部终端也落在同一份字体上（观感一致）。
 *
 * 已知取舍：xterm 用**初始化时的 options.fontFamily** 量字宽，而这里只改绘制字体，所以当
 * 所选字体与 `monospace` 的 ASCII 字宽不一致时可能出现列位轻微漂移（Nerd Font 的 mono 变体
 * 通常与 Menlo/Monaco 同宽，实测无感）。彻底的做法是宿主把字体做成设置项。
 */
import type { SidebarStore } from './state.ts'

/** 注入样式表的标记（幂等：同一 id 只注入一次）。 */
const STYLE_ID = 'dsh-better-sidebar-terminal-font'

/** 偏好非空时挂到 `documentElement` 上的字体变量。 */
export const TERMINAL_FONT_VAR = '--dsh-better-sidebar-terminal-font'

/** 与底部终端一致的兜底栈（变量值本身就是一份 `font-family` 值）。 */
const FALLBACK_STACK = 'ui-monospace, SFMono-Regular, Menlo, monospace'

/** 覆盖规则：宿主终端与本插件终端的行容器都命中。 */
const RULE = `.xterm .xterm-rows, .xterm .xterm-screen { font-family: var(${TERMINAL_FONT_VAR}) !important; }`

/**
 * 挂上终端字体覆盖：注入一次规则，并把偏好同步到 CSS 变量。
 * @param store - 侧边栏 store（读取 `terminalFontFamily` 并订阅其变化）。
 * @returns 清除订阅的 disposer（样式表与变量保留，插件卸载时由页面生命周期带走）。
 */
export function attachTerminalFontOverride(store: SidebarStore): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) === null) {
    const style = document.createElement('style')
    style.dataset.pluginCss = STYLE_ID
    style.textContent = RULE
    document.head.appendChild(style)
  }
  const apply = (): void => {
    const family = store.getPrefs().terminalFontFamily.trim()
    if (family === '') {
      document.documentElement.style.removeProperty(TERMINAL_FONT_VAR)
      return
    }
    // 字体族带空格必须加引号（`MesloLGS NF` 不加引号会被解析成多个族名）。
    document.documentElement.style.setProperty(TERMINAL_FONT_VAR, `"${family}", ${FALLBACK_STACK}`)
  }
  apply()
  return store.subscribe(apply)
}
