/**
 * @fileoverview Private registry MCP tools for enterprise skill management
 * @module @skillsmith/mcp-server/tools/registry-tools
 * @see SMI-3902: Private Registry MCP Tools (original stub)
 * @see SMI-5816: Private skill registry — real implementation
 * @see ADR-129: Postgres-native (JSONB) storage + real team-auth (migration 071)
 * @see SMI-6622: the public `@skillsmith/mcp-server` package must never need Supabase env vars —
 *   service selection and team resolution below are NOT gated on `isSupabaseConfigured()`. Round 2
 *   (adversarial review) added credential-source-aware error text and a best-effort non-member
 *   check (registry-tools.membership-check.ts) for an otherwise-ambiguous list/namespace/publish
 *   result.
 *
 * Enables enterprise teams to publish and manage skills in a private registry scoped to their
 * organization. Metadata + packaged content live in `private_registry_skills` (JSONB, not S3 —
 * ADR-129); team-scoped RLS + an in-query team_id filter (ADR-116, SMI-6109 addendum).
 *
 * Backing service is selected at module load: the live Supabase-backed service
 * (registry-tools.live.ts) is the DEFAULT — an in-memory stub (registry-tools.stub.ts) is used
 * only under the explicit `SKILLSMITH_REGISTRY_STUB` test opt-in (see `useRegistryStub()` below).
 *
 * Tier gate: Enterprise (private_registry feature flag — toolFeatureMapping.ts).
 */

import type { ToolContext } from '../context.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { createStubRegistryService } from './registry-tools.stub.js'
import { createLiveRegistryService } from './registry-tools.live.js'
import { resolveRegistryTeamId, type RegistryCredentialSource } from './registry-tools.team.js'
import { confirmedNonMemberMessage } from './registry-tools.membership-check.js'
import { executePrivateRegistryManageAction } from './registry-tools.manage-action.js'
import { dataSourceFor } from './stub-data-source.js'
import type {
  PrivateRegistryInstallSummary,
  RegistrySkillContent,
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
 * Explicit, test-only stub opt-in (SMI-6622) — NOT `isSupabaseConfigured()`. The live service
 * already has an anon-key production fallback (`supabase-client.ts`, SMI-6109), so no Supabase env
 * var is needed to reach it. `vitest.setup.ts` sets this for the whole test run; a test wanting the
 * live service still calls `setPrivateRegistryService(createLiveRegistryService())` to override.
 *
 * Adversarial-review finding (SMI-6622 round 2): honoring this flag unconditionally made it a
 * production footgun, not just a test convenience — a stray `SKILLSMITH_REGISTRY_STUB=1` in a real
 * MCP host's config would make `publish` return `success:true` with nothing written, the exact
 * silent-success class this issue exists to remove. Only ever honored when `process.env.VITEST`
 * is `'true'` (Vitest sets this itself — see e.g. `client.events.ts`/`rotation.ts` for the same
 * convention) — outside the test runner the flag is ignored and a warning is logged so a stray
 * value is diagnosable rather than silently inert.
 */
function useRegistryStub(): boolean {
  const v = process.env.SKILLSMITH_REGISTRY_STUB
  if (v !== '1' && v !== 'true') return false
  if (process.env.VITEST !== 'true') {
    console.error(
      '[skillsmith] SKILLSMITH_REGISTRY_STUB is set but ignored outside the Vitest test runner ' +
        '(process.env.VITEST is not "true"); the live registry service is used regardless.'
    )
    return false
  }
  return true
}

/** Module-level singleton. Live is the DEFAULT (SMI-6622); stub only under the opt-in above. */
let service: PrivateRegistryService = useRegistryStub()
  ? createStubRegistryService()
  : createLiveRegistryService()

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
 * Execute a private_registry_publish operation.
 */
async function executePrivateRegistryPublishImpl(
  input: PrivateRegistryPublishInput,
  _context: ToolContext
): Promise<PrivateRegistryPublishResult> {
  // One read of the module-level singleton, so provenance and data can never come from two
  // different instances if `setPrivateRegistryService()` lands during an await below (SMI-6203
  // pattern, as in rbac-tools.action.ts). `dataSource` reflects which service is ACTUALLY wired in,
  // not merely whether Supabase env happens to be configured (SMI-6622/SMI-6184).
  const svc = service
  const dataSource: 'stub' | 'live' = dataSourceFor(svc)
  let teamId: string
  let credentialSource: RegistryCredentialSource
  try {
    ;({ teamId, source: credentialSource } = await resolveRegistryTeamId())
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
  const namespace = await svc.getNamespace(teamId)
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
    const skill = await svc.publish(
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
    const message = err instanceof Error ? err.message : 'Failed to publish skill.'
    // SMI-6622 round 2 finding 3: an RLS-shaped insert denial is indistinguishable from a genuine
    // permission problem UNTIL we positively confirm non-membership — see
    // registry-tools.membership-check.ts's own header for why this never fires on a mere guess.
    if (dataSource === 'live' && /row-level security|permission denied|42501/i.test(message)) {
      const nonMember = await confirmedNonMemberMessage(teamId, credentialSource)
      if (nonMember) return { success: false, dataSource, error: nonMember }
    }
    return { success: false, dataSource, error: message }
  }
}

/**
 * Execute a private_registry_manage operation.
 *
 * Resolves the team/credential source and reads the module-level `service` singleton (both fresh,
 * at call time — never captured once at import time, so `setPrivateRegistryService()`'s test/
 * production swap keeps working), then delegates the actual action switch to
 * `registry-tools.manage-action.ts` (SMI-6622 round 3 — split out to keep this file comfortably
 * under the pre-commit 500-line file-length gate; see that file's own header for the full
 * rationale, including why `service` is passed as a parameter rather than re-fetched there).
 */
async function executePrivateRegistryManageImpl(
  input: PrivateRegistryManageInput,
  context: ToolContext
): Promise<PrivateRegistryManageResult> {
  // Single singleton read — see executePrivateRegistryPublishImpl's identical comment above.
  const svc = service
  const dataSource: 'stub' | 'live' = dataSourceFor(svc)
  let teamId: string
  let credentialSource: RegistryCredentialSource
  try {
    ;({ teamId, source: credentialSource } = await resolveRegistryTeamId())
  } catch (err) {
    return {
      success: false,
      dataSource,
      error: err instanceof Error ? err.message : 'Failed to resolve team from license key.',
    }
  }

  return executePrivateRegistryManageAction({
    input,
    context,
    teamId,
    credentialSource,
    dataSource,
    service: svc,
  })
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
