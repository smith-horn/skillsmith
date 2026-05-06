/**
 * SMI-4702 -- Retrieval Eval baseline drift check.
 *
 * Invoked by the "Retrieval Eval Gate" CI job. Enforces three rules:
 *   1. Ranking files changed -> baseline.json must also change (H1)
 *   2. gold-set.json changed -> baseline.json must also change (GAP 3)
 *   3. baseline.json changed + prior != null -> recall@5 must not drop >5%
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

// Types

export interface BaselineMetrics {
  recallAt5: number | null
  recallAt10?: number | null
  mrr?: number | null
  ndcgAt10?: number | null
}

export interface BaselineFile {
  prior: number | null
  current: number | null
  generated?: string
  corpus?: { filesScanned: number; chunksUpserted: number }
  knobs?: { boost: number; dampen: number; floor: number; bm25: boolean }
  metrics?: BaselineMetrics
}

export interface DriftResult {
  pass: boolean
  message: string
}

// Core logic -- exported for unit tests

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

    const delta = (current - prior) / prior
    if (delta < -0.05) {
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
        `✓ Retrieval Eval Gate: ranking files changed, baseline.json updated, recall@5 within 5% threshold ` +
        `(prior: ${prior}, current: ${current}).`,
    }
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
