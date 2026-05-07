/**
 * SMI-4702 / SMI-4764 -- Retrieval Eval baseline drift check.
 *
 * Invoked by the "Retrieval Eval Gate" CI job. Enforces:
 *   1. Ranking files changed -> baseline.json must also change (H1)
 *   2. gold-set.json changed -> baseline.json must also change (GAP 3)
 *   3. baseline.json changed -> hybrid drift threshold (SMI-4764 Wave 1):
 *      - byCategory present: per-category max(5% rel, N-hit floor) +
 *        global 10% tripwire on overall recall@5
 *      - byCategory absent (transitional / pre-Wave-1): legacy global 5% gate
 *
 * The N-hit floor is 1 for high-N categories (count >= LOW_N_THRESHOLD)
 * and 2 for low-N (count < LOW_N_THRESHOLD) — prevents single-flap
 * false positives in small categories like skill-discovery (N=5).
 *
 * Exits 0 on pass, 1 on failure. Error messages use ::error:: (GHA format).
 * Usage: tsx eval/check-baseline-drift.ts
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

const RANKING_FILES = [
  'packages/doc-retrieval-mcp/src/rerank.ts',
  'packages/doc-retrieval-mcp/src/search.ts',
  'packages/doc-retrieval-mcp/src/corpus.config.json',
]
const GOLD_SET_FILE = 'packages/doc-retrieval-mcp/eval/gold-set.json'
const BASELINE_FILE = 'packages/doc-retrieval-mcp/eval/baseline.json'

// SMI-4764 Wave 1 hybrid threshold tuning.
const PER_CATEGORY_REL_THRESHOLD = 0.05 // 5% relative drop trips per-category
const GLOBAL_TRIPWIRE_REL_THRESHOLD = 0.1 // 10% relative drop on overall trips global
const LEGACY_GLOBAL_REL_THRESHOLD = 0.05 // applied when byCategory absent (back-compat)
const LOW_N_THRESHOLD = 10 // categories with count < 10 use 2-hit floor
const HIGH_N_HIT_FLOOR = 1
const LOW_N_HIT_FLOOR = 2
// Recall values are floats derived from hit-count / question-count divisions,
// so an "exactly 1-hit" drop can read as 0.99999...×(1/N). Compare with a
// tiny epsilon so integer-hit boundaries trip predictably.
const HIT_FLOOR_EPSILON = 1e-9

// Types

export interface BaselineMetrics {
  recallAt5: number | null
  recallAt10?: number | null
  mrr?: number | null
  ndcgAt10?: number | null
}

export interface BaselineByCategory {
  recallAt5: Record<string, number>
  // Promoted from the prior run's `recallAt5`. `null` on the first run
  // that emits byCategory, `undefined` on baselines written before
  // SMI-4764 Wave 1 (drift checker treats both as "no per-category prior").
  recallAt5Prior?: Record<string, number> | null
  count: Record<string, number>
}

export interface BaselineFile {
  prior: number | null
  current: number | null
  generated?: string
  corpus?: { filesScanned: number; chunksUpserted: number }
  knobs?: { boost: number; dampen: number; floor: number; bm25: boolean }
  metrics?: BaselineMetrics
  byCategory?: BaselineByCategory
}

export interface DriftResult {
  pass: boolean
  message: string
}

// Core logic -- exported for unit tests

/**
 * SMI-4764 Wave 1 hybrid drift check.
 *
 * When `byCategory` (with `recallAt5Prior` and `count`) is present on the
 * baseline, applies:
 *   - Per-category: fail if any category drops by max(5% rel, N-hit floor),
 *     where N-hit floor = 1 (count >= 10) or 2 (count < 10).
 *   - Global tripwire: fail if overall recall@5 drops > 10% relative.
 *
 * When byCategory or its prior snapshot is absent, falls back to the legacy
 * global 5% gate. This preserves protection during the post-Wave-1 window
 * before the canonical dev re-runs to populate byCategory.
 */
export function checkHybridDrift(
  baseline: BaselineFile,
  prior: number,
  current: number
): DriftResult {
  const byCat = baseline.byCategory
  const priorByCat =
    byCat && byCat.recallAt5Prior !== null && byCat.recallAt5Prior !== undefined
      ? byCat.recallAt5Prior
      : null

  // Fallback path: byCategory absent OR no per-category prior available.
  // Use legacy global 5% gate so protection is preserved during the
  // transitional window between Wave 1 merge and the canonical dev's
  // first real-mode run that populates byCategory.recallAt5Prior.
  if (!byCat || !priorByCat) {
    const delta = (current - prior) / prior
    if (delta < -LEGACY_GLOBAL_REL_THRESHOLD) {
      const pct = (delta * 100).toFixed(1)
      return {
        pass: false,
        message:
          `::error::recall@5 regressed >5% vs prior (delta: ${pct}%, prior: ${prior}, current: ${current}). ` +
          'Investigate ranking changes before merging.',
      }
    }
    return {
      pass: true,
      message:
        `✓ Retrieval Eval Gate: byCategory not present, recall@5 within 5% threshold ` +
        `(prior: ${prior}, current: ${current}).`,
    }
  }

  // Hybrid path: per-category + global tripwire.
  const failures: string[] = []
  const currentByCat = byCat.recallAt5
  const counts = byCat.count

  for (const [cat, currentCat] of Object.entries(currentByCat)) {
    const priorCat = priorByCat[cat]
    if (priorCat === undefined) continue // new category — no prior to compare
    if (priorCat === 0) continue // can't compute relative drop from zero
    const drop = priorCat - currentCat
    if (drop <= 0) continue
    const count = counts[cat] ?? 0
    if (count === 0) continue // no entries in this category — skip
    const hitFloor = count < LOW_N_THRESHOLD ? LOW_N_HIT_FLOOR : HIGH_N_HIT_FLOOR
    const absoluteHitDrop = hitFloor / count // smallest drop that counts
    const relThreshold = priorCat * PER_CATEGORY_REL_THRESHOLD
    const threshold = Math.max(relThreshold, absoluteHitDrop)
    if (drop + HIT_FLOOR_EPSILON >= threshold) {
      const pctRel = ((drop / priorCat) * 100).toFixed(1)
      failures.push(
        `${cat} (count=${count}): ${priorCat.toFixed(4)} → ${currentCat.toFixed(4)} ` +
          `(Δ -${pctRel}%, threshold max(5%, ${hitFloor}/${count}=${absoluteHitDrop.toFixed(4)}))`
      )
    }
  }

  // Global tripwire: catches multi-category degradation that doesn't trip
  // any single category by itself.
  const overallDelta = (current - prior) / prior
  const tripwireTriggered = overallDelta < -GLOBAL_TRIPWIRE_REL_THRESHOLD

  if (failures.length > 0 || tripwireTriggered) {
    const lines: string[] = []
    if (failures.length > 0) {
      lines.push(`::error::Per-category recall@5 regression detected:`)
      for (const f of failures) lines.push(`  - ${f}`)
    }
    if (tripwireTriggered) {
      const pct = (overallDelta * 100).toFixed(1)
      lines.push(
        `::error::Global tripwire: overall recall@5 dropped >10% (delta: ${pct}%, prior: ${prior}, current: ${current}).`
      )
    }
    lines.push(
      'Re-run RETRIEVAL_EVAL_REAL=1 npm run eval:retrieval and investigate ranking changes before merging.'
    )
    return { pass: false, message: lines.join('\n') }
  }

  return {
    pass: true,
    message:
      `✓ Retrieval Eval Gate: hybrid threshold passed across ${Object.keys(currentByCat).length} ` +
      `categories (overall recall@5: ${prior} → ${current}).`,
  }
}

/**
 * Evaluate drift rules against a set of changed files and a parsed baseline.
 * M1 fix: when prior === null (first real-mode run), regression check is skipped.
 */
export function evaluateDrift(changedFiles: string[], baseline: BaselineFile): DriftResult {
  const rankingFilesChanged = RANKING_FILES.some((f) => changedFiles.includes(f))
  const goldSetChanged = changedFiles.includes(GOLD_SET_FILE)
  const baselineChanged = changedFiles.includes(BASELINE_FILE)

  // Rule 1: ranking files changed but baseline.json not updated
  if (rankingFilesChanged && !baselineChanged) {
    return {
      pass: false,
      message:
        '::error::Ranking files changed but baseline.json was not updated. ' +
        'Run RETRIEVAL_EVAL_REAL=1 npm run eval:retrieval locally and commit the updated baseline.json.',
    }
  }

  // Rule 2: gold-set.json changed but baseline.json not updated (GAP 3)
  if (goldSetChanged && !baselineChanged) {
    return {
      pass: false,
      message:
        '::error::gold-set.json changed but baseline.json was not updated. ' +
        'New entries change recall@K -- re-run the harness and commit updated baseline.json.',
    }
  }

  // Rule 3/4: baseline.json changed -- check regression when prior is not null
  if (baselineChanged) {
    const prior = baseline.prior
    const current = baseline.current

    // M1: first commit -- prior is null, skip regression check
    if (prior === null) {
      return {
        pass: true,
        message:
          '✓ Retrieval Eval Gate: baseline.json changed, prior is null (first real-mode run) -- regression check skipped.',
      }
    }

    if (typeof prior !== 'number' || typeof current !== 'number' || prior === 0) {
      return {
        pass: true,
        message:
          '✓ Retrieval Eval Gate: baseline.json changed, prior/current not numeric or prior=0 -- regression check skipped.',
      }
    }

    return checkHybridDrift(baseline, prior, current)
  }

  return {
    pass: true,
    message: '✓ Retrieval Eval Gate: no ranking or eval files changed -- nothing to check.',
  }
}

// Git diff helper

function getChangedFiles(): string[] {
  const baseRef = process.env['GITHUB_BASE_REF']
  const headRef = process.env['GITHUB_HEAD_REF']
  const range = baseRef && headRef ? `${baseRef}...HEAD` : 'main...HEAD'
  try {
    const output = execFileSync('git', ['diff', '--name-only', range], { encoding: 'utf8' })
    return output
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
  } catch {
    process.stderr.write(`::warning::git diff failed for range ${range}; treating as no changes.\n`)
    return []
  }
}

// Baseline loader

function loadBaseline(): BaselineFile {
  const cwdPath = join(process.cwd(), BASELINE_FILE)
  const fallbackPath = join(__dirname, '..', '..', '..', '..', BASELINE_FILE)
  const resolvedPath = existsSync(cwdPath) ? cwdPath : fallbackPath

  if (!existsSync(resolvedPath)) {
    process.stderr.write(`::error::baseline.json not found at ${resolvedPath}\n`)
    process.exit(1)
  }
  try {
    return JSON.parse(readFileSync(resolvedPath, 'utf8')) as BaselineFile
  } catch {
    process.stderr.write(`::error::Failed to parse baseline.json at ${resolvedPath}\n`)
    process.exit(1)
  }
}

// CLI entry point

function main(): void {
  const changedFiles = getChangedFiles()
  const baseline = loadBaseline()
  const result = evaluateDrift(changedFiles, baseline)
  if (result.pass) {
    process.stdout.write(result.message + '\n')
    process.exit(0)
  } else {
    process.stderr.write(result.message + '\n')
    process.exit(1)
  }
}

// Only run as CLI entry point -- do not execute when imported by tests
const isEntryPoint =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('check-baseline-drift.ts') ||
    process.argv[1].endsWith('check-baseline-drift.js'))

if (isEntryPoint) {
  main()
}
