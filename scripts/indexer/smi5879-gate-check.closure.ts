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
import {
  ADDITIONAL_CLOSURE_WATCHED_SOURCE_PATHS,
  CORROBORATION_COLLECTION,
} from './smi5879-corroboration.types.ts'
import type { StructuralClosureResult } from './smi5879-gate-check.types.ts'

/**
 * The three closure test files item 2 already shipped (verified in §12.1
 * against the merged files — zero `writeFileSync`/`artifact`/`run_id`
 * occurrences in any of them, confirming there is no artifact to read and
 * gate-check must run them itself), plus the two SMI-5879 Wave 1 fixture-
 * corpus corroboration test files (§8.5's OTHER G-5 half — corroboration
 * spec doc §6, point 1). Both new entries are also
 * {@link CORROBORATION_COLLECTION}'s `file` values — that constant is the
 * wire contract for the SENTINEL assertions within these files;
 * `CLOSURE_TEST_FILES` is what actually gets passed to `vitest run`.
 */
export const CLOSURE_TEST_FILES = [
  'packages/core/src/security/scanner/multiline-category-closure.test.ts',
  'scripts/tests/indexer/security-scanner-edge.multiline-category-closure.test.ts',
  'scripts/tests/indexer/security-scanner-edge.multiline-category-closure.supabase-twin.test.ts',
  'packages/core/tests/security/smi5879-corroboration.core.test.ts',
  'scripts/tests/indexer/smi5879-corroboration.edge.test.ts',
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
 *   - `scripts/tests/indexer/parity-utils.ts` — round-2 re-verification finding:
 *     the shared fixtures.ts above imports `isGitCryptEncrypted` from this file
 *     and calls it at module-load time to compute `supabaseScannerEncrypted`
 *     et al., so a dirty parity-utils.ts changes what the fixtures — and thus
 *     the closure suite — actually evaluate, exactly like a dirty fixtures.ts
 *     itself would.
 *   - `vitest.config.ts` — the repository-pinned config the self-invoked run
 *     relies on staying unmodified (§12.1: "repository-pinned config... no
 *     `--config` override"); a dirty config could silently change what "ran"
 *     even means.
 *   - `packages/core/src/security/scanner/patterns.ts` — round-3
 *     re-verification finding: `patterns.scope.ts` above imports
 *     `SSRF_INSTRUCTION_PATTERNS` from it and executes `assertScopeCoverage()`
 *     against it at module load, so a dirty patterns.ts changes what the
 *     watched patterns.scope.ts actually evaluates.
 *   - `vitest.preset.ts` — round-3 re-verification finding: `vitest.config.ts`
 *     imports `sharedTestConfig`/`coverageDefaults`/`coverageThresholds` from
 *     it, so it is as much a part of "the repository-pinned config" as
 *     vitest.config.ts itself.
 *   - `vitest.setup.ts` — round-3 re-verification finding: named in
 *     vitest.config.ts's `setupFiles`, so it runs before every test in the
 *     self-invoked vitest process, closure tests included.
 *   - `supabase/functions/_shared/cors.ts` — round-3 re-verification finding:
 *     read by vitest.config.ts's `gitCryptLocked()` sentinel check, which
 *     decides whether `supabase/functions/**` test paths are excluded from
 *     the run; a dirty sentinel can silently change what "ran" means the
 *     same way a dirty vitest.config.ts itself could.
 * Deliberately NOT used for the vitest invocation itself ({@link
 * CLOSURE_TEST_FILES} stays exactly the 3 real test files there — `vitest
 * run` takes test-file paths, not arbitrary source files).
 */
export const CLOSURE_WATCHED_SOURCE_PATHS = [
  ...CLOSURE_TEST_FILES,
  'scripts/tests/indexer/security-scanner-edge.multiline-category-closure.fixtures.ts',
  'scripts/tests/indexer/parity-utils.ts',
  'packages/core/src/security/scanner/SecurityScanner.ts',
  'packages/core/src/security/scanner/patterns.jailbreak.ts',
  'packages/core/src/security/scanner/patterns.jailbreak.evidence.ts',
  'packages/core/src/security/scanner/patterns.scope.ts',
  'packages/core/src/security/scanner/patterns.ts',
  'scripts/indexer/_shared/security-scanner-edge.ts',
  'scripts/indexer/_shared/security-scanner-edge.exec.ts',
  'scripts/indexer/_shared/security-scanner-edge.context.ts',
  'scripts/indexer/_shared/security-scanner-edge.patterns.ts',
  'supabase/functions/_shared/security-scanner-edge.ts',
  'supabase/functions/_shared/security-scanner-edge.exec.ts',
  'supabase/functions/_shared/security-scanner-edge.context.ts',
  'supabase/functions/_shared/security-scanner-edge.patterns.ts',
  'supabase/functions/_shared/cors.ts',
  'vitest.config.ts',
  'vitest.preset.ts',
  'vitest.setup.ts',
  // SMI-5879 Wave 1: everything the fixture-corpus corroboration tests read
  // or import — corroboration spec doc §6, point 2. Sourced from
  // `smi5879-corroboration.types.ts`'s own curated list (its own doc comment
  // explains each entry's rationale) rather than duplicated here.
  ...ADDITIONAL_CLOSURE_WATCHED_SOURCE_PATHS,
  // Not part of ADDITIONAL_CLOSURE_WATCHED_SOURCE_PATHS because it did not
  // exist when that constant was authored: the TS-compiler-API import-graph
  // tracer the edge corroboration test's OWN watch-list-closure assertion
  // (assertion 5) uses. A dirty tracer changes what that assertion evaluates
  // exactly like a dirty fixtures.ts would.
  'scripts/tests/indexer/smi5879-corroboration.import-graph.ts',
  // The remaining entries below were found by actually RUNNING assertion 5
  // against the real, merged files (not hand-derived) — proof the mechanism
  // does what it claims: ADDITIONAL_CLOSURE_WATCHED_SOURCE_PATHS's manually
  // curated list, however careful, missed four genuine scanner-behaviour
  // files reachable from `SecurityScanner.ts` / `skill-processor.security.ts`
  // (both already watched above) — exactly the drift-prevention case
  // assertion 5 exists for.
  'packages/core/src/security/scanner/SecurityScanner.compound.ts', // scanChmodFetchCompound (SMI-5434 split), imported by the already-watched SecurityScanner.scanners.ts
  'packages/core/src/security/scanner/SecurityScanner.formatters.ts', // imported by SecurityScanner.ts itself (toMinimalRefs et al.)
  'packages/core/src/security/scanner/confusables.ts', // confusable/homoglyph folding, imported by the already-watched SecurityScanner.exec.ts
  'scripts/indexer/_shared/github-auth.ts', // imported by the already-watched skill-processor.security.ts
  // The final four are a self-referential consequence of the edge
  // corroboration test importing `CLOSURE_WATCHED_SOURCE_PATHS` FROM this
  // very file (to check it is closed) — this file, and what it in turn
  // imports (type-only), are themselves now part of what that test executes.
  'scripts/indexer/smi5879-gate-check.closure.ts',
  'scripts/indexer/smi5879-gate-check.types.ts',
  'scripts/indexer/smi5879-census.types.ts',
  'scripts/indexer/smi5879-simulate-full.types.ts',
  // SMI-6033 Wave 1: two new siblings, imported by the already-watched
  // security-scanner-edge.ts on both twins (chmod-compound extraction +
  // sensitive_path port) — same closure-completeness reasoning as the four
  // entries above.
  'scripts/indexer/_shared/security-scanner-edge.compound.ts',
  'scripts/indexer/_shared/security-scanner-edge.paths.ts',
  'supabase/functions/_shared/security-scanner-edge.compound.ts',
  'supabase/functions/_shared/security-scanner-edge.paths.ts',
  // SMI-6033 Wave 1 (Gap 7): the Node twin's typosquat wiring imports
  // detectTyposquat from packages/core's scanner barrel (index.js), which
  // transitively pulls in these three — reachable from the already-watched
  // scripts/indexer/skill-processor.security.ts, same closure-completeness
  // reasoning as every other entry below the self-referential four above.
  'packages/core/src/security/scanner/typosquat.ts',
  'packages/core/src/security/scanner/typosquat-reference-list.ts',
  'packages/core/src/security/scanner/SecurityScanner.hostile-update.ts',
  // SMI-6033 Wave 2 (Gap 5/Gap 3): the already-watched SecurityScanner.ts /
  // security-scanner-edge.ts now import the new xattr Gatekeeper-bypass
  // detector's shared correlation helper and the new archive-evasion
  // detector — flagged by assertion 5 (the real import-graph tracer) as
  // reachable-but-unwatched. The scripts/indexer/_shared two are what the
  // tracer actually flagged (it only follows the Node-runnable import
  // graph); the supabase/functions/_shared counterparts are added alongside
  // for the same symmetry the Wave 1 compound.ts/paths.ts pair above used.
  'packages/core/src/security/scanner/SecurityScanner.archive.ts',
  'packages/core/src/security/scanner/SecurityScanner.fetch-correlation.ts',
  'scripts/indexer/_shared/security-scanner-edge.archive.ts',
  'scripts/indexer/_shared/security-scanner-edge.fetch-correlation.ts',
  'supabase/functions/_shared/security-scanner-edge.archive.ts',
  'supabase/functions/_shared/security-scanner-edge.fetch-correlation.ts',
  // SMI-6033 Wave 2 (Gap 4): the already-watched SecurityScanner.ts /
  // security-scanner-edge.ts now import the new paste-host reputation
  // detector and (core only) the shared URL-extraction helper it promotes
  // — flagged by assertion 5 (the real import-graph tracer) as
  // reachable-but-unwatched. The scripts/indexer/_shared entry is what the
  // tracer actually flagged (it only follows the Node-runnable import
  // graph); the supabase/functions/_shared counterpart is added alongside
  // for the same symmetry the archive.ts/fetch-correlation.ts pair above
  // used.
  'packages/core/src/security/scanner/SecurityScanner.paste-host.ts',
  'packages/core/src/security/scanner/SecurityScanner.urls.ts',
  'scripts/indexer/_shared/security-scanner-edge.paste-host.ts',
  'supabase/functions/_shared/security-scanner-edge.paste-host.ts',
] as const

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
