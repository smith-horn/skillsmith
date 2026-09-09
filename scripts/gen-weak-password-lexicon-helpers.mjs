// SMI-6441: pure functions, constants, and shared config for the
// weak-password lexicon generator — split out of gen-weak-password-lexicon.mjs
// to stay under this repo's 500-line file-length policy. This file has zero
// imports from the sibling CLI/orchestration module — it is the leaf module
// so it can never form a circular import.
//
// See gen-weak-password-lexicon.mjs for the CLI entry point, orchestration
// (loadGeneratorInputs / generateAll / detectDrift), and the full design
// doc: docs/internal/implementation/smi-6441-weak-password-veto.md

import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(__dirname, '..')

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
