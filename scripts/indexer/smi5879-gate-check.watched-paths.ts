/**
 * SMI-5879 G-5 — the closure gate's watched-path constants.
 * @module scripts/indexer/smi5879-gate-check.watched-paths
 *
 * SMI-6033 Wave 4: extracted verbatim out of `smi5879-gate-check.closure.ts`
 * (which crossed this repo's 500-line file gate once Wave 2/3/4 appended
 * their detector entries below) — pure data extraction, no behavior change.
 * `smi5879-gate-check.closure.ts` re-exports BOTH constants unchanged, so
 * every existing import path keeps working; that re-export is load-bearing,
 * do not remove it.
 *
 * NOTE: this module is itself watched (see the self-referential block at the
 * end of `CLOSURE_WATCHED_SOURCE_PATHS`) for exactly the reason the closure
 * module already was — the edge corroboration test imports
 * `CLOSURE_WATCHED_SOURCE_PATHS` to check it is closed, so whichever file
 * declares it is part of what that test executes.
 */

import { ADDITIONAL_CLOSURE_WATCHED_SOURCE_PATHS } from './smi5879-corroboration.types.ts'

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
  // SMI-6033 Wave 4: the sibling this constant was extracted into — same
  // self-referential reasoning as the line above.
  'scripts/indexer/smi5879-gate-check.watched-paths.ts',
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
  // SMI-6033 Wave 2 (Gap 2): the already-watched SecurityScanner.ts /
  // security-scanner-edge.ts now import the new encoded (base64) payload
  // decode-and-recursively-rescan detector — flagged by assertion 5 (the
  // real import-graph tracer) as reachable-but-unwatched. The
  // scripts/indexer/_shared entry is what the tracer actually flagged (it
  // only follows the Node-runnable import graph); the
  // supabase/functions/_shared counterpart is added alongside for the same
  // symmetry the archive.ts/paste-host.ts pairs above used.
  'packages/core/src/security/scanner/SecurityScanner.encoding.ts',
  'scripts/indexer/_shared/security-scanner-edge.encoding.ts',
  'supabase/functions/_shared/security-scanner-edge.encoding.ts',
  // SMI-6033 Wave 3 (Gap 5): the already-watched
  // scripts/indexer/skill-processor.security.ts now imports
  // HIGH_TRUST_AUTHORS (the Gatekeeper-bypass trust-tier carve-out's
  // author-allowlist lookup) from scripts/indexer/high-trust-authors.ts,
  // which re-assembles CORE_HIGH_TRUST_AUTHORS/LEADERBOARD_HIGH_TRUST_AUTHORS
  // from its own two sibling data files plus the shared type — flagged by
  // assertion 5 (the real import-graph tracer) as reachable-but-unwatched,
  // same closure-completeness reasoning as every entry above. Only the Node
  // tree is added: unlike security-scanner-edge.ts, skill-processor.security.ts
  // is watched for the Node twin only (the tracer follows the Node-runnable
  // import graph, and the Deno twin has no entry in this list to begin with).
  'scripts/indexer/high-trust-authors.ts',
  'scripts/indexer/high-trust-authors.core.ts',
  'scripts/indexer/high-trust-authors.leaderboard.ts',
  'scripts/indexer/high-trust-authors.types.ts',
  // SMI-6033 Wave 4 (Gap 6): the already-watched SecurityScanner.ts /
  // security-scanner-edge.ts now import the new decoy_misdirection URL-
  // target heuristic detector and its shared brand/authority-claim data
  // module — flagged by assertion 5 (the real import-graph tracer) as
  // reachable-but-unwatched, same closure-completeness reasoning as every
  // entry above. The scripts/indexer/_shared entries are what the tracer
  // actually flagged (it only follows the Node-runnable import graph); the
  // supabase/functions/_shared counterparts are added alongside for the
  // same symmetry the archive.ts/paste-host.ts pairs above used.
  'packages/core/src/security/scanner/SecurityScanner.decoy.ts',
  'scripts/indexer/_shared/security-scanner-edge.decoy.ts',
  'scripts/indexer/_shared/security-scanner-edge.brand-data.ts',
  'supabase/functions/_shared/security-scanner-edge.decoy.ts',
  'supabase/functions/_shared/security-scanner-edge.brand-data.ts',
  // SMI-6033 Wave 4 (Gap 1): CODE_EXECUTION_PATTERNS moved out of the
  // already-watched patterns.ts into this new sibling (which also holds
  // IMPERATIVE_FETCH_EXEC_PROSE) — flagged by assertion 5 as
  // reachable-but-unwatched. Core-only: the edge twins keep both arrays in
  // the already-watched security-scanner-edge.patterns.ts.
  'packages/core/src/security/scanner/patterns.exec.ts',
  // SMI-6033 Wave 2 (Gap 8): the already-watched
  // scripts/indexer/skill-processor.security.ts now imports the extended
  // scan-surface module (Trees API budget/memoization, ranked+capped
  // operational-code selection, scan-coverage causes), which in turn imports
  // trees-search.ts for the full-tree projection; and the corroboration
  // fixtures now import scan-skill-bundle.fixtures.ts for the empty-tree stub
  // that keeps the corroboration corpus offline. All three were flagged by
  // assertion 5 (the real import-graph tracer) as reachable-but-unwatched —
  // same closure-completeness reasoning as every entry above. Node tree only,
  // for the same reason the Wave 3 high-trust-authors entries are.
  'scripts/indexer/skill-processor.security.tree.ts',
  'scripts/indexer/trees-search.ts',
  'scripts/tests/indexer/scan-skill-bundle.fixtures.ts',
  // SMI-6033 Wave 2 (Gap 8) adversarial-review fix (2026-08-17): the
  // isExtended severity-gating fix pushed skill-processor.security.ts past
  // the 500-line gate a second time; its sibling-scan plumbing
  // (enumerateSiblingTargets, fetchSiblingContent, mergeSiblingScans,
  // buildMergedQuarantineReason) was extracted to this new sibling module,
  // re-exported so the import graph reaches it the same way it reached
  // skill-processor.security.tree.ts above. Same closure-completeness
  // reasoning; Node tree only.
  'scripts/indexer/skill-processor.security.sibling.ts',
] as const
