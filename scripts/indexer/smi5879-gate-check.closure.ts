/**
 * G-5's structural-closure-test invocation — design doc §12.1 (Round-8
 * addendum). Split out of smi5879-gate-check.ts because it owns real
 * subprocess-spawning side effects (git introspection + a self-invoked
 * vitest run) that the rest of the evaluator does not need, and because
 * `smi5879-gate-check.test.ts` must NEVER call this module's exported
 * function directly — it injects a fake `Smi5879GateCheckTestDeps` instead
 * (a real invocation here spawns a nested vitest process against three test
 * files and takes real wall-clock time; doing that from inside gate-check's
 * OWN test suite would be slow at best and a nested-vitest hazard at worst).
 * @module scripts/indexer/smi5879-gate-check.closure
 *
 * §12.1: "gate-check.ts instead runs the closure tests itself, at
 * gate-evaluation time, and binds the result on baseline_commit (`git
 * rev-parse HEAD`)... `git rev-parse HEAD` alone is not a complete identity
 * for the code actually executed -- it says nothing about uncommitted
 * changes to tracked files. gate-check.ts MUST verify the relevant paths are
 * clean (`git status --porcelain` empty, or equivalent) before trusting HEAD
 * as the executed commit; a dirty tree is INCONCLUSIVE, not a
 * silently-accepted HEAD... the self-invoked vitest run must use
 * repository-pinned config and fixed paths, non-watch mode, a bounded
 * timeout, and strict exit-code handling. A spawn error, a timeout, a
 * skipped suite, or zero collected tests are each their own INCONCLUSIVE
 * reason -- never silently treated as 'nothing to report' or, worse, as
 * passing."
 */

import { execFileSync } from 'node:child_process'
import type { StructuralClosureResult } from './smi5879-gate-check.types.ts'

/**
 * The three closure test files item 2 already shipped (verified in §12.1
 * against the merged files — zero `writeFileSync`/`artifact`/`run_id`
 * occurrences in any of them, confirming there is no artifact to read and
 * gate-check must run them itself).
 */
export const CLOSURE_TEST_FILES = [
  'packages/core/src/security/scanner/multiline-category-closure.test.ts',
  'scripts/tests/indexer/security-scanner-edge.multiline-category-closure.test.ts',
  'scripts/tests/indexer/security-scanner-edge.multiline-category-closure.supabase-twin.test.ts',
] as const

/**
 * Finding #4 (adversarial review): the dirty-worktree check MUST cover
 * everything the structural closure tests actually import or read, not just
 * the 3 test-file paths themselves — otherwise an uncommitted change to,
 * say, `SecurityScanner.ts` or the edge twin's pattern arrays could silently
 * ride along on a "clean" HEAD, because `git status` never looked at it.
 * Grepped directly against the 3 test files' own imports/`readFileSync`
 * calls (per §12.1's "verify the RELEVANT PATHS are clean" wording — not
 * merely the test files themselves):
 *   - Node core: `SecurityScanner.ts` (read), `patterns.jailbreak.ts`,
 *     `patterns.jailbreak.evidence.ts`, `patterns.scope.ts` (all imported).
 *   - Edge twin, Node mirror: `security-scanner-edge.{ts,exec,context,patterns}.ts`
 *     (read + imported, via the shared fixtures.ts both edge test files use).
 *   - Edge twin, DEPLOYED Supabase copy: the same four files under
 *     `supabase/functions/_shared/`, read directly by the supabase-twin test.
 *   - The shared `security-scanner-edge.multiline-category-closure.fixtures.ts`
 *     itself — two of the three test files import it, so a dirty fixtures.ts
 *     changes what the vitest run exercises just as much as a dirty test file
 *     would, and the ORIGINAL 3-file list never watched it either.
 *   - `vitest.config.ts` — the repository-pinned config the self-invoked run
 *     relies on staying unmodified (§12.1: "repository-pinned config... no
 *     `--config` override"); a dirty config could silently change what "ran"
 *     even means.
 * Deliberately NOT used for the vitest invocation itself ({@link
 * CLOSURE_TEST_FILES} stays exactly the 3 real test files there — `vitest
 * run` takes test-file paths, not arbitrary source files).
 */
export const CLOSURE_WATCHED_SOURCE_PATHS = [
  ...CLOSURE_TEST_FILES,
  'scripts/tests/indexer/security-scanner-edge.multiline-category-closure.fixtures.ts',
  'packages/core/src/security/scanner/SecurityScanner.ts',
  'packages/core/src/security/scanner/patterns.jailbreak.ts',
  'packages/core/src/security/scanner/patterns.jailbreak.evidence.ts',
  'packages/core/src/security/scanner/patterns.scope.ts',
  'scripts/indexer/_shared/security-scanner-edge.ts',
  'scripts/indexer/_shared/security-scanner-edge.exec.ts',
  'scripts/indexer/_shared/security-scanner-edge.context.ts',
  'scripts/indexer/_shared/security-scanner-edge.patterns.ts',
  'supabase/functions/_shared/security-scanner-edge.ts',
  'supabase/functions/_shared/security-scanner-edge.exec.ts',
  'supabase/functions/_shared/security-scanner-edge.context.ts',
  'supabase/functions/_shared/security-scanner-edge.patterns.ts',
  'vitest.config.ts',
] as const

const CLOSURE_TEST_TIMEOUT_MS = 120_000

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface GitCheckResult {
  clean: boolean
  error: string | null
}

/**
 * `git status --porcelain` on `paths` only — §12.1's dirty-tree hardening.
 * Exported (with an injectable `cwd`/`paths`) so `smi5879-gate-check.test.ts`
 * can exercise the dirty-worktree rejection against a REAL, isolated temp
 * git repo (via `scripts/tests/_lib/git-fixture-env.ts`) rather than only
 * mocking `child_process` — production always calls it with the defaults
 * (repo root, {@link CLOSURE_TEST_FILES}).
 */
export function checkGitTreeClean(
  paths: readonly string[] = CLOSURE_WATCHED_SOURCE_PATHS,
  cwd?: string
): GitCheckResult {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', ...paths], {
      encoding: 'utf8',
      timeout: 30_000,
      ...(cwd !== undefined ? { cwd } : {}),
    })
    return { clean: out.trim().length === 0, error: null }
  } catch (err) {
    return { clean: false, error: (err as Error).message }
  }
}

/** Same injectable-`cwd` rationale as {@link checkGitTreeClean}. */
export function gitRevParseHead(cwd?: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 30_000,
      ...(cwd !== undefined ? { cwd } : {}),
    }).trim()
  } catch {
    return null
  }
}

/**
 * Actually run the closure tests. Non-watch (`vitest run`, never `vitest`),
 * fixed paths (the pinned list above, not a glob), repository-pinned config
 * (no `--config` override — the default `vitest.config.ts` this repo
 * already commits), a bounded timeout, and strict exit-code + JSON-shape
 * handling: every one of §12.1's required hardenings.
 *
 * ONLY called from `smi5879-gate-check.ts`'s production wiring — the test
 * suite always injects a fake `Smi5879GateCheckTestDeps` instead.
 */
export async function runStructuralClosureTestsViaVitest(): Promise<StructuralClosureResult> {
  const gitCheck = checkGitTreeClean()
  if (!gitCheck.clean) {
    return {
      ran: false,
      passed: false,
      fixtureCorpusCorroborationVerified: false,
      baseline_commit: null,
      unavailable_reason: gitCheck.error
        ? `git status --porcelain failed: ${gitCheck.error}`
        : 'worktree has uncommitted changes on the closure-test paths — HEAD cannot be trusted ' +
          'as the executed commit (design doc §12.1 hardening)',
    }
  }

  const head = gitRevParseHead()
  if (!head) {
    return {
      ran: false,
      passed: false,
      fixtureCorpusCorroborationVerified: false,
      baseline_commit: null,
      unavailable_reason: 'git rev-parse HEAD failed — cannot determine the executed commit',
    }
  }

  let stdout: string
  try {
    stdout = execFileSync('npx', ['vitest', 'run', ...CLOSURE_TEST_FILES, '--reporter=json'], {
      encoding: 'utf8',
      timeout: CLOSURE_TEST_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
    })
  } catch (err) {
    // vitest exits non-zero on ANY test failure — that is itself a real,
    // parseable "closure test failed" result, not a spawn error, so stdout
    // (if any was captured before the non-zero exit) is still worth trying
    // to parse before giving up and reporting a spawn/timeout failure.
    const execErr = err as { stdout?: string; message: string }
    stdout = execErr.stdout ?? ''
    if (!stdout) {
      return {
        ran: false,
        passed: false,
        fixtureCorpusCorroborationVerified: false,
        baseline_commit: head,
        unavailable_reason: `vitest spawn/exit failed with no parseable stdout: ${execErr.message}`,
      }
    }
  }

  let summary: unknown
  try {
    summary = JSON.parse(stdout)
  } catch (err) {
    return {
      ran: false,
      passed: false,
      fixtureCorpusCorroborationVerified: false,
      baseline_commit: head,
      unavailable_reason: `vitest JSON output was not parseable: ${(err as Error).message}`,
    }
  }
  if (!isPlainObject(summary)) {
    return {
      ran: false,
      passed: false,
      fixtureCorpusCorroborationVerified: false,
      baseline_commit: head,
      unavailable_reason: 'vitest JSON report root was not an object',
    }
  }

  const numTotalTests = summary['numTotalTests']
  const success = summary['success']
  if (typeof numTotalTests !== 'number' || numTotalTests <= 0) {
    return {
      ran: false,
      passed: false,
      fixtureCorpusCorroborationVerified: false,
      baseline_commit: head,
      unavailable_reason:
        `vitest collected ${typeof numTotalTests === 'number' ? numTotalTests : '(unknown)'} ` +
        'test(s) — zero (or an unreadable) collected-test count is never treated as a pass',
    }
  }
  if (typeof success !== 'boolean') {
    return {
      ran: false,
      passed: false,
      fixtureCorpusCorroborationVerified: false,
      baseline_commit: head,
      unavailable_reason: 'vitest JSON report had no boolean `success` field',
    }
  }

  return {
    ran: true,
    passed: success,
    baseline_commit: head,
    unavailable_reason: null,
    fixtureCorpusCorroborationVerified: false,
  }
}
