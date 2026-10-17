/**
 * S8 derived-state copy, shared by the source table and the source config page.
 *
 * Both surfaces render the same `ClueSourceStatusKind` vocabulary; keeping the
 * key map in ONE place stops the two from drifting apart when a state is added
 * (the `Record` type makes the new state a compile error here).
 */
import type { CopyKey } from '../../locales.ts'
import type { ClueSourceStatusKind } from './status.ts'

/** The copy key of each derived source state. */
export const CLUE_SOURCE_STATUS_COPY: Record<ClueSourceStatusKind, CopyKey> = {
  unchecked: 'clueStateUnchecked',
  missing: 'clueStateMissing',
  incompatible: 'clueStateIncompatible',
  installing: 'clueStateInstalling',
  'not-configured': 'clueStateNotConfigured',
  'not-authorized': 'clueStateNotAuthorized',
  authorizing: 'clueStateAuthorizing',
  'auth-expired': 'clueStateAuthExpired',
  'request-failed': 'clueStateRequestFailed',
  ready: 'clueStateReady',
}
