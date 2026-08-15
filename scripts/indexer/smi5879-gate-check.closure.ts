/**
 * G-5's structural-closure-test invocation — design doc §12.1 (Round-8
 * addendum), extended by SMI-5879 Wave 1 to also collect the fixture-corpus
 * corroboration result (§8.5's OTHER G-5 half — see
 * `docs/internal/implementation/smi-5879-g5-corroboration-spec.md` §6). Split
 * out of smi5879-gate-check.ts because it owns real subprocess-spawning side
 * effects (git introspection + a self-invoked vitest run) that the rest of
 * the evaluator does not need, and because `smi5879-gate-check.test.ts` must
 * NEVER call this module's exported function directly — it injects a fake
 * `Smi5879GateCheckTestDeps` instead (a real invocation here spawns a nested
 * vitest process against five test files and takes real wall-clock time;
 * doing that from inside gate-check's OWN test suite would be slow at best
 * and a nested-vitest hazard at worst).
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
 *
 * `fixtureCorpusCorroborationVerified` used to be a permanent `false` literal
 * (no producer existed). SMI-5879 Wave 1 built that producer — the two
 * corroboration test files below — so this module now computes the flag from
 * the SAME parsed `--reporter=json` report the structural-closure result
 * already reads, via {@link computeFixtureCorpusCorroborationVerified}: never
 * inferred from the report's aggregate `success` boolean (a silently
 * uncollected file would make that trivially true), always positively
 * confirmed per {@link CorroborationCollectionSpec}'s sentinel-assertion
 * check (spec doc §6, point 4).
 */

import { execFileSync } from 'node:child_process'
import { CORROBORATION_COLLECTION } from './smi5879-corroboration.types.ts'
import type { StructuralClosureResult } from './smi5879-gate-check.types.ts'
import {
  CLOSURE_TEST_FILES,
  CLOSURE_WATCHED_SOURCE_PATHS,
} from './smi5879-gate-check.watched-paths.ts'

/**
 * SMI-6033 Wave 4: `CLOSURE_TEST_FILES` and `CLOSURE_WATCHED_SOURCE_PATHS`
 * moved verbatim to the `smi5879-gate-check.watched-paths.ts` sibling (this
 * file crossed the repo's 500-line gate once Wave 2/3/4 appended their
 * detector entries to the watched list). Pure data extraction, no behavior
 * change. Re-exported here unchanged so every existing import path keeps
 * working with zero churn — load-bearing, do not remove.
 */
export { CLOSURE_TEST_FILES, CLOSURE_WATCHED_SOURCE_PATHS }

// SMI-5879 Wave 1: the corpus adds ~60 scans per twin, including one ~300 KB
// input (SB-4) — measured before merge at well under a minute total, but
// 240s is the recommended budget (corroboration spec doc §6, point 1) rather
// than a guess, to leave headroom for a loaded CI runner.
const CLOSURE_TEST_TIMEOUT_MS = 240_000

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * SMI-5879 Wave 1: computes the REAL `fixtureCorpusCorroborationVerified`
 * value from the same parsed `--reporter=json` vitest report
 * {@link runStructuralClosureTestsViaVitest} already has in hand — never
 * inferred from the report's aggregate `success` boolean, which is true even
 * when one of the corroboration files was silently uncollected (§12.1's own
 * "zero collected tests" hazard, one level down at the per-file grain).
 * Positive, per-{@link CorroborationCollectionSpec} confirmation: the file
 * must appear in `testResults[]` (matched by POSIX-normalised SUFFIX, since
 * the reporter's `name` field is container-absolute, e.g. `/app/...` —
 * verified empirically against a real run), have `status === 'passed'`, have
 * collected at least one assertion, have every assertion `status ===
 * 'passed'` (never `pending`/`todo`/`skipped`), and have every one of its
 * `sentinelFullNames` present among those assertions with `status ===
 * 'passed'`. Corroboration spec doc §6, points 3-4.
 */
export function computeFixtureCorpusCorroborationVerified(summary: Record<string, unknown>): {
  verified: boolean
  reason: string | null
} {
  const testResults = summary['testResults']
  if (!Array.isArray(testResults)) {
    return { verified: false, reason: 'vitest JSON report had no testResults array' }
  }

  for (const spec of CORROBORATION_COLLECTION) {
    const suffix = '/' + spec.file
    const fileResult = testResults.find((r: unknown) => {
      if (!isPlainObject(r) || typeof r['name'] !== 'string') return false
      return r['name'].replace(/\\/g, '/').endsWith(suffix)
    })
    if (!fileResult || !isPlainObject(fileResult)) {
      return {
        verified: false,
        reason: `corroboration test file was not collected by the closure vitest run: ${spec.file}`,
      }
    }
    if (fileResult['status'] !== 'passed') {
      return {
        verified: false,
        reason: `corroboration test file did not pass: ${spec.file} (status=${String(fileResult['status'])})`,
      }
    }
    const assertionResults = fileResult['assertionResults']
    if (!Array.isArray(assertionResults) || assertionResults.length === 0) {
      return {
        verified: false,
        reason: `corroboration test file collected zero assertions: ${spec.file}`,
      }
    }
    const passedFullNames = new Set<string>()
    for (const assertion of assertionResults) {
      if (!isPlainObject(assertion)) {
        return {
          verified: false,
          reason: `corroboration test file had a malformed assertion result: ${spec.file}`,
        }
      }
      if (assertion['status'] !== 'passed') {
        return {
          verified: false,
          reason:
            `corroboration test file has a non-passed assertion: ${spec.file} :: ` +
            `${String(assertion['fullName'])} (status=${String(assertion['status'])})`,
        }
      }
      if (typeof assertion['fullName'] === 'string') passedFullNames.add(assertion['fullName'])
    }
    for (const sentinel of spec.sentinelFullNames) {
      if (!passedFullNames.has(sentinel)) {
        return {
          verified: false,
          reason: `corroboration sentinel assertion missing or not passed: ${spec.file} :: ${sentinel}`,
        }
      }
    }
  }

  return { verified: true, reason: null }
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

  // SMI-5879 Wave 1: the aggregate `success` boolean above is TRUE even when
  // a corroboration file was silently uncollected (§12.1's hazard, one level
  // down) — never infer the corroboration flag from it. Positively confirmed
  // per-file, per-sentinel instead (corroboration spec doc §6, point 4).
  const corroboration = computeFixtureCorpusCorroborationVerified(summary)

  return {
    ran: true,
    passed: success,
    baseline_commit: head,
    unavailable_reason: corroboration.verified ? null : corroboration.reason,
    fixtureCorpusCorroborationVerified: corroboration.verified,
  }
}
