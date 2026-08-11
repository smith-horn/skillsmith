/**
 * @fileoverview Types for the SMI-5949 review-gate service surface (`submissions`/`review`)
 * @module @skillsmith/mcp-server/tools/registry-tools.review.types
 * @see SMI-5949 D-5: the two `SECURITY DEFINER` RPCs
 * @see docs/internal/implementation/smi-5949-approval-gate.md
 *
 * A types-only companion (the `foo.types.ts` convention already used by
 * `registry-tools.content.types.ts`), split out so `registry-tools.ts` — 467/500 lines before
 * this step — does not absorb another interface's worth of JSDoc. `PrivateRegistryService`
 * (registry-tools.ts) extends {@link PrivateRegistryReviewService} rather than declaring these
 * two methods inline.
 */

import type { RegistrySkill } from './registry-tools.js'

/**
 * `review_private_registry_submission`'s own `RETURNS TABLE` shape — deliberately NOT a
 * `RegistrySkill`. The RPC returns only these 6 columns (no `description`/`publishedBy`/
 * `publishedAt`/`approvalMode`), so fabricating a full `RegistrySkill` would invent values.
 */
export interface RegistryReviewDecision {
  skillId: string
  version: string
  approvalStatus: 'approved' | 'rejected'
  approvedBy: string | null
  approvedAt: string | null
  reviewNote: string | null
}

/**
 * SMI-5949 D-5. Mixed into `PrivateRegistryService` (registry-tools.ts) via `extends`.
 */
export interface PrivateRegistryReviewService {
  /** `approved` rows to any member; `pending`/`rejected` rows only to their own submitter or a
   *  team admin. Metadata-only by construction (D-4(c)/plan-review finding C1) — never `content`. */
  submissions(
    teamId: string,
    status?: 'pending' | 'approved' | 'rejected'
  ): Promise<RegistrySkill[]>
  /** Approve/reject one `pending` row. Throws the RPC's error VERBATIM on every rejection path
   *  (not-admin `42501`, self-approval, terminal, missing `published_by` `23514`) — plan-review
   *  finding M10. Never remap a SQLSTATE to a canned message. */
  review(
    teamId: string,
    skillId: string,
    version: string,
    decision: 'approved' | 'rejected',
    note?: string
  ): Promise<RegistryReviewDecision>
}
