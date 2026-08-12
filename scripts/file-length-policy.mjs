/**
 * Shared file-length policy (SMI-5992)
 *
 * Exports the 500-line threshold and the test-file exemption predicate
 * shared between two otherwise-independent file-length checks:
 *   - scripts/check-file-length.mjs — pre-commit, hard-fails, checks
 *     whatever lint-staged passes it (any staged directory).
 *   - scripts/audit-standards.mjs Check 3 — CI, warn()-only (never fails
 *     the run), scans only packages/ + apps/.
 *
 * SCOPE NOTE — this module intentionally shares ONLY the threshold
 * (MAX_LINES) and the test-file exemption predicate
 * (isExemptFromLengthCheck). The two checks still deliberately differ in
 * everything else: directory scope, file extensions scanned (.ts + .sh
 * for pre-commit vs. .ts + .tsx for CI), and severity (hard-fail vs.
 * warn-only). This is NOT a full reconciliation of the two checks — see
 * the cross-referencing comments in scripts/check-file-length.mjs and
 * scripts/audit-standards.mjs Check 3, and SMI-5994, which tracks the
 * still-open scope/severity divergence separately.
 */

import { basename } from 'node:path'

/** The shared 500-line threshold both checks enforce (or warn on). */
export const MAX_LINES = 500

/**
 * True when `path` is a test file exempt from the length check.
 *
 * Matches both `.test.` and `.spec.` substrings — a deliberate decision,
 * not an oversight (SMI-5992): this repo's own test-file recognition
 * elsewhere already treats `.spec.` files as the same category as
 * `.test.` files — see scripts/audit-standards.mjs's own Check 4
 * (`getFilesRecursive('packages', ['.test.ts', '.test.tsx', '.spec.ts'])`)
 * and CLAUDE.md's "Test File Locations" table, which lists `*.spec.ts`
 * as an equally valid pattern alongside `*.test.ts`. Exempting one
 * pattern but not the other from this specific check was an unjustified
 * inconsistency, not a considered choice.
 *
 * Matches against the BASENAME only, not the full path (code-review
 * finding, SMI-5992) — matching the full path would wrongly exempt a
 * genuinely non-test file sitting under a directory whose name happens to
 * contain `.test.` or `.spec.` (e.g. `packages/foo.test.fixtures/src/
 * runtime.ts`), silently weakening both gates for a file that was never a
 * test file at all.
 *
 * @param {string} path - a file path (absolute or relative; any separator)
 * @returns {boolean} true if the file is exempt from the length check
 */
export function isExemptFromLengthCheck(path) {
  const base = basename(path)
  return base.includes('.test.') || base.includes('.spec.')
}
