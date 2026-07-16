/**
 * SMI-4703 Wave 1 §2 — memory-write injection/poisoning scanner.
 *
 * The ONLY doc-retrieval-mcp adapter that reads unattended, agent-authored
 * content is `memory-topic-files` (`~/.claude/projects/<cwd>/memory/*.md`) —
 * every other adapter's content reaches the corpus via a human-reviewed PR
 * merge (a real trust boundary already exists there by construction). This
 * module is the injection/poisoning detector that gates
 * `memory-topic-files`'s chunks between `'tier-a'` and `'quarantine'`
 * (`ProvenanceTier`, `../types.js`).
 *
 * Design (plan doc §2, `docs/internal/implementation/smi-4703-memory-trust-boundary.md`):
 *
 * 1. Normalize the raw chunk text through a FIXED pipeline (order matters —
 *    later steps assume earlier ones ran): invisible-strip -> entity-decode
 *    -> NFKC -> confusable-fold -> blockquote-strip -> bounded single-line
 *    join. Steps 1 (invisible-strip) and 4 (confusable-fold) reuse
 *    `stripInvisible`/`confusableSkeleton` from
 *    `@skillsmith/core/security/scanner` (the same primitives
 *    `SecurityScanner.exec.ts` uses for `obfuscated_directive`) — NOT
 *    reimplemented here.
 * 2. Run 8 detection rules against the normalized text. Rules 1-5 reuse the
 *    already-tested `SecurityScanner` pattern families (`JAILBREAK_PATTERNS`,
 *    `PROMPT_LEAKING_PATTERNS`, `SOCIAL_ENGINEERING_PATTERNS`,
 *    `DATA_EXFILTRATION_PATTERNS`, `PRIVILEGE_ESCALATION_PATTERNS`) by direct
 *    import. Rules 6-8 are new: role-spoofing markers, comment-concealed
 *    directives, and single-layer-encoded-payload detection.
 * 3. Fail-closed defaults (stated Wave 1 limitations, not silently solved):
 *    non-English-dominant text and nested/arbitrary encoding (beyond one
 *    decode layer) both force `quarantine` regardless of rule outcome.
 *
 * Any rule match (or a fail-closed default) yields `tier: 'quarantine'`; a
 * clean scan yields `tier: 'tier-a'`.
 */

import {
  JAILBREAK_PATTERNS,
  PROMPT_LEAKING_PATTERNS,
  SOCIAL_ENGINEERING_PATTERNS,
  DATA_EXFILTRATION_PATTERNS,
  PRIVILEGE_ESCALATION_PATTERNS,
  stripInvisible,
  confusableSkeleton,
  safeRegexCheck,
} from '@skillsmith/core/security/scanner'
import type { ProvenanceTier } from '../types.js'

export interface MemoryScanResult {
  tier: ProvenanceTier
  /** Rule ids that fired, or a fail-closed-default marker. Empty when clean. */
  matchedRules: string[]
}

// Bounded single-line join cap (plan §2.1 step 6) — keeps the joined text
// well under SecurityScanner's own MAX_LINE_LENGTH_FOR_REGEX (10000), so
// `safeRegexCheck`'s truncation never engages here.
const MAX_NORMALIZED_LENGTH = 2000

// ============================================================================
// Normalization pipeline (plan §2.1) — order matters, do not reorder.
// ============================================================================

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g

/**
 * Decode HTML/XML numeric (decimal + hex) and a small named-entity set.
 * Bypass this defeats (plan §2.1 step 2): an entity-encoded zero-width
 * character (e.g. `&#x200b;`) survives a strip-then-scan that doesn't
 * decode entities first — decoding BEFORE the invisible-strip-adjacent
 * NFKC/confusable steps closes that gap.
 */
function decodeEntities(s: string): string {
  return s.replace(ENTITY_PATTERN, (match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X'
      const codeStr = isHex ? entity.slice(2) : entity.slice(1)
      const code = parseInt(codeStr, isHex ? 16 : 10)
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code)
        } catch {
          return match
        }
      }
      return match
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

/** Strip leading markdown blockquote markers (`>`, `>>`, ...) per line. */
function stripBlockquoteMarkers(s: string): string {
  return s
    .split('\n')
    .map((line) => line.replace(/^\s*>+\s?/, ''))
    .join('\n')
}

/**
 * Collapse all whitespace runs (including newlines) to a single space and
 * cap length. Defeats a directive split across a hard line-wrap, which
 * would otherwise fail a single-line pattern's `\s+` expectations.
 */
function joinBounded(s: string, cap: number): string {
  const joined = s.replace(/\s+/g, ' ').trim()
  return joined.length > cap ? joined.slice(0, cap) : joined
}

/**
 * Steps 1-3 of the pipeline (invisible-strip, entity-decode, NFKC), plus a
 * SECOND invisible-strip pass. Split out from `normalizeForScan` so
 * `scanMemoryChunk` can run the non-English-dominant check (below) against
 * this PRE-confusable-fold snapshot — see that check's doc comment for why
 * fold must not have run yet.
 *
 * The second `stripInvisible` pass exists because decoding an entity can
 * MATERIALIZE a new invisible character (e.g. `&#x200b;` decodes to an
 * actual zero-width space) that the first strip pass — which ran before any
 * entity existed as a real codepoint — could not have removed. Without this
 * second pass, an entity-encoded invisible character would survive the
 * whole pipeline untouched, splitting a keyword apart in the final
 * normalized text exactly the way the plan's §2.1 step-2 bypass describes.
 * Idempotent on already-clean text.
 */
function preFoldNormalize(raw: string): string {
  let s = stripInvisible(raw)
  s = decodeEntities(s)
  s = stripInvisible(s)
  s = s.normalize('NFKC')
  return s
}

/** Steps 4-6 of the pipeline (confusable-fold, blockquote-strip, join). */
function applyFoldAndJoin(s: string): string {
  let out = confusableSkeleton(s)
  out = stripBlockquoteMarkers(out)
  out = joinBounded(out, MAX_NORMALIZED_LENGTH)
  return out
}

/**
 * Run the full 6-step normalization pipeline (plan §2.1). Exported for
 * direct unit testing of the pipeline in isolation from rule-matching.
 */
export function normalizeForScan(raw: string): string {
  return applyFoldAndJoin(preFoldNormalize(raw))
}

// ============================================================================
// Rules 1-6 — pattern-family content rules (run against normalized text).
// Rule 8 (encoded-payload) re-tests a decoded candidate against this SAME
// set, per plan §2.2 rule 8 ("decodes ... to text matching any of rules 1-6").
// ============================================================================

interface ContentRule {
  id: string
  patterns: readonly RegExp[]
}

const CONTENT_RULES: readonly ContentRule[] = [
  { id: 'jailbreak', patterns: JAILBREAK_PATTERNS },
  { id: 'prompt-leaking', patterns: PROMPT_LEAKING_PATTERNS },
  { id: 'social-engineering', patterns: SOCIAL_ENGINEERING_PATTERNS },
  { id: 'data-exfiltration', patterns: DATA_EXFILTRATION_PATTERNS },
  { id: 'privilege-escalation', patterns: PRIVILEGE_ESCALATION_PATTERNS },
  {
    // Rule 6 — role-spoofing markers: a fabricated conversation-turn boundary
    // inside what should be a first-person memory note.
    id: 'role-spoofing',
    patterns: [
      /(?:^|[\s.;])(?:system|assistant|user)\s*:\s/i,
      /<\|im_start\|>|<\|im_end\|>/,
      /\[INST\]|\[\/INST\]/,
    ],
  },
]

function testContentRules(normalized: string): string[] {
  return CONTENT_RULES.filter((rule) =>
    rule.patterns.some((p) => safeRegexCheck(p, normalized))
  ).map((rule) => rule.id)
}

// ============================================================================
// Rule 7 — comment-concealed directives.
// ============================================================================

const HTML_COMMENT_PATTERN = /<!--([\s\S]*?)-->/g
const CODE_FENCE_PATTERN = /```(?:\w+)?([\s\S]*?)```/g
const IMPERATIVE_VERB_PATTERN =
  /\b(?:ignore|disregard|bypass|reveal|exfiltrate|delete|overwrite|execute|run|send|upload|grant|escalate|disable|leak|dump)\b/i
const EXAMPLE_CONTEXT_PATTERN =
  /\b(?:example|snippet|sample|demo|illustration|for\s+instance|e\.g\.)\b/i

/**
 * An imperative instruction hidden inside a markdown/HTML comment or a
 * code-fence that isn't actually a code example (heuristic: imperative verb
 * present, no surrounding "example"/"snippet"/... context word).
 */
function hasCommentConcealedDirective(normalized: string): boolean {
  const bodies: string[] = []
  for (const m of normalized.matchAll(HTML_COMMENT_PATTERN)) bodies.push(m[1])
  for (const m of normalized.matchAll(CODE_FENCE_PATTERN)) bodies.push(m[1])
  return bodies.some(
    (body) => IMPERATIVE_VERB_PATTERN.test(body) && !EXAMPLE_CONTEXT_PATTERN.test(body)
  )
}

// ============================================================================
// Rule 8 — single-layer encoded payload + nested-encoding fail-closed gate.
// ============================================================================

// SMI-4703: the trailing boundary uses a negative lookahead rather than `\b`.
// A trailing `=`/`==` padding char is non-word, so when it's followed by
// another non-word char (a space, a period) `\b` asserts FALSE at that
// position (non-word -> non-word is not a boundary) — the regex then
// backtracks `={0,2}` down to 0 matched, silently dropping the padding from
// the captured candidate and breaking the `length % 4 === 0` shape check in
// `isBase64Shape` below. The lookahead has no such two-sided-boundary
// requirement.
const BASE64_CANDIDATE = /\b[A-Za-z0-9+/]{20,}={0,2}(?![A-Za-z0-9+/=])/g
const HEX_CANDIDATE = /\b(?:[0-9a-fA-F]{2}){10,}\b/g
const URL_ENCODED_CANDIDATE = /(?:%[0-9a-fA-F]{2}){5,}/g

function extractEncodedCandidates(s: string): string[] {
  const out: string[] = []
  for (const pattern of [BASE64_CANDIDATE, HEX_CANDIDATE, URL_ENCODED_CANDIDATE]) {
    for (const m of s.matchAll(pattern)) out.push(m[0])
  }
  return out
}

function isBase64Shape(s: string): boolean {
  return s.length >= 16 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)
}

function isHexShape(s: string): boolean {
  return s.length >= 20 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)
}

/** Ratio of printable-ASCII/whitespace bytes — a cheap "is this real text" gate. */
function isPrintable(s: string): boolean {
  if (s.length === 0) return false
  let printable = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if ((cp >= 0x20 && cp <= 0x7e) || cp === 0x09 || cp === 0x0a || cp === 0x0d) printable++
  }
  return printable / s.length >= 0.85
}

/** Attempt exactly one decode layer (base64, then hex, then URL-encoding). */
function decodeOneLayer(candidate: string): string | null {
  if (isBase64Shape(candidate)) {
    try {
      const decoded = Buffer.from(candidate, 'base64').toString('utf8')
      if (isPrintable(decoded)) return decoded
    } catch {
      // fall through to the next encoding
    }
  }
  if (isHexShape(candidate)) {
    try {
      const decoded = Buffer.from(candidate, 'hex').toString('utf8')
      if (isPrintable(decoded)) return decoded
    } catch {
      // fall through
    }
  }
  if (candidate.includes('%')) {
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded !== candidate && isPrintable(decoded)) return decoded
    } catch {
      // malformed % sequence — not URL-encoded
    }
  }
  return null
}

/**
 * True when a large fraction of `s` is itself made up of encoded-looking
 * runs — i.e. a one-level decode landed on text that still looks encoded.
 * This is the "nested/arbitrary encoding" signal (plan §2.3 stated
 * limitation): rather than attempt a second decode layer, treat this as
 * fail-closed and quarantine unconditionally.
 */
function looksStillEncoded(s: string): boolean {
  const candidates = extractEncodedCandidates(s)
  if (candidates.length === 0) return false
  const covered = candidates.reduce((sum, c) => sum + c.length, 0)
  return covered / Math.max(s.length, 1) >= 0.6
}

interface EncodedPayloadResult {
  matched: boolean
  nested: boolean
}

function scanEncodedPayloads(normalized: string): EncodedPayloadResult {
  let matched = false
  let nested = false
  for (const candidate of extractEncodedCandidates(normalized)) {
    const decoded = decodeOneLayer(candidate)
    if (decoded === null) continue
    if (looksStillEncoded(decoded)) {
      nested = true
      continue
    }
    if (testContentRules(decoded).length > 0) matched = true
  }
  return { matched, nested }
}

// ============================================================================
// Non-English-dominant fail-closed gate (plan §2.3 stated limitation).
// ============================================================================

const ANY_LETTER_PATTERN = /\p{L}/gu
const LATIN_LETTER_PATTERN = /[A-Za-z]/g
const MIN_LETTERS_FOR_SCRIPT_CHECK = 20
const NON_LATIN_DOMINANCE_THRESHOLD = 0.5

/**
 * The rule patterns above are English-language. A chunk whose dominant
 * script is non-Latin (and thus not meaningfully assessable by them)
 * defaults to quarantine regardless of scan result — fail-closed, not
 * fail-open.
 *
 * MUST be called against the PRE-confusable-fold snapshot
 * (`preFoldNormalize`'s output), not the final fully-normalized text.
 * `CONFUSABLES` intentionally covers exactly the Cyrillic/Greek letters
 * MOST COMMON in real prose (Cyrillic а/е/о/р/с/у are among the most
 * frequent letters in Russian; Greek α/ε/ο/τ/ι likewise) — that's what
 * makes them effective homoglyphs. Running this check AFTER fold empirically
 * misclassifies genuine Cyrillic/Greek prose as Latin-dominant (fold maps
 * roughly two-thirds of a real Russian sentence's letters to Latin,
 * dropping it well under the threshold below) — the opposite of fail-closed.
 * Checking pre-fold avoids that: a genuine non-English chunk is still
 * overwhelmingly non-Latin-lettered before any folding, while a homoglyph
 * ATTACK (a handful of look-alikes spliced into an otherwise-Latin word)
 * stays Latin-dominant pre-fold too, so it isn't misrouted to this
 * fail-closed path instead of being caught by the actual matching rule
 * after fold.
 */
function isDominantNonLatin(preFold: string): boolean {
  const letters = preFold.match(ANY_LETTER_PATTERN) ?? []
  if (letters.length < MIN_LETTERS_FOR_SCRIPT_CHECK) return false
  const latinCount = (preFold.match(LATIN_LETTER_PATTERN) ?? []).length
  const nonLatinRatio = 1 - latinCount / letters.length
  return nonLatinRatio > NON_LATIN_DOMINANCE_THRESHOLD
}

// ============================================================================
// Orchestration
// ============================================================================

/**
 * Scan a single memory-topic-file chunk's text and return its provenance
 * tier. Any rule match, or either fail-closed default (non-English-dominant,
 * nested encoding), yields `'quarantine'`; a clean scan yields `'tier-a'`.
 */
export function scanMemoryChunk(rawText: string): MemoryScanResult {
  const preFold = preFoldNormalize(rawText)

  // Script-dominance check runs BEFORE confusable-fold — see
  // isDominantNonLatin's doc comment for why fold must not have run yet.
  if (isDominantNonLatin(preFold)) {
    return { tier: 'quarantine', matchedRules: ['non-english-fail-closed'] }
  }

  const normalized = applyFoldAndJoin(preFold)
  const matchedRules = testContentRules(normalized)

  if (hasCommentConcealedDirective(normalized)) {
    matchedRules.push('comment-concealed-directive')
  }

  const encoded = scanEncodedPayloads(normalized)
  if (encoded.nested) {
    return {
      tier: 'quarantine',
      matchedRules: [...matchedRules, 'nested-encoding-fail-closed'],
    }
  }
  if (encoded.matched) {
    matchedRules.push('encoded-payload-directive')
  }

  return {
    tier: matchedRules.length > 0 ? 'quarantine' : 'tier-a',
    matchedRules,
  }
}
