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
 * Forward-declaration note: `RenameSuggestion` lands in
 * `./rename-engine.types.ts` in PR #2 of the Wave 2 stack. PR #1 ships only
 * the ledger reader/writer, which does not reference `NamespaceWarning` or
 * `PendingCollision`. To avoid a phantom dependency on a not-yet-shipped
 * file, the suggestion field is typed structurally below using
 * `RenameSuggestionRef` — a minimal shape pinned to the spec in plan §1.
 * PR #2 replaces the ref with `import type { RenameSuggestion } from
 * './rename-engine.types.js'`; both shapes are structurally compatible.
 */

import type { CollisionId } from './collision-detector.types.js'

/**
 * Forward-declaration shim for `RenameSuggestion` (defined in
 * `./rename-engine.types.ts` as of Wave 2 PR #2). The shape mirrors the spec
 * in `docs/internal/implementation/smi-4588-rename-engine-ledger-install.md`
 * §1 verbatim. PR #2 widens this into the full canonical type and replaces
 * the alias below with a direct import.
 */
export interface RenameSuggestionRef {
  collisionId: CollisionId
  /** `'rename_command_file' | 'rename_agent_file' | 'rename_skill_dir_and_frontmatter'`. */
  applyAction: string
  currentName: string
  /** First non-colliding candidate from `generateSuggestionChain`. */
  suggested: string
  reason: string
}

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
  suggestion: RenameSuggestionRef
  /**
   * FK to the audit history written by `runInstallPreflight` (PR #3). Lets
   * a later `apply_namespace_rename` call (Wave 4) re-read the original
   * suggestion without re-running detection.
   */
  auditId: string
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
  suggestedRename: RenameSuggestionRef
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
