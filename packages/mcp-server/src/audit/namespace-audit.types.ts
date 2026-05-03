/**
 * @fileoverview Shared namespace-audit type vocabulary (SMI-4588 Wave 2 Step 1, PR #1).
 * @module @skillsmith/mcp-server/audit/namespace-audit.types
 *
 * `NamespaceWarning` and `PendingCollision` live here — not in
 * `tools/install.types.ts` and not in `audit/install-preflight.ts` — to break
 * the `tools → audit → tools` cycle that would otherwise form between
 * `install-preflight.ts` (which constructs them) and `install.types.ts`
 * (which embeds them in `InstallResult`). The shared file is depended on by
 * both sides; neither side depends on the other.
 *
 * Wave 2 plan §4 + Edit 3 — placed in Step 1 so PRs #3/#4 import without
 * rework.
 *
 * `RenameSuggestion` is imported from `./rename-engine.types.js` (PR #2). The
 * PR #1 forward-declaration shim has been retired now that the canonical
 * type ships alongside the rename engine.
 */

import type { CollisionId } from './collision-detector.types.js'
import type { RenameSuggestion } from './rename-engine.types.js'
import type { RecommendedEdit } from './edit-suggester.types.js'

// `CollisionId` is referenced by `NamespaceWarning.collisionId`; do not remove.
// `RenameSuggestion` is referenced by `NamespaceWarning.suggestion` and
// `PendingCollision.suggestedRename`; PR #2 swap-in.

/**
 * A non-blocking namespace collision surfaced by the install pre-flight
 * (Wave 2 PR #3). `power_user` and `governance` modes return one of these
 * per detected collision in `InstallResult.warnings[]`; the agent surfaces
 * the suggestion to the user but the install still proceeds.
 */
export interface NamespaceWarning {
  /** Stable across audit runs — derived via `deriveCollisionId`. */
  collisionId: CollisionId
  /** Matches the source collision flag's `kind`. */
  kind: 'exact' | 'generic' | 'semantic'
  /** Always `'warning'` — `NamespaceWarning` never blocks install. */
  severity: 'warning'
  /** User-facing message (rendered verbatim to the agent). */
  message: string
  /**
   * Suggested rename for the agent to surface. Constructed by
   * `generateRenameSuggestions` (Wave 2 PR #2). Walking the suggestion
   * chain is the agent's job — `suggestion` is the first non-colliding
   * candidate.
   */
  suggestion: RenameSuggestion
  /**
   * FK to the audit history written by `runInstallPreflight` (PR #3). Lets
   * a later `apply_namespace_rename` call (Wave 4) re-read the original
   * suggestion without re-running detection.
   */
  auditId: string
  /**
   * SMI-4589 Wave 3: optional prose-edit recommendation surfaced for
   * `description_overlap` semantic collisions. The agent surfaces the
   * `RecommendedEdit` alongside the rename suggestion; rename may not
   * be the right remediation when descriptions semantically overlap.
   *
   * Per the per-template gate ratified 2026-05-01, only
   * `add_domain_qualifier`-pattern edits populate this field in v1.
   * `kind: 'exact'` and `kind: 'generic'` warnings never carry a
   * recommended edit (they're text-identifier collisions, not prose).
   */
  recommendedEdit?: RecommendedEdit
}

/**
 * Blocking-mode envelope for `audit_mode: 'preventative'` installs (Wave 2
 * PR #3, decision #2). When pre-flight detects a collision, `install_skill`
 * returns `installComplete: false` plus this envelope. The agent calls
 * `apply_namespace_rename({ auditId, action: 'apply' })` (Wave 4) and then
 * re-invokes `install_skill`.
 *
 * The `suggestionChain[]` carries up to 3 ordered candidates per
 * decision #11; the agent walks the chain and picks the first non-colliding
 * one. `chainExhausted` is `true` when all 3 collide and the agent must
 * escalate to the human via `customName`.
 */
export interface PendingCollision {
  /** ULID — passed back to `apply_namespace_rename`. */
  auditId: string
  /**
   * First non-colliding candidate from `generateSuggestionChain`. The agent
   * surfaces this to the user as the recommended rename.
   */
  suggestedRename: RenameSuggestion
  /**
   * Up to 3 candidates from `generateSuggestionChain` (decision #11). The
   * agent has the full chain so it can present alternatives without
   * re-querying.
   */
  suggestionChain: string[]
  /**
   * `true` when all 3 chain candidates collide. The agent must escalate to
   * the human and call `apply_namespace_rename({ customName: '…' })`.
   */
  chainExhausted: boolean
  /**
   * Human-readable remediation hint, e.g.
   * `"call apply_namespace_rename({ auditId, action: 'apply' }) then re-invoke install_skill"`.
   */
  remediationHint: string
}
