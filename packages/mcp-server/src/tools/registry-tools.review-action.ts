/**
 * @fileoverview `private_registry_manage(action:'submissions'|'approve'|'reject')` handlers
 * @module @skillsmith/mcp-server/tools/registry-tools.review-action
 * @see SMI-5949 Wave 2 Step 4 (D-5, D-12)
 * @see docs/internal/implementation/smi-5949-approval-gate.md
 *
 * Mirrors `registry-tools.install-action.ts`'s shape and reason for existing: `registry-tools.ts`
 * (already 445/500 lines once the earlier Wave 2 steps landed) stays a thin dispatcher, and the
 * three new review-gate actions' logic lives here instead.
 *
 * TWO INVARIANTS THIS FILE EXISTS TO HOLD (plan-review findings M10 / C1 / H6):
 *
 * 1. **RPC error messages are passed through VERBATIM.** `service.review()`
 *    (`registry-tools.live.ts` -> `registry-tools.live.submissions.ts`'s `reviewSubmission()`)
 *    throws `Error(resp.error.message)` unmodified. `executeRegistryReview()` below has NO local
 *    try/catch — the thrown Error propagates straight to `executePrivateRegistryManageImpl`'s own
 *    catch block (`registry-tools.ts`), which surfaces `err.message` unchanged. That unbroken
 *    chain is what makes the D-5 step-3 "you are not an admin — promote a second admin/owner"
 *    (`42501`) and step-6 client-version-remediation (`23514`) text reach the caller byte-for-byte
 *    by construction, not by convention a future edit could quietly break.
 * 2. **Neither response may imply the reviewer saw full content** (finding C1). Both `submissions`
 *    and `approve`/`reject` are provenance/metadata-only — the underlying RPCs have no `content`
 *    column at all, by construction (D-4(c)) — and every message below says so explicitly.
 *
 * A third finding (H6) applies everywhere in this file: never print `approvalStatus`/
 * `approvalMode` as a bare field name in a message — a value plus a noun-phrase qualifier only
 * (e.g. "review status"), so the two near-identical field names are never confused.
 */

import type {
  PrivateRegistryManageInput,
  PrivateRegistryManageResult,
  PrivateRegistryService,
} from './registry-tools.js'

export interface RegistryReviewActionParams {
  input: PrivateRegistryManageInput
  /** License-derived team id, resolved by the outer handler. Never taken from tool input. */
  teamId: string
  dataSource: 'stub' | 'live'
  service: PrivateRegistryService
}

/**
 * `private_registry_manage(action:'submissions')` — D-5's read side. No required input beyond
 * `action`; `status` narrows to one review status, omitted means everything visible to the caller
 * (their own submissions in any status, every approved version, and — for admins — every other
 * member's non-approved submissions too, per `get_private_registry_submissions`'s own body).
 */
export async function executeRegistrySubmissions(
  params: RegistryReviewActionParams
): Promise<PrivateRegistryManageResult> {
  const { input, teamId, dataSource, service } = params
  const submissions = await service.submissions(teamId, input.status)
  return {
    success: true,
    dataSource,
    submissions,
    message:
      `Found ${submissions.length} submission(s) visible to you. Metadata only — provenance ` +
      '(who published it, when, and what version/description) and review status, not a full ' +
      'read of any submitted content.',
  }
}

/**
 * `private_registry_manage(action:'approve'|'reject')` — D-5's write side (D-5/D-6/D-8's actual
 * checks all live in the `review_private_registry_submission` RPC itself; see this module's
 * header for why nothing here may re-wrap what it raises).
 */
export async function executeRegistryReview(
  params: RegistryReviewActionParams
): Promise<PrivateRegistryManageResult> {
  const { input, teamId, dataSource, service } = params
  const decision: 'approved' | 'rejected' = input.action === 'approve' ? 'approved' : 'rejected'

  if (!input.skillId || !input.version) {
    return {
      success: false,
      dataSource,
      error: `skillId and version are both required for action "${input.action}".`,
    }
  }

  const review = await service.review(teamId, input.skillId, input.version, decision, input.note)

  const message =
    decision === 'approved'
      ? `Approved ${input.skillId}@${input.version} — this is now the current installable ` +
        'version. Based on the submitted metadata (who published it, when, and what version/' +
        'description) — this decision did not include a full read of the submitted content.'
      : `Rejected ${input.skillId}@${input.version}, based on the submitted metadata — this ` +
        'decision did not include a full read of the submitted content. It stays invisible to ' +
        'every reader; rejected versions are terminal — bump the version and publish again to ' +
        'resubmit.'

  return { success: true, dataSource, review, message }
}
