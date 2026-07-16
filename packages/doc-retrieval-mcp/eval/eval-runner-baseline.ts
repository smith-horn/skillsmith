/**
 * SMI-4763 / SMI-5708 Item #3 — baseline.json read/write helpers.
 *
 * Split out of eval-runner.ts to keep that file under the 500-line standard
 * (audit:standards Check 3), same rationale as this file's sibling
 * eval-runner-signatures.ts. Re-exported from eval-runner.ts so existing
 * imports of `../../eval/eval-runner.js` (corpus-stats.test.ts,
 * eval-runner.test.ts) are unaffected.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MetricsReport } from './metrics.js'
import { resolveRepoPath } from '../src/config.js'
// SMI-5708 Item #4 — writeFileAtomicSync is the same write-to-temp-then-
// rename helper eval-runner-signatures.ts uses for `.signatures.log`; reused
// here (rather than duplicated) so both shared-state writes this plan's
// P-5 table covers go through one, single-source-of-truth implementation.
import { emitBaselineSignature, writeFileAtomicSync } from './eval-runner-signatures.js'
// SMI-5708 Item #3 (Codex round-2 review, High) — reuse the SAME schema
// validator the reader (check-baseline-drift.ts) uses, rather than a bare
// `typeof === 'number'` check. A bare type check let an existing baseline.json
// with current: 0, -1, 1.5, or even NaN (all still `typeof 'number'`) pass and
// get silently promoted as the new prior -- exactly the class of corruption
// this item targets, just at the writer instead of the reader. One shared
// source of truth for "what counts as a valid baseline" instead of two
// independently-maintained copies of the same rules.
import { validateBaselineFile } from './check-baseline-drift-validation.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = join(__dirname, 'baseline.json')

// ---------------------------------------------------------------------------
// Index-state helpers (SMI-4763)
//
// `resolveIndexStateFile` mirrors src/config.ts repoRoot()/resolveRepoPath()
// so the GAP 1 startup check (eval-runner.ts's buildRealResults) and the
// corpus-stats refresh below both consult the SAME path the indexer writes
// to: `$SKILLSMITH_REPO_ROOT/.ruvector/.index-state.json` (or
// `$CWD/.ruvector/.index-state.json` when the env var is unset).
//
// The previous `join(__dirname, '..', '.ruvector', '.index-state.json')` resolved
// inside the package (`packages/doc-retrieval-mcp/.ruvector/...`), which never
// exists in practice — the GAP 1 check silently passed and `updateBaseline()`
// carried forward stale corpus stats forever. See SMI-4763 issue body.
// ---------------------------------------------------------------------------

export function resolveIndexStateFile(): string {
  return resolveRepoPath('.ruvector/.index-state.json')
}

/**
 * Read corpus stats (filesScanned, chunksUpserted) from the indexer's
 * `.index-state.json`. Fails soft: missing or malformed files return zeros
 * and emit a warning to stderr — a degraded baseline is preferable to a
 * failed baseline write, since baseline.json is the only durable record of
 * the metric run that just completed.
 */
export function readCorpusStatsFromIndex(stateFile: string): {
  filesScanned: number
  chunksUpserted: number
} {
  if (!existsSync(stateFile)) {
    process.stderr.write(
      `Warning: index-state file not found at ${stateFile}; baseline corpus stats will be 0/0.\n`
    )
    return { filesScanned: 0, chunksUpserted: 0 }
  }
  let chunkCountByFile: Record<string, number>
  try {
    const raw = readFileSync(stateFile, 'utf8')
    const parsed = JSON.parse(raw) as { chunkCountByFile?: Record<string, number> }
    chunkCountByFile = parsed.chunkCountByFile ?? {}
  } catch (err: unknown) {
    process.stderr.write(
      `Warning: failed to parse index-state file at ${stateFile} (${String(err)}); baseline corpus stats will be 0/0.\n`
    )
    return { filesScanned: 0, chunksUpserted: 0 }
  }
  const filesScanned = Object.keys(chunkCountByFile).length
  const chunksUpserted = Object.values(chunkCountByFile).reduce(
    (sum, n) => sum + (typeof n === 'number' ? n : 0),
    0
  )
  return { filesScanned, chunksUpserted }
}

// ---------------------------------------------------------------------------
// Baseline update
// ---------------------------------------------------------------------------

// Plan §7 / §6 baseline.json schema — flat, machine-readable, parsed by
// check-baseline-drift.ts. `prior` and `current` are recall@5 scalars; the
// full metric set lives under `metrics`. Promotion: each real-mode run
// promotes existing.current → prior and writes the new recall@5 as current.
export interface BaselineFile {
  prior: number | null
  current: number | null
  generated: string
  corpus: { filesScanned: number; chunksUpserted: number }
  knobs: { boost: number; dampen: number; floor: number; bm25: boolean }
  metrics: {
    recallAt5: number | null
    recallAt10: number | null
    mrr: number | null
    ndcgAt10: number | null
  }
  // SMI-4764 Wave 1 — per-category recall@5 + counts. Optional for
  // backward compatibility with pre-Wave-1 baselines (drift checker
  // falls back to the global gate when absent). `recallAt5Prior` is
  // promoted from the previous run's `recallAt5` (null on first run
  // with byCategory present).
  byCategory?: {
    recallAt5: Record<string, number>
    recallAt5Prior: Record<string, number> | null
    count: Record<string, number>
  }
  // SMI-5708 Item #3 — set ONLY by this file's own bootstrap branch below
  // (!baselineFileExists, i.e. no prior baseline.json existed at all).
  // check-baseline-drift.ts's schema validator requires this marker to accept
  // `prior: null` as a legitimate first-run state rather than a corrupted or
  // hand-zeroed baseline; it must never be set `true` from anywhere else.
  bootstrapped?: boolean
}

// SMI-5708 Item #4 — result of a single `updateBaseline()` call, surfaced up
// through `maybeUpdateBaseline()`'s optional `outcome` out-param to
// `main()`'s run summary (eval-runner.ts's `buildBaselineSignatureWarning`).
// `signatureEmitted` mirrors `emitBaselineSignature()`'s own return value:
// `false` means the write to the shared `eval/.signatures.log` failed. That
// failure is still non-fatal to this function/the overall run (baseline.json
// itself was written successfully either way -- the whole point of Item #4's
// atomic-write fix is that a partial write is no longer possible), but a
// developer needs to see this before they push and hit a confusing,
// seemingly-unrelated pre-push validator rejection.
export interface UpdateBaselineResult {
  signatureEmitted: boolean
}

function readKnobsFromEnv(): BaselineFile['knobs'] {
  const num = (envVar: string, fallback: number): number => {
    const v = Number(process.env[envVar])
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  return {
    boost: num('SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY', 1.5),
    dampen: num('SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS', 0.85),
    floor: 0.35,
    bm25: process.env.SKILLSMITH_DOC_RETRIEVAL_RERANK === 'bm25',
  }
}

export function updateBaseline(
  report: MetricsReport,
  opts: { baselinePath?: string; stateFile?: string } = {}
): UpdateBaselineResult {
  const baselinePath = opts.baselinePath ?? BASELINE_PATH
  const stateFile = opts.stateFile ?? resolveIndexStateFile()
  let existingCurrent: number | null = null
  let existingByCategoryCurrent: Record<string, number> | null = null
  // SMI-5708 Item #3 (Codex review finding, High) — a genuinely MISSING
  // baseline.json (first-ever run) must be distinguished from an EXISTING
  // one that is malformed JSON or has a non-numeric `current`. The old code
  // mapped all three to the same `existingCurrent === null` outcome, which
  // would have let `bootstrapped` below silently launder real corruption
  // (a baseline.json that exists but can't be read) into a "legitimate
  // bootstrap" — exactly the bypass this whole item is meant to close. Only
  // "the file does not exist at all" is a legitimate bootstrap; anything
  // else that prevents reading an existing file's `current` is a hard error.
  const baselineFileExists = existsSync(baselinePath)
  if (baselineFileExists) {
    let existing: unknown
    try {
      existing = JSON.parse(readFileSync(baselinePath, 'utf8'))
    } catch (err) {
      throw new Error(
        `updateBaseline: existing baseline.json at ${baselinePath} is malformed JSON and cannot ` +
          `be safely promoted or overwritten (${err instanceof Error ? err.message : String(err)}). ` +
          'Restore it from git history before running eval:retrieval again.'
      )
    }
    // SMI-5708 Item #3 (Codex round-2 review, High): a bare
    // `typeof current === 'number'` check let current: 0, -1, 1.5, or NaN --
    // all still `typeof 'number'` -- pass through and get silently promoted
    // as the new prior. Reuse the full schema validator instead, closing
    // this gap the same way the reader (check-baseline-drift.ts) is closed,
    // and also catching malformed nested byCategory data on the existing
    // file (Codex round-2 finding #2 in the validator itself, fixed below).
    const validation = validateBaselineFile(existing as BaselineFile)
    if (!validation.ok) {
      throw new Error(
        `updateBaseline: existing baseline.json at ${baselinePath} failed schema validation and ` +
          `cannot be safely promoted (${validation.error}). Restore it from git history before ` +
          'running eval:retrieval again.'
      )
    }
    const validated = existing as BaselineFile
    // validateBaselineFile guarantees `current` is a finite number in [0, 1]
    // at this point (never null -- unlike `prior`, which may legitimately be
    // null only alongside `bootstrapped: true`).
    existingCurrent = validated.current
    if (validated.byCategory && validated.byCategory.recallAt5) {
      existingByCategoryCurrent = validated.byCategory.recallAt5
    }
  }
  const currentByCategoryRecall: Record<string, number> = {}
  const currentByCategoryCount: Record<string, number> = {}
  for (const [cat, ms] of Object.entries(report.byCategory)) {
    currentByCategoryRecall[cat] = ms.recallAt5
    currentByCategoryCount[cat] = ms.count
  }
  // SMI-4763: recompute corpus stats from the live index-state file on every
  // run. The previous implementation carried `existingCorpus` forward from the
  // prior baseline.json, so once the value was wrong it stayed wrong even as
  // the index grew (e.g., 1325 files → 1500 files would still report 1325).
  const freshCorpus = readCorpusStatsFromIndex(stateFile)
  // SMI-5708 Item #3 — this is the ONE legitimate place `bootstrapped: true`
  // may be written: `!baselineFileExists` means there was genuinely no prior
  // baseline.json at all (not merely unreadable — that now throws above), so
  // `prior` below is genuinely null for a real first-run reason, not because
  // an existing baseline was corrupted and silently treated as absent.
  const bootstrapped = !baselineFileExists
  const updated: BaselineFile = {
    prior: existingCurrent,
    current: report.overall.recallAt5,
    generated: new Date().toISOString().split('T')[0],
    corpus: freshCorpus,
    knobs: readKnobsFromEnv(),
    bootstrapped,
    metrics: {
      recallAt5: report.overall.recallAt5,
      recallAt10: report.overall.recallAt10,
      mrr: report.overall.mrr,
      ndcgAt10: report.overall.ndcgAt10,
    },
    byCategory: {
      recallAt5: currentByCategoryRecall,
      recallAt5Prior: existingByCategoryCurrent,
      count: currentByCategoryCount,
    },
  }
  const serialized = JSON.stringify(updated, null, 2) + '\n'
  // SMI-5708 Item #4 — write-to-temp-then-rename instead of a direct
  // writeFileSync: an interrupted run (Ctrl-C, OOM, crash) between opening
  // the file and finishing the write used to be able to leave a truncated
  // baseline.json on disk. A failure here (temp write or rename) throws and
  // is NOT caught -- unlike signature emission below, a baseline.json write
  // failure must fail the run loudly, not silently.
  writeFileAtomicSync(baselinePath, serialized)
  const signatureEmitted = emitBaselineSignature(serialized)
  return { signatureEmitted }
}

// SMI-5708 Task #1 — real-mode category filtering must never overwrite the
// canonical baseline. `updateBaseline()` writes the GLOBAL, all-category
// baseline.json that check-baseline-drift.ts's CI gate depends on; a
// `--category X`-filtered real-mode run only computed metrics over that one
// category, so calling updateBaseline() with its report would silently
// replace the canonical multi-category baseline with single-category numbers.
// Extracted as its own function (rather than inlining the branch in main())
// so the skip-vs-write decision is unit-testable without exercising the real
// search/rerank pipeline: tests inject a stub in place of the real
// `updateBaseline` via `updateBaselineFn`, or exercise the real function
// against a temp baselinePath/stateFile (see eval-runner.test.ts).
export function maybeUpdateBaseline(
  report: MetricsReport,
  opts: { category: string | null },
  updateBaselineOpts: { baselinePath?: string; stateFile?: string } = {},
  updateBaselineFn: (
    report: MetricsReport,
    opts?: { baselinePath?: string; stateFile?: string }
  ) => UpdateBaselineResult = updateBaseline,
  // SMI-5708 Item #4 — optional out-param: when provided, populated with the
  // write's signature-emission outcome so a caller (main()) can surface a
  // visible warning without changing this function's own return type. All
  // pre-existing call sites omit this argument and get byte-for-byte
  // identical behavior to before this change -- this function's own
  // documented contract (a plain `boolean`, asserted via `toBe(false)` /
  // `toBe(true)` in eval-runner.test.ts) is untouched.
  outcome?: UpdateBaselineResult
): boolean {
  if (opts.category !== null) {
    process.stderr.write(
      [
        `Filtered real-mode run (--category ${opts.category}): eval-only.`,
        'baseline.json was NOT updated — a category-filtered run only computes',
        'metrics for that one category and must never overwrite the canonical,',
        'all-category baseline. To refresh baseline.json, run an unfiltered',
        'real-mode pass (RETRIEVAL_EVAL_REAL=1 npm run eval:retrieval, no --category),',
        'which recomputes all categories.',
        '',
      ].join('\n')
    )
    return false
  }
  const result = updateBaselineFn(report, updateBaselineOpts)
  // Presence check on `result.signatureEmitted` is by exact type (`typeof
  // ... === 'boolean'`), not truthiness: `signatureEmitted: false` is the
  // one value this whole mechanism exists to detect and propagate, so a
  // truthy check (`if (result?.signatureEmitted)`) would silently treat the
  // failure case as "nothing to report" -- exactly backwards.
  if (
    outcome !== undefined &&
    result !== undefined &&
    typeof result.signatureEmitted === 'boolean'
  ) {
    outcome.signatureEmitted = result.signatureEmitted
  }
  return true
}
