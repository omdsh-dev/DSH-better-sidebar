/**
 * Right-workbench fullscreen control exposed to editor headers. The shell
 * owns panel geometry; file tabs render the presentation action beside their
 * path input while tab creation stays in the pane-level tab strip.
 */
import { createContext } from 'react'

export interface WorkbenchToolbarActions {
  /** Whether the right workbench currently covers the conversation column. */
  codeFocus: boolean
  /** Fullscreen is unavailable in the narrow drawer presentation. */
  canCodeFocus: boolean
  /** Enter or leave the transient fullscreen presentation. */
  toggleCodeFocus: () => void
}

/** Null outside the right workbench (direct tests and bottom-panel tabs). */
export const WorkbenchToolbarContext = createContext<WorkbenchToolbarActions | null>(null)
