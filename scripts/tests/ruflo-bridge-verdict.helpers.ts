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
 * Module-private on purpose (governance on 8edd4fcef, F8): a `/g` regex
 * carries `lastIndex`, and one `.test()` by an outside consumer would make
 * the next `matchAll` here start mid-source and silently halve the site
 * count -- the exact quiet shrink the drift guard's exact-count assertion
 * exists to catch.
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
  /** Every character outside a quoted region, in order. */
  unquoted: string
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
 * One escape-aware walk over a value span, feeding both computed-syntax
 * detection and literal extraction. A span that ends inside a string
 * yields an unterminated region, which the caller must treat as
 * unrecognised: a truncated read is not evidence about the value.
 */
function tokenizeSpan(span: string): SpanTokens {
  const regions: QuotedRegion[] = []
  let unquoted = ''
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < span.length; i++) {
    const ch = span[i]
    if (quote !== null) {
      const step = stepInsideString(span, i, quote)
      if (step.closed) {
        regions.push({ content: span.slice(start, i), terminated: true })
        quote = null
      }
      i = step.last
      continue
    }
    if (isQuote(ch)) {
      quote = ch
      start = i + 1
    } else unquoted += ch
  }
  if (quote !== null) regions.push({ content: span.slice(start), terminated: false })
  return { regions, unquoted }
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
  for (const m of src.matchAll(BACKEND_SITE_RE)) {
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
    const { regions, unquoted } = tokenizeSpan(span)
    // Governance on B1.2 (2026-09-19): a concatenation-built value such as
    // `'on' + 'nx'` used to be counted as two static literals ('on', 'nx')
    // instead of as dynamic. Governance on 8edd4fcef (F3) generalised the
    // rule from "a `+` outside every quoted region" to "anything outside
    // the quoted regions that a literal-or-ternary value does not need" --
    // a call, an index, `||`, `??` -- because `pick('mock','onnx')` read as
    // two static literals under the `+`-only rule, the same defect one
    // operator over. Unlike the unrecognised-region path below, this one
    // deliberately adds NOTHING to `found`: a computed value's quoted
    // operands are inputs to the computation ('on' + 'nx';
    // pick('mock','onnx')), not the value, so reporting them would name a
    // backend label that may never exist.
    if (hasComputedSyntax(unquoted)) {
      incomplete++
      continue
    }
    // Every quoted region is either a recognised static literal or it is
    // not; one unrecognised region (an escaped quote, an interpolation, an
    // upper-case label, an unterminated string) marks the site incomplete
    // even when another arm was recognised -- otherwise that arm vanishes
    // from the report with no failure, the F8 shape again.
    let recognised = 0
    let unrecognised = 0
    for (const r of regions) {
      if (r.terminated && STATIC_LITERAL_RE.test(r.content)) {
        found.add(r.content)
        recognised++
      } else unrecognised++
    }
    if (recognised === 0 || unrecognised > 0) incomplete++
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
 * True when the span's unquoted text (`tokenizeSpan`'s `unquoted`) contains
 * anything the scanner does not model as a literal-or-ternary value. It
 * understands exactly two shapes: a bare literal, and a chain of ternaries
 * whose conditions are identifiers, member accesses or optional chains.
 * Everything else -- `+`, a call `(`, an index `[`, `||`, `??`, `!`, `=`
 * -- means the value is COMPUTED and the site is `incomplete`. `?` and `:`
 * are allowed for the ternary itself, so `??` needs its own alternation
 * (a first draft without it let `opts.backend ?? 'mock'` through). A `+`
 * inside a template literal's `${...}` is not seen here -- the backtick
 * region is quoted -- and such a site is still incomplete, its region
 * content failing STATIC_LITERAL_RE. A negated condition (`!isMock ? ...`)
 * reads as computed: the loud direction, and no upstream site uses it.
 */
const COMPUTED_SYNTAX_RE = /[^A-Za-z0-9_$.?:\s]|\?\?/
function hasComputedSyntax(unquoted: string): boolean {
  return COMPUTED_SYNTAX_RE.test(unquoted)
}
