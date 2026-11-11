/**
 * 一键关闭窗口：注册进 DSH 会话头 utilities（`conversation.session.header.utilities`），
 * 落在这一排的最靠里一席（工作台开关 10、dsh-context 诊断入口 20 之后）。
 *
 * 为什么是这个席位：宿主没有窗口标题栏/窗口控件插槽（list-slot 全集里只有
 * conversation.* / sidebar.* / settings.* / shell.* / main），macOS 走
 * `titleBarStyle: "hiddenInset"` 也没有原生关窗按钮，所以「关窗」只能挂在插件
 * 自己已有的面上；会话头 utilities 是插件本来就在用的同一排，入口落在 flow 里，
 * 不需要绝对定位或测量宿主控件。
 *
 * 为什么只在桌面渲染：关窗的唯一公开通道是宿主的 `shortcuts` 服务的
 * `closeWindow()`，它转发到 preload 的 `window.dshDesktop.keyboard.closeWindow(revision)`，
 * 再由主进程 `window.close()` 生效（主进程的 `window.on('close')` 会
 * preventDefault + hide，所以「关窗」等于收起窗口、不退出进程，与 App 的最小化到
 * 后台一致）。Web 部署里 `shortcuts` 服务也存在，但没有 keyboard 桥，
 * `closeWindow()` 必然 throw 'Desktop keyboard bridge unavailable'——因此用
 * preload 写在 `<html data-platform>` 上的桌面戳做判据，Web 下整个控件不渲染，
 * 不给用户一个点了只会报错的按钮。
 */
import { useState } from 'react'
import { IconCloseFillRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import { t } from '../locales.ts'
import css from '../sidebar.module.css'

/** 本控件在 `conversation.session.header.utilities` 里的 entry id。 */
export const CLOSE_WINDOW_ENTRY_ID = 'dsh-better-sidebar:close-window'

/** 控件的 testid；Web 部署下不存在（控件不渲染）。 */
export const CLOSE_WINDOW_ATTR = 'data-dsh-close-window'

/**
 * 当前页面是否跑在 Desktop 窗口里。
 *
 * 判据是 Electron preload 在页面加载前写到 `<html>` 上的 `data-platform`
 * （darwin | win32 | linux，见宿主 `lib/types/preload-platform.js` 的
 * `markDocumentPlatform()`）。Web 部署没有这个戳；welcome 窗口虽然也是 Electron，
 * 但它的 preload 不打这个戳，而且本插件本来也不在 welcome 窗口里运行。
 */
export function desktopWindowOpen(): boolean {
  // dataset 在 DOM 里是有索引签名的 DOMStringMap（读不到时给 undefined，
  // 但类型上写成了 string），这里显式放宽成 string | undefined 再判存在，
  // 避免把「没这个属性」和「空字符串」混为一谈。
  const platform = (document.documentElement.dataset as Record<string, string | undefined>)['platform']
  return platform !== undefined
}

/** `shortcuts` 服务上本控件唯一用到的方法。 */
type WindowCloseFace = { closeWindow(): Promise<void> }

/**
 * 点击时才读宿主服务，不在注册时缓存：
 * - `shortcuts` 可能比本插件晚激活（cordis 的服务按 inject 顺序上线）；
 * - Web 部署里服务也在，只是没有 keyboard 桥，要按方法是否存在来判断。
 *
 * `ctx.get(name, false)` 是显式读服务（不受 `inject` 声明限制），strict=false
 * 表示服务缺席时返回 undefined 而不是抛错；整段再兜一层 try，兼容不认识的宿主。
 */
function closeFaceOf(ctx: Context): WindowCloseFace | undefined {
  try {
    const face = ctx.get('shortcuts', false) as unknown
    if (typeof face !== 'object' || face === null) return undefined
    const close = (face as Record<string, unknown>)['closeWindow']
    if (typeof close !== 'function') return undefined
    // 把 this 绑回服务本身：closeWindow() 内部要读自己的 keyboard 与 revision。
    return { closeWindow: () => (close as () => Promise<void>).call(face) }
  } catch {
    return undefined
  }
}

/** slot inject 交给控件的东西：一个在活上下文上解析的关窗动作。 */
export interface CloseWindowProps {
  closeWindow: () => Promise<void>
}

/**
 * 会话头里的关窗按钮。
 *
 * 点击后先禁用（关窗是异步的：IPC 往返 + 主进程判断），失败时恢复并只打一条
 * 控制台错误——这个通道的失败几乎只发生在「窗口没有焦点」，而用户点按钮这件事
 * 本身就把焦点给了窗口，所以不值得为它再造一套浮层提示。
 */
export function CloseWindowButton(props: CloseWindowProps) {
  const [busy, setBusy] = useState(false)
  // Web 部署不渲染：没有 keyboard 桥，按钮点了只会 throw。
  if (!desktopWindowOpen()) return null
  const label = t('closeWindow')
  return (
    <Tooltip label={label} side="bottom" delayMs={500}>
      <button
        type="button"
        className={css.toggleButton}
        {...{ [CLOSE_WINDOW_ATTR]: '' }}
        aria-label={label}
        data-busy={busy ? 'true' : undefined}
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void props.closeWindow().catch((error: unknown) => {
            console.error('Window close failed', error)
            setBusy(false)
          })
        }}
      >
        <IconCloseFillRegular size={14} />
      </button>
    </Tooltip>
  )
}

/**
 * 注册关窗按钮；返回 disposer。
 *
 * `slots.inject` 而不是直接 register：这个 list 的声明由宿主 ui-conversation
 * 的父 entry 建立，本插件激活时可能还没上 ledger；声明塌掉再重建时回调会重跑。
 * `order: 30` 落在同一 list 的末尾：工作台开关是 10、dsh-context 的诊断入口是 20，
 * 关窗取最后一席——这一排紧挨着宿主右侧栏自己的折叠按钮（corner 单占席位），
 * 「关窗」作为最后动作放在最靠里侧是宿主右栏控件簇的习惯排法。
 */
export function registerCloseWindow(ctx: Context): () => void {
  return ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: CLOSE_WINDOW_ENTRY_ID,
    order: 30,
    registrant: 'dsh-better-sidebar',
    inject: () => ({
      closeWindow: async () => {
        const face = closeFaceOf(ctx)
        if (face === undefined) throw new Error('Desktop window close bridge unavailable')
        await face.closeWindow()
      },
    }),
  }, CloseWindowButton))
}
