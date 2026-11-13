/**
 * Flat collection artwork shared by dense rows and the native guide.
 * No fixed palette or SVG ids: every layer rides a skin-owned alias via CSS.
 * It scales from dense 14–16px rows to the native guide's 22–26px seat.
 */
import type { ReactNode } from 'react'
import css from './artwork.module.css'

/** A collection of references: a warm back sheet, blue front and surface marks. */
export function CluePackArtwork({ size = 16, className }: {
  readonly size?: number
  readonly className?: string
}): ReactNode {
  return (
    <span className={`${css.artwork}${className === undefined ? '' : ` ${className}`}`} data-clue-artwork="pack" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 20 20" fill="none" focusable="false" aria-hidden="true">
        <path className={css.packBack} fill="currentColor" d="M2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
        <path className={css.packFront} fill="currentColor" d="M8 5h6l5 5v7a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
        <path className={css.packMark} fill="currentColor" d="M14 5v4a1 1 0 0 0 1 1h4Z" />
        <path className={css.packMark} stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" d="M9 13h7M9 16h4" />
      </svg>
    </span>
  )
}
