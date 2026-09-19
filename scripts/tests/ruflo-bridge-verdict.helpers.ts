/**
 * SMI-6772 — shared, directly-testable pieces of ruflo-bridge-verdict.test.ts's
 * predicate-source-drift guard. Split out so the guard's own describe block
 * and this repo's unit tests share ONE implementation instead of two copies
 * drifting apart, and so ruflo-bridge-verdict.test.ts stays under the repo's
 * 500-line file gate (CLAUDE.md: "split into foo.helpers.ts").
 */
import type { Probe } from './_lib/probe-path.js'

/**
 * Matches a `backend:`-shaped object-property site, key optionally quoted.
 * It runs over raw source; a match counts as a site only when its colon
 * is code by `maskedPositions` (SMI-6781, PR #2900 gate round 4: a
 * `backend:` inside a string, template or comment used to count, so a
 * vanished real site could be masked by same-shaped quoted text with the
 * exact expected counts). The colon, not the match start, is the test: a
 * string whose CONTENT begins with `backend` starts its match at the
 * string's own opening quote, which is code, and only the colon tells it
 * from a quoted key. Module-private on purpose (governance on 8edd4fcef,
 * F8): a `/g` regex carries `lastIndex`, and one `.test()` by an outside
 * consumer would make the next `matchAll` here start mid-source and
 * silently halve the site count -- the exact quiet shrink the drift
 * guard's exact-count assertion exists to catch.
 */
const BACKEND_SITE_RE = /(?<![A-Za-z0-9_$.])["']?backend["']?\s*:\s*/g

/**
 * The CONTENT of a fully-static string literal: lowercase letters/hyphens
 * only, the enum's own character set. Tested against the inside of a quoted
 * region that `tokenizeSpan` has already delimited -- never against raw
 * span text. SMI-6772 F8 made the extractor quote-style-agnostic (a
 * single-quote-only regex let `"gpu"` vanish from `found` beside two
 * single-quoted arms); the governance round on f8134e340 then found that a
 * regex over the raw span ignores escapes, so `'a\'b'` matched at the
 * escaped quote and yielded a phantom `'b'`. A template literal's `${`
 * fails this class, so a dynamic arm is never miscounted as a literal.
 */
const STATIC_LITERAL_RE = /^[a-z-]+$/

interface QuotedRegion {
  /** Raw source between the quotes, escapes untouched. */
  content: string
  /** False when the span ended before the closing quote was seen. */
  terminated: boolean
}

interface SpanTokens {
  regions: QuotedRegion[]
  /**
   * The span with every quoted region collapsed to a single `'` marker and
   * every unquoted character kept in place -- the string the ternary
   * grammar below is checked against. A quote character can never occur in
   * unquoted text (it would have opened a region), so the marker cannot
   * collide with content.
   */
  shape: string
}

/** The three characters that open a string literal in JavaScript source. */
function isQuote(ch: string): boolean {
  return ch === "'" || ch === '"' || ch === '`'
}

/**
 * One step of the string sub-machine, taken while inside a string that
 * `quote` opened. The character at `i` is consumed; a backslash consumes
 * the next character too, so an escaped quote is content and an escaped
 * backslash does not close the string on the quote that follows it; the
 * matching quote closes the string. Returns the index of the last consumed
 * character and whether the string closed there. Both tokenizeSpan and
 * scanBackendSites's span bounder take their steps here (governance on
 * 8edd4fcef, F4: they used to carry textually identical copies), so the
 * escape rule exists in exactly one place and the two cannot disagree
 * about where a string ends.
 */
function stepInsideString(s: string, i: number, quote: string): { last: number; closed: boolean } {
  if (s[i] === '\\') return { last: i + 1, closed: false }
  return { last: i, closed: s[i] === quote }
}

/**
 * A content map of `src`: `masked[i]` is 1 when `src[i]` is string or
 * template CONTENT (between the delimiters) or part of a line (`//`) or
 * block comment (delimiters included), 0 for everything else. The site
 * regex runs over the ORIGINAL source and consults this map at exactly one
 * position, its colon, so the string delimiters' own status is immaterial
 * (a mutation that masks them survives every test, and rightly: it changes
 * no verdict); they are left at 0 only so the map reads as "content".
 * String state is consulted before a comment opener is looked for, so a
 * URL's `//` or a `/*` inside a string starts nothing. Steps inside strings come from
 * stepInsideString, the same step the value scan uses. Not modelled, and
 * stated rather than implied: a regular-expression literal. One that
 * contains a quote or a comment opener desyncs this map from that point
 * on, in the loud direction -- sites vanish or appear and the drift
 * guard's exact site count fails -- never as a silent same-count mask. A
 * block comment left open masks to the end of the source, also loud.
 * Measured against a twenty-four-shape case table on the host before it
 * was written here.
 */
function maskedPositions(src: string): Uint8Array {
  const masked = new Uint8Array(src.length)
  let quote: string | null = null
  let comment: 'none' | 'line' | 'block' = 'none'
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quote !== null) {
      const step = stepInsideString(src, i, quote)
      if (step.closed) {
        quote = null
        continue
      }
      for (let k = i; k <= Math.min(step.last, src.length - 1); k++) masked[k] = 1
      i = step.last
      continue
    }
    if (comment === 'line') {
      if (ch === '\n') comment = 'none'
      else masked[i] = 1
      continue
    }
    if (comment === 'block') {
      masked[i] = 1
      if (ch === '*' && src[i + 1] === '/') {
        masked[i + 1] = 1
        i++
        comment = 'none'
      }
      continue
    }
    if (isQuote(ch)) {
      quote = ch
      continue
    }
    if (ch === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      comment = src[i + 1] === '/' ? 'line' : 'block'
      masked[i] = 1
      masked[i + 1] = 1
      i++
    }
  }
  return masked
}

/**
 * One escape-aware walk over a value span, feeding both the shape check
 * and literal extraction. A span that ends inside a string yields an
 * unterminated region (its marker still lands in `shape`), which the
 * caller must treat as unrecognised: a truncated read is not evidence
 * about the value.
 */
function tokenizeSpan(span: string): SpanTokens {
  const regions: QuotedRegion[] = []
  let shape = ''
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < span.length; i++) {
    const ch = span[i]
    if (quote !== null) {
      const step = stepInsideString(span, i, quote)
      if (step.closed) {
        regions.push({ content: span.slice(start, i), terminated: true })
        shape += "'"
        quote = null
      }
      i = step.last
      continue
    }
    if (isQuote(ch)) {
      quote = ch
      start = i + 1
    } else shape += ch
  }
  if (quote !== null) {
    regions.push({ content: span.slice(start), terminated: false })
    shape += "'"
  }
  return { regions, shape }
}

export interface BackendScan {
  sites: number
  found: string[]
  incomplete: number
}

/**
 * Scans `src` for every `backend:` site and the literal value(s) each
 * site's bounded span contains. Each value span is bounded at the first
 * `,`, `;`, `}`, `)` or `]` at brace/paren depth 0, with quoted spans
 * opaque (a `,` or `}` inside a string does not end the value) -- so a
 * ternary arm or a multi-line call argument is read whole.
 */
export function scanBackendSites(src: string): BackendScan {
  const found = new Set<string>()
  let sites = 0
  let incomplete = 0
  const masked = maskedPositions(src)
  for (const m of src.matchAll(BACKEND_SITE_RE)) {
    // SMI-6781: a match whose colon is string, template or comment content
    // is text about a site, not a site.
    if (masked[(m.index ?? 0) + m[0].indexOf(':')]) continue
    sites++
    const start = (m.index ?? 0) + m[0].length
    let depth = 0
    let quote: string | null = null
    let end = start
    for (; end < src.length; end++) {
      const ch = src[end]
      if (quote !== null) {
        const step = stepInsideString(src, end, quote)
        if (step.closed) quote = null
        end = step.last
        continue
      }
      if (isQuote(ch)) quote = ch
      else if (ch === '(' || ch === '{' || ch === '[') depth++
      else if (ch === ')' || ch === '}' || ch === ']') {
        if (depth === 0) break
        depth--
      } else if ((ch === ',' || ch === ';') && depth === 0) break
    }
    const span = src.slice(start, end)
    const { regions, shape } = tokenizeSpan(span)
    // Governance on B1.2 (2026-09-19): a concatenation-built value such as
    // `'on' + 'nx'` used to be counted as two static literals ('on', 'nx')
    // instead of as dynamic. Governance on 8edd4fcef (F3) generalised the
    // rule from "a `+` outside every quoted region" to a character class;
    // PR #2900 gate round 3 then showed a class cannot tell an unquoted
    // ARM from a condition (`x ? 'mock' : y ? 'onnx' : fallback` read as
    // complete with the expected labels), so the rule is now the grammar
    // itself, checked positionally over `shape`: a bare literal, or a chain
    // of ternaries whose conditions are identifiers (with member or
    // optional-chain access) and whose arms are literals. Anything else --
    // a call, an index, `||`, `??`, `+`, a numeric or negated condition, an
    // unquoted arm, two adjacent literals -- is a computed value. This
    // path deliberately adds NOTHING to `found`: a computed value's quoted
    // operands are inputs to the computation ('on' + 'nx';
    // pick('mock','onnx')), not the value, so reporting them would name a
    // backend label that may never exist.
    if (!isLiteralOrTernaryShape(shape)) {
      incomplete++
      continue
    }
    // The grammar guarantees at least one region. Each is either a
    // recognised static literal or it is not; one unrecognised region (an
    // escaped quote, an interpolation, an upper-case label, an unterminated
    // string) marks the site incomplete even when another arm was
    // recognised -- otherwise that arm vanishes from the report with no
    // failure, the F8 shape again.
    let unrecognised = 0
    for (const r of regions) {
      if (r.terminated && STATIC_LITERAL_RE.test(r.content)) found.add(r.content)
      else unrecognised++
    }
    if (unrecognised > 0) incomplete++
  }
  return { sites, found: [...found].sort(), incomplete }
}

/**
 * SMI-6772 F7: the drift guard's original `it.skipIf(trees.length === 0)`
 * treated every zero-trees cause identically -- a genuinely absent npx
 * cache (a legitimate "nothing to check" skip) and a PRESENT cache whose
 * scan could not conclude anything (a dangling symlink, malformed or
 * BOM-prefixed JSON, an unscannable root, an unreachable entry) rendered as
 * the same skip. Only the first is legitimate; the second must fail
 * loudly, naming why, so a broken environment cannot masquerade as "ruflo
 * was never installed here".
 */
export interface DriftGuardState {
  root: Probe | 'unscannable'
  treesLength: number
  unreadable: number
  unreachable: number
}

export type DriftGuardOutcome = { skip: true } | { skip: false; fail: string | null }

export function resolveDriftGuardOutcome(state: DriftGuardState): DriftGuardOutcome {
  const scanIncomplete =
    state.root === 'unscannable' ||
    state.root === 'unreachable' ||
    state.unreadable > 0 ||
    state.unreachable > 0
  if (state.root === 'absent') return { skip: true }
  if (state.treesLength === 0 && !scanIncomplete) return { skip: true }
  if (scanIncomplete) {
    return {
      skip: false,
      fail:
        `_npx cache scan incomplete (root=${state.root}, unreadable=${state.unreadable}, ` +
        `unreachable=${state.unreachable}) -- cannot conclude no derived-from version is ` +
        `present, refusing to render this as a legitimate skip`,
    }
  }
  return { skip: false, fail: null }
}

/**
 * The two value shapes the scanner models, as a grammar over a span's
 * `shape` (every quoted region is a `'` marker): a bare literal, or a
 * chain of ternaries `COND ? ' : COND ? ' : ... : '` whose conditions are
 * identifiers with member (`a.b`) or optional-chain (`a?.b`) access and
 * whose arms are literals. PR #2900 gate round 3: the previous character
 * allowlist admitted `x ? 'mock' : y ? 'onnx' : fallback` as complete,
 * because identifier characters are needed in condition position and a
 * class cannot see position. Anything the grammar rejects is a computed
 * value: `+`, a call, an index, `||`, `??`, a comparison, a negation
 * (`!isMock ? ...` -- the loud direction, and no upstream site uses it), a
 * numeric or spread condition, an object literal, an unquoted arm, a
 * literal in condition position, two adjacent literals. Measured against
 * a thirty-shape case table before it was written here. A `+` inside a
 * template literal's `${...}` is not seen here -- the backtick region is
 * one marker -- and such a site is still incomplete, its region content
 * failing STATIC_LITERAL_RE.
 */
const IDENTIFIER = String.raw`[A-Za-z_$][A-Za-z0-9_$]*`
const CONDITION = `${IDENTIFIER}(?:\\??\\.${IDENTIFIER})*`
const LITERAL_OR_TERNARY_SHAPE_RE = new RegExp(`^\\s*(?:${CONDITION}\\s*\\?\\s*'\\s*:\\s*)*'\\s*$`)
function isLiteralOrTernaryShape(shape: string): boolean {
  return LITERAL_OR_TERNARY_SHAPE_RE.test(shape)
}
