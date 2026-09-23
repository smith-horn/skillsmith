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
 *   4. `bridge.embedding` (the human-readable string named in "WHY THIS
 *      EXISTS" above) carries its own `backend=X` token, rendered from the
 *      SAME `isMock` local as embeddingBackend. A disagreement between them
 *      is malformed, the same signal as an agentdb-vs-bridge disagreement
 *      (SMI-6772 F5) -- but the token itself is never a primary source of
 *      truth; only a contradiction changes the verdict.
 *
 * A value outside the enumerated set means upstream changed the enum. The
 * verdict is then 'unrecognized' with a non-zero exit, so a reworded upstream
 * cannot become a silent pass. scripts/tests/ruflo-bridge-verdict.test.ts
 * checks the three source files for drift on any machine that has the tree.
 *
 * CLI exit status: 0 healthy, 1 degraded, 2 for anything that is not a verdict
 * on the substrate (not-evaluated, malformed, unrecognized, unreadable input,
 * or a CLI usage error -- more than one positional argument).
 */
import { readFileSync } from 'node:fs'

import { isMainModule } from './is-main-module.mjs'

export const DERIVED_FROM = Object.freeze({
  package: '@claude-flow/cli',
  // SMI-6744 A1.4: the launcher-pinned tree actually served in prod
  // (RUFLO_CLI_PIN in scripts/mcp-ruflo-launcher.sh) is the primary version
  // here -- the earlier primary (3.14.2, Wave 0's install-time resolution)
  // moved to alsoVerifiedAt below, since it was independently re-read there
  // and never re-promoted after the ADR-170 launcher cutover.
  version: '3.42.4',
  // `version` is @claude-flow/cli's, not the wrapper's. Historically this
  // coincided with the `.mcp.json` npx wrapper pin (`ruflo@3.14.2`) by
  // accident, since the wrapper's dependency range was open
  // (`>=3.0.0-alpha.1`): the repo's own ruflo@3.5.42 resolved cli 3.5.80,
  // and a fresh install of ruflo@3.14.2 resolved cli 3.42.4 on 2026-09-18.
  // SMI-6744 ADR-170 retires that npx entry: ruflo is now served by
  // scripts/mcp-ruflo-launcher.sh, which docker execs into the `ruflo`
  // Compose service (skillsmith-ruflo-1), itself running a lockfile-pinned
  // @claude-flow/cli@3.42.4 baked into the image at /opt/ruflo-seed
  // (ADR-170 § 1, § 7 — RUFLO_CLI_PIN is the one pin literal). Bumping
  // that pin does not re-derive this predicate; only re-reading the cli
  // source does.
  servedBy: 'scripts/mcp-ruflo-launcher.sh via the ruflo Compose service (skillsmith-ruflo-1)',
  // The same six source literals were re-read, unchanged, at this earlier
  // version (the one `npm install ruflo@3.14.2` resolved to on
  // 2026-09-18, before the ADR-170 launcher cutover made 3.42.4 primary).
  alsoVerifiedAt: Object.freeze(['3.14.2']),
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

/**
 * Cross-checked against FIELDS_READ's embeddingBackend for internal
 * consistency (SMI-6772 F5). `bridge.embedding` is a human-readable string
 * ("all-MiniLM-L6-v2 (384-dim, backend=mock)") the handler renders from the
 * SAME local that also produces embeddingBackend (memory-bridge.js's
 * `isMock` ternary), so a `backend=X` token here that disagrees with
 * embeddingBackend means this payload did not come from that handler -- the
 * same signal FIELDS_READ's own agentdb-vs-bridge disagreement check
 * already uses, one field over.
 *
 * This is NOT a primary source of truth: an absent field, an unparseable
 * string, or an agreeing token changes nothing. It is never `agentdb.backend`
 * -- that field is a DERIVED label the handler renders from embeddingBackend
 * post-hoc ('unknown' -> 'sql.js + ONNX'), so reading it here would let a
 * probe that never completed pass as healthy, exactly the SMI-6744 defect
 * this detector exists to close. `agentdb.backend` stays in FIELDS_CONTEXT,
 * reported but never read, by documented design.
 */
export const FIELD_EMBEDDING_TOKEN = 'bridge.embedding'

/**
 * Matches every `backend=X` token inside FIELD_EMBEDDING_TOKEN's free text.
 * Global on purpose: a non-global match read only the FIRST token, so a
 * string carrying `backend=onnx` and then `backend=mock` read as agreeing
 * (governance on B1.2, 2026-09-19). Every occurrence is returned and the
 * caller treats more than one distinct value as its own contradiction.
 */
const EMBEDDING_TOKEN_RE = /backend=([a-z0-9._-]+)/gi

/** Distinct `backend=` tokens in document order; [] when none or not a string. */
function extractEmbeddingTokens(value) {
  if (typeof value !== 'string') return []
  const seen = []
  for (const m of value.matchAll(EMBEDDING_TOKEN_RE)) {
    if (!seen.includes(m[1])) seen.push(m[1])
  }
  return seen
}

export const EXIT = Object.freeze({
  healthy: 0,
  degraded: 1,
  'not-evaluated': 2,
  malformed: 2,
  unrecognized: 2,
  unreadable: 2,
})

/**
 * Own DATA properties only, at every path segment (SMI-6772 F6). A dotted
 * traversal via bare `o[k]` reads through the prototype chain (an inherited
 * `embeddingBackend` reads as present) and invokes accessor properties
 * unconditionally (a throwing getter propagates out of bridgeVerdict()
 * uncrashed-and-uncaught, before the payload-type guard ever runs).
 * `Object.getOwnPropertyDescriptor` never invokes a getter and never sees an
 * inherited property, so requiring an own, value-bearing descriptor at every
 * segment closes both holes in one change: a real JSON.parse() result never
 * has an inherited or accessor property in the first place, so this is a
 * no-op for every real payload and a hard rejection for a hand-built one
 * that supplies either.
 */
function ownDataValue(o, k) {
  if (o === null || typeof o !== 'object') return undefined
  const desc = Object.getOwnPropertyDescriptor(o, k)
  return desc && 'value' in desc ? desc.value : undefined
}

function get(obj, dotted) {
  return dotted.split('.').reduce((o, k) => ownDataValue(o, k), obj)
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
  for (const f of [...FIELDS_READ, ...FIELDS_CONTEXT, FIELD_EMBEDDING_TOKEN]) {
    observed[f] = get(payload, f)
  }
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
  // SMI-6772 F5: bridge.embedding's own backend=X token must agree with
  // embeddingBackend. A syntheticHealthy() that flips only the two
  // embeddingBackend fields and leaves this string saying "backend=mock"
  // is exactly the shape this check exists to reject -- see the fixture
  // generator's own comment in ruflo-bridge-verdict.test.ts.
  const embeddingTokens = extractEmbeddingTokens(observed[FIELD_EMBEDDING_TOKEN])
  if (embeddingTokens.length > 1) {
    return malformed(
      `${FIELD_EMBEDDING_TOKEN} names ${embeddingTokens.length} distinct backend= tokens (${embeddingTokens.join(', ')}); the handler renders exactly one`
    )
  }
  const embeddingToken = embeddingTokens.length === 1 ? embeddingTokens[0] : null
  if (embeddingToken !== null && embeddingToken !== a) {
    return malformed(
      `${FIELD_EMBEDDING_TOKEN} names backend=${embeddingToken}, contradicting embeddingBackend=${a}`
    )
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
    `  cross-check ${FIELD_EMBEDDING_TOKEN}=${JSON.stringify(result.observed[FIELD_EMBEDDING_TOKEN])}`
  )
  lines.push(
    '  note: bridge.status is a row-count claim (totalEntries > 0), not evidence about embeddings'
  )
  lines.push(`  predicate derived from ${DERIVED_FROM.package}@${DERIVED_FROM.version}`)
  return lines.join('\n')
}

/**
 * The exit code for a verdict against `table` (defaults to EXIT), or null
 * when `table` does not name it. Exported so the guard is REACHABLE from a
 * test: bridgeVerdict returns five literals and all five are own keys of
 * EXIT, so an inline guard in main() measured unreachable -- deleting it
 * left the suite green. Two failure shapes, both measured: `table[x]` for
 * an unnamed verdict is undefined and process.exit(undefined) is exit 0,
 * the healthy verdict; and Object.freeze does not remove inherited keys,
 * so `table['constructor']` is a function and process.exit(<function>) is
 * exit 1, the degraded verdict, with no line saying why.
 *
 * The `table` param (SMI-6772 F1) is a test seam, not a runtime need --
 * every real caller uses the default. Without it, the own-key half
 * (`Object.hasOwn`) is unconstrained by any test: EXIT is a frozen object
 * literal directly over `Object.prototype`, so every one of its inherited
 * members is a function (or, for `__proto__`, an object) and `typeof code
 * === 'number'` alone already rejects all of them -- the own-key check
 * does no work the second half is not already doing, on THIS table. A
 * table with an INHERITED NUMERIC property (`Object.create({ x: 2 })`) is
 * the one shape only the own-key half can reject, and it needs an
 * injectable table to construct.
 *
 * The value half requires a process exit integer, not merely a number
 * (PR #2900 gate round 1): `typeof NaN === 'number'`, and measured on Node
 * 22, process.exit(NaN), (1.5) and (Infinity) throw RangeError and end the
 * process 1 -- the degraded verdict, with a stack trace in place of the
 * verdict line -- while exit(256) wraps to 0, the healthy verdict, and
 * exit(-1) to 255. Number.isInteger plus the 0..255 status-byte range
 * rejects every one of those; a numeric string is rejected by the same
 * check even though process.exit would have accepted it.
 */
export function exitCodeFor(verdict, table = EXIT) {
  const code = Object.hasOwn(table, verdict) ? table[verdict] : undefined
  return Number.isInteger(code) && code >= 0 && code <= 255 ? code : null
}

// SMI-6772 F9: exactly one positional argument (or none, for stdin).
// Without this, argv[2] silently ignores any argument after the first
// (M5's mechanism: argv.at(-1) would instead silently pick the LAST one) --
// either way a typo'd extra path is never surfaced, it just reads the
// wrong file.
const USAGE_EXIT = 2

function main(argv) {
  if (argv.length > 3) {
    process.stdout.write(
      'ruflo-bridge-verdict: usage: ruflo-bridge-verdict.mjs [path-to-payload.json]\n'
    )
    return USAGE_EXIT
  }
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
  const code = exitCodeFor(result.verdict)
  if (code === null) {
    // SMI-6772 F4: a distinct local constant, not EXIT.unreadable. The
    // numeric value is the same (2, per the header's exit contract) but the
    // CAUSE is not -- "input could not be read" vs "bridgeVerdict returned
    // a verdict string with no EXIT entry" are different failures that
    // happen to share a code today; naming them separately means a future
    // split of the two does not have to hunt down a borrowed name first.
    // Do not add an EXIT.unmapped key for this -- an unmapped verdict is
    // exactly the case EXIT cannot name (it is unmapped BECAUSE it is not a
    // key), and adding one would also break F2's reverse-direction
    // assertion (every EXIT key must correspond to a verdict the detector
    // actually produces).
    const UNCLASSIFIED_EXIT = 2
    process.stdout.write(
      `ruflo-bridge-verdict: unmapped verdict ${JSON.stringify(result.verdict)}\n`
    )
    return UNCLASSIFIED_EXIT
  }
  return code
}

// Entry-point guard: scripts/lib/is-main-module.mjs. Two earlier spellings
// each measured exit 0 with no output -- the healthy verdict, for a degraded
// payload, silently: a URL comparison that differs through a symlink, then a
// realpath comparison whose catch returned false when argv[1] could not be
// resolved. The test pins both with a real symlink and a direct exec.
if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv))
}
