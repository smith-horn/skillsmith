/**
 * SMI-5620: regression coverage for three bugs found and fixed in the
 * smoke-prod harness. No network calls — deterministic and fast.
 *
 * L-1 LIB ACCUMULATOR SURVIVES RE-SOURCE: scripts/smoke-prod/lib.sh is
 *     sourced once by scripts/smoke-prod.sh, then AGAIN by every per-surface
 *     module it loads (each module sources lib.sh at its own top). Before
 *     the SMOKE_LIB_SOURCED guard, every re-source unconditionally reset
 *     SMOKE_RESULTS_JSON/SMOKE_FAIL_COUNT/SMOKE_PASS_COUNT, so a multi-
 *     surface run only ever reported the last-processed surface's results —
 *     confirmed live against prod: a run with 5 real check failures across
 *     2 surfaces reported pass=1 fail=0. This test reproduces that exact
 *     shape (report → re-source → report) and asserts accumulation holds.
 *
 * L-2 NO COMMAND-SUBSTITUTION AROUND _smoke_mcp_install_once: a caller
 *     written as `install=$(_smoke_mcp_install_once ...)` forks a subshell,
 *     which silently discards the function's `report_fail` call on an
 *     install failure (report_fail mutates SMOKE_FAIL_COUNT, a shell
 *     variable — subshell mutations don't propagate to the caller). This
 *     was confirmed live: a forced install failure vanished from the JSON
 *     report entirely, even though it printed to stderr (I/O passes through
 *     subshells; variable mutations don't). Static regression guard: the
 *     dangerous call shape must never reappear in mcp-server.sh.
 *
 * L-3 ALWAYS-RUN SURFACES EXEMPT FROM THE INNER BUDGET BREAK: adversarial
 *     plan-review (SMI-5620) found the inner per-check budget break, as
 *     first researched, did not respect the always_run exemption the outer
 *     loop adds — so a canary surface's single check (health,
 *     website-homepage-canary, tier1-skill-drift-canary) could be silently
 *     skipped when the budget was already blown, with the run still exiting
 *     0. Static regression guard: the inner break must stay conditioned on
 *     the surface's always_run flag.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SMOKE_PROD_DIR = resolve(__dirname, '..', 'smoke-prod')
const LIB_SH = resolve(SMOKE_PROD_DIR, 'lib.sh')
const MCP_SERVER_SH = resolve(SMOKE_PROD_DIR, 'mcp-server.sh')
const SMOKE_PROD_SH = resolve(__dirname, '..', 'smoke-prod.sh')

describe('smoke-prod/lib.sh — SMOKE_LIB_SOURCED guard (L-1)', () => {
  // LIB_SH is passed via env (below), not interpolated into the script
  // string: a raw `${LIB_SH}` template-literal interpolation into a
  // double-quoted `. "..."` line doesn't escape `$`, so a checkout path
  // containing `$(...)` would be live for bash's command substitution —
  // the same defect class CodeQL #113 flagged in the sibling
  // git-crypt-remediation-strings.test.ts (SMI-5887), verified here by
  // direct reproduction even though these alerts (#110/#111) were already
  // dismissed under SMI-5652 before this was discovered.
  it('preserves SMOKE_FAIL_COUNT/SMOKE_PASS_COUNT/SMOKE_RESULTS_JSON across a re-source', () => {
    const script = `
      set -euo pipefail
      . "$LIB_SH"
      report_fail "surfaceA" "checkA" "url" "expected" "actual" "10"
      . "$LIB_SH"
      report_pass "surfaceB" "checkB" "url" "5"
      printf 'fail=%s pass=%s results=%s\\n' "$SMOKE_FAIL_COUNT" "$SMOKE_PASS_COUNT" "$SMOKE_RESULTS_JSON"
    `
    const out = execFileSync('bash', ['-c', script], {
      encoding: 'utf-8',
      env: { ...process.env, LIB_SH },
    })
    expect(out).toContain('fail=1 pass=1')
    expect(out).toContain('"surface":"surfaceA"')
    expect(out).toContain('"surface":"surfaceB"')
  })

  it('still resets accumulators on the FIRST source of a fresh process', () => {
    const script = `
      set -euo pipefail
      . "$LIB_SH"
      printf 'fail=%s pass=%s results=[%s]\\n' "$SMOKE_FAIL_COUNT" "$SMOKE_PASS_COUNT" "$SMOKE_RESULTS_JSON"
    `
    const out = execFileSync('bash', ['-c', script], {
      encoding: 'utf-8',
      env: { ...process.env, LIB_SH },
    })
    expect(out.trim()).toBe('fail=0 pass=0 results=[]')
  })
})

// Strips full-line `#` comments so regression regexes only see live code —
// the file's own header comment deliberately quotes the dangerous pattern
// as a documented "don't do this" example, which would otherwise false-
// match a naive full-source regex.
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
}

describe('smoke-prod/mcp-server.sh — no command-substitution around _smoke_mcp_install_once (L-2)', () => {
  it('never invokes the helper via `=$(_smoke_mcp_install_once ...)`', () => {
    const src = codeOnly(readFileSync(MCP_SERVER_SH, 'utf-8'))
    expect(src).not.toMatch(/=\s*\$\(\s*_smoke_mcp_install_once/)
  })

  it('every call site reads the shared install path from $SMOKE_MCP_INSTALL_DIR', () => {
    const src = readFileSync(MCP_SERVER_SH, 'utf-8')
    const callSites =
      src.match(/_smoke_mcp_install_once\s+"[^"]+"\s+"[^"]+"\s*\|\|\s*return 1/g) ?? []
    // Four checks share the helper (version + three audit-tool dispatch greps).
    expect(callSites.length).toBe(4)
    for (const call of callSites) {
      const idx = src.indexOf(call)
      const nextLine = src.slice(idx + call.length, idx + call.length + 200)
      expect(nextLine).toMatch(/install="\$SMOKE_MCP_INSTALL_DIR"/)
    }
  })
})

describe('smoke-prod.sh — inner budget break respects always_run (L-3)', () => {
  it('gates the per-check budget break on the surface not being always_run', () => {
    const src = readFileSync(SMOKE_PROD_SH, 'utf-8')
    // The inner per-check loop's budget break must be conditioned on
    // `$always` (or equivalent) so an always_run surface's single check can
    // never be short-circuited by a blown budget.
    const innerLoopMatch = src.match(/while IFS= read -r fn;[\s\S]*?done < <\(jq[^\n]*\)/)
    expect(
      innerLoopMatch,
      'could not locate the inner per-check loop in smoke-prod.sh'
    ).toBeTruthy()
    const innerLoop = innerLoopMatch![0]
    expect(innerLoop).toMatch(/SECONDS.*SMOKE_BUDGET_SEC/)
    expect(innerLoop).toMatch(/\$always/)
  })

  it('reports budget_exceeded in the JSON report and keys exit purely on SMOKE_FAIL_COUNT', () => {
    const src = readFileSync(SMOKE_PROD_SH, 'utf-8')
    // The JSON report object must carry the observability field...
    expect(src).toMatch(/budget_exceeded:\s*\(\s*\$budget_exceeded\s*==\s*1\s*\)/)
    // ...and the exit-code decision must reference SMOKE_FAIL_COUNT alone,
    // never SMOKE_BUDGET_EXCEEDED — a budget-exceeded run with zero real
    // failures must exit 0 (this is the entire point of SMI-5620).
    const exitBlockMatch = src.match(/if \[ "\$SMOKE_FAIL_COUNT" -gt 0 \];[\s\S]*?\nexit 0\n?$/)
    expect(
      exitBlockMatch,
      'could not locate the final exit-code block in smoke-prod.sh'
    ).toBeTruthy()
    expect(exitBlockMatch![0]).not.toMatch(/if.*SMOKE_BUDGET_EXCEEDED.*exit 1/)
  })
})
