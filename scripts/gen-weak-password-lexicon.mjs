#!/usr/bin/env node
// SMI-6441: generate the weak-password lexicon consumed by the
// `sensitive_path` MF-4b veto (Wave 2 — no severity change in this wave).
// Reads a vendored, SHA-256-pinned SecLists snapshot, truncates it to its
// first SOURCE_RANK_LIMIT (5000) rank-ordered lines (M-2a — see that
// constant below and docs/internal/implementation/smi-6441-weak-password-
// veto.md § item 3 "Sizing the corpus"; the untruncated 10k-line pipeline
// yields 7,063 entries / 506 lines, failing both gates below), filters to
// lowercase 3-19-char tokens, subtracts a hand-curated documentation-
// vocabulary keeplist, and emits three byte-identical-modulo-@module
// TypeScript modules: @skillsmith/core, the Node indexer edge twin, and
// the Deno Supabase edge twin (git-crypt encrypted — unlock before
// writing).
//
// Modeled on scripts/gen-docs-folder-index.mjs: --write/--check convention,
// zero runtime dependencies, plain .mjs so audit-standards.mjs can call it
// with no build step, exit 1 on drift or any sanity-gate failure.
//
// Sanity gates (all hard-fail, see § item 3 of the plan doc):
//   1. SOURCES.json SHA-256 verification of every vendored file.
//   2. Entry count within [MIN_ENTRIES, MAX_ENTRIES].
//   3. No entry contains a backtick, backslash, or `$` (encoding-safety
//      invariant, asserted independently of the shape regex).
//   4. No entry collides with PROSE_STOPWORDS (disjointness invariant — a
//      hard-fail check, NOT a silent subtraction; the fixed remediation is
//      a doc-vocab-keeplist.txt addition, never editing PROSE_STOPWORDS).
//   5. Emitted file line count <= MAX_EMITTED_LINES.
//
// Full design: docs/internal/implementation/smi-6441-weak-password-veto.md
//
// Usage:
//   node scripts/gen-weak-password-lexicon.mjs --write   (default)
//   node scripts/gen-weak-password-lexicon.mjs --check
//   node scripts/gen-weak-password-lexicon.mjs --help
//
// Exit codes:
//   0 — success (--write done, or --check found all three files fresh)
//   1 — --check found drift, or a sanity gate / integrity check failed
//
// This file holds the CLI entry point and orchestration (loadGeneratorInputs
// / generateAll / detectDrift) only. The pure functions and shared constants
// live in the sibling gen-weak-password-lexicon-helpers.mjs (split out to
// stay under this repo's 500-line file-length policy) and are re-exported
// below unchanged, so existing importers (scripts/audit-standards.mjs,
// scripts/tests/gen-weak-password-lexicon.test.ts) need no path changes.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REPO_ROOT,
  LEXICON_VERSION,
  SHAPE_RE,
  ENCODING_UNSAFE_RE,
  MIN_ENTRIES,
  MAX_ENTRIES,
  MAX_EMITTED_LINES,
  WRAP_WIDTH,
  SOURCE_RANK_LIMIT,
  SOURCES_JSON_PATH,
  KEEPLIST_PATH,
  PROSE_LEXICON_PATH,
  OUTPUTS,
  verifySourcesIntegrity,
  computeLexicon,
  wrapPayload,
  renderModule,
  assertEmittedLineBudget,
} from './gen-weak-password-lexicon-helpers.mjs'

// Re-export the full helpers surface unchanged for existing consumers.
export * from './gen-weak-password-lexicon-helpers.mjs'

/** Read every real input file this generator consumes. */
export function loadGeneratorInputs({
  sourcesJsonPath = SOURCES_JSON_PATH,
  keeplistPath = KEEPLIST_PATH,
  proseLexiconPath = PROSE_LEXICON_PATH,
} = {}) {
  const wordlistsDir = dirname(sourcesJsonPath)
  const sources = JSON.parse(readFileSync(sourcesJsonPath, 'utf8'))
  const snapshotEntry = sources.files.find((f) => f.file === 'seclists-xato-top-10000.txt')
  if (!snapshotEntry) {
    throw new Error(`SOURCES.json has no entry for seclists-xato-top-10000.txt`)
  }
  const snapshotBuffer = readFileSync(join(wordlistsDir, snapshotEntry.file))
  verifySourcesIntegrity(sources, (file) =>
    file === snapshotEntry.file ? snapshotBuffer : readFileSync(join(wordlistsDir, file))
  )
  return {
    snapshotText: snapshotBuffer.toString('utf8'),
    keeplistText: readFileSync(keeplistPath, 'utf8'),
    proseLexiconText: readFileSync(proseLexiconPath, 'utf8'),
    sourceMeta: snapshotEntry,
  }
}

/** Run every gate and render all three outputs. Throws on any gate failure. */
export function generateAll(inputs) {
  const entries = computeLexicon(inputs)
  const payloadLines = wrapPayload(entries, WRAP_WIDTH)
  const source = {
    upstream: inputs.sourceMeta.upstream,
    path: inputs.sourceMeta.path,
    license: inputs.sourceMeta.license,
    commit: inputs.sourceMeta.commit,
    sha256: inputs.sourceMeta.sha256,
    sourceRankLimit: SOURCE_RANK_LIMIT,
    entries: entries.length,
  }
  const rendered = OUTPUTS.map((out) => {
    const text = renderModule({
      moduleLine: out.moduleLine,
      source,
      version: LEXICON_VERSION,
      payloadLines,
    })
    assertEmittedLineBudget(text, out.label)
    return { ...out, text }
  })
  return { entries, rendered }
}

/**
 * Compare each rendered output against what's on disk. Injectable `exists`/
 * `readOnDisk` so this is unit-testable without touching real repo paths —
 * see scripts/tests/gen-weak-password-lexicon.test.ts.
 */
export function detectDrift(
  rendered,
  { exists = existsSync, readOnDisk = (p) => readFileSync(p, 'utf8') } = {}
) {
  return rendered.map((r) => {
    if (!exists(r.path)) return { ...r, status: 'missing' }
    const onDisk = readOnDisk(r.path)
    return { ...r, status: onDisk === r.text ? 'fresh' : 'stale' }
  })
}

function main(argv) {
  if (argv.includes('--help')) {
    console.log(
      [
        'gen-weak-password-lexicon.mjs — generate the SMI-6441 weak-password lexicon',
        '',
        'Usage:',
        '  node scripts/gen-weak-password-lexicon.mjs            rewrite all 3 files (--write)',
        '  node scripts/gen-weak-password-lexicon.mjs --check    exit 1 if any file is stale',
        '  node scripts/gen-weak-password-lexicon.mjs --help     this message',
      ].join('\n')
    )
    return 0
  }

  const check = argv.includes('--check')

  let inputs
  let result
  try {
    inputs = loadGeneratorInputs()
    result = generateAll(inputs)
  } catch (err) {
    console.error(`✖ ${err.message}`)
    return 1
  }

  if (check) {
    const statuses = detectDrift(result.rendered)
    let drift = false
    for (const s of statuses) {
      if (s.status === 'missing') {
        console.error(
          `✖ ${s.label}: ${s.path} does not exist — run: npm run lexicon:weak-passwords`
        )
        drift = true
      } else if (s.status === 'stale') {
        console.error(`✖ ${s.label}: ${s.path} is stale — run: npm run lexicon:weak-passwords`)
        drift = true
      } else {
        console.log(`✓ ${s.label}: ${s.path} is up to date`)
      }
    }
    if (!drift) {
      console.log(`✓ all 3 generated files fresh (${result.entries.length} entries)`)
    }
    return drift ? 1 : 0
  }

  for (const r of result.rendered) {
    writeFileSync(r.path, r.text)
    console.log(
      `✓ wrote ${r.label}: ${r.path} (${r.text.split('\n').length} lines, ${result.entries.length} entries)`
    )
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)))
}
