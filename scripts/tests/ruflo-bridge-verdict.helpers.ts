/**
 * SMI-6772 — shared, directly-testable pieces of ruflo-bridge-verdict.test.ts's
 * predicate-source-drift guard. Split out so the guard's own describe block
 * and this repo's unit tests share ONE implementation instead of two copies
 * drifting apart, and so ruflo-bridge-verdict.test.ts stays under the repo's
 * 500-line file gate (CLAUDE.md: "split into foo.helpers.ts").
 */
import type { Probe } from './_lib/probe-path.js'

/** Matches a `backend:`-shaped object-property site, key optionally quoted. */
export const BACKEND_SITE_RE = /(?<![A-Za-z0-9_$.])["']?backend["']?\s*:\s*/g

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

/**
 * One escape-aware walk over a value span, shared by concatenation
 * detection and literal extraction so the two cannot disagree about where
 * a string ends. A backslash inside a string skips the next character, so
 * an escaped quote is content and an escaped backslash does not close the
 * string on the following quote. A span that ends inside a string yields an
 * unterminated region, which the caller must treat as unrecognised: a
 * truncated read is not evidence about the value.
 */
function tokenizeSpan(span: string): SpanTokens {
  const regions: QuotedRegion[] = []
  let unquoted = ''
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < span.length; i++) {
    const ch = span[i]
    if (quote !== null) {
      if (ch === '\\') i++
      else if (ch === quote) {
        regions.push({ content: span.slice(start, i), terminated: true })
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
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
        if (ch === '\\') end++
        else if (ch === quote) quote = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch
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
    // instead of as dynamic. A `+` outside every quoted region in the span
    // means the value is computed, so the site is `incomplete`, the same
    // treatment as template interpolation.
    if (hasUnquotedPlus(unquoted)) {
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
 * True when a `+` occurs in the span's unquoted text (`tokenizeSpan`'s
 * `unquoted`). A `+` inside a template literal's `${...}` is NOT seen here
 * -- the whole backtick region is quoted -- and such a site still reads as
 * `incomplete`, because its region content contains `${` and so fails
 * STATIC_LITERAL_RE.
 */
function hasUnquotedPlus(unquoted: string): boolean {
  return unquoted.includes('+')
}
