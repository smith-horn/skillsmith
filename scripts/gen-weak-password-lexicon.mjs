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

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

// Bumped BY HAND whenever the emitted entry set changes. Deliberately never
// derived from the wall clock — a timestamp here would make --check and
// byte-identity both break on every run regardless of content.
export const LEXICON_VERSION = '2026-09-08.1'

export const SHAPE_RE = /^[a-z]{3,19}$/
export const ENCODING_UNSAFE_RE = /[`\\$]/
// [2000, 6000]: tightened from the pre-review [2000, 8000] (M-2) — see the
// plan doc's "Gate interaction" note. Do not raise without a plan review.
export const MIN_ENTRIES = 2000
export const MAX_ENTRIES = 6000
export const MAX_EMITTED_LINES = 480
export const WRAP_WIDTH = 120
// M-2a: truncate the rank-ordered snapshot to its first N lines BEFORE any
// filtering (`lines.slice(0, SOURCE_RANK_LIMIT)`, so N maps to `sed -n
// '1,5000p'`). Measured: 4,079 entries / 317 total lines (plan doc's
// "Sizing the corpus"). Raising this is a GATED change — re-run the sizing
// table, the Wave 2 fixture matrix, and the Wave 2 Step 4 replay.
export const SOURCE_RANK_LIMIT = 5000

export const SOURCES_JSON_PATH = join(REPO_ROOT, 'data/wordlists/SOURCES.json')
export const KEEPLIST_PATH = join(REPO_ROOT, 'data/wordlists/doc-vocab-keeplist.txt')
export const PROSE_LEXICON_PATH = join(
  REPO_ROOT,
  'packages/core/src/security/scanner/SecurityScanner.prose-lexicon.ts'
)

/** The three generated outputs, byte-identical modulo `moduleLine` (L1/L2). */
export const OUTPUTS = [
  {
    label: 'core',
    path: join(REPO_ROOT, 'packages/core/src/security/scanner/SecurityScanner.weak-passwords.ts'),
    moduleLine: '@module @skillsmith/core/security/scanner/SecurityScanner.weak-passwords',
  },
  {
    label: 'node-edge',
    path: join(REPO_ROOT, 'scripts/indexer/_shared/security-scanner-edge.weak-passwords.ts'),
    moduleLine: '@module scripts/indexer/_shared/security-scanner-edge.weak-passwords (Node port)',
  },
  {
    label: 'deno-edge',
    path: join(REPO_ROOT, 'supabase/functions/_shared/security-scanner-edge.weak-passwords.ts'),
    moduleLine: '@module _shared/security-scanner-edge.weak-passwords',
  },
]

/** SHA-256 hex digest of a Buffer or string. */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Render `str` as a single-quoted JS string literal, matching this repo's
 * Prettier config (`.prettierrc`'s `singleQuote: true`) — used instead of
 * `JSON.stringify` (which always double-quotes) so raw generator output is
 * ALREADY a Prettier fixed point.
 *
 * Load-bearing: `.prettierignore` excludes `supabase/functions/` entirely
 * (git-crypt ciphertext can't be parsed when locked), so the Deno-edge copy
 * is NEVER reformatted by the pre-commit `prettier --write` step that the
 * other two copies (`packages/core`, `scripts/indexer`) go through. Emitting
 * `JSON.stringify`'s double quotes here would make the Deno copy silently
 * diverge from the other two on every regeneration + normal commit — this
 * is exactly what happened once already (SMI-6441 Wave 1 post-review fix)
 * and is not a one-time bug to hand-patch, but a raw-output invariant this
 * function exists to hold permanently.
 */
export function singleQuoteJs(str) {
  return `'${str.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * Verify every vendored file recorded in `sourcesObj.files` against its
 * recorded sha256, via the injected `readVendoredFile(name) -> Buffer`.
 * Hard-fails on the first mismatch — a tampered or partially-written
 * snapshot must never silently regenerate the lexicon.
 */
export function verifySourcesIntegrity(sourcesObj, readVendoredFile) {
  for (const entry of sourcesObj.files) {
    const bytes = readVendoredFile(entry.file)
    const actual = sha256Hex(bytes)
    if (actual !== entry.sha256) {
      throw new Error(
        `SOURCES.json integrity check failed for ${entry.file}: expected sha256 ${entry.sha256}, got ` +
          `${actual}. The vendored snapshot may be tampered or partially written — re-vendor from the ` +
          `pinned commit (${entry.commit}) and update SOURCES.json, or investigate before proceeding.`
      )
    }
  }
}

/**
 * Truncate the raw vendored snapshot to its first `limit` lines (rank-order
 * cut) — MUST run before any shape filtering (M-2a). The upstream file is
 * frequency-rank-ordered, most common password first, so this keeps the
 * most-common half and drops the least-common half; it is not an arbitrary
 * sample. `lines.slice(0, limit)` so a reviewer can reproduce the cut by
 * hand with `sed -n '1,Np'` on the vendored file.
 */
export function truncateToRankLimit(rawText, limit = SOURCE_RANK_LIMIT) {
  return rawText.split('\n').slice(0, limit).join('\n')
}

/** Lowercase, `/^[a-z]{3,19}$/`-shaped, deduped tokens from a snapshot's raw text. */
export function filterShapeTokens(rawText) {
  const set = new Set()
  for (const line of rawText.split('\n')) {
    const t = line.trim().toLowerCase()
    if (SHAPE_RE.test(t)) set.add(t)
  }
  return set
}

/** Whitespace-separated lowercase tokens from a keeplist file's text; `#` starts a comment. */
export function parseKeeplist(text) {
  const set = new Set()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0]
    for (const tok of line.trim().split(/\s+/)) {
      if (tok) set.add(tok.toLowerCase())
    }
  }
  return set
}

/**
 * Parse the PROSE_STOPWORDS Set literal out of
 * SecurityScanner.prose-lexicon.ts's source text without importing it —
 * this generator has zero dependencies and no build step (see file header).
 */
export function parseProseStopwords(tsSource) {
  const anchor = 'export const PROSE_STOPWORDS = new Set(['
  const start = tsSource.indexOf(anchor)
  if (start === -1) {
    throw new Error(`PROSE_STOPWORDS anchor not found in ${PROSE_LEXICON_PATH}`)
  }
  const bodyStart = start + anchor.length
  const end = tsSource.indexOf('])', bodyStart)
  if (end === -1) {
    throw new Error(`PROSE_STOPWORDS closing "])" not found in ${PROSE_LEXICON_PATH}`)
  }
  const body = tsSource.slice(bodyStart, end)
  const re = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g
  const set = new Set()
  let m
  while ((m = re.exec(body)) !== null) {
    set.add(m[1] !== undefined ? m[1] : m[2])
  }
  return set
}

/** `shapeTokens` minus `keeplist`, as a new Set. */
export function subtractKeeplist(shapeTokens, keeplist) {
  const out = new Set()
  for (const t of shapeTokens) if (!keeplist.has(t)) out.add(t)
  return out
}

/**
 * PROSE_STOPWORDS disjointness — a hard-fail INVARIANT check, not a silent
 * subtraction (§ item 2). Returns the sorted list of colliding tokens
 * (empty if none).
 */
export function findStopwordCollisions(entries, proseStopwords) {
  const out = []
  for (const t of entries) if (proseStopwords.has(t)) out.push(t)
  return out.sort()
}

/**
 * Encoding-safety invariant (M-1), asserted INDEPENDENTLY of the shape
 * regex so a later-widened shape regex cannot silently drop this
 * guarantee. A backtick, backslash, or `$` in an entry could terminate or
 * open a substitution inside the untagged template literal the payload is
 * emitted into.
 */
export function findEncodingUnsafeEntries(entries) {
  const out = []
  for (const t of entries) if (ENCODING_UNSAFE_RE.test(t)) out.push(t)
  return out.sort()
}

/** Hard-fail if `count` is outside `[min, max]` (default the module constants). */
export function assertEntryCountInRange(count, min = MIN_ENTRIES, max = MAX_ENTRIES) {
  if (count < min || count > max) {
    throw new Error(
      `entry count ${count} is outside the sanity bound [${min}, ${max}]. A count below the floor usually ` +
        'means a filtering bug silently emptied the lexicon (the exact "silently disabled detector" ' +
        'failure this gate exists to catch); a count above the ceiling usually means the vendored ' +
        'snapshot or the keeplist changed significantly. Do not raise this bound without a new ' +
        'plan-review round — it was set deliberately (SMI-6441 M-2) against the ' +
        `${MAX_EMITTED_LINES}-line emitted-file budget.`
    )
  }
}

/** Wrap sorted, space-joined tokens at `width` columns for the template-literal payload. */
export function wrapPayload(sortedEntries, width = WRAP_WIDTH) {
  const lines = []
  let current = ''
  for (const tok of sortedEntries) {
    if (current === '') {
      current = tok
    } else if (current.length + 1 + tok.length <= width) {
      current += ' ' + tok
    } else {
      lines.push(current)
      current = tok
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

/**
 * Run every gate and return the final sorted entry array. Throws (does not
 * silently degrade) on the first violated invariant. `sourceRankLimit`
 * defaults to the real SOURCE_RANK_LIMIT constant; tests pass a smaller
 * value to exercise the truncation boundary against small fixtures.
 */
export function computeLexicon({
  snapshotText,
  keeplistText,
  proseLexiconText,
  sourceRankLimit = SOURCE_RANK_LIMIT,
}) {
  const truncated = truncateToRankLimit(snapshotText, sourceRankLimit)
  const shapeTokens = filterShapeTokens(truncated)
  const keeplist = parseKeeplist(keeplistText)
  const proseStopwords = parseProseStopwords(proseLexiconText)
  const afterKeeplist = subtractKeeplist(shapeTokens, keeplist)

  const collisions = findStopwordCollisions(afterKeeplist, proseStopwords)
  if (collisions.length > 0) {
    throw new Error(
      `PROSE_STOPWORDS disjointness violated by: ${collisions.join(', ')}. A token cannot simultaneously ` +
        'be prose evidence and credential evidence. Fixed remediation (do not improvise): add each ' +
        'colliding token to data/wordlists/doc-vocab-keeplist.txt with a comment naming the collision, ' +
        'then re-run. Do not edit PROSE_STOPWORDS and do not weaken this gate.'
    )
  }

  const unsafe = findEncodingUnsafeEntries(afterKeeplist)
  if (unsafe.length > 0) {
    throw new Error(
      'entries contain a backtick, backslash, or "$", which would be unsafe inside the untagged ' +
        `template-literal encoding (SMI-6441 M-1): ${unsafe.join(', ')}. This should be structurally ` +
        'impossible under the current shape filter — investigate the shape regex before proceeding.'
    )
  }

  const entries = [...afterKeeplist].sort()
  assertEntryCountInRange(entries.length)
  return entries
}

/** Render one of the three generated modules (see OUTPUTS for `moduleLine` values). */
export function renderModule({ moduleLine, source, version, payloadLines }) {
  const payload = payloadLines.join('\n')
  const header = [
    '/**',
    ' * SMI-6441: generated common-password lexicon for the `sensitive_path`',
    " * MF-4b veto (Wave 2). Vetoes MF-4's 2-token documentation-label",
    ' * carve-out when one of the tokens is a known common password.',
    ` * ${moduleLine}`,
    ' * @generated DO NOT EDIT — produced by scripts/gen-weak-password-lexicon.mjs',
    ' * from data/wordlists/{seclists-xato-top-10000.txt,doc-vocab-keeplist.txt}.',
    ' * Regenerate with `npm run lexicon:weak-passwords`; verify freshness with',
    ' * `npm run lexicon:weak-passwords:check`. A hand edit here is overwritten',
    ' * on the next --write and is caught by the L3 --check gate before merge.',
    ' *',
    ' * SECURITY-RELEVANT DUPLICATION (ADR-137 Decision point 4): this file is',
    ' * one of three byte-identical-modulo-@module copies of the same',
    ' * generated payload —',
    ' *   packages/core/src/security/scanner/SecurityScanner.weak-passwords.ts',
    ' *   scripts/indexer/_shared/security-scanner-edge.weak-passwords.ts',
    ' *   supabase/functions/_shared/security-scanner-edge.weak-passwords.ts',
    ' * A silent divergence between these three is a SECURITY GAP, not a',
    ' * cosmetic inconsistency: this data decides whether a `sensitive_path`',
    ' * finding is HIGH or MEDIUM (quarantine vs. pass on the weekly scan',
    ' * surface; blocked vs. permitted install). Enforced by three parity',
    ' * layers: L1 Deno<->Node byte identity',
    " * (scripts/tests/indexer/security-scanner-edge.test.ts's",
    ' * PATHS_FAMILY_TWINS), L2 three-way literal payload identity',
    " * (scripts/tests/indexer/parity-utils.ts's extractGeneratedPayload),",
    ' * and L3 freshness/anti-hand-edit (`npm run lexicon:weak-passwords:check`,',
    ' * wired into scripts/audit-standards.mjs).',
    ' *',
    ' * Source: SecLists (MIT license) — see data/wordlists/LICENSE-SecLists',
    ' * and WEAK_PASSWORD_LEXICON_SOURCE below for exact provenance.',
    ' *',
    ' * Full design: docs/internal/implementation/smi-6441-weak-password-veto.md',
    ' * See also: docs/internal/adr/149-generated-scanner-data-veto-severity-model.md',
    ' * and docs/internal/adr/137-cross-runtime-duplication-of-security-logic.md',
    ' */',
    '',
    '/** Provenance of the vendored upstream snapshot this file was generated from. */',
    'export const WEAK_PASSWORD_LEXICON_SOURCE = {',
    `  upstream: ${singleQuoteJs(source.upstream)},`,
    `  path: ${singleQuoteJs(source.path)},`,
    `  license: ${singleQuoteJs(source.license)},`,
    `  commit: ${singleQuoteJs(source.commit)},`,
    `  sha256: ${singleQuoteJs(source.sha256)},`,
    `  sourceRankLimit: ${source.sourceRankLimit},`,
    `  entries: ${source.entries},`,
    '} as const',
    '',
    '/** Bumped whenever the emitted entry set changes. Deterministic, no timestamp. */',
    `export const WEAK_PASSWORD_LEXICON_VERSION = ${singleQuoteJs(version)} as const`,
    '',
    '/**',
    ' * Lowercase-alphabetic common-password tokens, 3-19 chars, sorted, with the',
    ' * documentation vocabulary subtracted at generation time. Exact membership',
    " * by design (see the ADR): the veto's failure direction is a false positive",
    ' * on ordinary documentation, so an approximate structure is not acceptable here.',
    ' */',
    'export const COMMON_WEAK_PASSWORDS: ReadonlySet<string> = new Set(',
    '  `' + payload + '`',
    '    .split(/\\s+/)',
    '    .filter(Boolean)',
    ')',
    '',
  ]
  return header.join('\n')
}

/** Hard-fail if `text` exceeds the emitted-file line budget. */
export function assertEmittedLineBudget(text, label) {
  const lineCount = text.split('\n').length
  if (lineCount > MAX_EMITTED_LINES) {
    throw new Error(
      `${label}: emitted file is ${lineCount} lines, over the ${MAX_EMITTED_LINES}-line pre-commit ` +
        'hard-fail budget (scripts/file-length-policy.mjs). This means the source list grew past what ' +
        '120-column wrapping can fit — the fix is the front-coding/prefix-compression lever named in ' +
        'the plan doc (docs/internal/implementation/smi-6441-weak-password-veto.md § item 1), NOT ' +
        'raising this line budget and NOT adding this file to scripts/check-file-length.ignore (that ' +
        "file's own header forbids new entries without a split follow-up, and a generated file is " +
        'exactly the wrong candidate for a grandfather exemption).'
    )
  }
  return lineCount
}

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
