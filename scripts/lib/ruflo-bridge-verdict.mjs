#!/usr/bin/env node
/**
 * ruflo-bridge-verdict.mjs -- SMI-6744 Wave 0 detector.
 *
 * Reads one `memory_bridge_status` payload (the ruflo MCP tool's JSON result)
 * and returns a verdict on the embedding substrate.
 *
 * WHY THIS EXISTS. The payload reports `bridge.status: "connected"` and
 * `bridge.embedding: "... backend=mock"` in the same object. For two months
 * every reader took the first field and not the second (SMI-6744). Without a
 * predicate, Wave 1's repair and Wave 1's no-op produce the same observable.
 *
 * WHERE THE PREDICATE COMES FROM (plan, Wave 0 Step 2: from the implementation,
 * never from strings observed in the wild). At @claude-flow/cli@3.14.2:
 *
 *   dist/src/mcp-tools/memory-tools.js, the memory_bridge_status handler:
 *     embeddingBackend = probe.backend ?? 'unknown'   // 'unknown' = the probe threw
 *     agentdb.backend  = embeddingBackend === 'mock'
 *                          ? 'sql.js + MOCK (hash fallback)' : 'sql.js + ONNX'
 *     bridge.status    = agentdbEntries > 0 ? 'connected' : 'not-synced'
 *   dist/src/memory/memory-initializer.js, generateEmbedding / generateLocalEmbedding:
 *     backend: 'onnx' | 'mock'
 *   dist/src/memory/memory-bridge.js, bridgeGenerateEmbedding:
 *     backend: isMock ? 'mock' : 'onnx'
 *
 * So `embeddingBackend` takes exactly three values at that version, and the
 * verdict encodes three consequences:
 *   1. `bridge.status === 'connected'` is a ROW-COUNT claim. It is not evidence
 *      about embeddings; it is reported here as context only.
 *   2. `agentdb.backend` is a derived LABEL that renders 'unknown' as
 *      'sql.js + ONNX'. It is never read for the verdict.
 *   3. 'unknown' means the probe did not run to completion. That is a third
 *      outcome, reported as such -- never folded into healthy or degraded.
 *
 * A value outside the enumerated set means upstream changed the enum. The
 * verdict is then 'unrecognized' with a non-zero exit, so a reworded upstream
 * cannot become a silent pass. scripts/tests/ruflo-bridge-verdict.test.ts
 * checks the three source files for drift on any machine that has the tree.
 *
 * CLI exit status: 0 healthy, 1 degraded, 2 for anything that is not a verdict
 * on the substrate (not-evaluated, malformed, unrecognized, unreadable input).
 */
import { readFileSync } from 'node:fs'

import { isMainModule } from './is-main-module.mjs'

export const DERIVED_FROM = Object.freeze({
  package: '@claude-flow/cli',
  version: '3.14.2',
  // `version` is @claude-flow/cli's, not the wrapper's. `.mcp.json` pins the
  // wrapper (`ruflo@3.14.2`) and the wrapper's dependency range is open
  // (`>=3.0.0-alpha.1`), so the two numbers coincide today by accident: the
  // repo's own ruflo@3.5.42 resolves cli 3.5.80, and a fresh install of
  // ruflo@3.14.2 resolved cli 3.42.4 on 2026-09-18. Bumping the wrapper pin
  // does not re-derive this predicate; only re-reading the cli source does.
  servedBy: 'npx ruflo@3.14.2 (.mcp.json)',
  // The same five source literals were re-read, unchanged, at this later
  // version (the one `npm install ruflo@3.14.2` resolves to on 2026-09-18).
  alsoVerifiedAt: Object.freeze(['3.42.4']),
  files: Object.freeze([
    'dist/src/mcp-tools/memory-tools.js',
    'dist/src/memory/memory-initializer.js',
    'dist/src/memory/memory-bridge.js',
  ]),
})

/** The complete value set of `embeddingBackend` at DERIVED_FROM.version. */
export const EMBEDDING_BACKENDS = Object.freeze({
  healthy: Object.freeze(['onnx']),
  degraded: Object.freeze(['mock']),
  notEvaluated: Object.freeze(['unknown']),
})

/** Fields the verdict reads. Printed as the denominator so "clean" names its scope. */
export const FIELDS_READ = Object.freeze(['agentdb.embeddingBackend', 'bridge.embeddingBackend'])

/** Fields reported as context only -- never part of the verdict. */
export const FIELDS_CONTEXT = Object.freeze([
  'bridge.status',
  'agentdb.backend',
  'agentdb.totalEntries',
  'intelligence.patternsLearned',
  'intelligence.trajectoriesRecorded',
])

export const EXIT = Object.freeze({
  healthy: 0,
  degraded: 1,
  'not-evaluated': 2,
  malformed: 2,
  unrecognized: 2,
  unreadable: 2,
})

function get(obj, dotted) {
  return dotted
    .split('.')
    .reduce((o, k) => (o !== null && typeof o === 'object' ? o[k] : undefined), obj)
}

/**
 * @param {unknown} payload parsed memory_bridge_status result
 * @returns {{
 *   verdict: 'healthy'|'degraded'|'not-evaluated'|'malformed'|'unrecognized',
 *   reason: string,
 *   observed: Record<string, unknown>,
 *   read: string[], present: string[], missing: string[],
 * }}
 */
export function bridgeVerdict(payload) {
  const observed = {}
  for (const f of [...FIELDS_READ, ...FIELDS_CONTEXT]) observed[f] = get(payload, f)
  const present = FIELDS_READ.filter((f) => observed[f] !== undefined)
  const missing = FIELDS_READ.filter((f) => observed[f] === undefined)
  const base = { observed, read: [...FIELDS_READ], present, missing }
  const malformed = (reason) => ({ verdict: 'malformed', reason, ...base })

  if (payload === null || typeof payload !== 'object') {
    return malformed('payload is not an object')
  }
  if (missing.length > 0) {
    return malformed(`missing ${missing.join(', ')}`)
  }
  const a = observed['agentdb.embeddingBackend']
  const b = observed['bridge.embeddingBackend']
  if (a !== b) {
    // memory-tools.js writes both from one local; a disagreement means this
    // payload did not come from that handler.
    return malformed(
      `agentdb.embeddingBackend=${JSON.stringify(a)} disagrees with bridge.embeddingBackend=${JSON.stringify(b)}`
    )
  }
  if (typeof a !== 'string') {
    return malformed(`embeddingBackend is ${typeof a}, expected string`)
  }
  if (EMBEDDING_BACKENDS.healthy.includes(a)) {
    return { verdict: 'healthy', reason: `embeddingBackend=${a}`, ...base }
  }
  if (EMBEDDING_BACKENDS.degraded.includes(a)) {
    return {
      verdict: 'degraded',
      reason: `embeddingBackend=${a}: vectors are a deterministic hash, not embeddings`,
      ...base,
    }
  }
  if (EMBEDDING_BACKENDS.notEvaluated.includes(a)) {
    return {
      verdict: 'not-evaluated',
      reason: `embeddingBackend=${a}: the status probe did not complete; this is not a clean result`,
      ...base,
    }
  }
  return {
    verdict: 'unrecognized',
    reason:
      `embeddingBackend=${JSON.stringify(a)} is outside the set enumerated at ` +
      `${DERIVED_FROM.package}@${DERIVED_FROM.version}; re-derive the predicate before trusting any verdict`,
    ...base,
  }
}

export function render(result, source) {
  const lines = [
    `ruflo-bridge-verdict: ${result.verdict} -- ${result.reason}`,
    `  source: ${source}`,
    `  read (${result.present.length}/${result.read.length} present): ${result.read.join(', ')}`,
  ]
  for (const f of FIELDS_CONTEXT) lines.push(`  context ${f}=${JSON.stringify(result.observed[f])}`)
  lines.push(
    '  note: bridge.status is a row-count claim (totalEntries > 0), not evidence about embeddings'
  )
  lines.push(`  predicate derived from ${DERIVED_FROM.package}@${DERIVED_FROM.version}`)
  return lines.join('\n')
}

function main(argv) {
  const src = argv[2] ?? '/dev/stdin'
  let payload
  try {
    payload = JSON.parse(readFileSync(src, 'utf8'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stdout.write(`ruflo-bridge-verdict: unreadable -- ${src}: ${msg}\n`)
    return EXIT.unreadable
  }
  const result = bridgeVerdict(payload)
  process.stdout.write(`${render(result, src)}\n`)
  return EXIT[result.verdict]
}

// Entry-point guard: scripts/lib/is-main-module.mjs. Two earlier spellings
// each measured exit 0 with no output -- the healthy verdict, for a degraded
// payload, silently: a URL comparison that differs through a symlink, then a
// realpath comparison whose catch returned false when argv[1] could not be
// resolved. The test pins both with a real symlink and a direct exec.
if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv))
}
