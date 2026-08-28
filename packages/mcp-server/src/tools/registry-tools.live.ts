/**
 * @fileoverview Live Supabase-backed PrivateRegistryService (ADR-129)
 * @module @skillsmith/mcp-server/tools/registry-tools.live
 * @see SMI-5816: Private skill registry — real implementation
 * @see ADR-129: Postgres-native (JSONB) storage, real team-auth (migration 071)
 * @see ADR-116: MCP service-role client + explicit tenant filter — NARROWED for this file's
 *   team-scoped reads by SMI-6109 (see the "Addendum: SMI-6109" section in
 *   docs/internal/adr/116-mcp-server-service-role-for-team-scoped-tools.md). Still current
 *   for `team-workspace.live.ts`, deliberately not touched by that change.
 *
 * Backs `private_registry_publish` / `private_registry_manage` with the real
 * `private_registry_skills` table (migration 20260724000000).
 *
 * TWO CREDENTIALS, EVERY PATH ON A REAL PERSON (SMI-5822 fix, SMI-5882 Wave 3; `getContent` added
 * SMI-5905 Wave 3; `publish` moved off service-role SMI-5949 Wave 2 Step 2, D-7; `list`/`get`/
 * `getNamespace` moved off service-role SMI-6109):
 *
 * - **Member-level operations** (`list`, `get`, `getNamespace`, `getContent`, `publish`,
 *   `submissions`, `approve`/`reject`) run through the signed-in user's own Supabase JWT
 *   (`getMemberUserClient()`, `registry-tools.live.auth.ts`) — `skillsmith login`, not the shared
 *   team license key. `teamId` still always comes from `resolve_team_from_license` (never from
 *   tool input), and `list`/`get` still carry the same explicit, mandatory `team_id` /
 *   `approval_status = 'approved'` / `deprecated = FALSE` in-query predicates as before (ADR-116's
 *   tenant-isolation invariant — RLS does not enforce `approval_status`/`deprecated` at all, so
 *   dropping these predicates would silently widen what a signed-in member can read, not just
 *   change which credential reads it). Query logic for `list`/`get` lives in
 *   `registry-tools.live.reads.ts`.
 *
 *   SMI-6109: before this change, `list`/`get`/`getNamespace` ran on the Supabase service-role
 *   client — the single most powerful credential in the backend, required as
 *   `SUPABASE_SERVICE_ROLE_KEY` on every MCP host that used these tools. The published
 *   `@skillsmith/mcp-server` README instructed real customers to configure exactly that key on
 *   their own machines, in an open-core repo whose source (including this file) is public — a
 *   documented, live threat vector, not a hypothetical. These three are member-level reads (any
 *   team member may run them), not admin-level, so `getMemberUserClient()` is the correct getter
 *   — never `getAdminUserClient()`. A license-key-team-vs-logged-in-user-membership mismatch is a
 *   real, pre-existing dual-identity-signal gap this move inherits (the license key resolves one
 *   team; the signed-in user's own membership can silently point at a different one, or none) —
 *   RLS fails closed on the mismatch indistinguishably from "genuinely not found," and the
 *   `recordRegistryAudit()` calls added to all three make that mismatch observable rather than
 *   invisible (`registry-tools.live.audit.ts`). Reconciling the two identity signals directly is a
 *   separate, broader design question, tracked as a follow-up, not fixed here.
 *
 * - **Admin-level writes** (`deprecate`, `undeprecate`) also run through the signed-in user's own
 *   Supabase JWT (`getAdminUserClient()`), so PostgREST evaluates
 *   `private_registry_skills_admin_update` with a real `auth.uid()` and the database — not this
 *   file — decides whether the caller is a team admin.
 *
 *   Why the change (pre-dates SMI-6109): a team's license key is shared, and
 *   `resolve_team_from_license` is `(p_license_key TEXT) RETURNS TEXT` — it resolves a *team*,
 *   never a *person*. Running these two operations as service-role therefore made the shared key
 *   an effective admin credential: SMI-5882's staging run proved the asymmetry directly (a team
 *   *member* reaches 0 rows over the authenticated path, while the identical UPDATE as
 *   service-role deprecated 2 rows). Re-checking the role in application code was rejected as the
 *   fix — it would duplicate a policy that already exists and can silently drift from it. Letting
 *   the existing, proven policy do the work cannot drift.
 *
 *   Cost, stated plainly: deprecate/undeprecate (and, since SMI-6109, list/get/getNamespace too)
 *   require `skillsmith login` in addition to SKILLSMITH_LICENSE_KEY (or SKILLSMITH_API_KEY,
 *   SMI-6080), and surface an actionable error when no user credential is present.
 *
 * - **Content reads** (`getContent`, SMI-5905 Wave 3) are member-level like the operations above:
 *   the signed-in user's own JWT (so `_member_read` decides visibility against a real
 *   `auth.uid()`). `getAdminUserClient()` / `getMemberUserClient()` (`registry-tools.live.auth.ts`)
 *   are two explicitly-named getters for exactly this reason — the choice cannot be defaulted or
 *   omitted at a call site. What decides whether a content read is *entitled* is in
 *   `registry-tools.live.content.ts`, and is scoped to the row's own team, not the caller's tier.
 *
 * - **`publish`** (SMI-5949 Wave 2 Step 2, D-7) is member-level like `getContent` — not admin: any
 *   team member may submit a version, not only admins. `published_by` is `DEFAULT auth.uid()`
 *   (migration 20260729000000), which stays NULL on the service-role path this method used before
 *   — and an unconditional BEFORE INSERT trigger (Wave 1) now hard-rejects a NULL `published_by`,
 *   so a service-role publish fails outright. Beyond that trigger, a real submitter identity is
 *   also the prerequisite for D-6's self-approval check: `review_private_registry_submission()`
 *   can only refuse a submitter approving their own work if it can name the submitter, and a
 *   shared license key never can. Two consequences the D-4 RLS gate forces on this method
 *   specifically (a `pending` row is invisible even to its own submitter): the INSERT can no
 *   longer request a representation (`.select()`/`RETURNING`) — see the empirically-confirmed
 *   D-4(a) note on `publish()` below — and the freshly-published row is read back through the
 *   metadata-only `get_private_registry_submissions` RPC (D-5) instead.
 *
 * Single-phase write: metadata + content land in one INSERT (ADR-129) — no two-phase
 * Supabase+S3 write/rollback. Published (team_id, skill_id, version) triples are
 * immutable; a re-publish raises a unique violation surfaced as a clear error.
 *
 * NOT touched by SMI-6109, deliberately (see docs/internal/implementation, SMI-6109 plan,
 * "Explicitly out of scope"): `team-workspace.live.ts`'s identical service-role pattern across 8
 * methods (writes, not just reads, with no existing member-client precedent to reuse);
 * `registry-tools.live.audit.ts`'s own audit-log write path (a system-table insert, fail-soft,
 * structurally different from a tenant-data read); `SKILLSMITH_API_KEY_HMAC_SECRET`'s
 * distribution (an unrelated secret, not consumed by any Supabase call).
 */

import { sha256Hex } from '@skillsmith/core'
import { recordRegistryAudit } from './registry-tools.live.audit.js'
import { getAdminUserClient, getMemberUserClient } from './registry-tools.live.auth.js'
import {
  REGISTRY_METADATA_COLUMNS,
  REGISTRY_TABLE,
  type RegistrySkillContent,
} from './registry-tools.content.types.js'
import { getSkillContent } from './registry-tools.live.content.js'
import { auditedList, auditedGet, auditedGetNamespace } from './registry-tools.live.member-reads.js'
import {
  mapSubmissionRow,
  readBackSubmission,
  listSubmissions,
  reviewSubmission,
} from './registry-tools.live.submissions.js'
import type { PrivateRegistryService, RegistrySkill, SkillContent } from './registry-tools.js'
import type { RegistryReviewDecision } from './registry-tools.review.types.js'

/** 2 MB raw-content cap (ADR-129 Risks). Primary user-facing guard; the migration's
 *  pg_column_size CHECK is a stored-size backstop. */
const MAX_CONTENT_BYTES = 2 * 1024 * 1024

export interface PrivateRegistrySkillRow {
  id: string
  team_id: string
  skill_id: string
  version: string
  description: string | null
  content_hash: string
  deprecated: boolean
  published_by: string | null
  published_at: string
  /** SMI-5949 D-3. NOT NULL on the table; every row has one. */
  approval_status: 'pending' | 'approved' | 'rejected'
  /** SMI-5949 D-3. NOT NULL on the table; every row has one. */
  approval_mode: 'review' | 'auto'
}

export interface SupabaseError {
  code?: string
  message?: string
  details?: string
}

export interface SupabaseQueryResult<T> {
  data: T | null
  error: SupabaseError | null
}

export interface SupabaseTableQuery<T> {
  select: (columns?: string) => SupabaseTableQuery<T>
  eq: (column: string, value: unknown) => SupabaseTableQuery<T>
  single: () => Promise<SupabaseQueryResult<T>>
  insert: (row: Record<string, unknown>) => SupabaseTableQuery<T>
  update: (row: Record<string, unknown>) => SupabaseTableQuery<T>
  then: <R>(onFulfilled: (value: SupabaseQueryResult<T[]>) => R) => Promise<R>
}

export interface MinimalSupabaseClient {
  from: <T>(table: string) => SupabaseTableQuery<T>
  /**
   * PostgREST RPC call (`POST /rpc/<fn>`) — SMI-5949 D-5's two `SECURITY DEFINER` functions have
   * no plain table representation. Used today only for `get_private_registry_submissions()`, the
   * sole read path for a `pending` row (D-4(c)).
   */
  rpc: <T>(fn: string, params?: Record<string, unknown>) => Promise<SupabaseQueryResult<T>>
}

// Table name + metadata column list live in registry-tools.content.types.ts so the content module
// shares them without a runtime import cycle back into this file. Aliased to the names this file
// has always used. METADATA_COLUMNS excludes `content` — see that file for why that matters.
const TABLE = REGISTRY_TABLE
const METADATA_COLUMNS = REGISTRY_METADATA_COLUMNS

/** PostgREST's code for "no rows" (or >1 row) via .single() — a real absence, not a
 *  failure. Any other error code/message is a genuine failure and must not be
 *  silently mapped to null, or an outage would look identical to "not found". */
function isNoRowsError(error: SupabaseError | null): boolean {
  return error?.code === 'PGRST116'
}

/** Postgres unique_violation (immutability breach) — code 23505, or a duplicate-key message. */
function isUniqueViolation(error: SupabaseError | null): boolean {
  if (!error) return false
  if (error.code === '23505') return true
  const haystack = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase()
  return haystack.includes('duplicate key') || haystack.includes('unique constraint')
}

/**
 * Flip `deprecated` for every version of a skill within one team, over the authenticated user
 * path so `private_registry_skills_admin_update` is the authorization check (SMI-5822).
 *
 * RLS denials on UPDATE do not raise — a row failing the policy's USING clause is simply invisible
 * to the statement, which then affects zero rows. "0 rows" is therefore ambiguous between "no such
 * skill" and "you are not an admin", and reporting the wrong one would be actively misleading. The
 * probe below disambiguates: `_member_read` lets ANY team member SELECT the rows, while
 * `_admin_update` restricts the write, so rows-visible-but-not-writable means exactly "not an
 * admin".
 *
 * SMI-5949 adversarial-review correction (M-1): the above was written before Wave 2 and is now
 * stale on its own — since Wave 2, `_member_read` ALSO requires `approval_status = 'approved'`
 * (D-4), so a `pending`/`rejected` row is invisible to the probe too, for a reason that has
 * nothing to do with admin status. The probe's "0 rows" therefore now has a THIRD possible cause
 * alongside "no such skill" and "not an admin": "this skillId exists only as a pending/rejected
 * row, so it is invisible to every team member (including this probe), not just to a non-admin".
 * All three report `false` ("not found") below, which is the correct externally-visible answer in
 * every case — there is nothing live to deprecate/undeprecate either way — but a future reader
 * should not assume a `false` return here always means "this skillId was never published".
 */
async function setDeprecated(teamId: string, skillId: string, value: boolean): Promise<boolean> {
  const operation = value ? 'deprecate' : 'undeprecate'
  // ADMIN getter — never getMemberUserClient(). `authRole` on every audit row below is read back
  // off this binding rather than hard-coded, so a swapped call site would show up in the audit
  // trail rather than only in a test that could itself be edited to match.
  const { client, actorUserId, role } = await getAdminUserClient(operation)
  // .select() is REQUIRED here: PostgREST only returns affected-row data (the
  // `Prefer: return=representation` the JS client sets via .select()) when asked; without it,
  // `resp.data` is null on every call — including a successful update — and this method would
  // always report "not found" in production.
  const resp = await client
    .from<PrivateRegistrySkillRow>(TABLE)
    .update({ deprecated: value })
    .eq('team_id', teamId)
    .eq('skill_id', skillId)
    .select(METADATA_COLUMNS)
  if (resp.error) {
    await recordRegistryAudit({
      operation,
      teamId,
      skillId,
      result: 'error',
      authPath: 'user_jwt',
      authRole: role,
      actorUserId,
      detail: resp.error.code ?? 'query_error',
    })
    throw new Error(`Failed to ${operation} skill: ${resp.error.message ?? 'unknown error'}`)
  }
  if (Array.isArray(resp.data) && resp.data.length > 0) {
    await recordRegistryAudit({
      operation,
      teamId,
      skillId,
      result: 'success',
      authPath: 'user_jwt',
      authRole: role,
      actorUserId,
    })
    return true
  }

  const probe = await client
    .from<{ id: string }>(TABLE)
    .select('id')
    .eq('team_id', teamId)
    .eq('skill_id', skillId)
  // A failed probe is NOT evidence of absence. Only a confirmed no-rows result is (the
  // `isNoRowsError` convention this file uses everywhere else) — mapping an expired token, a
  // network fault or a permission problem to "not found" would make a real outage
  // indistinguishable from a skill that does not exist, and would silently return `false` to a
  // caller who asked us to change something.
  if (probe.error && !isNoRowsError(probe.error)) {
    await recordRegistryAudit({
      operation,
      teamId,
      skillId,
      result: 'error',
      authPath: 'user_jwt',
      authRole: role,
      actorUserId,
      detail: probe.error.code ?? 'probe_error',
    })
    throw new Error(
      `Failed to ${operation} skill: the update matched no rows and the follow-up check for ` +
        `"${skillId}" also failed, so we cannot tell whether it is missing or you lack admin ` +
        `rights: ${probe.error.message ?? 'unknown error'}`
    )
  }
  if (Array.isArray(probe.data) && probe.data.length > 0) {
    await recordRegistryAudit({
      operation,
      teamId,
      skillId,
      result: 'denied',
      authPath: 'user_jwt',
      authRole: role,
      actorUserId,
      detail: 'not_team_admin',
    })
    throw new Error(
      `Only team admins can ${operation} "${skillId}". Your account is a member of this team but ` +
        'not an admin — ask a team admin to run this, or have them promote you.'
    )
  }
  await recordRegistryAudit({
    operation,
    teamId,
    skillId,
    result: 'not_found',
    authPath: 'user_jwt',
    actorUserId,
  })
  return false
}

/**
 * Validate + size-check the content map and compute its content_hash.
 * content_hash = sha256 hex of SKILL.md, matching skills.content_hash /
 * device_skills.content_hash (inventory-collector) so cross-source drift logic
 * (ADR-130 Wave 2) needs no per-source branching.
 */
function prepareContent(content: SkillContent): { contentHash: string } {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('Publish requires a "content" file map (e.g. { "SKILL.md": "..." }).')
  }
  const skillMd = content['SKILL.md']
  if (typeof skillMd !== 'string' || skillMd.length === 0) {
    throw new Error('Publish content must include a non-empty "SKILL.md" entry.')
  }
  const bytes = Buffer.byteLength(JSON.stringify(content), 'utf8')
  if (bytes > MAX_CONTENT_BYTES) {
    throw new Error(
      `Skill content is ${bytes} bytes, over the ${MAX_CONTENT_BYTES}-byte (2 MB) private-registry limit. Split large assets out of the skill package.`
    )
  }
  return { contentHash: sha256Hex(skillMd) }
}

/**
 * Create a live Supabase-backed PrivateRegistryService.
 *
 * Every DB call explicitly filters by `team_id = <resolved teamId>`. `list`/`get`/`getNamespace`
 * run on the signed-in user's own JWT (SMI-6109) — RLS is the real authorization boundary, but the
 * explicit `team_id`/`approval_status`/`deprecated` predicates stay, since RLS does not enforce
 * the latter two at all (ADR-116's invariant, still load-bearing after the credential change).
 */
export function createLiveRegistryService(): PrivateRegistryService {
  return {
    async publish(teamId, skillId, version, content, description): Promise<RegistrySkill> {
      const { contentHash } = prepareContent(content)
      // D-7: publish now runs as the signed-in user, not service-role — `published_by`
      // (DEFAULT auth.uid()) needs a real person behind it, both because an unconditional
      // BEFORE INSERT trigger (Wave 1) hard-rejects a NULL published_by, and because D-6's
      // self-approval check can only refuse a submitter approving their own work if it can name
      // the submitter. A shared team license key can do neither — see registry-tools.live.auth.ts
      // for the actionable login-required error this throws when no user is signed in.
      const { client, actorUserId } = await getMemberUserClient('publish')

      // D-4(a): the approval-gate RLS policy hides a fresh `pending` row from a SELECT —
      // including from its own submitter — so `INSERT … RETURNING` (the `.select().single()`
      // this call used before the gate) cannot be used: empirically confirmed against staging
      // (real `authenticated` INSERT, real RLS) that requesting a representation on this insert
      // raises `"new row violates row-level security policy"` and rolls the write back entirely,
      // while the identical insert WITHOUT `.select()` succeeds and the row lands. The insert is
      // therefore representation-free.
      //
      // `content_hash` is deliberately NOT sent on this path (unlike the pre-D-7 service-role
      // insert): `GRANT INSERT (team_id, skill_id, version, description, content) … TO
      // authenticated` (20260729000000:268-269) does not include `content_hash` — sending it as
      // `authenticated` raises a column-privilege 42501, empirically confirmed alongside the
      // RETURNING check above. The BEFORE INSERT trigger derives it server-side from
      // `content->>'SKILL.md'` regardless. `prepareContent()`'s own hash is still computed for
      // validation and is attached to the audit row below for correlation with the server-derived
      // value, not sent to the database.
      const insertResp = await client.from<PrivateRegistrySkillRow>(TABLE).insert({
        team_id: teamId,
        skill_id: skillId,
        version,
        description: description ?? null,
        content,
      })
      if (insertResp.error) {
        await recordRegistryAudit({
          operation: 'publish',
          teamId,
          skillId,
          version,
          result: 'error',
          authPath: 'user_jwt',
          authRole: 'member',
          actorUserId,
          detail: isUniqueViolation(insertResp.error)
            ? 'version_immutable'
            : (insertResp.error.code ?? 'insert_error'),
        })
        if (isUniqueViolation(insertResp.error)) {
          throw new Error(
            `Version ${version} of "${skillId}" already exists in this team's private registry. ` +
              'Published versions are immutable — bump the version and publish a new one.'
          )
        }
        throw new Error(`Failed to publish skill: ${insertResp.error.message ?? 'unknown error'}`)
      }

      // D-4(c): the row just landed `pending` and is structurally invisible to a plain SELECT —
      // read it back through the metadata-only submissions RPC instead (D-5).
      //
      // SMI-5949 adversarial-review fix (M-5): the INSERT above already committed — the row
      // genuinely exists in the database either way — so a failure HERE (RPC error, or a
      // read-back miss) must still be audited, or a real, successful publish leaves ZERO audit
      // trail: not a success row (the code never reaches the one below) and not an error row
      // (nothing previously recorded one). Every other branch in this function audits both
      // outcomes; this closes the one that did not. This does not roll back the already-committed
      // insert — the fix is purely about not losing the audit trail for what already happened.
      let submission
      try {
        submission = await readBackSubmission(client, teamId, skillId, version)
      } catch (err) {
        await recordRegistryAudit({
          operation: 'publish',
          teamId,
          skillId,
          version,
          result: 'error',
          authPath: 'user_jwt',
          authRole: 'member',
          actorUserId,
          contentHash,
          detail: 'readback_failed',
        })
        throw err
      }
      await recordRegistryAudit({
        operation: 'publish',
        teamId,
        skillId,
        version,
        result: 'success',
        authPath: 'user_jwt',
        authRole: 'member',
        actorUserId,
        contentHash,
      })
      return mapSubmissionRow(teamId, submission)
    },

    // D-4 surface 3 + SMI-5949 Wave 3 (deprecated read-filter closure) + SMI-6109 (moved off
    // service-role onto the signed-in user's own JWT). Implementation, audit logging, and the
    // never-throws-vs-throws contract rationale live in registry-tools.live.member-reads.ts (this
    // file's own 500-line budget) — see that file's header comment.
    async list(teamId, version, includeDeprecated): Promise<RegistrySkill[]> {
      return auditedList(teamId, version, includeDeprecated)
    },

    async get(teamId, skillId, version): Promise<RegistrySkill | null> {
      return auditedGet(teamId, skillId, version)
    },

    // SMI-5905 Wave 3. MEMBER getter — never getAdminUserClient(): reading a skill you may
    // install is not an admin action, and claiming it is would lock every non-admin member out of
    // their own team's registry. The entitlement check that DOES gate this lives in
    // registry-tools.live.content.ts and is scoped to the row's own team, not the caller's tier.
    async getContent(teamId, skillId, version): Promise<RegistrySkillContent | null> {
      const binding = await getMemberUserClient('install')
      return getSkillContent({ binding, teamId, skillId, version })
    },

    // Deprecates every version of the skill within this team. SMI-5949 Wave 3: no longer just
    // "hidden from search, remains installable" — since the deprecated=false predicate below is
    // now real (registry-tools.live.reads.ts, registry-tools.live.content.ts, the Edge Function),
    // this makes every version genuinely unreachable through list/get/install, not just absent
    // from a search surface the private registry never had. Admin-gated: runs as the signed-in
    // user so RLS authorizes it (SMI-5822). The team_id filter is still load-bearing — never
    // cross-team — and is now backed by `_admin_update`'s own USING clause rather than standing
    // alone.
    async deprecate(teamId, skillId): Promise<boolean> {
      return setDeprecated(teamId, skillId, true)
    },

    // SMI-6109: moved off service-role — see registry-tools.live.member-reads.ts for the
    // implementation and why this one never throws, unlike list()/get() above.
    async getNamespace(teamId): Promise<string | null> {
      return auditedGetNamespace(teamId)
    },

    // Admin-gated — see deprecate()'s comment above.
    async undeprecate(teamId, skillId): Promise<boolean> {
      return setDeprecated(teamId, skillId, false)
    },

    // SMI-5949 D-5. MEMBER getter, deliberately: the RPC's own auth.uid()-based checks are the
    // real gate (steps 2-3) — see registry-tools.review-action.ts for why.
    async submissions(teamId, status): Promise<RegistrySkill[]> {
      const { client } = await getMemberUserClient('submissions')
      return listSubmissions(client, teamId, status)
    },

    async review(teamId, skillId, version, decision, note): Promise<RegistryReviewDecision> {
      const { client, actorUserId } = await getMemberUserClient(
        decision === 'approved' ? 'approve' : 'reject'
      )
      return reviewSubmission({ client, teamId, skillId, version, decision, note, actorUserId })
    },
  }
}
