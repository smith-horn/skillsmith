/**
 * SMI-6514: tests for the P-7 State-Flip Assertion Audit scanner
 * (`.claude/skills/plan-review-skill/scripts/scan-state-flip.sh`).
 *
 * The scanner lives in the private strategy submodule beside the skill it
 * serves (SMI-6514 section 4, matching the concurrency-auditor precedent),
 * so every test here skips cleanly when that submodule is absent: external
 * contributors, and CI runners with no PAT access to
 * smith-horn/skillsmith-strategy.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// __dirname here is <repo-root>/scripts/tests, so two levels up is repo root
// regardless of vitest's own invocation cwd (matches the convention in
// audit-standards.test.ts and audit-workflow-sha-pin.test.ts).
const REPO_ROOT = join(__dirname, '..', '..')
const SCANNER_PATH = join(REPO_ROOT, '.claude/skills/plan-review-skill/scripts/scan-state-flip.sh')
const SCANNER_PRESENT = existsSync(SCANNER_PATH)

/** True when the `shellcheck` binary resolves on PATH in this environment. */
function shellcheckAvailable(): boolean {
  try {
    execFileSync('shellcheck', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    // Not on PATH (ENOENT), or some other spawn failure. Either way there
    // is no shellcheck binary this test can safely invoke.
    return false
  }
}

describe('scan-state-flip.sh (SMI-6514 P-7 scanner)', () => {
  it.skipIf(!SCANNER_PRESENT)('parses cleanly under `bash -n`', () => {
    expect(() => execFileSync('bash', ['-n', SCANNER_PATH], { encoding: 'utf8' })).not.toThrow()
  })

  it.skipIf(!SCANNER_PRESENT)('is shellcheck-clean, when shellcheck is available', () => {
    if (!shellcheckAvailable()) {
      // Not installed in this environment (the Docker dev container does
      // not carry it; the repo's actual shellcheck enforcement surface for
      // scripts/ is the dedicated host-runner steps in
      // .github/workflows/validate-hooks.yml and friends). Nothing to
      // assert when the binary itself is absent.
      return
    }
    expect(() => execFileSync('shellcheck', [SCANNER_PATH], { encoding: 'utf8' })).not.toThrow()
  })

  it.skipIf(!SCANNER_PRESENT)(
    'reproduces the Fixture 1 pre-fix counts (577 / 29 / 5) against dfe3a485a^',
    () => {
      // dfe3a485a is SMI-6491's own git-crypt-install commit (fixed,
      // permanent SHA; PR #2792). Its parent is the pre-fix tree the plan's
      // own D-11 counterfactual measured.
      const out = execFileSync('bash', [SCANNER_PATH, 'git-crypt', '--ref', 'dfe3a485a^'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
      expect(out).toContain('STEP 1 (denominator): 577')
      expect(out).toContain('STEP 2: noun x absence-vocabulary (29 hit(s))')
      expect(out).toContain('STEP 3: high-yield triage subset (5 hit(s))')
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'exits non-zero on a zero STEP-1 denominator (the vacuous-success guard)',
    () => {
      expect(() =>
        execFileSync(
          'bash',
          [SCANNER_PATH, 'zzz-nonexistent-noun-xyz-skillsmith-smi-6514', '--ref', 'HEAD'],
          { cwd: REPO_ROOT, encoding: 'utf8' }
        )
      ).toThrow()
    }
  )

  it.skipIf(!SCANNER_PRESENT)('usage error (no noun given) exits with code 2', () => {
    let threw = false
    try {
      execFileSync('bash', [SCANNER_PATH], { cwd: REPO_ROOT, encoding: 'utf8' })
    } catch (err) {
      threw = true
      expect((err as { status: number }).status).toBe(2)
    }
    expect(threw).toBe(true)
  })
})
