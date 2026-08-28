#!/usr/bin/env node
/**
 * SMI-6220: test-only jq-compatible shim.
 *
 * Real `jq` is not installed anywhere in this repo's Docker image --
 * confirmed via `apt-cache policy jq` (no candidate) and a `find /` sweep
 * inside `skillsmith-dev-1` / a worktree container, both built from the
 * same root `Dockerfile` that CI's `skillsmith-ci` image also builds from
 * (`.github/workflows/ci.yml` runs `npx vitest run scripts/tests ...`
 * inside `skillsmith-ci:${{ github.sha }}`). No existing test in this repo
 * had previously exercised a real `jq` binary at test-execution time --
 * every prior `jq`-adjacent assertion in `scripts/tests/**` is a static
 * string/regex match against workflow YAML text, never a real invocation.
 *
 * `.github/workflows/indexer.yml` itself runs on GitHub's `ubuntu-latest`
 * hosted runner, which ships jq by default -- this gap is purely a local
 * dev-container / CI-test-sandbox limitation, not a production concern.
 * Adding `jq` to the root `Dockerfile` is an ADR-109-gated infra change
 * (requires its own SPARC + plan-review) and is out of scope for
 * SMI-6220's own plan-reviewed doc, which only covers the workflow file,
 * `run.ts`'s typing, and this test file.
 *
 * This shim implements EXACTLY the fixed, enumerable set of jq invocations
 * the "Evaluate Result Thresholds" step (indexer.yml) uses, so
 * `indexer-alert-gap.test.ts`'s `runThresholdEval` can exercise the real
 * extracted bash under real execution (SPARC §4.1 layer 3) rather than
 * only `bash -n`. An unrecognized filter throws loudly instead of silently
 * misbehaving, so any future drift between the step's jq calls and this
 * shim's coverage is caught by the test itself, not masked.
 */
'use strict'

const { readFileSync } = require('node:fs')

function main() {
  const args = process.argv.slice(2)
  let nullInput = false
  const namedArgs = {}
  let filter = null

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-r' || a === '-e') {
      // no-op for this shim's output formatting (see below)
    } else if (a === '-n') {
      nullInput = true
    } else if (a === '--arg') {
      namedArgs[args[i + 1]] = args[i + 2]
      i += 2
    } else if (a === '--argjson') {
      namedArgs[args[i + 1]] = JSON.parse(args[i + 2])
      i += 2
    } else if (filter === null) {
      filter = a
    }
  }

  const input = nullInput ? null : JSON.parse(readFileSync(0, 'utf8'))
  const result = evalFilter(filter, input, namedArgs)

  if (typeof result === 'string') {
    process.stdout.write(result + '\n')
  } else {
    process.stdout.write(JSON.stringify(result) + '\n')
  }
}

function resolvePath(obj, path) {
  const parts = path.split('.').filter(Boolean)
  let cur = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return null
    cur = Object.prototype.hasOwnProperty.call(cur, p) ? cur[p] : null
    if (cur === undefined) cur = null
  }
  return cur === undefined ? null : cur
}

/** jq's `//` alternative operator: falls through only on `null` or `false`. */
function evalAlternatives(input, expr) {
  const terms = expr.split('//').map((t) => t.trim())
  let last
  for (const term of terms) {
    let value
    if (term.startsWith('.')) {
      value = resolvePath(input, term)
    } else if (term === 'true') {
      value = true
    } else if (term === 'false') {
      value = false
    } else if (/^-?\d+(\.\d+)?$/.test(term)) {
      value = Number(term)
    } else {
      throw new Error(`fake-jq: unsupported literal term "${term}" in filter "${expr}"`)
    }
    last = value
    if (value !== null && value !== false) return value
  }
  return last
}

function evalFilter(filter, input, namedArgs) {
  if (filter === 'type=="object" and has("meta")') {
    const isObject = input !== null && typeof input === 'object' && !Array.isArray(input)
    return isObject && Object.prototype.hasOwnProperty.call(input, 'meta')
  }
  if (filter === '$f/$t') {
    return namedArgs.f / namedArgs.t
  }
  if (filter === '$r > $m') {
    return namedArgs.r > namedArgs.m
  }
  if (filter === '$r > 0.1') {
    return namedArgs.r > 0.1
  }
  if (
    filter ===
    '{type:"indexer_degraded", message:$msg, workflow:"Skill Indexer", runId:$rid, runUrl:$url}'
  ) {
    return {
      type: 'indexer_degraded',
      message: namedArgs.msg,
      workflow: 'Skill Indexer',
      runId: namedArgs.rid,
      runUrl: namedArgs.url,
    }
  }
  if (typeof filter === 'string' && filter.startsWith('.') && filter.includes('//')) {
    return evalAlternatives(input, filter)
  }
  if (typeof filter === 'string' && filter.startsWith('.')) {
    return resolvePath(input, filter)
  }
  throw new Error(`fake-jq: unsupported filter: ${JSON.stringify(filter)}`)
}

main()
