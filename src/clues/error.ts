/**
 * The fixed clue error vocabulary, in its own module on purpose.
 *
 * Both the host bundle (`lib/index.js`, through `wire.ts`) and the public
 * `./clues` artifact (`lib/clues.js`) need this class, and error identity is
 * `instanceof`-based: if each artifact bundled its own copy, a source plugin
 * that throws `ClueError` from `dsh-better-sidebar/clues` would be normalized
 * as an unknown failure by the host. `tsdown.config.ts` therefore externalizes
 * this module from the host bundle onto `./clues.js`, so both artifacts share
 * exactly one class object. Keep this file free of `node:*` imports as well as
 * of every other clue module (cycles would make that externalization fragile).
 */

/**
 * Fixed error categories of the clue surface. Transports never leak original
 * stdout/stderr, auth headers, tokens or environment secrets into these.
 */
export const CLUE_ERROR_CATEGORIES = [
  'source-missing',
  'dependency-missing',
  'dependency-incompatible',
  'auth-required',
  'permission-denied',
  'not-found',
  'unsupported',
  'rate-limited',
  'conflict',
  'cancelled',
  'timeout',
  'failed',
] as const

/** One fixed error category. */
export type ClueErrorCategory = (typeof CLUE_ERROR_CATEGORIES)[number]

/** One clue failure with its machine-readable category. */
export class ClueError extends Error {
  /**
   * @param category - the fixed failure category.
   * @param message - a safe, user-renderable message (never a token/stdout).
   * @param meta - optional non-secret structured context.
   */
  constructor(
    readonly category: ClueErrorCategory,
    message: string,
    readonly meta?: Record<string, string>,
  ) {
    super(message)
    this.name = 'ClueError'
  }
}

/** Whether a thrown value is a {@link ClueError}. */
export function isClueError(value: unknown): value is ClueError {
  return value instanceof ClueError
}
