/**
 * G-5 fixture-corpus corroboration — the typed contract.
 * @module scripts/indexer/smi5879-corroboration.types
 *
 * Design: `docs/internal/implementation/smi-5879-edge-twin-parity-design.md`
 * §8.3.1.2.4 (line ~530, "no category outside {jailbreak, ai_defence} changes
 * under the port -- full fixture corpus through pre-port and post-port
 * scanners") and §6.2 (line ~287, which names the corpus). Gate semantics are
 * §8.5's G-5 row, NOT §8.3.1.2.4's looser "the fixture sweep failing is a bug"
 * framing — §8.5 explicitly supersedes it: **both halves block merge
 * uniformly**.
 * Plan: `docs/internal/implementation/smi-5879-runbook-readiness-closure.md`
 * Wave 1. Algorithm + wiring narrative:
 * `docs/internal/implementation/smi-5879-g5-corroboration-spec.md`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CHECK IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * This is a **version-regression** check: ONE twin at a time, PRE-port scanner
 * vs POST-port scanner, over a shared corpus, asserting every non-AI
 * `RiskScoreBreakdown` key is byte-identical across the port.
 *
 * It is NOT `scripts/tests/indexer/parity.test.ts`'s twin-parity check, which
 * compares core/Node/Deno twins against EACH OTHER, all on the post-port
 * version. The two share corpus inputs; they share no baseline. Do not merge
 * them, and do not let one satisfy the other — §8.5 G-5 consumes this one only.
 *
 * ---------------------------------------------------------------------------
 * THE PRE-PORT BASELINE
 * ---------------------------------------------------------------------------
 * {@link PRE_PORT_BASELINE_SHA} is an explicit, captured full SHA — never
 * "current main", which moves. It was resolved and verified pre-port on
 * 2026-08-12 by the predicate in {@link PRE_PORT_VERIFICATION}: the RC-1 fix
 * commit `82d2ccaa0` (which introduces the all-match multiline traversal the
 * port is built on) is NOT an ancestor of it, and PR #2192 was still `OPEN`.
 *
 * Because that SHA is still pre-port, the golden can be generated **directly on
 * a branch cut from it** — the scanner imported there IS the pre-port scanner,
 * so no isolated checkout and no source-overlay is required. That shortcut
 * expires the moment PR #2192 merges; after that, generate from an isolated
 * checkout (`git worktree add <dir> <PRE_PORT_BASELINE_SHA>`) with the manifest,
 * generator and projection helpers copied in, and NEVER by hand-reconstructing
 * pre-port values from post-port code.
 */

// ---------------------------------------------------------------------------
// Baseline pin
// ---------------------------------------------------------------------------

/**
 * The pinned pre-port commit the golden snapshots are generated from.
 * `origin/main` as of 2026-08-12T16:03:23-07:00.
 */
export const PRE_PORT_BASELINE_SHA = 'a694a9f242197277fa69210e0241f84b883552e6'

/**
 * How {@link PRE_PORT_BASELINE_SHA} was established, and how to re-establish it
 * if it must be advanced (e.g. the corpus needs a fixture that only exists on a
 * later pre-port commit). All three must hold:
 *
 *  1. `git merge-base --is-ancestor 82d2ccaa0 <SHA>` must exit NON-zero — the
 *     RC-1 multiline fix must not be reachable.
 *  2. `git show <SHA>:packages/core/src/security/scanner/SecurityScanner.risk-score.ts`
 *     must fail — that file is ADDED by PR #2192; its absence is a second,
 *     independent pre-port witness.
 *  3. `gh pr view 2192 --json state` must report `OPEN`, or the SHA must
 *     predate the merge commit.
 *
 * Do NOT substitute a "does `scanPatternsWithMultilineSupport` exist" check.
 * That function exists on BOTH sides in core (it is the function the port
 * changes, not one it adds) and on NEITHER side in the edge twin, so its
 * presence discriminates nothing.
 */
export const PRE_PORT_VERIFICATION = {
  rc1FixCommit: '82d2ccaa07028d9e88cabf9f221355c6a4575483',
  portOnlyFile: 'packages/core/src/security/scanner/SecurityScanner.risk-score.ts',
  portPullRequest: 2192,
} as const

// ---------------------------------------------------------------------------
// Projection key sets — the heart of the comparison
// ---------------------------------------------------------------------------

/**
 * Core's non-AI `RiskScoreBreakdown` keys: every key EXCEPT `jailbreak` and
 * `aiDefence`. Sorted, so a golden's key order is canonical by construction.
 *
 * **The design doc's own enumeration is stale — do not copy it.** §8.3.1.2.4
 * cites "SecurityScanner.helpers.ts:346-359" and lists ELEVEN keys; the live
 * type has FOURTEEN, because `typosquat` was added later (SMI-595). Twelve of
 * those fourteen are non-AI. Verified against
 * `packages/core/src/security/scanner/types.ts`'s `RiskScoreBreakdown` and
 * `SecurityScanner.helpers.ts`'s `calculateRiskScore` initialiser on
 * {@link PRE_PORT_BASELINE_SHA}, 2026-08-12.
 */
export const CORE_NON_AI_BREAKDOWN_KEYS = [
  'codeExecution',
  'dataExfiltration',
  'externalUrls',
  'obfuscatedDirective',
  'pii',
  'privilegeEscalation',
  'promptLeaking',
  'sensitivePaths',
  'socialEngineering',
  'ssrf',
  'suspiciousCode',
  'typosquat',
] as const
export type CoreNonAiKey = (typeof CORE_NON_AI_BREAKDOWN_KEYS)[number]

/** Core's AI keys — deliberately excluded from the projection; the port is allowed to move these. */
export const CORE_AI_BREAKDOWN_KEYS = ['jailbreak', 'aiDefence'] as const

/**
 * Edge's non-AI categories: every `SecurityFindingType` EXCEPT `jailbreak` and
 * `prompt_injection` (the latter maps onto core's `ai_defence`). Sourced from
 * `scripts/indexer/_shared/security-scanner-edge.context.ts`'s
 * `CATEGORY_WEIGHTS` / `CATEGORY_COEFFICIENTS`, which agree on all seven types.
 */
export const EDGE_NON_AI_BREAKDOWN_KEYS = [
  'code_execution',
  'data_exfiltration',
  'obfuscated_directive',
  'privilege_escalation',
  'suspicious_pattern',
] as const
export type EdgeNonAiKey = (typeof EDGE_NON_AI_BREAKDOWN_KEYS)[number]

/** Edge's AI categories — deliberately excluded, mirroring {@link CORE_AI_BREAKDOWN_KEYS}. */
export const EDGE_AI_BREAKDOWN_KEYS = ['jailbreak', 'prompt_injection'] as const

/**
 * Keys that are structurally unreachable through the scanned entry point and
 * are therefore expected to be identically `0` in every golden row — recorded
 * here so "always zero" is an ASSERTED fact rather than an unnoticed blind spot.
 *
 * `typosquat` is emitted only by `packages/core/src/security/scanner/typosquat.ts`,
 * which `SecurityScanner.scan()` never calls (verified: `scan()`'s detector
 * fan-out at `SecurityScanner.ts:260-286` has no typosquat arm). It stays IN the
 * projection — it is a non-AI key, and a future port that started routing it
 * through `scan()` must be caught, not silently tolerated — but the corroboration
 * test asserts it is zero everywhere rather than pretending the corpus exercises it.
 */
export const STRUCTURALLY_ZERO_CORE_KEYS = ['typosquat'] as const

// ---------------------------------------------------------------------------
// Corpus manifest — `scripts/tests/indexer/smi5879-corroboration-corpus.json`
// ---------------------------------------------------------------------------

/**
 * Case content. `literal` is the default; `composed` exists ONLY so the two
 * bulk fixtures (SW-1's 45 identical filler lines, SB-4's ~300 KB of padding)
 * do not land in the committed JSON as one enormous line.
 *
 * The materialiser is deliberately trivial —
 * `segments.map((s) => s.text.repeat(s.repeat)).join('')` — so that duplicating
 * it on the core side and the edge side carries no divergence risk, and any
 * divergence that did occur is caught immediately by
 * {@link ContentCase.contentSha256}.
 */
export type CaseContent =
  | { kind: 'literal'; text: string }
  | { kind: 'composed'; segments: Array<{ text: string; repeat: number }> }

/** Which design-named corpus (or the coverage extension) a case belongs to. */
export type CorpusGroup = 'SW-1' | 'SB' | 'false-positive' | 'saturation' | 'coverage-extension'

/** The four groups §8.3.1.2.4 names by hand. All four must be non-empty. */
export const DESIGN_NAMED_CORPORA = ['SW-1', 'SB', 'false-positive', 'saturation'] as const

/**
 * Where a case's text came from. Recorded so the manifest stays auditable
 * against its sources — and so the drift assertions described in the spec doc
 * (re-read the pointer, re-derive the composed text) know what to re-check.
 */
export type CaseOrigin =
  | { kind: 'literal'; file: string }
  /** A JSON Pointer into a committed fixture, e.g. `safe-prompts.json`. */
  | { kind: 'json-pointer'; file: string; pointer: string }
  /** A named symbol or test in a committed test file. */
  | { kind: 'test-symbol'; file: string; symbol: string; line?: number; note?: string }
  /** Authored for this manifest (coverage-extension cases only). */
  | { kind: 'authored'; file: string }

export interface ContentCase {
  /** Stable, human-meaningful, unique. Golden rows are keyed and sorted by this. */
  caseId: string
  corpus: CorpusGroup
  /** The design-doc section this case realises, or an explicit "NOT design-named" note. */
  designRef: string
  description: string
  origin: CaseOrigin
  /** Which scanner function each twin routes this case through. */
  entryPoints: { core: 'SecurityScanner.scan'; edge: 'scanSkillContent' }
  /** Twins this case is scanned on. Most cases are `['core', 'edge']`. */
  twins: Array<'core' | 'edge'>
  /**
   * First argument to `SecurityScanner.scan(skillId, content)`. Pinned per case
   * rather than defaulted, because it reaches the report and must not drift.
   */
  skillId: string
  content: CaseContent
  /** SHA-256 (hex, utf8) of the MATERIALISED text. Guards the materialiser and the origin. */
  contentSha256: string
  /** Length in UTF-16 code units of the materialised text — a cheap second guard. */
  contentLength: number
}

/**
 * A bundle case — EDGE ONLY. `scanSkillBundle` lives in
 * `scripts/indexer/skill-processor.security.ts`; core has no equivalent
 * (verified: zero hits for `scanSkillBundle`/`enumerateSiblingTargets`/
 * `mergeSiblingScans` anywhere under `packages/core/src/`).
 *
 * This answers the readiness plan's Wave-1 Step-1 open question directly:
 * **core needs neither an SB-1..SB-4 equivalent nor PR-2192a's adaptation
 * judgment call.** It has no sibling-bundle surface to regress. Core's coverage
 * of the SB inputs is the `SB-*-primary` / `SB-*-sibling` content cases, which
 * scan the same strings through `SecurityScanner.scan`.
 */
export interface BundleCase {
  caseId: string
  corpus: 'SB'
  designRef: string
  description: string
  twins: ['edge']
  /** {@link ContentCase.caseId} supplying `primaryContent`. */
  primaryRef: string
  siblings: Array<
    | { relPath: string; contentRef: string }
    /** A transient (null) fetch outcome — the sibling is neither scanned nor treated as clean. */
    | { relPath: string; outcome: 'transient' }
  >
  /** Every sibling path not named above resolves to this. Always `'removed'` (a 404). */
  defaultSiblingOutcome: 'removed'
}

export interface CorpusManifest {
  manifestVersion: number
  /** Bumped whenever {@link CORE_NON_AI_BREAKDOWN_KEYS} / {@link EDGE_NON_AI_BREAKDOWN_KEYS} change. */
  projectionSchemaVersion: number
  designRef: string
  contract: string
  namedCorpora: typeof DESIGN_NAMED_CORPORA
  /** Sorted by `caseId` (`localeCompare(_, 'en')`). */
  contentCases: ContentCase[]
  bundleCases: BundleCase[]
}

// ---------------------------------------------------------------------------
// Golden snapshots — one per twin, never merged
// ---------------------------------------------------------------------------

/**
 * Core and edge get SEPARATE golden files. They are independently-implemented
 * scanners with disjoint key vocabularies and different entry points; a merged
 * baseline would have to invent a lossy mapping between them, which is exactly
 * the conflation §8.5's two-comparison distinction warns against. What IS shared:
 * the manifest, the canonicalisation/digest helper, and the comparison driver.
 * What is NOT shared: the two projection functions.
 */
export interface GoldenProvenance {
  /** {@link PRE_PORT_BASELINE_SHA}, recorded so a golden can never be read out of context. */
  sourceCommit: string
  /** SHA-256 of the committed, prettier-formatted manifest FILE BYTES. */
  manifestDigest: string
  manifestVersion: number
  projectionSchemaVersion: number
  /** `process.version` of the generating runtime — a scoring change is arithmetic, so this matters. */
  nodeVersion: string
  /** Repo-relative path of the generator, for reproduction. */
  generator: string
  /** ISO 8601 UTC. Informational only — never compared. */
  generatedAt: string
  /** Repeats performed per case during generation before the projection was trusted. */
  determinismRepeats: number
}

/** One projected row. Values are the RAW per-category subtotals, already capped at 100. */
export interface GoldenRow<K extends string> {
  caseId: string
  /**
   * Re-asserted at comparison time: the post-port run must scan byte-identical
   * input. For a bundle row (see {@link bundle}) this is the PRIMARY content's
   * hash — siblings are separately covered as their own content-case rows.
   */
  contentSha256: string
  breakdown: Record<K, number>
  /**
   * Bundle-case-only (edge — `scanSkillBundle`, spec doc §2's bundle
   * paragraph). Absent for plain content-case rows. Recorded so a change in
   * WHICH siblings reached the merge is a diff rather than an invisible
   * input change: this field, not {@link GoldenRow}'s base shape, is the
   * implementation-filled-in extension the design doc's typed contract left
   * for the generator/comparison-test author to add.
   */
  bundle?: {
    /** True iff `mergedSecurityScan` was defined (>=1 sibling successfully fetched and scanned). */
    merged: boolean
    /** Sorted `SiblingEdgeScan.relPath` values that were successfully fetched and scanned. */
    siblingRelPaths: string[]
    /** Sorted `relPath:kind` pairs from `siblingFailures`. */
    siblingFailures: string[]
  }
}

export interface GoldenSnapshot<K extends string> {
  twin: 'core' | 'edge'
  provenance: GoldenProvenance
  /** The exact key list projected, in order. A mismatch is its own failure, not a diff. */
  projectedKeys: readonly K[]
  /** Sorted by `caseId`. Covers content cases and, for edge, bundle cases. */
  rows: Array<GoldenRow<K>>
}

export type CoreGoldenSnapshot = GoldenSnapshot<CoreNonAiKey>
export type EdgeGoldenSnapshot = GoldenSnapshot<EdgeNonAiKey>

// ---------------------------------------------------------------------------
// Collection signal — how gate-check proves the check actually RAN
// ---------------------------------------------------------------------------

/**
 * The readiness plan's explicit requirement: "corroboration passed" must be
 * distinguishable from "test absent / skipped / uncollected", and an aggregate
 * Vitest `success` boolean is NOT acceptable on its own.
 *
 * `runStructuralClosureTestsViaVitest` already parses `--reporter=json`. That
 * report carries a per-file `testResults[]`, each with an ABSOLUTE `name`
 * (container-rooted, e.g. `/app/scripts/tests/...`), a file-level `status`, and
 * an `assertionResults[]` whose entries carry `status` and `fullName`
 * (empirically confirmed against a real run, 2026-08-12).
 *
 * So the signal is positive and non-inferred: for EACH entry below, locate a
 * `testResults` element whose `name` ends with the POSIX-normalised `file`,
 * require `status === 'passed'`, require `assertionResults.length > 0`, require
 * every assertion's `status === 'passed'` (never `pending`/`todo`/`skipped`),
 * and require every `sentinelFullNames` string to appear as some assertion's
 * `fullName` with `status === 'passed'`.
 *
 * The sentinels are what stop a gutted-but-green file from satisfying the gate:
 * a renamed or deleted assertion fails the gate loudly instead of shrinking the
 * suite silently. Any shortfall sets `fixtureCorpusCorroborationVerified` false
 * with its own `unavailable_reason` — never a bare `false`.
 */
export interface CorroborationCollectionSpec {
  /** Repo-relative, POSIX separators. Must also be present in `CLOSURE_TEST_FILES`. */
  file: string
  /** Exact `fullName` values (describe titles + test title, space-joined) that must be present and passed. */
  sentinelFullNames: readonly string[]
}

/**
 * The two corroboration test files and their sentinel assertions. Keep these
 * `fullName` strings byte-identical to the test titles — they are a wire
 * contract between the test files and `smi5879-gate-check.closure.ts`, not
 * documentation. A test-rename PR MUST update this constant in the same commit;
 * the guard test described in the spec doc asserts both directions agree.
 */
export const CORROBORATION_COLLECTION: readonly CorroborationCollectionSpec[] = [
  {
    file: 'packages/core/tests/security/smi5879-corroboration.core.test.ts',
    sentinelFullNames: [
      'SMI-5879 G-5 fixture-corpus corroboration (core) golden provenance binds to the pinned pre-port SHA and the committed manifest digest',
      'SMI-5879 G-5 fixture-corpus corroboration (core) every non-AI RiskScoreBreakdown key is unchanged from the pre-port golden, for every corpus case',
      'SMI-5879 G-5 fixture-corpus corroboration (core) the golden covers every manifest case targeting this twin, and no others',
      'SMI-5879 G-5 fixture-corpus corroboration (core) every projected key except the structurally-zero ones is exercised non-zero by at least one case',
    ],
  },
  {
    file: 'scripts/tests/indexer/smi5879-corroboration.edge.test.ts',
    sentinelFullNames: [
      'SMI-5879 G-5 fixture-corpus corroboration (edge) golden provenance binds to the pinned pre-port SHA and the committed manifest digest',
      'SMI-5879 G-5 fixture-corpus corroboration (edge) every non-AI category subtotal is unchanged from the pre-port golden, for every corpus case',
      'SMI-5879 G-5 fixture-corpus corroboration (edge) the golden covers every manifest case targeting this twin, including bundle cases, and no others',
      'SMI-5879 G-5 fixture-corpus corroboration (edge) every projected key is exercised non-zero by at least one case',
      'SMI-5879 G-5 fixture-corpus corroboration (edge) CLOSURE_WATCHED_SOURCE_PATHS is closed under both corroboration tests import graphs',
    ],
  },
] as const

/**
 * Paths that must be ADDED to `CLOSURE_WATCHED_SOURCE_PATHS` in
 * `scripts/indexer/smi5879-gate-check.closure.ts`. The two test files arrive
 * for free via that constant's existing `...CLOSURE_TEST_FILES` spread, so they
 * are not repeated here.
 *
 * Rationale for each addition is the same one the existing list already states:
 * a dirty file here changes what the corroboration suite evaluates just as much
 * as a dirty test file would, and today's list — scoped to the AST-only
 * structural closure tests — does not watch the core scoring path at all.
 *
 * Three entries do not exist yet on {@link PRE_PORT_BASELINE_SHA} — they are
 * ADDED by PR #2192 (`SecurityScanner.risk-score.ts`, and the edge twin's
 * `.evidence.ts` / `.chmod-compound.ts`). Listing them early is safe and
 * correct: `git status --porcelain -- <path>` exits 0 with empty output for a
 * pathspec that matches nothing (verified 2026-08-12), so a not-yet-existing
 * entry is inert pre-merge and starts biting the instant the file lands.
 */
export const ADDITIONAL_CLOSURE_WATCHED_SOURCE_PATHS = [
  // Manifest, goldens, and the shared helper the two tests both import.
  'scripts/tests/indexer/smi5879-corroboration-corpus.json',
  'scripts/tests/indexer/smi5879-corroboration-golden.core.json',
  'scripts/tests/indexer/smi5879-corroboration-golden.edge.json',
  'scripts/tests/indexer/smi5879-corroboration.fixtures.ts',
  'scripts/indexer/smi5879-corroboration.types.ts',
  // Upstream fixtures the manifest's json-pointer cases are re-derived against.
  'packages/core/tests/fixtures/security/safe-prompts.json',
  'packages/core/tests/fixtures/security/edge-cases.json',
  // Core scoring path — `calculateRiskScore` and the breakdown type itself.
  // NONE of these are watched today; the existing list only covers the files
  // the AST-based structural tests read.
  'packages/core/src/security/scanner/SecurityScanner.helpers.ts',
  'packages/core/src/security/scanner/SecurityScanner.risk-score.ts',
  'packages/core/src/security/scanner/types.ts',
  'packages/core/src/security/scanner/weights.ts',
  'packages/core/src/security/scanner/index.ts',
  // Core detectors `scan()` fans out to — each contributes to a projected key.
  'packages/core/src/security/scanner/SecurityScanner.scanners.ts',
  'packages/core/src/security/scanner/SecurityScanner.exec.ts',
  'packages/core/src/security/scanner/SecurityScanner.ssrf.ts',
  'packages/core/src/security/scanner/SecurityScanner.pii.ts',
  'packages/core/src/security/scanner/SecurityScanner.evidence.ts',
  'packages/core/src/security/scanner/regex-utils.ts',
  // Edge bundle path — `scanSkillBundle` and its sibling enumeration/merge.
  'scripts/indexer/skill-processor.security.ts',
  'scripts/indexer/_shared/security-scanner-edge.evidence.ts',
  'scripts/indexer/_shared/security-scanner-edge.chmod-compound.ts',
  'scripts/indexer/_shared/rate-limit.ts',
] as const
