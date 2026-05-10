#!/usr/bin/env node
/**
 * Verify skills.repo_updated_at format invariant against live data
 * @file scripts/runbooks/verify-repo-updated-at-format.mjs
 *
 * SMI-4852 Issue #5b: live-data companion to the pure-unit fixture test in
 * scripts/indexer/tests/format-roundtrip.test.ts. Samples 10 random rows
 * from prod with non-null `repo_updated_at` and asserts each round-trips
 * through `new Date(s).toISOString() === s`.
 *
 * Invocation cadence:
 *   - Once pre-merge from the PR author's terminal (recorded in PR thread).
 *   - Once post-deploy as a manual smoke step (Smoke vs CI table).
 *   - NOT invoked from CI on every push (taps the prod pooler).
 *
 * Usage:
 *   varlock run -- ./scripts/runbooks/verify-repo-updated-at-format.mjs
 *
 * Exit codes:
 *   0  all sampled rows pass round-trip
 *   1  one or more rows fail round-trip
 *   2  pooler not reachable / env missing
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const POOLER_SCRIPT = resolve(__dirname, '..', 'pooler-psql.sh')

function runPsql(query) {
  const result = spawnSync(POOLER_SCRIPT, ['-At', '-c', query], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    process.stderr.write(
      `[verify-repo-updated-at-format] pooler-psql.sh failed (exit ${result.status}):\n${result.stderr}\n`
    )
    process.exit(2)
  }
  return result.stdout.trim()
}

const query = `
  SELECT repo_updated_at
  FROM skills
  WHERE repo_updated_at IS NOT NULL
  ORDER BY random()
  LIMIT 10
`

const output = runPsql(query)
const rows = output.split('\n').filter((line) => line.length > 0)

if (rows.length === 0) {
  console.error(
    '[verify-repo-updated-at-format] No rows returned — pool may be empty or query failed.'
  )
  process.exit(2)
}

let passed = 0
let failed = 0
const failures = []

for (const stored of rows) {
  const parsed = new Date(stored)
  if (Number.isNaN(parsed.getTime())) {
    failed++
    failures.push({ stored, reason: 'unparseable' })
    continue
  }
  const roundTripped = parsed.toISOString()
  if (roundTripped === stored) {
    passed++
  } else {
    failed++
    failures.push({ stored, roundTripped, reason: 'format-mismatch' })
  }
}

console.log(
  JSON.stringify(
    {
      event: 'verify-repo-updated-at-format',
      sampled: rows.length,
      passed,
      failed,
      failures: failures.slice(0, 5),
    },
    null,
    2
  )
)

if (failed > 0) {
  console.error(`[verify-repo-updated-at-format] ${failed}/${rows.length} rows failed round-trip.`)
  process.exit(1)
}

console.log(`[verify-repo-updated-at-format] ${passed}/${rows.length} rows passed round-trip.`)
process.exit(0)
