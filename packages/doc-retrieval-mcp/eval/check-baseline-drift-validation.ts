/**
 * SMI-5708 Item #3 -- baseline.json schema validation.
 *
 * Split out of check-baseline-drift.ts to keep that file under the 500-line
 * standard (audit:standards Check 3). `BaselineFile` is imported type-only
 * from check-baseline-drift.ts, so this does not create a runtime circular
 * import even though that file re-exports `validateBaselineFile` from here.
 *
 * Previously, `prior === null`, `typeof prior !== 'number'`, `typeof current
 * !== 'number'`, and `prior === 0` were ALL treated identically by
 * check-baseline-drift.ts as "first real-mode run, skip the regression
 * check" -- indistinguishable from a corrupted, hand-edited, or zeroed
 * baseline.json. This module closes that gap.
 */

import type { BaselineFile } from './check-baseline-drift.js'

/**
 * Result of `validateBaselineFile`. Mirrors the `ChangedFilesResult`
 * discriminated-union style in check-baseline-drift.ts (SMI-5708 Item #2)
 * for consistency.
 */
export interface BaselineValidationOk {
  ok: true
}

export interface BaselineValidationError {
  ok: false
  error: string
}

export type BaselineValidationResult = BaselineValidationOk | BaselineValidationError

const REQUIRED_METRIC_KEYS = ['recallAt5', 'recallAt10', 'mrr', 'ndcgAt10'] as const

/**
 * Validate a "required" metric-style field: must be a finite number in
 * [0, 1]. `null`/`undefined` are NOT accepted here -- only the dedicated
 * `prior`-style fields below get that allowance.
 */
function invalidRequiredMetric(value: unknown, field: string): string | null {
  if (typeof value !== 'number') {
    return `${field} must be a number, got ${typeof value} (${JSON.stringify(value)})`
  }
  if (!Number.isFinite(value)) {
    return `${field} must be a finite number, got ${value}`
  }
  if (value < 0 || value > 1) {
    return `${field} must be in range [0, 1], got ${value}`
  }
  return null
}

/**
 * Validate a per-category "prior" map entry (`byCategory.recallAt5Prior[cat]`):
 * finite number in [0, 1] when present. Unlike the top-level `prior` field
 * below, an exact 0 here is a legitimate, already-handled state (see
 * `checkHybridDrift`'s `priorCat === 0` skip) so it is NOT rejected.
 */
function invalidCategoryPriorEntry(value: unknown, field: string): string | null {
  if (typeof value !== 'number') {
    return `${field} must be a number, got ${typeof value} (${JSON.stringify(value)})`
  }
  if (!Number.isFinite(value)) {
    return `${field} must be a finite number, got ${value}`
  }
  if (value < 0 || value > 1) {
    return `${field} must be in range [0, 1], got ${value}`
  }
  return null
}

/**
 * Structural check for a plain, non-null, non-array object -- used to
 * validate byCategory's required sub-fields are genuinely map-shaped before
 * iterating their entries (Codex round-2 review finding, High: without
 * this, `byCategory: {}` or a partial shape silently skipped the per-entry
 * checks below instead of being flagged as invalid).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Schema-validates a loaded `baseline.json`. This is the core of the
 * SMI-5708 Item #3 fix.
 *
 * Rules:
 *   - `prior`: may be `null` ONLY when `bootstrapped === true` (written
 *     exclusively by `eval-runner.ts`'s `updateBaseline()` bootstrap branch).
 *     Otherwise must be a finite number in (0, 1] -- exactly 0 is rejected,
 *     closing the original `prior === 0` skip loophole. A present, non-null
 *     `prior` is validated on its own merits regardless of `bootstrapped`'s
 *     value -- `bootstrapped: true` never legitimizes anything other than
 *     `prior === null`.
 *   - `current`: required finite number in [0, 1] (never null).
 *   - `metrics.*` (when `metrics` is present): each of recallAt5/recallAt10/
 *     mrr/ndcgAt10 must be `null` (not yet computed, per the field's own
 *     type) or a finite number in [0, 1].
 *   - `byCategory` (when present): `recallAt5` and `count` are REQUIRED
 *     objects (not just checked-if-truthy, per Codex round-2 review finding
 *     -- `byCategory: {}` or a partial shape used to silently skip the
 *     per-entry checks below instead of being flagged invalid). Their
 *     entries: `recallAt5[*]` and `recallAt5Prior[*]` must be a finite
 *     number in [0, 1] per category (0 allowed -- see
 *     `invalidCategoryPriorEntry`; both the prior AND current per-category
 *     snapshots are validated, Opus review finding F2 -- a NaN/out-of-range
 *     value in the CURRENT snapshot alone would otherwise silently disable
 *     that category's regression check in `checkHybridDrift`, since a NaN
 *     comparison is always false). `count[*]` must be a finite
 *     non-negative integer -- feeds the N-hit floor division
 *     (`hitFloor / count`) in `checkHybridDrift`. `recallAt5Prior` itself
 *     may be `null` (legitimate first run with byCategory present) but
 *     must be an object when not null.
 */
export function validateBaselineFile(baseline: BaselineFile): BaselineValidationResult {
  // Opus round-3 review finding (LOW, in-scope): a top-level `null` (or any
  // other non-object JSON value) is syntactically valid, so a bare
  // `JSON.parse` at either call site (the CI reader in check-baseline-drift.ts,
  // or the writer's existing-file check in eval-runner-baseline.ts) would
  // hand this function a non-object, which then throws an uncaught TypeError
  // reading `.prior` off it -- still fail-closed, but an unactionable crash
  // instead of this item's whole point: a loud, ACTIONABLE failure. Guarding
  // once here (rather than duplicating the guard at every call site) covers
  // both callers.
  if (!isPlainObject(baseline)) {
    return {
      ok: false,
      error:
        `baseline.json must be a JSON object, got ` +
        (baseline === null ? 'null' : Array.isArray(baseline) ? 'array' : typeof baseline),
    }
  }

  const errors: string[] = []

  if (baseline.prior === null) {
    if (baseline.bootstrapped !== true) {
      errors.push(
        'prior is null but bootstrapped is not true -- a null prior is only valid on the ' +
          "genuine first real-mode run, marked by eval-runner.ts's updateBaseline(). If this " +
          'baseline.json was hand-edited or corrupted, restore it from git history or re-run ' +
          'RETRIEVAL_EVAL_REAL=1 npm run eval:retrieval.'
      )
    }
  } else if (typeof baseline.prior !== 'number') {
    errors.push(
      `prior must be null or a number, got ${typeof baseline.prior} (${JSON.stringify(baseline.prior)})`
    )
  } else if (!Number.isFinite(baseline.prior)) {
    errors.push(`prior must be finite, got ${baseline.prior}`)
  } else if (baseline.prior <= 0 || baseline.prior > 1) {
    errors.push(
      `prior must be in range (0, 1] when non-null, got ${baseline.prior} -- a value of exactly ` +
        '0 is rejected because it previously disabled the regression check silently (SMI-5708 Item #3)'
    )
  }

  const currentError = invalidRequiredMetric(baseline.current, 'current')
  if (currentError) errors.push(currentError)

  if (baseline.metrics) {
    for (const key of REQUIRED_METRIC_KEYS) {
      const value = baseline.metrics[key]
      if (value === null || value === undefined) continue
      const err = invalidRequiredMetric(value, `metrics.${key}`)
      if (err) errors.push(err)
    }
  }

  // Codex round-2 review finding (High): the per-entry checks below were
  // previously gated on truthiness alone (`baseline.byCategory?.recallAt5`),
  // so a malformed shape like `byCategory: {}` or `byCategory: { recallAt5:
  // {...} }` (missing `count` entirely) silently skipped the missing
  // sub-object's checks rather than being flagged as invalid -- letting that
  // corruption pass validation on any unrelated diff. `recallAt5` and
  // `count` are REQUIRED whenever `byCategory` itself is present (per the
  // BaselineFile type); `recallAt5Prior` may legitimately be `null` (first
  // run with byCategory present) but must be an object when it isn't null.
  //
  // Codex round-3 review finding: the parent guard itself, `if
  // (baseline.byCategory)`, was ALSO truthiness-based -- so a present but
  // falsy-and-wrong-typed `byCategory` (`null`, `false`, `0`, `""`) silently
  // passed as though the optional field were genuinely absent, the same bug
  // one level up. `undefined` is the only value the `byCategory?:` type
  // actually allows for "absent"; anything else present must be a plain
  // object or it's a type violation.
  if (baseline.byCategory !== undefined) {
    if (!isPlainObject(baseline.byCategory)) {
      errors.push(
        `byCategory must be an object when present, got ${JSON.stringify(baseline.byCategory)}`
      )
    } else {
      if (!isPlainObject(baseline.byCategory.recallAt5)) {
        errors.push(
          `byCategory.recallAt5 must be an object when byCategory is present, got ` +
            `${JSON.stringify(baseline.byCategory.recallAt5)}`
        )
      } else {
        for (const [cat, value] of Object.entries(baseline.byCategory.recallAt5)) {
          // Opus review finding (F2): the CURRENT per-category values were
          // validated for their `*Prior` counterpart but not themselves -- a
          // NaN/out-of-range byCategory.recallAt5 entry slips through
          // unnoticed and silently disables that category's regression
          // check in checkHybridDrift (a NaN comparison is always false, so
          // the category never trips). Same tolerance as the prior-entry
          // check: 0 is a legitimate score, not rejected.
          const err = invalidCategoryPriorEntry(value, `byCategory.recallAt5.${cat}`)
          if (err) errors.push(err)
        }
      }

      if (!isPlainObject(baseline.byCategory.count)) {
        errors.push(
          `byCategory.count must be an object when byCategory is present, got ` +
            `${JSON.stringify(baseline.byCategory.count)}`
        )
      } else {
        // byCategory.count feeds the N-hit floor threshold math in
        // checkHybridDrift (hitFloor / count) -- a negative or non-finite
        // count would corrupt that division. 0 is legitimate
        // (checkHybridDrift already skips count === 0 categories), so only
        // reject negative/non-finite/non-integer values.
        for (const [cat, value] of Object.entries(baseline.byCategory.count)) {
          if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
            errors.push(
              `byCategory.count.${cat} must be a finite integer, got ${JSON.stringify(value)}`
            )
          } else if (value < 0) {
            errors.push(`byCategory.count.${cat} must be >= 0, got ${value}`)
          }
        }
      }

      const recallAt5Prior = baseline.byCategory.recallAt5Prior
      if (recallAt5Prior !== null && recallAt5Prior !== undefined) {
        if (!isPlainObject(recallAt5Prior)) {
          errors.push(
            `byCategory.recallAt5Prior must be null or an object, got ${JSON.stringify(recallAt5Prior)}`
          )
        } else {
          for (const [cat, value] of Object.entries(recallAt5Prior)) {
            const err = invalidCategoryPriorEntry(value, `byCategory.recallAt5Prior.${cat}`)
            if (err) errors.push(err)
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join('; ') }
  }
  return { ok: true }
}
