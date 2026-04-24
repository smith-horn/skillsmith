#!/usr/bin/env node
/**
 * SMI-4417 Wave 2 Step 6 — Token-delta harness.
 *
 * Measures total input-context consumption for representative agent tasks
 * with the skillsmith-doc-retrieval MCP server disabled (baseline) vs
 * enabled (measured). Produces a reproducible go/no-go artifact for the
 * gate: >=40% median reduction across the 3 tasks = pass Phase 2.
 *
 * Usage:
 *   node scripts/token-delta-harness.mjs run --mode baseline
 *   node scripts/token-delta-harness.mjs run --mode measured
 *   node scripts/token-delta-harness.mjs compare
 *
 * Measurement (SMI-4437 fix):
 *   Earlier revision summed only `usage.input_tokens` (uncached delta),
 *   which under-counted when tool results flowed through prompt caching.
 *   Now reads the terminal `result` event's cumulative usage totals and
 *   reports the full input ingestion across all three buckets:
 *     - input_tokens                (never-cached)
 *     - cache_creation_input_tokens (written to cache)
 *     - cache_read_input_tokens     (read from cache)
 *   The gate compares `totalInputAll = sum of all three` — the true
 *   workload the model had to ingest to produce the answer. Tool-use
 *   events are also counted so we can verify the MCP search tool was
 *   actually invoked in measured mode.
 *
 * The tasks live in scripts/ruvector-harness-tasks.json so measurements
 * stay reproducible across sessions.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const TASKS_PATH = resolve(__dirname, 'ruvector-harness-tasks.json')
const RESULTS_PATH = resolve(__dirname, 'ruvector-baseline.json')
const EMPTY_MCP_PATH = resolve(tmpdir(), 'token-delta-empty-mcp.json')

function loadTasks() {
  if (!existsSync(TASKS_PATH)) {
    throw new Error(`Harness tasks not found: ${TASKS_PATH}`)
  }
  return JSON.parse(readFileSync(TASKS_PATH, 'utf8'))
}

function loadResults() {
  if (!existsSync(RESULTS_PATH)) return { version: 2, runs: {} }
  return JSON.parse(readFileSync(RESULTS_PATH, 'utf8'))
}

function saveResults(data) {
  mkdirSync(dirname(RESULTS_PATH), { recursive: true })
  writeFileSync(RESULTS_PATH, JSON.stringify(data, null, 2), 'utf8')
}

function invokeClaude(prompt, mode) {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'default',
    '--model',
    'claude-sonnet-4-6',
  ]
  if (mode === 'baseline') {
    writeFileSync(EMPTY_MCP_PATH, JSON.stringify({ mcpServers: {} }), 'utf8')
    args.push('--mcp-config', EMPTY_MCP_PATH)
  }
  const result = spawnSync('claude', args, {
    cwd: REPO_ROOT,
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`claude exited ${result.status}: ${result.stderr?.slice(0, 500)}`)
  }
  return parseStream(result.stdout)
}

function parseStream(raw) {
  let finalUsage = null
  let totalCostUsd = null
  let turns = 0
  const toolCalls = {}

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let evt
    try {
      evt = JSON.parse(line)
    } catch {
      continue
    }
    if (evt.type === 'assistant') {
      turns++
      const content = evt.message?.content ?? []
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name) {
          toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1
        }
      }
    }
    if (evt.type === 'result' && evt.usage) {
      finalUsage = evt.usage
      if (typeof evt.total_cost_usd === 'number') totalCostUsd = evt.total_cost_usd
    }
  }

  const u = finalUsage ?? {}
  const inputTokens = u.input_tokens ?? 0
  const cacheCreation = u.cache_creation_input_tokens ?? 0
  const cacheRead = u.cache_read_input_tokens ?? 0
  const outputTokens = u.output_tokens ?? 0
  const totalInputAll = inputTokens + cacheCreation + cacheRead
  // Cost-weighted proxy (Sonnet pricing ratios: input=1x, cache_creation=1.25x, cache_read=0.1x)
  const costWeightedInput = inputTokens + cacheCreation * 1.25 + cacheRead * 0.1

  return {
    totalInputAll,
    inputTokens,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    outputTokens,
    costWeightedInput: Math.round(costWeightedInput),
    totalCostUsd,
    turns,
    toolCalls,
  }
}

function run(mode) {
  if (mode !== 'baseline' && mode !== 'measured') {
    throw new Error(`mode must be 'baseline' or 'measured', got: ${mode}`)
  }
  const tasks = loadTasks()
  const results = loadResults()
  for (const task of tasks) {
    const key = task.id
    results.runs[key] ??= {}
    const m = invokeClaude(task.prompt, mode)
    results.runs[key][mode] = {
      totalInputAll: m.totalInputAll,
      inputTokens: m.inputTokens,
      cacheCreationInputTokens: m.cacheCreationInputTokens,
      cacheReadInputTokens: m.cacheReadInputTokens,
      outputTokens: m.outputTokens,
      costWeightedInput: m.costWeightedInput,
      totalCostUsd: m.totalCostUsd,
      turns: m.turns,
      toolCalls: m.toolCalls,
      capturedAt: new Date().toISOString(),
    }
    const toolSummary = Object.entries(m.toolCalls)
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
    console.log(
      `[token-delta] ${key} mode=${mode} totalInputAll=${m.totalInputAll} ` +
        `(in=${m.inputTokens} cache_create=${m.cacheCreationInputTokens} cache_read=${m.cacheReadInputTokens}) ` +
        `turns=${m.turns} cost=$${m.totalCostUsd?.toFixed(4) ?? 'n/a'} tools=[${toolSummary}]`
    )
  }
  saveResults(results)
}

/**
 * Pure verdict computation — exported for unit tests.
 *
 * @param {Record<string, { baseline?: { totalInputAll?: number; totalCostUsd?: number; turns?: number }; measured?: { totalInputAll?: number; totalCostUsd?: number; turns?: number; toolCalls?: Record<string, number> } }>} runs
 * @returns {{ rows: object[]; medianReductionPct: number | null; gate: string; gateVerdict: 'PASS' | 'FAIL' | 'FAIL_TOOL_NOT_INVOKED'; toolInvocationFailure: boolean; toolNotInvokedTasks: string[] }}
 */
export function computeGateVerdict(runs) {
  const deltas = []
  const rows = []
  const toolNotInvokedTasks = []
  for (const [key, modes] of Object.entries(runs ?? {})) {
    const b = modes.baseline?.totalInputAll
    const m = modes.measured?.totalInputAll
    const mcpCalls =
      modes.measured?.toolCalls?.['mcp__skillsmith-doc-retrieval__skill_docs_search'] ?? 0
    const toolNotInvoked = typeof m === 'number' && mcpCalls === 0
    if (toolNotInvoked) toolNotInvokedTasks.push(key)
    if (typeof b !== 'number' || typeof m !== 'number' || b === 0) {
      rows.push({
        task: key,
        baselineTotalInput: b ?? null,
        measuredTotalInput: m ?? null,
        deltaPct: null,
        mcpSearchCalls: mcpCalls,
        toolNotInvoked,
      })
      continue
    }
    const deltaPct = (1 - m / b) * 100
    deltas.push(deltaPct)
    rows.push({
      task: key,
      baselineTotalInput: b,
      measuredTotalInput: m,
      deltaPct: Number(deltaPct.toFixed(1)),
      baselineCost: modes.baseline?.totalCostUsd ?? null,
      measuredCost: modes.measured?.totalCostUsd ?? null,
      baselineTurns: modes.baseline?.turns ?? null,
      measuredTurns: modes.measured?.turns ?? null,
      mcpSearchCalls: mcpCalls,
      toolNotInvoked,
    })
  }
  deltas.sort((a, b) => a - b)
  const median =
    deltas.length === 0
      ? null
      : deltas.length % 2 === 1
        ? deltas[(deltas.length - 1) / 2]
        : (deltas[deltas.length / 2 - 1] + deltas[deltas.length / 2]) / 2
  const toolInvocationFailure = toolNotInvokedTasks.length > 0
  const gateVerdict = toolInvocationFailure
    ? 'FAIL_TOOL_NOT_INVOKED'
    : typeof median === 'number' && median >= 40
      ? 'PASS'
      : 'FAIL'
  return {
    rows,
    medianReductionPct: median,
    gate: '>=40',
    gateVerdict,
    toolInvocationFailure,
    toolNotInvokedTasks,
  }
}

function compare() {
  const results = loadResults()
  const verdict = computeGateVerdict(results.runs)
  console.log(JSON.stringify(verdict, null, 2))
  if (verdict.gateVerdict !== 'PASS') process.exit(1)
}

function main() {
  const [, , cmd, ...rest] = process.argv
  if (cmd === 'run') {
    const modeIdx = rest.indexOf('--mode')
    const mode = modeIdx >= 0 ? rest[modeIdx + 1] : null
    if (!mode) throw new Error('Usage: run --mode <baseline|measured>')
    run(mode)
    return
  }
  if (cmd === 'compare') {
    compare()
    return
  }
  console.error('Usage: token-delta-harness.mjs <run --mode baseline|measured | compare>')
  process.exit(2)
}

// Only run CLI when executed directly (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error('[token-delta-harness] error:', err?.message ?? err)
    process.exit(1)
  }
}
