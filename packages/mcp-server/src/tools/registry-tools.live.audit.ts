/**
 * @fileoverview Audit trail for private-registry writes (ADR-129)
 * @module @skillsmith/mcp-server/tools/registry-tools.live.audit
 * @see SMI-5882: red-team assessment, What Changes §4a — attribution absent on the MCP path
 * @see SMI-5822: a shared team license key identifies a team, not a person
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `published_by`.
 *
 * `private_registry_skills.published_by` is server-derived from `auth.uid()` (migration
 * 20260729000000). **`publish` itself now runs on the `user_jwt` path** (SMI-5949 Wave 2 Step 2,
 * D-7) — a real signed-in user's own Supabase JWT, not `SKILLSMITH_LICENSE_KEY` — precisely so
 * `auth.uid()` resolves to a person and `published_by` lands non-NULL. That is a deliberate
 * credential move, not an incidental one: D-6's self-approval check (`review_private_registry_
 * submission()`) can only refuse a submitter approving their own work if it can name the
 * submitter, and a shared team license key never could. `license`/`content_read` still exist as
 * distinct auth paths on OTHER private-registry operations — `list`/`get`/`getNamespace` remain
 * license-key (team-scoped, no person needed); `deprecate`/`undeprecate`/`getContent` were already
 * `user_jwt` before this change (SMI-5822/SMI-5905).
 *
 * A pre-D-7 service-role publish (an old client, or any path that still presented only a license
 * key) left `published_by` NULL, and this module's job was to record what WAS known — the team,
 * plus a one-way fingerprint of which license key was presented — rather than fabricate a
 * plausible-looking actor. That reasoning still holds for every operation that remains
 * license-key-scoped; it just no longer describes `publish`. `license_keys.user_id` was never a
 * usable substitute either way: a team's resolvable key is the single row the checkout webhook
 * created for the *purchaser*, then shared with the team, so it names the buyer rather than the
 * caller.
 *
 * Before this module existed, there were zero `audit_logs` writes on any private-registry path,
 * so an Enterprise customer asking "who published this" had no answer at all. `publish` now has
 * an exact one (a real `actorUserId`, same as `deprecate`/`undeprecate`); the license-key-scoped
 * operations still have the bounded one this module was built for: which key, which team, which
 * skill, when.
 *
 * ONE ACTOR PER PATH, NEVER THE WRONG ONE (cross-provider review finding #3).
 *
 * `deprecate`/`undeprecate`/`publish` all run through the signed-in user's own JWT, so the license
 * key does **not** authorize them — `private_registry_skills_admin_update` /
 * `private_registry_skills_member_insert` do, against a real `auth.uid()`. Writing
 * `license_key:<fingerprint>` as the `actor` for those rows would name a credential that had no
 * say in the decision, which is a materially misleading security record. The `actor` is therefore
 * chosen by `authPath`: the JWT's own subject on the `user_jwt` path, the key fingerprint on the
 * `license_key` path. When the JWT path cannot yield a subject the row says `user_jwt:unknown` —
 * explicitly unattributed, never attributed to the wrong principal. The fingerprint is still
 * recorded in `metadata` on both paths, because "which key was present" stays useful for
 * correlation even when it is not the authorizing credential.
 *
 * Fail-soft by construction: an audit write must never turn a successful publish into a failed
 * one. Failures are logged to stderr (the MCP transport's log channel) and swallowed.
 */

import { createHash } from 'node:crypto'
import { getSupabaseAdminClient } from '../supabase-client.js'
import { readLicenseKey } from './team-resolver.js'

/**
 * Registry operations worth an audit row.
 *
 * Metadata reads (`list`/`get`) are still deliberately not audited — they carry no file bytes.
 * `content_read` (SMI-5905 Wave 3) is: it is the operation that hands a team's packaged skill
 * content to a caller, so it gets the same coverage the mutations do. `event_type` and `action`
 * are byte-identical to what the `private-registry-get` Edge Function writes
 * (supabase/functions/private-registry-get/access.ts), so both transports land in one queryable
 * stream and neither can be audited without the other showing up in the same query.
 *
 * `approve`/`reject` (SMI-5949 Wave 2 Step 4, D-5) are the two terminal decisions
 * `review_private_registry_submission()` can write. `submissions` (the read side, D-5's other RPC)
 * is deliberately NOT here — it is a metadata read like `list`/`get`, not a mutation.
 */
export type RegistryAuditOperation =
  | 'publish'
  | 'deprecate'
  | 'undeprecate'
  | 'content_read'
  | 'approve'
  | 'reject'

/**
 * Which credential authorized the call.
 * - `license_key`: the shared team license key (team-scoped, no per-user identity).
 * - `user_jwt`: the signed-in user's own token, so RLS authorized it against a real `auth.uid()`.
 */
export type RegistryAuditAuthPath = 'license_key' | 'user_jwt'

export interface RegistryAuditEvent {
  operation: RegistryAuditOperation
  teamId: string
  skillId: string
  version?: string
  result: 'success' | 'denied' | 'not_found' | 'error'
  authPath: RegistryAuditAuthPath
  /**
   * The authenticated user's id (the JWT `sub`), on the `user_jwt` path only. Null/absent means
   * no subject could be read from the presented token — recorded as explicitly unattributed
   * rather than backfilled with the license-key actor, which did not authorize the call.
   */
  actorUserId?: string | null
  /**
   * SMI-5905 Wave 3: which of the two user-client getters authorized this call —
   * `getAdminUserClient()` or `getMemberUserClient()`. Recorded so the "no call site may use the
   * wrong one" invariant is observable in the audit trail itself, not only in a unit test.
   * Absent on the license-key path, which has no user role at all.
   */
  authRole?: 'admin' | 'member'
  /** Short reason for a non-success result. Never include credential material. */
  detail?: string
  /** Number of files handed to the caller. Count ONLY — never the filenames, never the bytes. */
  fileCount?: number
  /** The row's stored content_hash. A digest of SKILL.md, not the content itself. */
  contentHash?: string | null
}

/** Truncated so the audit row correlates keys without being a verification oracle for one. */
const FINGERPRINT_LENGTH = 12

/**
 * Upper bound on a decoded JWT payload, so a malformed or hostile token cannot turn this into an
 * unbounded `JSON.parse`. Real Supabase access tokens are well under 2 KB.
 */
const MAX_JWT_PAYLOAD_BYTES = 8192

/**
 * One-way fingerprint of the presented team credential.
 *
 * Correlates rows written by the same key (and matches nothing else) without storing the key or
 * anything that could be replayed. Returns null when no key is readable, so an absent credential
 * is recorded as absent rather than as some default bucket.
 *
 * SMI-6080: "the presented credential" is whatever `readLicenseKey()` resolved — a license key, or
 * `SKILLSMITH_API_KEY` when that fallback applied. Both hash into the same `license_keys.key_hash`
 * row, so a fingerprint stays a stable per-key correlator either way; it just no longer implies the
 * caller configured `SKILLSMITH_LICENSE_KEY` specifically.
 */
export function licenseKeyFingerprint(licenseKey?: string): string | null {
  const key = readLicenseKey(licenseKey)
  if (!key) return null
  // codeql[js/insufficient-password-hash] Not password storage — a truncated,
  // one-way correlation fingerprint for audit rows (see doc comment above).
  // SMI-6080 added SKILLSMITH_API_KEY as a second possible source for `key`,
  // which is why this line is newly flagged; the same rationale that already
  // applies to the SKILLSMITH_LICENSE_KEY path applies unchanged to it too —
  // both hash into the identical license_keys.key_hash lookup, and neither
  // is ever compared against a stored hash to authenticate anything. Calls
  // node:crypto directly (not the shared sha256Hex() journal-chain helper)
  // so this inline suppression sits at CodeQL's actual flagged sink — going
  // through the shared wrapper reports the alert inside journal/hash.ts
  // instead, a generic multi-purpose utility where a blanket suppression
  // would be both wrong (too broad) and ineffective (wrong file).
  return createHash('sha256').update(key).digest('hex').slice(0, FINGERPRINT_LENGTH)
}

/**
 * Read the `sub` (user id) claim out of a Supabase access token, for audit attribution.
 *
 * Deliberately does NOT verify the signature, and must never be used to authorize anything. It is
 * only ever called on a token this process is *already presenting* to PostgREST, which verifies
 * the signature itself before RLS resolves `auth.uid()` from the same claim. So for a row whose
 * `result` is `success` or `denied`, the value recorded here is the identity the database actually
 * evaluated; for `error` it is the identity that was claimed. Either way it is strictly more
 * accurate than naming a license key that authorized nothing.
 *
 * @param accessToken - a Supabase user access token (`skillsmith login`, SMI-4402)
 * @returns the `sub` claim, or null when the token is not a decodable three-part JWT
 */
export function accessTokenSubject(accessToken: string): string | null {
  const parts = accessToken.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const decoded = Buffer.from(parts[1], 'base64url').toString('utf8')
    if (decoded.length === 0 || decoded.length > MAX_JWT_PAYLOAD_BYTES) return null
    const payload = JSON.parse(decoded) as { sub?: unknown }
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null
  } catch {
    // A credential we cannot decode is recorded as unattributed, not as some other principal.
    return null
  }
}

/**
 * Pick the `actor` string for one audit row.
 *
 * The authorizing credential differs per path, so the actor must too — see the module docstring.
 */
function resolveActor(event: RegistryAuditEvent, fingerprint: string | null): string {
  if (event.authPath === 'user_jwt') {
    return event.actorUserId ? `user:${event.actorUserId}` : 'user_jwt:unknown'
  }
  // No user identity exists on the license-key path — say so explicitly rather than leaving
  // `actor` NULL, which would be indistinguishable from "never recorded".
  return fingerprint ? `license_key:${fingerprint}` : 'license_key:unknown'
}

interface AuditInsertClient {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => PromiseLike<{ error: { message?: string } | null }>
  }
}

/**
 * Write one `audit_logs` row for a private-registry mutation.
 *
 * Never throws: the caller's operation has already succeeded or failed on its own terms, and an
 * audit-transport problem must not change that outcome.
 */
export async function recordRegistryAudit(event: RegistryAuditEvent): Promise<void> {
  try {
    const fingerprint = licenseKeyFingerprint()
    const client = (await getSupabaseAdminClient()) as AuditInsertClient
    const resource = event.version
      ? `private_registry_skills/${event.teamId}/${event.skillId}@${event.version}`
      : `private_registry_skills/${event.teamId}/${event.skillId}`

    const { error } = await client.from('audit_logs').insert({
      event_type: `private_registry:${event.operation}`,
      actor: resolveActor(event, fingerprint),
      resource,
      action: event.operation,
      result: event.result,
      metadata: {
        team_id: event.teamId,
        skill_id: event.skillId,
        version: event.version ?? null,
        auth_path: event.authPath,
        // Kept on BOTH paths: on the user_jwt path the key is no longer the actor, but "which key
        // was present when this ran" is still the only way to correlate a user's admin action with
        // the team key their session was configured with.
        license_key_fingerprint: fingerprint,
        actor_user_id: event.actorUserId ?? null,
        auth_role: event.authRole ?? null,
        // Distinguishes these rows from the `private-registry-get` Edge Function's, which write
        // the same event_type with `transport: 'edge_function'` (SMI-5905 Wave 2).
        transport: 'mcp_server',
        // Count and digest only — the content map itself is never recorded.
        file_count: event.fileCount ?? null,
        content_hash: event.contentHash ?? null,
        // Recorded per-row so a future reader can tell an unattributed row from one written
        // before published_by existed, without diffing migration timestamps.
        published_by_available: event.authPath === 'user_jwt',
        detail: event.detail ?? null,
      },
    })

    if (error) {
      console.error(
        `[skillsmith] private-registry audit write failed (${event.operation}): ${error.message ?? 'unknown error'}`
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    console.error(
      `[skillsmith] private-registry audit write failed (${event.operation}): ${message}`
    )
  }
}
