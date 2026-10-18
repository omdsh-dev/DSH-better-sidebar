/**
 * The chunk-resident bottom terminal (xterm lazy chunk): a light stub module
 * so the core-bundle descriptor can mount the terminal view without statically
 * pulling xterm (and the xterm stylesheet) into the startup path. The chunk
 * itself (src/client/chunks/terminal) loads on first render via
 * /sidebar/bundle.
 */
import type { ComponentType } from 'react'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import type { TerminalBottomProps } from './TerminalView.tsx'

/** The terminal view, deferred until its tab is first mounted. */
export const LazyTerminalBottom = lazyChunkComponent<TerminalBottomProps>(
  'terminal',
  (mod) => mod.TerminalBottomView as ComponentType<TerminalBottomProps> | undefined,
)
