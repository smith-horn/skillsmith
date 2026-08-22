/**
 * @fileoverview Private registry MCP tools for enterprise skill management
 * @module @skillsmith/mcp-server/tools/registry-tools
 * @see SMI-3902: Private Registry MCP Tools (original stub)
 * @see SMI-5816: Private skill registry — real implementation
 * @see ADR-129: Postgres-native (JSONB) storage + real team-auth (migration 071)
 *
 * Enables enterprise teams to publish and manage skills in a private registry scoped to their
 * organization. Metadata + packaged content live in `private_registry_skills` (JSONB, not S3 —
 * ADR-129); team-scoped RLS + an in-query team_id filter (ADR-116, SMI-6109 addendum).
 *
 * Backing service is selected at module load: the live Supabase-backed service
 * (registry-tools.live.ts) when Supabase is configured, else an in-memory stub
 * (registry-tools.stub.ts) for local dev / tests.
 *
 * Tier gate: Enterprise (private_registry feature flag — toolFeatureMapping.ts).
 */

import type { ToolContext } from '../context.js'
import { isSupabaseConfigured } from '../supabase-client.js'
import { resolveLicenseTeamId, readLicenseKey } from './team-resolver.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { createStubRegistryService } from './registry-tools.stub.js'
import { createLiveRegistryService } from './registry-tools.live.js'
import { executeRegistryInstall } from './registry-tools.install-action.js'
import {
  executeRegistrySubmissions,
  executeRegistryReview,
} from './registry-tools.review-action.js'
import {
  registrySkillNotFoundMessage,
  type PrivateRegistryInstallSummary,
  type RegistrySkillContent,
} from './registry-tools.content.types.js'
import type {
  RegistryReviewDecision,
  PrivateRegistryReviewService,
} from './registry-tools.review.types.js'
// Imported for LOCAL use (this file's own function signatures below) in addition to the
// `export {...} from` re-export further down — `export {X} from 'y'` alone does not bring X into
// this module's own scope.
import type {
  SkillContent,
  PrivateRegistryPublishInput,
  PrivateRegistryManageInput,
} from './registry-tools.schemas.js'

// Re-export stub factory for external consumers and tests. `StubRegistryService`/`StubActor`
// (SMI-5949 Wave 2 Step 5) are the stub-only identity-simulation seam — see registry-tools.stub.ts
// — not part of `PrivateRegistryService` itself, so this module's own singleton stays typed as
// plain `PrivateRegistryService` below.
export { createStubRegistryService } from './registry-tools.stub.js'
export type { StubRegistryService, StubActor } from './registry-tools.stub.js'

// Both the Zod runtime-validation schemas and the MCP tool-registration schemas live in
// registry-tools.schemas.ts (SMI-5949 D-12 Wave 2 Steps 1 + 4 — this file's own 500-line
// audit:standards budget) and are re-exported here so every existing import site (index.ts,
// tool-dispatch.ts, every test file) reaches them through this module unchanged.
export {
  privateRegistryPublishToolSchema,
  privateRegistryManageToolSchema,
  skillContentSchema,
  privateRegistryPublishInputSchema,
  privateRegistryManageInputSchema,
  type SkillContent,
  type PrivateRegistryPublishInput,
  type PrivateRegistryManageInput,
} from './registry-tools.schemas.js'

// ============================================================================
// Output types
// ============================================================================

export interface RegistrySkill {
  skillId: string
  version: string
  description: string | null
  deprecated: boolean
  publishedAt: string
  publishedBy: string
  /**
   * `null` for a non-`'approved'` row (SMI-5949 adversarial-review finding L-2): a pending or
   * rejected version is not actually live at any URL, so presenting one would contradict the
   * intent already honored in `executePrivateRegistryPublishImpl`'s pending-branch message (which
   * omits a Registry URL entirely). Only `registry-tools.live.submissions.ts`'s `mapSubmissionRow()`
   * (the submissions/publish-read-back path, which can return non-approved rows) actually nulls
   * this; `list()`/`get()` only ever return `'approved'` rows by construction (D-4), so this is
   * always non-null there.
   */
  registryUrl: string | null
  /**
   * SMI-5949 D-3. Every row has one (`NOT NULL` on the table). `list()`/`get()` only ever return
   * `'approved'` rows (D-4's `.eq('approval_status','approved')` predicate) — the field is still
   * populated from the real column rather than hardcoded, so it stays accurate if that predicate
   * is ever loosened for an admin-facing view. A freshly-`publish()`-ed skill is `'pending'` until
   * an admin reviews it. Never print this bare field name unqualified in a user-facing message —
   * pair it with a noun phrase (e.g. "review status") so it is not confused with `approvalMode`.
   */
  approvalStatus: 'pending' | 'approved' | 'rejected'
  /**
   * SMI-5949 D-3. `'auto'` for rows grandfathered in before the approval gate existed;
   * `'review'` for everything published after. Disambiguates an `approved` row with no approver:
   * legitimate iff `approvalMode === 'auto'`. Never print this bare field name unqualified in a
   * user-facing message — pair it with a noun phrase (e.g. "approval workflow") so it is not
   * confused with `approvalStatus`.
   */
  approvalMode: 'review' | 'auto'
}

export interface PrivateRegistryPublishResult {
  success: boolean
  dataSource: 'stub' | 'live'
  skill?: RegistrySkill
  /** The team's publish namespace (SMI-5852, AC-11) — surfaced on success too, not only
   *  as an error-path side effect, so a first publish need not be how a team discovers it. */
  skillNamespace?: string
  message?: string
  error?: string
}

export interface PrivateRegistryManageResult {
  success: boolean
  dataSource: 'stub' | 'live'
  skills?: RegistrySkill[]
  skill?: RegistrySkill
  /** Present for action:'namespace' — the team's publish namespace (SMI-5852, AC-11). */
  namespace?: string
  /** Present for action:'install' (SMI-5905). An allowlist — never carries raw `content`. */
  install?: PrivateRegistryInstallSummary
  /** action:'submissions' (SMI-5949 D-5). Metadata only, never `content` (C1) — separate from
   *  `skills` since this can include pending/rejected items. */
  submissions?: RegistrySkill[]
  /** action:'approve'/'reject' (SMI-5949 D-5). */
  review?: RegistryReviewDecision
  message?: string
  error?: string
}

// ============================================================================
// Service interface
// ============================================================================

/**
 * PrivateRegistryService — team-scoped private registry CRUD.
 *
 * **Invariant (ADR-116, addendum SMI-6109)**: every method MUST filter explicitly on `teamId` —
 * still true though every live method now runs on the caller's own JWT, not service-role (RLS
 * alone isn't enough on `list`/`get`, per the addendum).
 *
 * @see packages/mcp-server/src/tools/registry-tools.live.ts
 * @see docs/internal/adr/129-private-skill-registry-real-implementation.md
 * @see docs/internal/adr/116-mcp-server-service-role-for-team-scoped-tools.md (SMI-6109 addendum)
 */
export interface PrivateRegistryService extends PrivateRegistryReviewService {
  publish(
    teamId: string,
    skillId: string,
    version: string,
    content: SkillContent,
    description?: string
  ): Promise<RegistrySkill>
  /**
   * SMI-5949 Wave 3: `includeDeprecated` skips the `deprecated = FALSE` predicate this method
   * carries by default, so an admin can still see what they deprecated. No equivalent flag on
   * `get()` below — see `registry-tools.live.reads.ts`'s `getSkill()` for why that asymmetry is
   * deliberate.
   */
  list(teamId: string, version?: string, includeDeprecated?: boolean): Promise<RegistrySkill[]>
  get(teamId: string, skillId: string, version?: string): Promise<RegistrySkill | null>
  /** SMI-5905: one version's packaged `content`, for install. `null` when nothing visible
   *  matches (absent OR cross-team — deliberately indistinguishable). Throws when the row's OWN
   *  team is no longer Enterprise-entitled: that check lives in the implementation, never in a
   *  caller. Version semantics are `get()`'s — explicit pins, omitted = most recently published. */
  getContent(
    teamId: string,
    skillId: string,
    version?: string
  ): Promise<RegistrySkillContent | null>
  deprecate(teamId: string, skillId: string): Promise<boolean>
  undeprecate(teamId: string, skillId: string): Promise<boolean>
  /**
   * The team's publish namespace (teams.skill_namespace — SMI-5852), or null if it
   * could not be resolved. Used both for a UX pre-check before publish (surfacing a
   * namespace mismatch as a typed error instead of a raw DB-trigger exception) and
   * for the dedicated `manage(action: 'namespace')` read path (AC-11) — a team should
   * be able to discover its namespace without attempting a publish at all.
   */
  getNamespace(teamId: string): Promise<string | null>
}

/**
 * Module-level singleton. Picks the live Supabase-backed service when
 * SUPABASE_URL + SUPABASE_ANON_KEY are configured; otherwise the in-memory stub
 * (local dev / tests).
 */
let service: PrivateRegistryService = isSupabaseConfigured()
  ? createLiveRegistryService()
  : createStubRegistryService()

/** Replace the registry service implementation (for testing or production swap) */
export function setPrivateRegistryService(svc: PrivateRegistryService): void {
  service = svc
}

/** Get the current registry service instance */
export function getPrivateRegistryService(): PrivateRegistryService {
  return service
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Resolve team ID from the team credential (license key, or API key — SMI-6080).
 *
 * SMI-4292 (finding C3): unified resolution — calls the same `resolve_team_from_license` RPC as
 * team-workspace.ts. A missing/invalid credential surfaces as a typed error (thrown) when Supabase
 * is configured; falls back to a static stub id when it is not (local dev).
 *
 * SMI-6080: `readLicenseKey()` also accepts `SKILLSMITH_API_KEY`, so an admin-granted account
 * (which holds no signed JWT license blob) can resolve its team. Team resolution ONLY — the
 * publish/install/submissions/approve/deprecate actions also require `skillsmith login`.
 */
async function resolveTeamId(): Promise<string> {
  if (!isSupabaseConfigured()) return 'team_stub_00000000-0000-0000-0000-000000000000'
  const licenseKey = readLicenseKey()
  if (!licenseKey) {
    throw new Error(
      'SKILLSMITH_LICENSE_KEY or SKILLSMITH_API_KEY is required for private registry operations. ' +
        'Set one in your MCP server config — shell exports do not reach MCP subprocesses. ' +
        'Publishing, installing, and reviewing submissions additionally require `skillsmith login`.'
    )
  }
  const teamId = await resolveLicenseTeamId(licenseKey)
  if (!teamId) {
    throw new Error(
      'Unable to resolve team from the configured key. Ensure SKILLSMITH_LICENSE_KEY or SKILLSMITH_API_KEY is active and attached to an Enterprise-tier subscription.'
    )
  }
  return teamId
}

/**
 * Execute a private_registry_publish operation.
 */
async function executePrivateRegistryPublishImpl(
  input: PrivateRegistryPublishInput,
  _context: ToolContext
): Promise<PrivateRegistryPublishResult> {
  const dataSource: 'stub' | 'live' = isSupabaseConfigured() ? 'live' : 'stub'
  let teamId: string
  try {
    teamId = await resolveTeamId()
  } catch (err) {
    return {
      success: false,
      dataSource,
      error: err instanceof Error ? err.message : 'Failed to resolve team from license key.',
    }
  }

  // SMI-5852 UX pre-check: the DB trigger (enforce_private_skill_namespace) is the actual
  // security boundary. getNamespace() never throws (SMI-6109) — a lookup failure resolves to
  // `null`, so this pre-check is simply skipped and the trigger remains the sole gate.
  let skillNamespace: string | undefined
  const namespace = await service.getNamespace(teamId)
  if (namespace) {
    skillNamespace = namespace
    const requestedNamespace = input.skillId.split('/')[0]
    if (requestedNamespace !== namespace) {
      return {
        success: false,
        dataSource,
        error: `skill_id must start with "${namespace}/" for this team's private registry namespace.`,
      }
    }
  }

  // Service errors (immutability conflict, size cap, missing SKILL.md, missing
  // service-role key) surface as typed {success:false} results, not exceptions.
  try {
    const skill = await service.publish(
      teamId,
      input.skillId,
      input.version,
      input.content,
      input.description
    )
    // SMI-5949 Wave 2 Step 2 (plan-review finding M9): a 'pending' result is not live yet — the
    // message must say so and must NOT present a Registry URL, which would read as "installable
    // now" when it structurally is not (D-4's RLS hides the row from every read surface until an
    // admin approves it). Every other value ('approved' — pre-approval-gate rows and Enterprise
    // teams without the gate; 'rejected' can never reach here, publish() always inserts pending)
    // keeps the pre-existing "published, here is the URL" message.
    const message =
      skill.approvalStatus === 'pending'
        ? `Submitted ${input.skillId}@${input.version} for review — an admin must approve it ` +
          'before teammates can install it. Review confirms who published this and what ' +
          'version/description was submitted; it does not include a full content read by the ' +
          'approver.'
        : `Published ${input.skillId}@${input.version} to private registry.\n` +
          `Registry URL: ${skill.registryUrl}`
    return {
      success: true,
      dataSource,
      skill,
      skillNamespace,
      message,
    }
  } catch (err) {
    return {
      success: false,
      dataSource,
      error: err instanceof Error ? err.message : 'Failed to publish skill.',
    }
  }
}

/**
 * Execute a private_registry_manage operation.
 */
async function executePrivateRegistryManageImpl(
  input: PrivateRegistryManageInput,
  context: ToolContext
): Promise<PrivateRegistryManageResult> {
  const dataSource: 'stub' | 'live' = isSupabaseConfigured() ? 'live' : 'stub'
  let teamId: string
  try {
    teamId = await resolveTeamId()
  } catch (err) {
    return {
      success: false,
      dataSource,
      error: err instanceof Error ? err.message : 'Failed to resolve team from license key.',
    }
  }

  // Wrap service calls so live-mode errors (e.g. missing service-role key) surface
  // as typed {success:false} results instead of propagating as unhandled exceptions.
  try {
    switch (input.action) {
      case 'list': {
        const skills = await service.list(teamId, input.version, input.includeDeprecated)
        return {
          success: true,
          dataSource,
          skills,
          message: `Found ${skills.length} skill(s) in private registry.`,
        }
      }

      case 'get': {
        if (!input.skillId) {
          return { success: false, dataSource, error: 'skillId is required for action "get".' }
        }
        const skill = await service.get(teamId, input.skillId, input.version)
        if (!skill) {
          // Non-leaking (plan-review finding M11): the same message covers "does not exist",
          // "wrong team", and "exists but is pending/rejected and therefore RLS-invisible" — a
          // caller must not be able to distinguish those from this response.
          return {
            success: false,
            dataSource,
            error: registrySkillNotFoundMessage(input.skillId),
          }
        }
        return { success: true, dataSource, skill }
      }

      // SMI-5905 Wave 3. Handler lives in a companion file (this one was 466/500 lines).
      // `await` is load-bearing here (SMI-5949 Wave 2 Step 4 finding): `return promise` inside a
      // try block does NOT let a rejection reach this function's own `catch` below — the promise
      // adoption happens outside the try/catch's synchronous scope, so an unawaited rejection
      // bypasses it and becomes an unhandled rejection at the caller instead of a typed
      // {success:false} result. Confirmed empirically; applies to every delegating case below too.
      case 'install':
        return await executeRegistryInstall({ input, teamId, dataSource, service, context })

      case 'deprecate': {
        if (!input.skillId) {
          return {
            success: false,
            dataSource,
            error: 'skillId is required for action "deprecate".',
          }
        }
        const deprecated = await service.deprecate(teamId, input.skillId)
        if (!deprecated) {
          return {
            success: false,
            dataSource,
            error: registrySkillNotFoundMessage(input.skillId),
          }
        }
        return {
          success: true,
          dataSource,
          // SMI-5949 Wave 3: corrected from "will no longer appear in search results" — the
          // private registry has no search surface at all (Context § "precedent warning" in the
          // plan doc). This is the actual, now-enforced behavior: `list`/`get`/`install` (both the
          // MCP and Edge Function transports) all carry a `deprecated = FALSE` predicate with no
          // per-call bypass, so an approved-then-deprecated version is invisible everywhere,
          // including to a caller who already knows its exact skillId+version.
          //
          // SMI-5949 adversarial-review corrections (M-1, M-3): this UPDATE has no `.eq('version',
          // …)`, but PostgreSQL applies the SELECT policy to it too (migration
          // 20260809000000_private_registry_approval_gate.sql:78-86), so it only ever actually
          // affects this skillId's currently-APPROVED row(s) — a `pending`/`rejected` sibling
          // version, if one exists, is untouched by this call and can still be independently
          // approved and installed later, regardless of this deprecation. And the
          // `includeDeprecated:true` opt-in is NOT admin-gated — it is a plain, unauthenticated
          // query parameter on `list()`, checked nowhere against role (see
          // `registry-tools.live.reads.ts`'s own doc comment on `listSkills()`), so any team
          // member can pass it, not only a team admin. Since SMI-6109, `list()` runs on the
          // signed-in user's own JWT, not the shared license key — so the message below says
          // "signed-in team member," not "anyone holding the license key."
          message: `Skill "${input.skillId}" has been deprecated. Its approved version(s) will no longer be returned by list, get, or install — even by an exact version — for any team member; a separate pending or rejected version of this skillId, if one exists, is unaffected. Any signed-in team member can still see deprecated versions via private_registry_manage {action:'list', includeDeprecated:true} — this is not restricted to team admins.`,
        }
      }

      case 'undeprecate': {
        if (!input.skillId) {
          return {
            success: false,
            dataSource,
            error: 'skillId is required for action "undeprecate".',
          }
        }
        const undeprecated = await service.undeprecate(teamId, input.skillId)
        if (!undeprecated) {
          return {
            success: false,
            dataSource,
            error: registrySkillNotFoundMessage(input.skillId),
          }
        }
        return {
          success: true,
          dataSource,
          // SMI-5949 Wave 3: same correction as the deprecate message above — "search results" was
          // never accurate for a private registry with no search surface.
          message: `Skill "${input.skillId}" has been undeprecated and is visible again via list, get, and install.`,
        }
      }

      // SMI-5852, AC-11: discover the team's publish namespace without attempting a
      // publish (the required skill_id prefix, e.g. "acme" for "acme/my-skill").
      case 'namespace': {
        const namespace = await service.getNamespace(teamId)
        if (!namespace) {
          // getNamespace() never throws, so "not logged in" and "genuinely unconfigured" both
          // collapse to this one message (unlike list/get's actionable login error) — hinting at
          // login here is a partial fix for that UX gap (SMI-6109 cross-provider review).
          return {
            success: false,
            dataSource,
            error:
              "Unable to resolve this team's private registry namespace. If you haven't run " +
              '`skillsmith login` yet, do that and try again.',
          }
        }
        return {
          success: true,
          dataSource,
          namespace,
          message: `Your team's private registry namespace is "${namespace}".`,
        }
      }

      // SMI-5949 D-5/D-12 — handlers in a companion file, same reason 'install' is. `await`
      // is load-bearing — see the comment on 'install' above.
      case 'submissions':
        return await executeRegistrySubmissions({ input, teamId, dataSource, service })

      case 'approve':
      case 'reject':
        return await executeRegistryReview({ input, teamId, dataSource, service })
    }
  } catch (err) {
    return {
      success: false,
      dataSource,
      error: err instanceof Error ? err.message : 'Registry operation failed.',
    }
  }
}

// SMI-5017 W2.S2: wrap at export boundary
export const executePrivateRegistryPublish = withTelemetry(executePrivateRegistryPublishImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'private_registry_publish',
  extractFramework: () => 'unknown',
})
export const executePrivateRegistryManage = withTelemetry(executePrivateRegistryManageImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'private_registry_manage',
  extractFramework: () => 'unknown',
})
