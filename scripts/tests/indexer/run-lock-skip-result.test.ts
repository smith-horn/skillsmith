/**
 * SMI-6210: static regression guard for run.ts's lock-skip branch, per the
 * plan doc's change #2
 * (docs/internal/implementation/indexer-lock-starvation-and-audit-log-plan.md):
 * a lock-skip row must write `result='success'`, not `'partial'` — a
 * benign, expected skip (the lock working as designed) should never map to
 * 'degraded' via classifyIndexerQuality() on the public status page.
 * `meta.status='skipped_lock'` (untouched by this change) already carries
 * the real observability signal (SMI-4870's own comment: query via GROUP BY
 * meta.status, not result).
 *
 * scripts/indexer/run.ts's main() runs unconditionally at import time (no
 * import.meta.main guard, no export) and dispatches through the full
 * discovery/maintenance/recheck machinery, so a live invocation-based unit
 * test would need to mock the entire indexer stack for one literal
 * assertion. This instead follows the static-assertion convention already
 * established for run.ts by scripts/tests/indexer-alert-gap.test.ts's own
 * "static/regression (layers 1-2)" describe block (its case 22 reads
 * run.ts's RunSummary interface via regex against the same file).
 *
 * The classification-level regression ("a lock-skip row never classifies as
 * degraded via classifyIndexerQuality") lives in
 * supabase/functions/_shared/health-checks.readers.test.ts, alongside the
 * change #6 (indexer_lock_starvation_state.is_degraded wiring) regression
 * case — see that file's "SMI-6210" case.
 *
 * SMI-6246: the lock-skip branch moved out of run.ts's inline `main()` body
 * into `scripts/indexer/run-lock-retry.ts`'s `handleLockSkip()`, to add the
 * bounded cron-side retry (ADR-140) without pushing run.ts over the 500-line
 * CI gate. This test now targets that file; a companion check confirms
 * run.ts still calls the extracted function rather than reimplementing it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const RUN_TS_PATH = resolve(REPO_ROOT, 'scripts', 'indexer', 'run.ts')
const RUN_LOCK_RETRY_TS_PATH = resolve(REPO_ROOT, 'scripts', 'indexer', 'run-lock-retry.ts')

describe("SMI-6210: run-lock-retry.ts's lock-skip handler writes result='success', not 'partial'", () => {
  const runTs = readFileSync(RUN_TS_PATH, 'utf8')
  const retryTs = readFileSync(RUN_LOCK_RETRY_TS_PATH, 'utf8')

  it('run.ts delegates to handleLockSkip() rather than reimplementing the skip branch inline (SMI-6246)', () => {
    expect(runTs).toMatch(/await handleLockSkip\(supabase,\s*env,\s*requestId\)/)
  })

  // Isolate the lock-skip handler: from the `writeIndexerAuditLog` call
  // (skipMeta is built above it) through its own `process.exit(0)`.
  const branchStart = retryTs.indexOf('const skipMeta')
  const branchEnd = retryTs.indexOf('process.exit(0)', branchStart)

  it('locates the lock-skip handler (sanity check — a miss here would silently no-op every assertion below)', () => {
    expect(branchStart).toBeGreaterThan(-1)
    expect(branchEnd).toBeGreaterThan(branchStart)
  })

  const branch = retryTs.slice(branchStart, branchEnd === -1 ? retryTs.length : branchEnd)

  it("calls writeIndexerAuditLog(supabase, 'success', ...) — the SMI-6210 fix — never 'partial'", () => {
    expect(branch).toMatch(/writeIndexerAuditLog\(supabase,\s*'success',/)
    expect(branch).not.toMatch(/writeIndexerAuditLog\(supabase,\s*'partial',/)
  })

  it("meta.status stays 'skipped_lock' as const — the real observability signal, untouched by the relabel", () => {
    expect(branch).toMatch(/status:\s*'skipped_lock'\s*as const/)
  })

  it("regression: the writeIndexerAuditLog result argument is exactly 'success' (not some other/third value)", () => {
    const resultArgMatch = branch.match(/writeIndexerAuditLog\(supabase,\s*'([a-z]+)',/)
    expect(resultArgMatch).not.toBeNull()
    expect(resultArgMatch?.[1]).toBe('success')
  })

  it('SMI-6246: extends the skip audit row with github_run_id/resumed_from/dispatch_inputs for backfill dispatches only', () => {
    expect(branch).toMatch(/isBackfillAcquisition\(env\)/)
    expect(branch).toMatch(/github_run_id:\s*process\.env\.GITHUB_RUN_ID/)
    expect(branch).toMatch(/resumed_from:\s*process\.env\.RESUME_FROM/)
    expect(branch).toMatch(/dispatch_inputs:\s*buildBackfillDispatchInputs\(env\)/)
  })
})
