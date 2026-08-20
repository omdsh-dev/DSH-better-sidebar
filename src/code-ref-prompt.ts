/**
 * Optional system-prompt injection for code references (host half).
 *
 * DSH's agent prompt is assembled from ordered sections registered through
 * the `systemPrompt` service (`ctx.get('systemPrompt').section(...)`) — the
 * same seam `dsh-app-boot` uses for its harness-source section and every
 * tool plugin uses for its tool usage notes. We register ONE short section
 * asking the model to cite code as relative paths with line ranges — the
 * exact format the chat mention links (chat-mentions.ts) parse and the
 * sidebar editor jumps to.
 *
 * Deliberately defensive: the service may be absent (a deployment without
 * the prompt registry) or mount late — registration retries briefly and
 * degrades to a no-op. Config-gated (`codeRefPrompt`, default on).
 */

/** The one-line instruction (kept intentionally short). */
export const CODE_REF_PROMPT = 'When referencing code in your replies, cite files as relative paths with a line range when relevant, e.g. `src/main.ts:42-56`.'

/** The section name (namespaced, so no other plugin can collide). */
export const CODE_REF_PROMPT_SECTION = 'better-sidebar:code-references'

/** The structural face of the systemPrompt service we touch. */
export interface SystemPromptFace {
  section(section: { name: string; order: number; text: string }): () => void
}

/** How long (ms) registration retries while the service mounts. */
const RETRY_WINDOW_MS = 10_000
const RETRY_INTERVAL_MS = 1_000

/**
 * Register the code-reference prompt section once the `systemPrompt`
 * service is available. Returns a disposer (HMR-safe). A missing or late
 * service is not an error — registration simply never happens.
 */
export function registerCodeRefPrompt(
  getSystemPrompt: () => SystemPromptFace | undefined,
  logger?: { warn(message: string, ...args: unknown[]): void },
): () => void {
  let dispose: (() => void) | null = null
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined

  const tryRegister = (): void => {
    if (disposed || dispose !== null) return
    const systemPrompt = getSystemPrompt()
    if (systemPrompt === undefined) return
    try {
      dispose = systemPrompt.section({
        name: CODE_REF_PROMPT_SECTION,
        order: 90,
        text: CODE_REF_PROMPT,
      })
    } catch (error) {
      logger?.warn('[dsh-better-sidebar] systemPrompt.section failed:', error)
    }
  }

  tryRegister()
  if (dispose === null) {
    const started = Date.now()
    timer = setInterval(() => {
      if (Date.now() - started > RETRY_WINDOW_MS) {
        if (timer !== undefined) clearInterval(timer)
        timer = undefined
        return
      }
      tryRegister()
      if (dispose !== null && timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }, RETRY_INTERVAL_MS)
  }

  return () => {
    disposed = true
    if (timer !== undefined) clearInterval(timer)
    dispose?.()
  }
}
