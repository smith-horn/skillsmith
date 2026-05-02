/**
 * @fileoverview Type vocabulary for the edit-suggester (SMI-4589 Wave 3 Step 1).
 * @module @skillsmith/mcp-server/audit/edit-suggester.types
 *
 * Defines `RecommendedEdit`, `EditCategory`, `EditTemplate` — the public
 * surface consumed by Wave 3's audit-report writer extension, install
 * pre-flight wiring, and Wave 4's MCP `apply_recommended_edit` tool surface.
 *
 * The shapes are deliberately additive: `RecommendedEdit` does not extend
 * `RenameSuggestion` (Wave 2) because the `before`/`after` snippet pair has
 * no analogue in the rename surface — coupling them would force the rename
 * engine to carry prose-edit fields it never uses.
 *
 * Plan: docs/internal/implementation/smi-4589-edit-suggester.md §1.
 */

import type { CollisionId, SemanticCollisionFlag } from './collision-detector.types.js'

/**
 * Which class of prose collision a `RecommendedEdit` addresses.
 *
 * - `description_overlap` — two SKILL.md descriptions semantically overlap
 *   (cosine ≥0.75). Renaming doesn't help; the descriptions need to
 *   differentiate.
 * - `claude_md_trigger_overlap` — two CLAUDE.md trigger phrases semantically
 *   overlap. Renaming the file doesn't help; the prose needs to change.
 *
 * v1 ships only `description_overlap` via the `add_domain_qualifier`
 * template. `claude_md_trigger_overlap` (paired with the
 * `reword_trigger_verb` template) FAILED the per-template gate at 2.35/5
 * and is dropped from v1 — see plan §"Wave 3 ship gate". The category enum
 * still ships so SMI-4593's reauthored template body has a stable value to
 * register against without a follow-up type change.
 */
export type EditCategory = 'description_overlap' | 'claude_md_trigger_overlap'

/**
 * The narrow set of template patterns the edit-suggester knows about. v1
 * ships `add_domain_qualifier` only (4.10/5 from GPT-5.4 reviewer-#2
 * scoring). The other two templates failed the per-template gate at
 * 2.35/5 and 1.70/5 respectively; SMI-4593 reauthors them.
 *
 * The string union is the canonical allowlist key for
 * `APPLY_TEMPLATE_REGISTRY` in `edit-applier.ts`. Adding a new pattern
 * here without registering it in that allowlist is a TS error (the apply
 * path narrows on the registry literal); adding it to the allowlist
 * without re-scoring against the per-template gate is caught at
 * plan-review time per the Wave 3 plan §6.
 */
export type EditTemplatePattern = 'add_domain_qualifier' | 'narrow_scope' | 'reword_trigger_verb'

/**
 * One concrete prose-edit recommendation surfaced by `runEditSuggester`.
 *
 * Wave 3 emits these in two surfaces:
 *
 * 1. Audit-report writer's "Recommended Edits" section (rendered as a
 *    `diff` fenced markdown block per plan §2).
 * 2. `NamespaceWarning.recommendedEdit` field for `description_overlap`
 *    collisions surfaced at install pre-flight time (plan §3).
 *
 * Wave 4's `apply_recommended_edit` MCP tool consumes this shape directly
 * — `applyMode: 'apply_with_confirmation'` is the green-light for the
 * tool to mutate the file, gated by `APPLY_TEMPLATE_REGISTRY`.
 */
export interface RecommendedEdit {
  /** Matches the source `SemanticCollisionFlag.collisionId` from Wave 1. */
  collisionId: CollisionId
  /** Which prose-collision class this edit addresses. */
  category: EditCategory
  /** Template pattern that generated the edit (registry allowlist key). */
  pattern: EditTemplatePattern
  /** Absolute path to the file to mutate (SKILL.md or CLAUDE.md). */
  filePath: string
  /** 1-indexed inclusive line range covering the `before` snippet. */
  lineRange: { start: number; end: number }
  /**
   * Exact current snippet at `filePath:lineRange`. The applier validates
   * this matches byte-for-byte before mutating; mismatch returns
   * `error: 'edit.stale_before'` and the file is untouched.
   */
  before: string
  /**
   * Templated proposed text. Deterministic — no LLM rewrite. v1 inserts
   * `for <tag> tasks` after the trigger verb in the description.
   */
  after: string
  /**
   * Human-readable rationale, e.g.
   * `"differentiates from skillsmith/release-tools (cosine 0.82)"`.
   * Surfaced verbatim in the audit-report markdown and in the install
   * pre-flight warning message.
   */
  rationale: string
  /**
   * Always `'recommended_edit'`. Distinguishes the prose-edit surface
   * from Wave 2's rename surface (`'rename_command_file'` etc.) when
   * agents introspect heterogeneous suggestion lists.
   */
  applyAction: 'recommended_edit'
  /**
   * `'manual_review'` — render in the audit report only; no mutation
   * path. `'apply_with_confirmation'` — agent may auto-apply via
   * `apply_recommended_edit` after user confirmation.
   *
   * v1: `add_domain_qualifier` (the only registered template) ships at
   * `'apply_with_confirmation'`. `runEditSuggester` does NOT emit any
   * edit at `'manual_review'` mode in v1 — the failing templates are
   * absent from output entirely per plan R-4/R-8.
   */
  applyMode: 'manual_review' | 'apply_with_confirmation'
  /**
   * Cross-reference to the partner skill in the original collision flag.
   * Lets the audit report say "differentiates from <other>" without
   * forcing the writer to re-read inventory state.
   */
  otherEntry: { identifier: string; sourcePath: string }
}

/**
 * One template implementation. `applies()` is a synchronous predicate over
 * the flag; `generate()` is synchronous over `flag + fileContent` (the
 * dispatcher pre-reads files in parallel before iterating templates per
 * plan §1 async dispatch pattern).
 *
 * Templates return `null` from `generate()` when the flag matches but the
 * synthesized edit can't be produced (e.g. line-range extraction fails
 * because the file changed under us). The caller skips silently — the
 * user still sees the warning + cosine score from Wave 1.
 */
export interface EditTemplate {
  category: EditCategory
  pattern: EditTemplatePattern
  /**
   * Higher fires first within a flag. Tiebreak by registration order —
   * the dispatcher is stable. v1 ships a single template per category so
   * priority is informational only, but the field is load-bearing for
   * the SMI-4593 reauthoring path that may register additional templates
   * against the same category.
   */
  priority: number
  applies(flag: SemanticCollisionFlag): boolean
  generate(flag: SemanticCollisionFlag, context: { fileContent: string }): RecommendedEdit | null
}
