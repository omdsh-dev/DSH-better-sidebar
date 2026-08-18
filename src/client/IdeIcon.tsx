/** IDE product marks sourced from the Simple Icons package. */
import type { ReactNode } from 'react'
import {
  siAndroidstudio,
  siClion,
  siCursor,
  siGoland,
  siIntellijidea,
  siPycharm,
  siRider,
  siSublimetext,
  siTrae,
  siVscodium,
  siWebstorm,
  siWindsurf,
  siXcode,
  siZedindustries,
  type SimpleIcon,
} from 'simple-icons'
import type { IdeId } from '../ide-catalog.ts'
import css from './IdeLauncherAction.module.css'
import { VSCODE_ICON_SRC } from './vscode-icon.ts'

/**
 * Simple Icons 16.x currently covers fourteen of the sixteen detected IDEs.
 * VS Code uses the user-supplied official-style SVG; Visual Studio is the
 * sole text fallback because it is not present in the current catalog.
 */
const SIMPLE_ICONS: Partial<Record<IdeId, SimpleIcon>> = {
  cursor: siCursor,
  windsurf: siWindsurf,
  zed: siZedindustries,
  vscodium: siVscodium,
  trae: siTrae,
  intellij: siIntellijidea,
  webstorm: siWebstorm,
  pycharm: siPycharm,
  goland: siGoland,
  clion: siClion,
  rider: siRider,
  'android-studio': siAndroidstudio,
  xcode: siXcode,
  'sublime-text': siSublimetext,
}

const FALLBACK_LABELS: Partial<Record<IdeId, string>> = {
  'visual-studio': 'VS',
}

/** Render the Simple Icons path with DSH's adaptive foreground color. */
export function IdeIcon({ id }: { id: IdeId }): ReactNode {
  if (id === 'vscode') {
    return (
      <img
        className={css.ideIcon}
        src={VSCODE_ICON_SRC}
        alt=""
        aria-hidden="true"
        draggable={false}
        data-ide-icon="vscode"
      />
    )
  }
  const icon = SIMPLE_ICONS[id]
  if (icon !== undefined) {
    return (
      <svg className={css.ideIcon} viewBox="0 0 24 24" aria-hidden="true" data-simple-icon={icon.slug}>
        <path fill="currentColor" d={icon.path} />
      </svg>
    )
  }
  return (
    <span className={`${css.ideIcon} ${css.ideFallback}`} aria-hidden="true">
      {FALLBACK_LABELS[id] ?? id.slice(0, 2).toUpperCase()}
    </span>
  )
}
