/**
 * The GitHub source revision (S3).
 *
 * It combines the resource's `updatedAt` with a fingerprint of the editable
 * content (title, body, state and the PR-only draft/merged flags). It is the
 * baseline of a best-effort "re-read, compare, then write" save; it is NOT a
 * GitHub ETag, `If-Match` value or server-side atomic CAS token, and nothing
 * may advertise it as one.
 *
 * The value is opaque to callers (only equality matters), so the exact
 * fingerprint construction may evolve — hence the `ghsb1-` prefix.
 */
import { createHash } from 'node:crypto'

/** The fields the revision fingerprints. */
export interface GithubRevisionFields {
  readonly updatedAt: string
  readonly title: string
  readonly body: string
  readonly state: string
  readonly isDraft?: boolean
  readonly merged?: boolean
  readonly stateReason?: string | null
}

/** Build the opaque save baseline of one read. */
export function githubRevisionOf(fields: GithubRevisionFields): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([
      fields.updatedAt,
      fields.title,
      fields.body,
      fields.state,
      fields.isDraft ?? false,
      fields.merged ?? false,
      fields.stateReason ?? null,
    ]))
    .digest('hex')
    .slice(0, 16)
  return `ghsb1-${fields.updatedAt}-${fingerprint}`
}
