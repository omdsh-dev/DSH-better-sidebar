/**
 * Shared React helpers for the component specs (tests/*.spec.tsx): the two
 * pieces of boilerplate every createRoot-based spec used to repeat inline —
 * - the React 18 act() environment flag, without which act() warns on every
 *   flush (setupReactAct(), idempotent, called at module scope per spec —
 *   vitest isolates each spec file in its own global, so per-file setup is
 *   required, exactly like the inlined statement it replaces),
 * - the detached-container render cycle (div → document.body.append →
 *   createRoot → act(render) → act(unmount) + container.remove), collected
 *   as renderRoot().
 *
 * Deliberately minimal: no querying DSL, no auto-cleanup registry, no new
 * dependencies. Specs with bespoke harnesses (domain fixtures around the
 * render, SSR renders, module-scoped container state) keep their own mounts.
 */
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

/**
 * Declare this file's environment as a React act() environment (React 18.2
 * reads the flag before flushing effects). Assigning `true` is idempotent,
 * so every spec may call it unconditionally at module scope.
 */
export function setupReactAct(): void {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
}

/** What renderRoot() hands back: the DOM container plus act()-wrapped controls. */
export interface RenderedRoot {
  /** The div renderRoot() appended to document.body. */
  container: HTMLDivElement
  /** The react-dom root, for direct render/unmount control if ever needed. */
  root: Root
  /** Re-render a new element tree under act(). */
  rerender: (next: ReactNode) => void
  /** Unmount under act() and drop the container from document.body. */
  unmount: () => void
}

/**
 * Render `node` into a detached div appended to document.body and flush the
 * initial commit under act() — the concurrent initial commit is flushed, so
 * the rendered tree is already in the DOM when renderRoot() returns.
 * rerender(next) re-renders under act(); unmount() unmounts under act() and
 * removes the container (call it once — like the per-spec mounts this
 * replaces, it is not guarded against double unmount).
 */
export function renderRoot(node: ReactNode): RenderedRoot {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(node) })
  return {
    container,
    root,
    rerender: (next: ReactNode): void => { act(() => { root.render(next) }) },
    unmount: (): void => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}
