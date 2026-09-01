/**
 * Helper for audit-standards.mjs's `.husky/_/<hook>` stub-coverage check
 * (SMI-6334 Wave 2 Step 1), plus its unit-test twin in
 * scripts/tests/audit-standards.test.ts.
 *
 * SMI-6334's fix makes `core.hooksPath` the relative literal '.husky/_',
 * which git resolves against the invoking working tree. Husky's dispatcher
 * (`.husky/_/h`) resolves the hook body to invoke from `$0` (i.e. from
 * `.husky/_/<hook>`) -- so a `.husky/<hook>` body with NO matching
 * `.husky/_/<hook>` stub gets silently skipped by git entirely (a missing
 * hook file is not an error; git just doesn't run it), not routed to any
 * other tree. This is exactly the "residual risk" the plan doc's Wave 1
 * table calls out: any branch whose `.husky/_/<hook>` tree has drifted
 * (never committed, or accidentally deleted) trades a wrong-tree hook for
 * NO hook at all once the relative-hooksPath fix lands.
 *
 * This check is a backstop for whichever ONE tree `npm run audit:standards`
 * happens to run against (CI checks out one branch at a time) -- it cannot
 * centrally sweep every currently-active worktree branch. The per-invoking-
 * tree companion at scripts/lib/check-hooks-path.sh (invoked from
 * .husky/pre-push) is what catches a missing stub for the branch actually
 * being used, at push time -- see that file's own doc comment.
 */

import { readdirSync, statSync } from 'fs'
import { join } from 'path'

// The real husky stub body is `#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n`
// (39 bytes as shipped in this repo). Anything well under that is the
// truncated/empty failure mode this check guards against, not a
// legitimately shorter valid stub.
export const MIN_HUSKY_STUB_BYTES = 10

/**
 * Walk `<huskyDir>/*` (excluding the `_` dispatch directory itself) and
 * report every hook file that has no corresponding non-trivial
 * `<huskyDir>/_/<hook>` stub.
 *
 * @param {string} huskyDir - path to the `.husky/` directory to check.
 * @returns {Array<{hook: string, reason: 'missing' | 'trivial', size?: number}>}
 *   One entry per uncovered hook. Empty array = fully covered (or
 *   `huskyDir` itself doesn't exist / isn't readable -- nothing to check).
 */
export function findMissingHuskyStubs(huskyDir) {
  const dispatchDir = join(huskyDir, '_')

  let entries
  try {
    entries = readdirSync(huskyDir, { withFileTypes: true })
  } catch {
    return []
  }

  const findings = []
  for (const entry of entries) {
    // `_` itself is a directory (the dispatch tree), not a hook file --
    // isFile() excludes it along with any other stray non-file entry.
    if (!entry.isFile()) continue

    const hook = entry.name
    const stubPath = join(dispatchDir, hook)

    let size
    try {
      size = statSync(stubPath).size
    } catch {
      findings.push({ hook, reason: 'missing' })
      continue
    }

    if (size < MIN_HUSKY_STUB_BYTES) {
      findings.push({ hook, reason: 'trivial', size })
    }
  }

  return findings
}
