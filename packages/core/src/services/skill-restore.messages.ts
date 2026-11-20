/**
 * SMI-6531 (A1 step 6d-ii): wording `skillsmith restore` shares between its
 * plan-time refusals, the locked re-plan and the file and symlink primitives, so
 * one stop never says the same thing two ways.
 *
 * @module @skillsmith/core/services/skill-restore.messages
 */

/** The copy or its origin is no longer what the user confirmed. */
export const PLAN_CHANGED =
  'The copy or its origin changed after you confirmed. Nothing was restored. Run `skillsmith restore <id>` again to see the new plan.'

/** Something already sits at the origin (§4.3 `origin-occupied`). */
export const occupiedMessage = (origin: string): string =>
  `Something already exists at \`${origin}\`. Move it aside first, then run \`skillsmith restore <id>\` again.`
