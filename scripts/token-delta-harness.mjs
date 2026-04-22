#!/usr/bin/env node
/**
 * SMI-4417 Wave 2 Step 6 — Token-delta harness.
 *
 * Measures input-token consumption for representative agent tasks with the
 * skillsmith-doc-retrieval MCP server disabled (baseline) vs enabled
 * (measured). Produces a reproducible go/no-go artifact for the gate:
 * ≥40% median reduction across the 3 tasks = pass Phase 2.
 *
 * Usage:
 *   node scripts/token-delta-harness.mjs run --mode baseline
 *   node scripts/token-delta-harness.mjs run --mode measured
 *   node scripts/token-delta-harness.mjs compare
 *
 * Implementation:
 *   - Invokes `claude --print --output-format stream-json` per task.
 *   - Parses stream events, sums `usage.input_tokens` across assistant turns.
 *   - Writes results to scripts/ruvector-baseline.json (keyed by task + mode).
 *   - `compare` reads the JSON and emits the delta summary.
 *
 * The tasks live in scripts/ruvector-harness-tasks.json so measurements stay
 * reproducible across sessions.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const TASKS_PATH = resolve(__dirname, 'ruvector-harness-tasks.json')
const RESULTS_PATH = resolve(__dirname, 'ruvector-baseline.json')

function loadTasks() {
  if (!existsSync(TASKS_PATH)) {
    throw new Error(`Harness tasks not found: ${TASKS_PATH}`)
  }
  return JSON.parse(readFileSync(TASKS_PATH, 'utf8'))
}

function loadResults() {
  if (!existsSync(RESULTS_PATH)) return { version: 1, runs: {} }
  return JSON.parse(readFileSync(RESULTS_PATH, 'utf8'))
}

function saveResults(data) {
  mkdirSync(dirname(RESULTS_PATH), { recursive: true })
  writeFileSync(RESULTS_PATH, JSON.stringify(data, null, 2), 'utf8')
}

function invokeClaude(prompt, mode) {
  const args = ['--print', '--output-format', 'stream-json', '--permission-mode', 'default']
  if (mode === 'baseline') {
    args.push('--mcp-config', '/dev/null')
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
  let totalInput = 0
  let turns = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let evt
    try {
      evt = JSON.parse(line)
    } catch {
      continue
    }
    const usage = evt?.message?.usage ?? evt?.usage
    if (usage && typeof usage.input_tokens === 'number') {
      totalInput += usage.input_tokens
      turns++
    }
  }
  return { totalInputTokens: totalInput, turns }
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
    const measurement = invokeClaude(task.prompt, mode)
    results.runs[key][mode] = {
      totalInputTokens: measurement.totalInputTokens,
      turns: measurement.turns,
      capturedAt: new Date().toISOString(),
    }
    console.log(
      `[token-delta] ${key} mode=${mode} input=${measurement.totalInputTokens} turns=${measurement.turns}`
    )
  }
  saveResults(results)
}

function compare() {
  const results = loadResults()
  const deltas = []
  const rows = []
  for (const [key, modes] of Object.entries(results.runs ?? {})) {
    const b = modes.baseline?.totalInputTokens
    const m = modes.measured?.totalInputTokens
    if (typeof b !== 'number' || typeof m !== 'number' || b === 0) {
      rows.push({ task: key, baseline: b ?? null, measured: m ?? null, deltaPct: null })
      continue
    }
    const deltaPct = (1 - m / b) * 100
    deltas.push(deltaPct)
    rows.push({ task: key, baseline: b, measured: m, deltaPct: Number(deltaPct.toFixed(1)) })
  }
  deltas.sort((a, b) => a - b)
  const median =
    deltas.length === 0
      ? null
      : deltas.length % 2 === 1
        ? deltas[(deltas.length - 1) / 2]
        : (deltas[deltas.length / 2 - 1] + deltas[deltas.length / 2]) / 2
  console.log(JSON.stringify({ rows, medianReductionPct: median, gate: '>=40' }, null, 2))
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

try {
  main()
} catch (err) {
  console.error('[token-delta-harness] error:', err?.message ?? err)
  process.exit(1)
}
