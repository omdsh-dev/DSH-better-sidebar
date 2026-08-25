/**
 * Right-workbench controls exposed to editor headers. The shell owns panel
 * geometry and tab creation; file tabs only render the controls beside their
 * path input so the layout actions live where the user is working.
 */
import { createContext } from 'react'
import type { NewTabOption } from './TabBar.tsx'

export interface WorkbenchToolbarActions {
  /** Whether the right workbench currently covers the conversation column. */
  codeFocus: boolean
  /** Fullscreen is unavailable in the narrow drawer presentation. */
  canCodeFocus: boolean
  /** Enter or leave the transient fullscreen presentation. */
  toggleCodeFocus: () => void
  /** The same registered options shown by the tab strip's plus menu. */
  newTabOptions: NewTabOption[]
  /** Create the selected tab in the active right-workbench pane. */
  onNewTab: (optionId: string) => void
}

/** Null outside the right workbench (direct tests and bottom-panel tabs). */
export const WorkbenchToolbarContext = createContext<WorkbenchToolbarActions | null>(null)
