/**
 * The plan resource-address families — the address half of the plan takeover,
 * kept dependency-free so the native registration and the plan page can both
 * use it without importing each other. Mirrors resource-address.ts's split for
 * the file family.
 *
 * `dsh-resource://plan/<sessionId>/<callId>` is a logged plan invocation whose
 * document the host's resource provider resolves. `dsh-resource://plan-review/
 * <sessionId>/<requestId>` is a temporary review preview: it has no provider,
 * and its document rides the tab's navigation params.
 */

/** The logged-plan address family. */
export const PLAN_ADDRESS_PREFIX = 'dsh-resource://plan/'

/** The temporary review preview family (the document lives in params). */
export const PLAN_REVIEW_ADDRESS_PREFIX = 'dsh-resource://plan-review/'

/** The two glob patterns the native claim registers. */
export const PLAN_ADDRESS_PATTERN = `${PLAN_ADDRESS_PREFIX}**`
export const PLAN_REVIEW_ADDRESS_PATTERN = `${PLAN_REVIEW_ADDRESS_PREFIX}**`

/** Whether an address is the temporary review preview (no resource provider). */
export function isPlanReviewAddress(address: string): boolean {
  return address.startsWith(PLAN_REVIEW_ADDRESS_PREFIX)
}

/** Whether an address belongs to either plan family. */
export function isPlanResourceAddress(address: string): boolean {
  return address.startsWith(PLAN_ADDRESS_PREFIX) || isPlanReviewAddress(address)
}
