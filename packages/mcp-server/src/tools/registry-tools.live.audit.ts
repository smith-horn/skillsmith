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
 * submitter, and a shared team license key never could. `deprecate`/`undeprecate`/`getContent`
 * were already `user_jwt` before that change (SMI-5822/SMI-5905), and SMI-6109 moved the last
 * three holdouts — `list`/`get`/`getNamespace` — over as well. **As of SMI-6109 no MCP-path
 * private-registry operation is license-key-scoped any more**: every `recordRegistryAudit()` call
 * site in this package now passes `authPath: 'user_jwt'`. The `'license_key'` arm of
 * `RegistryAuditAuthPath`/`resolveActor()` is kept deliberately — `audit_logs` still holds
 * historical rows written on that path, and the type is what makes reading them unambiguous — but
 * nothing writes it today.
 *
 * A pre-D-7 service-role publish (an old client, or any path that still presented only a license
 * key) left `published_by` NULL, and this module's job was to record what WAS known — the team,
 * plus a one-way fingerprint of which license key was presented — rather than fabricate a
 * plausible-looking actor. That reasoning is what the `'license_key'` arm still exists to explain
 * for those historical rows; it no longer describes any operation this package writes today.
 * `license_keys.user_id` was never a usable substitute either way: a team's resolvable key is the
 * single row the checkout webhook created for the *purchaser*, then shared with the team, so it
 * names the buyer rather than the caller.
 *
 * SMI-6114: COMMITTED MUTATIONS ARE NOT AUDITED HERE, AND NOTHING HERE USES A SERVICE-ROLE KEY.
 *
 * This module used to write `audit_logs` through the service-role Supabase client, which needs
 * `SUPABASE_SERVICE_ROLE_KEY`. The public MCP server never carries that key, so in production every
 * row this module tried to write was dropped with a stderr line, and prod held zero
 * `private_registry:publish`/`approve`/`reject`/`deprecate` rows while real publishes and reviews
 * had happened (measured 2026-09-13). A committed publish, approve, reject, deprecate or
 * undeprecate is recorded by the database itself: `trg_prs_audit` (migration
 * 20260913000000_private_registry_audit_trigger.sql) writes one `audit_logs` row per state change,
 * in the same transaction. This module therefore refuses a `success` row for a mutation operation
 * (see `recordRegistryAudit()`).
 *
 * What flows through here: reads (`list`/`get`/`namespace`) and mutation or content-read ATTEMPTS
 * that did not commit (`denied`/`not_found`/`error`). A trigger cannot see those (a read writes
 * nothing; a denied UPDATE matches zero rows; a refused review RPC rolls back). They are now
 * written by `record_private_registry_audit_attempt()` (migration
 * 20261008000000_private_registry_audit_attempt_rpc.sql, ADR-178), called with the SAME
 * authenticated client that already authorized the caller's own operation. No new credential
 * enters the server. The RPC derives the actor from `auth.uid()`, so a row's actor is the identity
 * the database verified, not one decoded from an unverified token.
 *
 * Rows the RPC writes are authenticated CLIENT REPORTS (`audit_source: 'client_reported'`), never
 * member-visible and never carrying a `team_id` key. A `content_read` success/denied/not_found is
 * written only by `release_private_registry_skill_content()`, so this module can only report a
 * `content_read` as `error`; the type makes anything else unrepresentable and the RPC refuses it.
 *
 * LOCALLY-OBSERVABLE-ONLY FAILURES. A failure before an authenticated client exists (no signed-in
 * user, token unavailable) cannot be recorded by an authenticated RPC. Those are passed as a `null`
 * client: the RPC is skipped and the only trace is the stderr line, whose `reason` is
 * `no_authenticated_client`. A failure AFTER the client was bound is recordable and is recorded.
 *
 * ONE ACTOR PER PATH, NEVER THE WRONG ONE (cross-provider review finding #3).
 *
 * `deprecate`/`undeprecate`/`publish` all run through the signed-in user's own JWT, so the license
 * key does **not** authorize them. Since ADR-178 the actor is not chosen client-side at all: the
 * RPC records `user:<auth.uid()>`. The license-key fingerprint is still sent, as a correlation
 * token only ("which key was present"), never as an identity.
 *
 * Fail-soft by construction: an audit write must never turn a successful publish into a failed
 * one. But fail-soft is NOT silent (ADR-178 § 4): a resolved `{ error }` from the RPC and a thrown
 * call each emit exactly one structured stderr line naming the operation, result, detail and
 * reason, and are then swallowed.
 */

import { createHash } from 'node:crypto'
// SMI-6622 round 2: readRegistryCredential() also covers ~/.skillsmith/config.json, unlike
// team-resolver.ts's env-only readLicenseKey() this replaced — see registry-tools.team.ts's own
// doc comment on the export.
import { readRegistryCredential } from './registry-tools.team.js'

/**
 * Registry operations worth an audit row.
 *
 * `content_read` (SMI-5905 Wave 3) hands a team's packaged skill content to a caller, so it gets
 * the same coverage the mutations do. `event_type` and `action` are byte-identical to what the
 * `private-registry-get` Edge Function writes (supabase/functions/private-registry-get/access.ts),
 * so both transports land in one queryable stream and neither can be audited without the other
 * showing up in the same query.
 *
 * `list`/`get`/`namespace` (SMI-6109) were previously NOT audited here — "metadata reads carry no
 * file bytes" was true, but stopped being the whole story once these three moved off the
 * license-key-scoped service-role client onto the signed-in user's own JWT
 * (`getMemberUserClient()`, `registry-tools.live.ts`). That move introduces a real dual-identity-
 * signal gap: the license key resolves one team, the signed-in user's own membership can silently
 * point at a different one (or none), and RLS fails closed on the mismatch indistinguishably from
 * "genuinely not found." Recording `authRole`/`actorUserId` here is what makes that mismatch
 * observable in the audit stream rather than invisible. `submissions` remains unaudited — it is a
 * metadata read like the pre-SMI-6109 `list`/`get` were, with no comparable identity-mismatch
 * concern (D-5's RPC already evaluates `auth.uid()` itself).
 *
 * `approve`/`reject` (SMI-5949 Wave 2 Step 4, D-5) are the two terminal decisions
 * `review_private_registry_submission()` can write.
 */
export type RegistryMutationOperation =
  | 'publish'
  | 'deprecate'
  | 'undeprecate'
  | 'approve'
  | 'reject'

export type RegistryReadOperation = 'content_read' | 'list' | 'get' | 'namespace'

export type RegistryAuditOperation = RegistryMutationOperation | RegistryReadOperation

const MUTATION_OPERATIONS: ReadonlySet<string> = new Set<RegistryMutationOperation>([
  'publish',
  'deprecate',
  'undeprecate',
  'approve',
  'reject',
])

/**
 * Which credential authorized the call. READ-ONLY since ADR-178: the RPC always records
 * `user_jwt`, so `license_key` can no longer be written; the arm is kept so historical rows read
 * unambiguously.
 * - `license_key`: the shared team license key (team-scoped, no per-user identity).
 * - `user_jwt`: the signed-in user's own token, so RLS authorized it against a real `auth.uid()`.
 */
export type RegistryAuditAuthPath = 'license_key' | 'user_jwt'

/**
 * SMI-6114: a mutation operation cannot carry `result: 'success'` (the committed change is audited
 * server-side by `trg_prs_audit`), and `content_read` can only be reported as `error` (its other
 * outcomes are written by `release_private_registry_skill_content()`). The types make a new call
 * site that sends either a compile error; `recordRegistryAudit()` also refuses both at runtime for
 * untyped callers, and the RPC refuses them with 22023 as the non-bypassable third layer.
 */
export type RegistryAuditEvent =
  | RegistryReadAuditEvent
  | RegistryContentReadAuditEvent
  | RegistryMutationAuditEvent

export type RegistryReadAuditEvent = RegistryAuditEventFields & {
  operation: Exclude<RegistryReadOperation, 'content_read'>
  result: 'success' | 'denied' | 'not_found' | 'error'
}

export type RegistryContentReadAuditEvent = RegistryAuditEventFields & {
  operation: 'content_read'
  result: 'error'
}

export type RegistryMutationAuditEvent = RegistryAuditEventFields & {
  operation: RegistryMutationOperation
  result: 'denied' | 'not_found' | 'error'
}

export interface RegistryAuditEventFields {
  teamId: string
  /** Omitted for team-wide operations with no single skill in scope (SMI-6109) — `list` (bulk)
   *  and `namespace` (queries the `teams` table, not `private_registry_skills` at all). */
  skillId?: string
  version?: string
  authPath: RegistryAuditAuthPath
  /**
   * The authenticated user's id (the JWT `sub`). Local context only since ADR-178: the RPC
   * derives the recorded actor from `auth.uid()` and accepts no actor argument.
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
 * SMI-6080: "the presented credential" is whatever the registry credential chain resolved — a
 * license key, `SKILLSMITH_API_KEY`, or (SMI-6622 round 2) `~/.skillsmith/config.json`'s `apiKey`.
 * All three hash into the same `license_keys.key_hash` row, so a fingerprint stays a stable
 * per-key correlator regardless of source; it just no longer implies any one of them specifically.
 */
export function licenseKeyFingerprint(licenseKey?: string): string | null {
  const key = licenseKey ?? readRegistryCredential()
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
 * only ever called on a token this process is *already presenting* to PostgREST. Since ADR-178 the
 * audit row's actor is derived by the RPC from `auth.uid()` (the identity the database verified),
 * so this value is local context only and no longer the recorded identity; the gap between "the
 * identity that was claimed" and "the identity the database evaluated" is closed for every row
 * the RPC writes.
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

/** The RPC's own refusals (22023) mirrored client-side so an untyped caller cannot reach them. */
function refusedPairing(event: RegistryAuditEvent): string | null {
  if (MUTATION_OPERATIONS.has(event.operation) && (event.result as string) === 'success') {
    return 'committed mutations are audited server-side by trg_prs_audit'
  }
  if (event.operation === 'content_read' && (event.result as string) !== 'error') {
    return 'content_read success/denied/not_found is written by the release RPC only'
  }
  return null
}

/**
 * The structural slice of an authenticated Supabase client this module needs. Any
 * `MinimalSupabaseClient` satisfies it; tests inject a plain object.
 */
export interface AuditRpcClient {
  rpc: (
    fn: string,
    params?: Record<string, unknown>
  ) => PromiseLike<{ error: { code?: string; message?: string } | null }>
}

const AUDIT_RPC = 'record_private_registry_audit_attempt'

/** Reason recorded when no authenticated client existed to call the RPC with. */
export const NO_AUTHENTICATED_CLIENT = 'no_authenticated_client'

/**
 * One structured stderr line per lost audit event (ADR-178 § 4). The stderr line is the ONLY trace
 * of an audit write that failed, so it names the operation, result, detail and reason.
 */
function logAuditFailure(event: RegistryAuditEvent, reason: string): void {
  console.error(
    `[skillsmith] private-registry audit write failed ${JSON.stringify({
      operation: event.operation,
      result: event.result,
      detail: event.detail ?? null,
      reason,
    })}`
  )
}

/**
 * Best-effort `audit_logs` row for a private-registry read, or for a mutation/content-read attempt
 * that did not commit, written by `record_private_registry_audit_attempt()` over the caller's own
 * authenticated client (ADR-178).
 *
 * @param client - the client that authorized the caller's own operation, or `null` when client
 *   creation itself failed (the RPC is skipped and the stderr line says `no_authenticated_client`)
 *
 * Never throws: the caller's operation has already succeeded or failed on its own terms, and an
 * audit-transport problem must not change that outcome. A resolved `{ error }` and a thrown call
 * are each logged exactly once.
 */
export async function recordRegistryAudit(
  client: AuditRpcClient | null,
  event: RegistryAuditEvent
): Promise<void> {
  const refusal = refusedPairing(event)
  if (refusal) {
    console.error(
      `[skillsmith] private-registry audit: not writing a client-side row for ` +
        `"${event.operation}"/"${event.result}" — ${refusal}`
    )
    return
  }
  if (!client) {
    logAuditFailure(event, NO_AUTHENTICATED_CLIENT)
    return
  }
  // The failure reason is captured inside the try and logged AFTER it, so a resolved `{ error }`
  // and a throw can never both log for one event.
  let failure: string | null = null
  try {
    const { error } = await client.rpc(AUDIT_RPC, {
      p_operation: event.operation,
      p_result: event.result,
      p_skill_id: event.skillId ?? null,
      p_version: event.version ?? null,
      p_detail: event.detail ?? null,
      p_file_count: event.fileCount ?? null,
      p_content_hash: event.contentHash ?? null,
      p_team_id: event.teamId,
      p_license_key_fingerprint: licenseKeyFingerprint(),
      p_auth_role: event.authRole ?? null,
    })
    if (error) failure = error.message ?? error.code ?? 'unknown error'
  } catch (err) {
    failure = err instanceof Error ? err.message : 'unknown error'
  }
  if (failure !== null) logAuditFailure(event, failure)
}

/** Event for a site whose getter failed: the operation's identity, minus result and detail. */
export type NoClientAuditContext = Omit<RegistryAuditEventFields, 'detail'> & {
  operation: RegistryAuditOperation
}

/**
 * Run an authenticated-client getter; if it throws, record the failure with a `null` client (so
 * only the stderr line survives, reason `no_authenticated_client`) and rethrow the ORIGINAL error
 * unchanged. Wraps ONLY the getter: a failure after it returns is not recorded here, so it cannot
 * be recorded twice.
 */
export async function withNoClientAudit<T>(
  context: NoClientAuditContext,
  getter: () => Promise<T>
): Promise<T> {
  try {
    return await getter()
  } catch (err) {
    await recordRegistryAudit(null, {
      ...context,
      result: 'error',
      detail: NO_AUTHENTICATED_CLIENT,
    } as RegistryAuditEvent)
    throw err
  }
}
