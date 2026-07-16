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
// resolveIndexStateFile and maybeUpdateBaseline are used locally in this
// file) so existing imports of `../../eval/eval-runner.js`
// (corpus-stats.test.ts, eval-runner.test.ts) are unaffected.
import { resolveIndexStateFile, maybeUpdateBaseline } from './eval-runner-baseline.js'

export {
  resolveIndexStateFile,
  readCorpusStatsFromIndex,
  updateBaseline,
  maybeUpdateBaseline,
  type BaselineFile,
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

async function buildRealResults(entries: GoldEntry[]): Promise<RunResult[]> {
  // GAP 1 startup check: verify memory-topic-files adapter is indexed.
  // SMI-4763: resolve via repoRoot() so we consult the real .index-state.json
  // the indexer writes to (`$REPO_ROOT/.ruvector/...`), not the
  // package-local stub path that never exists in practice.
  const stateFile = resolveIndexStateFile()
  if (existsSync(stateFile)) {
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

  const { search } = await import('../src/search.js')
  const { rerank } = await import('../src/rerank.js')
  const { DEFAULT_MIN_SIMILARITY } = await import('../src/config.js')

  const results: RunResult[] = []

  for (const e of entries) {
    const pool = await search({ query: e.query, k: 20, preRerank: true })
    const reranked = rerank(pool, e.query)
    const filtered = reranked.filter((h) => h.score >= DEFAULT_MIN_SIMILARITY).slice(0, 10)
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
  const { search } = await import('../src/search.js')
  const { rerank } = await import('../src/rerank.js')
  const { DEFAULT_MIN_SIMILARITY } = await import('../src/config.js')
  const threshold = minScore ?? DEFAULT_MIN_SIMILARITY
  const results: RunResult[] = []
  for (const e of entries) {
    const pool = await search({ query: e.query, k: 20, preRerank: true })
    const reranked = rerank(pool, e.query)
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
    results = await buildRealResults(entries)
    const report = computeMetrics(results)
    maybeUpdateBaseline(report, opts)
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    } else {
      process.stdout.write(renderMarkdownTable(report, opts.difficulty))
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
