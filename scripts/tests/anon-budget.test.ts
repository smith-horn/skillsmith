/**
 * SMI-6040 (Wave 1, Step 4): regression coverage for two bugs found and
 * fixed in scripts/smoke-prod/anon-budget.sh's PR review (#2387), before
 * either had a committed test. No network calls — deterministic and fast.
 *
 * TRAP-1 `trap ... RETURN` IS NOT FUNCTION-SCOPED: the reset step
 *     (adjust_anon_usage, delta=-1) was originally guaranteed to "always run"
 *     via `trap '_anon_budget_reset "$ip_hash"' RETURN` inside
 *     _anon_budget_layer2_shadow/_anon_budget_layer2_enforce. Empirically
 *     confirmed live (and independently reproduced from scratch — a prior
 *     review pass had incorrectly claimed the trap fires exactly once) that
 *     bash RETURN traps are NOT function-scoped: the trap fires again on
 *     every ENCLOSING caller's own return too, until something overwrites or
 *     clears it. Each extra firing is a real `adjust_anon_usage(ip_hash, -1)`
 *     against the live production row. Fixed by replacing the trap with two
 *     ordinary sequential statements (assert, capture exit code, always
 *     reset, return the captured code). These tests pin the fixed behavior
 *     (reset fires exactly once across every exit path) and statically guard
 *     against the trap pattern reappearing.
 *
 * RETRY-1 with_retry ON A NON-IDEMPOTENT RPC CALL: `with_retry`'s
 *     ambiguous-failure retry treats any "000" substring anywhere in
 *     captured stdout+stderr — including inside a real skills-search JSON
 *     response body, where a millisecond ISO-8601 timestamp like ".000Z" is
 *     a near-certain false match — as a signal to retry. Since
 *     check_anon_usage/adjust_anon_usage increment/adjust non-idempotently,
 *     and both probe layers assert an EXACT delta or value, a phantom retry
 *     silently corrupts the assertion. Fixed by removing with_retry from all
 *     four non-idempotent-write call sites (three _anon_budget_search_request
 *     calls in anon-budget.sh, one _anon_budget_adjust call in
 *     anon-budget.helpers.sh). Static regression guard: those call sites must
 *     never be wrapped in with_retry again. (_anon_budget_seed and the
 *     egress-IP lookup are correctly left on with_retry — an absolute SET is
 *     naturally idempotent under a duplicate retry, and the IP lookup is a
 *     read with no side effect — so this guard is scoped, not blanket.)
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SMOKE_PROD_DIR = resolve(__dirname, '..', 'smoke-prod')
const ANON_BUDGET_SH = resolve(SMOKE_PROD_DIR, 'anon-budget.sh')
const ANON_BUDGET_HELPERS_SH = resolve(SMOKE_PROD_DIR, 'anon-budget.helpers.sh')

/** Sources the real anon-budget.sh with every network-touching function
 * stubbed, then runs `check_anon_budget_identity_derivation` once and prints
 * how many times the reset RPC helper was invoked plus the check's own exit
 * code — the harness this whole test file drives. */
function runShadowCheck(opts: { searchStatus: string; searchUsed?: string }): {
  resetCount: number
  rc: number
  stderr: string
} {
  const script = `
    set -uo pipefail
    export SUPABASE_URL="https://example.test"
    export SUPABASE_ANON_KEY="anonkey"
    export TRIAL_SALT="salt"
    export SUPABASE_SERVICE_ROLE_KEY="svc"

    . "$ANON_BUDGET_SH"

    RESET_CALL_COUNT=0
    _anon_budget_reset() { RESET_CALL_COUNT=$((RESET_CALL_COUNT + 1)); }
    _anon_budget_seed() { printf '200\\n{}'; }
    _anon_budget_egress_ip() { printf '1.2.3.4'; }
    _anon_budget_hash_ip() { printf 'deadbeef'; }
    report_pass() { :; }
    report_fail() { :; }
    now_ms() { printf '0'; }
    _anon_budget_search_request() { printf '${opts.searchStatus}\\n${opts.searchUsed ?? ''}\\n{}'; }

    # Deliberately MORE sensitive than production's own call depth, not an
    # exact match of it: smoke-prod.sh:271 calls check functions directly
    # from its dispatch loop ("$fn" || true), with no intermediate wrapper
    # function. This extra run_check layer adds one more RETURN-trap firing
    # point on top of that -- so if TRAP-1 ever reappears, this harness
    # catches it at least as reliably as production would, never less.
    run_check() {
      check_anon_budget_identity_derivation
      return $?
    }

    run_check
    rc=$?
    # A totally unrelated function call after the check — if the trap were
    # still armed (TRAP-1 reintroduced), it would fire a THIRD time here.
    unrelated() { :; }
    unrelated
    printf 'RESET_COUNT=%s RC=%s\\n' "$RESET_CALL_COUNT" "$rc"
  `
  const result = execFileSync('bash', ['-c', script], {
    encoding: 'utf-8',
    env: { ...process.env, ANON_BUDGET_SH },
  })
  const match = result.match(/RESET_COUNT=(\d+) RC=(\d+)/)
  if (!match) throw new Error(`could not parse harness output: ${result}`)
  return { resetCount: Number(match[1]), rc: Number(match[2]), stderr: result }
}

describe('smoke-prod/anon-budget.sh — reset runs exactly once, never via a RETURN trap (TRAP-1)', () => {
  it('resets exactly once when the assertion passes', () => {
    const { resetCount, rc } = runShadowCheck({ searchStatus: '200', searchUsed: '3' })
    expect(resetCount).toBe(1)
    expect(rc).toBe(0)
  })

  it('resets exactly once when the assertion fails (used mismatch)', () => {
    const { resetCount, rc } = runShadowCheck({ searchStatus: '200', searchUsed: '99' })
    expect(resetCount).toBe(1)
    expect(rc).toBe(1)
  })

  it('resets exactly once, and soft-passes, on a shared-bucket 429', () => {
    const { resetCount, rc } = runShadowCheck({ searchStatus: '429' })
    expect(resetCount).toBe(1)
    expect(rc).toBe(0)
  })

  it('does NOT reset when the seed itself fails (nothing was seeded)', () => {
    const script = `
      set -uo pipefail
      export SUPABASE_URL="https://example.test"
      export SUPABASE_ANON_KEY="anonkey"
      export TRIAL_SALT="salt"
      export SUPABASE_SERVICE_ROLE_KEY="svc"
      . "$ANON_BUDGET_SH"
      RESET_CALL_COUNT=0
      _anon_budget_reset() { RESET_CALL_COUNT=$((RESET_CALL_COUNT + 1)); }
      _anon_budget_seed() { printf '500\\nerror'; }
      _anon_budget_egress_ip() { printf '1.2.3.4'; }
      _anon_budget_hash_ip() { printf 'deadbeef'; }
      report_pass() { :; }
      report_fail() { :; }
      now_ms() { printf '0'; }
      check_anon_budget_identity_derivation
      rc=$?
      printf 'RESET_COUNT=%s RC=%s\\n' "$RESET_CALL_COUNT" "$rc"
    `
    const result = execFileSync('bash', ['-c', script], {
      encoding: 'utf-8',
      env: { ...process.env, ANON_BUDGET_SH },
    })
    const match = result.match(/RESET_COUNT=(\d+) RC=(\d+)/)
    expect(match).toBeTruthy()
    expect(Number(match![1])).toBe(0)
    expect(Number(match![2])).toBe(1)
  })

  it('never contains a `trap ... RETURN` statement (static regression guard)', () => {
    const src = readFileSync(ANON_BUDGET_SH, 'utf-8')
    const codeOnly = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(codeOnly).not.toMatch(/\btrap\b/)
  })
})

describe('smoke-prod/anon-budget.{sh,helpers.sh} — no with_retry on non-idempotent calls (RETRY-1)', () => {
  it('none of the four _anon_budget_search_request call sites use with_retry', () => {
    const src = readFileSync(ANON_BUDGET_SH, 'utf-8')
    // Four invocations total: check_anon_budget_counter_increments makes TWO
    // (resp1/resp2, proving the increment), _anon_budget_layer2_shadow_assert
    // and _anon_budget_layer2_enforce_assert each make one.
    const callSites = src.match(/_anon_budget_search_request\s+"/g) ?? []
    expect(callSites.length).toBe(4)
    for (const match of src.matchAll(/^.*_anon_budget_search_request\s+".*$/gm)) {
      expect(match[0]).not.toMatch(/with_retry/)
    }
  })

  it('_anon_budget_adjust does not use with_retry', () => {
    const src = readFileSync(ANON_BUDGET_HELPERS_SH, 'utf-8')
    const fnMatch = src.match(/_anon_budget_adjust\(\)\s*\{[\s\S]*?\n\}/)
    expect(fnMatch, 'could not locate _anon_budget_adjust function body').toBeTruthy()
    expect(fnMatch![0]).not.toMatch(/with_retry/)
  })

  it('_anon_budget_seed still legitimately uses with_retry (scope check, not a blanket ban)', () => {
    const src = readFileSync(ANON_BUDGET_HELPERS_SH, 'utf-8')
    const fnMatch = src.match(/_anon_budget_seed\(\)\s*\{[\s\S]*?\n\}/)
    expect(fnMatch, 'could not locate _anon_budget_seed function body').toBeTruthy()
    expect(fnMatch![0]).toMatch(/with_retry/)
  })
})
