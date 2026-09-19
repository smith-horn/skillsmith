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
 * Matches a fully-static single-, double-, or backtick-quoted string literal
 * (lowercase letters/hyphens only, the enum's own character set). SMI-6772
 * F8: the original single-quote-only regex silently dropped a literal
 * spelled with a different quote style inside the same site --
 * `backend: a ? 'mock' : b ? 'onnx' : "gpu"` kept that site's own-literal
 * count above zero (from the two single-quoted arms), so it never tripped
 * the `incomplete` counter, while "gpu" vanished from `found` with no
 * failure anywhere. A template literal containing `${` cannot match any of
 * the three alternatives (interpolation breaks the `[a-z-]+`-only class),
 * so a genuinely dynamic arm still falls through to `incomplete` -- it is
 * never miscounted as a literal.
 */
const LITERAL_RE = /'([a-z-]+)'|"([a-z-]+)"|`([a-z-]+)`/g

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
    // Governance on B1.2 (2026-09-19): a concatenation-built value such as
    // `'on' + 'nx'` matched LITERAL_RE twice and was counted as two static
    // literals ('on', 'nx') instead of as dynamic. A `+` outside every quoted
    // region in the span means the value is computed, so the site is
    // `incomplete`, the same treatment as template interpolation.
    if (hasUnquotedPlus(span)) {
      incomplete++
      continue
    }
    let n = 0
    for (const lit of span.matchAll(LITERAL_RE)) {
      const value = lit[1] ?? lit[2] ?? lit[3]
      found.add(value)
      n++
    }
    if (n === 0) incomplete++
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

/** True when a `+` occurs in `span` outside every quoted region. */
function hasUnquotedPlus(span: string): boolean {
  let quote: string | null = null
  for (let i = 0; i < span.length; i++) {
    const ch = span[i]
    if (quote !== null) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '+') return true
  }
  return false
}
