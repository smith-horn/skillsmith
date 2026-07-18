/**
 * SMI-4702 — Retrieval eval runner.
 *
 * CLI-executable via `tsx eval/eval-runner.ts [flags]`.
 *
 * Flags:
 *   --json            Output raw JSON instead of markdown table
 *   --category <cat>  Filter gold set to this category only
 *   --difficulty      Include per-difficulty breakdown in output
 *   --ablate <dim>    Delegate to ablation-runner (Worker 2)
 *
 * Modes:
 *   Default (no RETRIEVAL_EVAL_REAL): mock mode. Each query produces 1 hit
 *     matching its first expectedChunk. Used for CI structural validation.
 *   Real (RETRIEVAL_EVAL_REAL=1): calls real search() + rerank(), updates
 *     baseline.json, and checks the memory-topic-files adapter is wired.
 *
 * Output uses process.stdout.write (not console.log) for determinism.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GoldEntry, RunResult, MetricsReport } from './metrics.js'
import { computeMetrics } from './metrics.js'
// SMI-4764 Wave 0 / SMI-5708 Item #3 — baseline.json read/write helpers live
// in a sibling file to keep this file under the 500-line gate. Re-exported
// below (a plain `export { ... } from`, not a separate import — only
// resolveIndexStateFile, maybeUpdateBaseline, and updateBaseline (SMI-5708
// Item #4 — passed explicitly to maybeUpdateBaseline below so main() can
// wire up the outcome out-param) are used locally in this file) so existing
// imports of `../../eval/eval-runner.js` (corpus-stats.test.ts,
// eval-runner.test.ts) are unaffected.
import {
  resolveIndexStateFile,
  maybeUpdateBaseline,
  updateBaseline,
  type UpdateBaselineResult,
} from './eval-runner-baseline.js'

export {
  resolveIndexStateFile,
  readCorpusStatsFromIndex,
  updateBaseline,
  maybeUpdateBaseline,
  type BaselineFile,
  type UpdateBaselineResult,
} from './eval-runner-baseline.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GOLD_SET_PATH = join(__dirname, 'gold-set.json')

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  json: boolean
  category: string | null
  difficulty: boolean
  ablate: string | null
} {
  const args = argv.slice(2)
  let json = false
  let category: string | null = null
  let difficulty = false
  let ablate: string | null = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true
    else if (args[i] === '--difficulty') difficulty = true
    else if (args[i] === '--category' && args[i + 1]) {
      category = args[++i]
    } else if (args[i] === '--ablate' && args[i + 1]) {
      ablate = args[++i]
    }
  }
  return { json, category, difficulty, ablate }
}

// ---------------------------------------------------------------------------
// Gold set loading
// ---------------------------------------------------------------------------

function loadGoldSet(): GoldEntry[] {
  const raw = readFileSync(GOLD_SET_PATH, 'utf8')
  return JSON.parse(raw) as GoldEntry[]
}

// ---------------------------------------------------------------------------
// Mock mode (CI structural validation)
// ---------------------------------------------------------------------------

function buildMockResults(entries: GoldEntry[]): RunResult[] {
  return entries.map((e) => ({
    id: e.id,
    query: e.query,
    category: e.category,
    difficulty: e.difficulty,
    // Mock: first expectedChunk as exact filePath hit at position 0
    hits: e.expectedChunks.length > 0 ? [{ filePath: e.expectedChunks[0].filePath }] : [],
    expectedChunks: e.expectedChunks,
  }))
}

// ---------------------------------------------------------------------------
// Real mode
// ---------------------------------------------------------------------------

// SMI-5708 Item #11: GAP 1 startup check, extracted so both real-mode callers
// (main()'s real-mode path and the ablation path, via runRealMode below)
// share it — previously only the main path reached this check, so an
// ablation run (--ablate <dim>) against an unindexed memory corpus silently
// computed recall against missing data.
//
// SMI-4763: resolve via repoRoot() so we consult the real .index-state.json
// the indexer writes to (`$REPO_ROOT/.ruvector/...`), not the package-local
// stub path that never exists in practice.
export function assertMemoryCorpusIndexed(): void {
  const stateFile = resolveIndexStateFile()
  if (!existsSync(stateFile)) return
  const stateRaw = readFileSync(stateFile, 'utf8')
  const state = JSON.parse(stateRaw) as { chunkCountByFile?: Record<string, number> }
  const chunkCountByFile = state.chunkCountByFile ?? {}
  const memoryPaths = Object.keys(chunkCountByFile).filter((p) => p.startsWith('memory://'))
  if (memoryPaths.length === 0) {
    process.stderr.write(
      [
        'Error: memory-topic-files adapter has 0 indexed chunks.',
        'Verify SMI-4677 wiring: SKILLSMITH_MEMORY_DIR_OVERRIDE must be set and the',
        'bind-mount must point to the correct memory directory.',
        'See docs/internal/implementation/memory-routing-multi-layer.md §SMI-4677.',
        'RETRIEVAL_EVAL_REAL=1 will produce meaningless recall values without memory chunks.',
        '',
      ].join('\n')
    )
    process.exit(1)
  }
}

// SMI-5708 Item #11: consolidated search/rerank/filter loop, shared by
// main()'s real-mode path (directly, below, minScore omitted) and
// ablation-runner.ts's defaultRunEvalFn (via runRealMode below, minScore
// supplied for the 'floor' dimension sweep). Previously duplicated
// near-identically as buildRealResults/runRealMode, with only
// buildRealResults running the corpus guard above.
async function runRealEval(entries: GoldEntry[], minScore?: number): Promise<RunResult[]> {
  assertMemoryCorpusIndexed()

  const { search, createVectorDb } = await import('../src/search.js')
  const { rerank } = await import('../src/rerank.js')
  const { DEFAULT_MIN_SIMILARITY } = await import('../src/config.js')
  const { embedBatch } = await import('../src/embedding.js')
  const threshold = minScore ?? DEFAULT_MIN_SIMILARITY

  // SMI-5708 Item #12: reuse one VectorDb handle and batch-embed all of this
  // pass's queries once, instead of search() constructing a fresh VectorDb
  // (each of which reopens the on-disk index) and re-embedding one query at
  // a time for every entry. Purely a performance fix -- results are
  // byte-identical either way (Wave 0 finding: confirmed-but-overstated,
  // the ONNX model itself was already a cached singleton).
  const db = await createVectorDb()
  const queryVecs = db ? await embedBatch(entries.map((e) => e.query)) : []

  const results: RunResult[] = []

  for (const [i, e] of entries.entries()) {
    const pool = db
      ? await search({
          query: e.query,
          k: 20,
          preRerank: true,
          db,
          queryVec: new Float32Array(queryVecs[i]),
        })
      : []
    // SMI-5708 Item #6: topK=10, matching this harness's own Recall@10/
    // nDCG@10 metrics -- rerank()'s BM25/MMR branch previously hardcoded a
    // 5-item selection cap, so BM25's Recall@10 could never exceed Recall@5.
    const reranked = rerank(pool, e.query, 10)
    const filtered = reranked.filter((h) => h.score >= threshold).slice(0, 10)
    results.push({
      id: e.id,
      query: e.query,
      category: e.category,
      difficulty: e.difficulty,
      hits: filtered.map((h) => ({ filePath: h.filePath })),
      expectedChunks: e.expectedChunks,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toFixed(4)
}

function renderMarkdownTable(report: MetricsReport, showDifficulty: boolean): string {
  const lines: string[] = []

  lines.push('## Retrieval Eval Results\n')
  lines.push('### Overall\n')
  lines.push('| Metric | Value |')
  lines.push('|--------|-------|')
  lines.push(`| Count | ${report.overall.count} |`)
  lines.push(`| Recall@5 | ${fmt(report.overall.recallAt5)} |`)
  lines.push(`| Recall@10 | ${fmt(report.overall.recallAt10)} |`)
  lines.push(`| MRR | ${fmt(report.overall.mrr)} |`)
  lines.push(`| nDCG@10 | ${fmt(report.overall.ndcgAt10)} |`)
  lines.push('')

  lines.push('### By Category\n')
  lines.push('| Category | Count | Recall@5 | Recall@10 | MRR | nDCG@10 |')
  lines.push('|----------|-------|----------|-----------|-----|---------|')
  for (const [cat, ms] of Object.entries(report.byCategory).sort()) {
    lines.push(
      `| ${cat} | ${ms.count} | ${fmt(ms.recallAt5)} | ${fmt(ms.recallAt10)} | ${fmt(ms.mrr)} | ${fmt(ms.ndcgAt10)} |`
    )
  }
  lines.push('')

  if (showDifficulty) {
    lines.push('### By Difficulty\n')
    lines.push('| Difficulty | Count | Recall@5 | Recall@10 | MRR | nDCG@10 |')
    lines.push('|------------|-------|----------|-----------|-----|---------|')
    for (const [diff, ms] of Object.entries(report.byDifficulty).sort()) {
      lines.push(
        `| ${diff} | ${ms.count} | ${fmt(ms.recallAt5)} | ${fmt(ms.recallAt10)} | ${fmt(ms.mrr)} | ${fmt(ms.ndcgAt10)} |`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

// SMI-5708 Item #4 — pure, directly-testable helper for the visibility half
// of this fix: given whether a baseline write was attempted and its
// signature-emission outcome, decide the warning text (if any) to surface in
// this run's own output. Kept as a small pure function (rather than inlined
// in main()) so it's unit-testable without invoking the real search/rerank
// pipeline main() otherwise requires.
//
// Returns null when there's nothing to warn about: either no write was
// attempted (a `--category`-filtered run, per Task #1) or the write's
// signature emission succeeded. The `!== false` check (not a truthy check)
// matters here too: `outcome.signatureEmitted` is only ever `true` or
// `false` in practice, but treating it as "anything not exactly `false`
// means no warning" keeps the same non-truthy-check discipline as the rest
// of this fix.
export function buildBaselineSignatureWarning(
  wrote: boolean,
  outcome: UpdateBaselineResult
): string | null {
  if (!wrote || outcome.signatureEmitted !== false) {
    return null
  }
  return [
    'WARNING: baseline.json was updated but signature emission to',
    'eval/.signatures.log FAILED. The pre-push validator',
    '(scripts/eval-baseline-validator.mjs) will not find a matching signature',
    'for this baseline and will reject it as stale/unsigned. See the',
    '"warning: failed to update .signatures.log" line above (stderr) for the',
    'underlying I/O error, fix it, then re-run',
    'RETRIEVAL_EVAL_REAL=1 npm run eval:retrieval to re-emit a matching signature.',
  ].join(' ')
}

// ---------------------------------------------------------------------------
// runRealMode — exported for ablation-runner (Worker 2 refactor, SMI-4702)
//
// Executes a real-mode eval pass over the gold set (or a pre-loaded subset)
// and returns the overall MetricSet. The minScore parameter allows the ablation
// runner to sweep the floor dimension without an env var.
//
// Called by ablation-runner.ts defaultRunEvalFn with env already applied to
// process.env before invocation.
// ---------------------------------------------------------------------------

export async function runRealMode(minScore?: number): Promise<import('./metrics.js').MetricSet> {
  const entries = loadGoldSet()
  // Rebuild real results under the current process.env (env overrides applied by caller).
  const results = await runRealEval(entries, minScore)
  const report = computeMetrics(results)
  return report.overall
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv)

  // Ablation delegation: ablation-runner.ts is provided by SMI-4702 Worker 2.
  // Dynamic import keeps the eval-runner module-loadable even if the ablation
  // runner is ever moved or removed in a future refactor; the import only
  // resolves at runtime when --ablate is passed.
  if (opts.ablate !== null) {
    const { runAblation } = await import('./ablation-runner.js')
    await runAblation(opts.ablate as 'boost' | 'dampen' | 'floor' | 'bm25', opts)
    return
  }

  let entries = loadGoldSet()

  if (opts.category !== null) {
    entries = entries.filter((e) => e.category === opts.category)
  }

  const realMode = process.env['RETRIEVAL_EVAL_REAL'] === '1'

  let results: RunResult[]
  if (realMode) {
    results = await runRealEval(entries)
    const report = computeMetrics(results)
    // SMI-5708 Item #4 — signature-emission failure stays non-fatal to this
    // run (the pre-push validator is the intended backstop, per this file's
    // own long-standing design), but must be visible in the run's own
    // output, not just a stderr warning that can scroll past unnoticed.
    // `signatureEmitted` starts `true`: maybeUpdateBaseline() only
    // overwrites it when a write was actually attempted, so a skipped write
    // (a filtered --category run, Task #1) correctly implies "nothing to
    // warn about" rather than a false alarm.
    const baselineOutcome: UpdateBaselineResult = { signatureEmitted: true }
    const wrote = maybeUpdateBaseline(report, opts, {}, updateBaseline, baselineOutcome)
    const signatureWarning = buildBaselineSignatureWarning(wrote, baselineOutcome)
    if (opts.json) {
      const jsonOutput: MetricsReport & { baselineSignatureWarning?: string } =
        signatureWarning !== null
          ? { ...report, baselineSignatureWarning: signatureWarning }
          : report
      process.stdout.write(JSON.stringify(jsonOutput, null, 2) + '\n')
    } else {
      let markdown = renderMarkdownTable(report, opts.difficulty)
      if (signatureWarning !== null) {
        markdown += `\n### WARNING\n\n${signatureWarning}\n`
      }
      process.stdout.write(markdown)
    }
  } else {
    results = buildMockResults(entries)
    const report = computeMetrics(results)
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    } else {
      process.stdout.write(renderMarkdownTable(report, opts.difficulty))
    }
  }
}

// Only run as CLI entry point — do not execute when imported by tests.
// SMI-4763: corpus-stats.test.ts imports updateBaseline / readCorpusStatsFromIndex
// from this module; without this guard, every test import would run a full
// mock-mode eval pass and pollute stdout. Mirrors check-baseline-drift.ts.
const isEntryPoint =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('eval-runner.ts') || process.argv[1].endsWith('eval-runner.js'))

if (isEntryPoint) {
  main().catch((err: unknown) => {
    process.stderr.write(`eval-runner error: ${String(err)}\n`)
    process.exit(1)
  })
}
