/**
 * Security Scanner — decoy/misdirection URL-target heuristic
 * @module @skillsmith/core/security/scanner/SecurityScanner.decoy
 *
 * SMI-6033 Wave 4 (Gap 6): reuses the typosquat detector's brand data —
 * `BRAND_ALIASES` (typosquat.ts) and `AUTHORITY_CLAIMING_AFFIXES`
 * (typosquat.ts, exported for exactly this reuse as part of Wave 1's Gap 6
 * prerequisite) — to catch a fetch/exec instruction whose surrounding prose
 * claims a specific vendor (a brand token, optionally reinforced by an
 * authority-claiming affix like "official"/"verified") while the fetch
 * target's actual domain does not belong to that vendor and is not in the
 * general `DEFAULT_ALLOWED_DOMAINS` allowlist.
 *
 * Per the plan's §9 reconciliation table: `decoy_misdirection` is "N/A —
 * never standalone... Approximate NL heuristic by construction; co-signal
 * required (medium tier), unchanged." This detector therefore NEVER emits
 * `high`/`critical` — only `medium`, or nothing (see the doc-context
 * downgrade below, which uses `low`, not a third severity choice for the
 * non-doc case). The co-signal mechanism that would let this medium finding
 * contribute toward escalating a separate weak `code_execution` finding is a
 * SEPARATE dispatch's job — `SecurityScanner.exec.ts`'s
 * `CO_SIGNAL_MIN_SEVERITY` replacement — and is NOT implemented in this file.
 *
 * Design note, NOT explicit in the plan text and flagged here for review:
 * the plan says to compare "the claimed vendor's canonical domain" against
 * the fetch target's domain, but `BRAND_ALIASES`'s values are GitHub OWNER
 * SLUGS (`anthropics`, `google-gemini`, ...) — they answer "whose GitHub org
 * publishes this," not "what is this vendor's real website." A small
 * curated `BRAND_CANONICAL_DOMAINS` map below, scoped to the exact same six
 * brand tokens `BRAND_ALIASES` already curates, fills that gap; a brand
 * token with no entry here is not currently possible (the two maps share the
 * same key set by construction) but the lookup fails safe (empty domain
 * list -> never matches -> never suppresses) if that ever drifts.
 *
 * Second design note: the plan text reads "a brand token OR an
 * authority-claiming phrase implying a specific vendor." An authority-
 * claiming affix ALONE ("the official installer") never names a specific
 * vendor and so cannot resolve a canonical domain to compare against — this
 * detector therefore requires a brand-token match to identify "the claimed
 * vendor" at all (necessary for the domain comparison to mean anything), and
 * treats a co-occurring authority-claiming affix as a confidence booster
 * (medium -> high), not an alternate, independently-sufficient trigger. This
 * mirrors typosquat.ts's own rule 3 (`hasBrandToken && hasAuthorityAffix`),
 * which also requires both signals together.
 *
 * Two fixes from adversarial review (2026-08-16 — see
 * docs/internal/code_review/2026-08-15-smi6033-wave4-escalation-model.md
 * for the full account):
 *
 *  1. Fetch-target correlation. The original version treated ANY URL on a
 *     line that ALSO matched the generic FETCH_COMMAND_PATTERN as the fetch
 *     target — including a URL that was merely mentioned in prose alongside
 *     an unrelated fetch-verb usage on the same line (e.g.
 *     "curl --version; see mirror documentation at <url>", where curl is
 *     checking its own version, not fetching that URL). Replaced with
 *     `isActualFetchTarget`, which requires the fetch verb to be
 *     IMMEDIATELY followed (only flag-like tokens and whitespace, no
 *     command separator, no prose) by the URL — i.e. the URL must actually
 *     be the verb's argument.
 *
 *  2. Authority-affix proximity. `hasAuthorityAffix` used to scan the ENTIRE
 *     ±5-line window independently of where the brand token itself was
 *     found, so an unrelated authority phrase elsewhere in the window (e.g.
 *     "for official documentation on Python packaging, see PEP 517") could
 *     wrongly boost confidence to 'high' for a brand claim it has nothing to
 *     do with. Now scoped to a tight window around the brand token's OWN
 *     line (`DECOY_AUTHORITY_AFFIX_PROXIMITY_LINES`).
 */

import type { SecurityFinding } from './types.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import { analyzeMarkdownContext, isDocumentationContext } from './SecurityScanner.helpers.js'
import { extractUrls } from './SecurityScanner.urls.js'
import { DEFAULT_ALLOWED_DOMAINS } from './patterns.js'
import { BRAND_ALIASES, AUTHORITY_CLAIMING_AFFIXES } from './typosquat.js'

/** Bounded prose window (±N lines) around a fetch/exec instruction, per the plan's Gap 6 text. */
const DECOY_WINDOW_LINES = 5

/**
 * How close an authority-claiming affix ("official", "verified", ...) must
 * be to the brand token's OWN line for it to count as a confidence booster.
 * Same-line-only (adversarial-review fix, 2026-08-16) — the affix and the
 * brand claim must plausibly be part of the SAME sentence/claim, not merely
 * co-located somewhere in the wider fetch-correlation window OR on an
 * adjacent line carrying an unrelated sentence (a real adversarial-review
 * example: "For official documentation on Python packaging, see PEP 517."
 * on the line right after a genuine, affix-free "Claude API" brand mention —
 * a ±1-line window still wrongly pairs the two).
 */
const DECOY_AUTHORITY_AFFIX_PROXIMITY_LINES = 0

const FETCH_VERBS = new Set(['curl', 'wget', 'npx'])
/** A bare flag token, e.g. `-o`, `-fsSL`, `--output`, `--data=x`. */
const FLAG_TOKEN = /^-{1,2}[A-Za-z][\w-]*$/
/**
 * Common curl/wget/npx flags that take a SEPARATE value token (e.g.
 * `-o setup.sh`, `-X POST`) — that value token must be consumed as part of
 * the flag, not mistaken for prose.
 */
const VALUE_TAKING_FLAGS = new Set([
  '-o',
  '-x',
  '-h',
  '-d',
  '-a',
  '-e',
  '-u',
  '-b',
  '--output',
  '--request',
  '--header',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '--user-agent',
  '--referer',
  '--proxy',
  '--cookie',
])

/**
 * True when `url` (verbatim substring of `lineContent`) is actually the
 * argument to a fetch verb (curl/wget/npx, or `git clone`) on that line —
 * not merely co-located with one. Tokenizes the prefix before the URL:
 * rejects outright on any command separator (`;`, `|`, `&`), requires the
 * prefix to start with the fetch verb, and requires every remaining token to
 * be either a flag or the value argument of a value-taking flag (e.g.
 * `curl -o setup.sh <url>`) — any other token (prose) fails the match.
 * Rejects "curl --version; see mirror documentation at <url>" (the URL is
 * not curl's argument, and the `;` alone already disqualifies it); accepts
 * "curl -fsSL <url>", "curl -o setup.sh <url>", "wget <url>",
 * "git clone <url>", "npx --yes <url>".
 */
function isActualFetchTarget(lineContent: string, url: string): boolean {
  const urlIndex = lineContent.indexOf(url)
  if (urlIndex < 0) return false
  const prefix = lineContent.slice(0, urlIndex)
  if (/[;|&]/.test(prefix)) return false

  const tokens = prefix
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return false

  let i: number
  if (tokens[0]?.toLowerCase() === 'git' && tokens[1]?.toLowerCase() === 'clone') {
    i = 2
  } else if (FETCH_VERBS.has(tokens[0]?.toLowerCase() ?? '')) {
    i = 1
  } else {
    return false
  }

  for (; i < tokens.length; i++) {
    const token = tokens[i]
    if (!FLAG_TOKEN.test(token)) return false
    if (VALUE_TAKING_FLAGS.has(token.toLowerCase()) && i + 1 < tokens.length) {
      i++ // consume the flag's own value token too
    }
  }
  return true
}

/**
 * Curated canonical domain(s) per `BRAND_ALIASES` brand token — see this
 * file's own header for why this cannot simply reuse `BRAND_ALIASES`'
 * values directly (those are GitHub owner slugs, not DNS domains).
 */
const BRAND_CANONICAL_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['anthropic.com', 'claude.ai'],
  claude: ['anthropic.com', 'claude.ai'],
  gemini: ['google.com', 'ai.google.dev', 'deepmind.google'],
  copilot: ['github.com', 'microsoft.com'],
  vercel: ['vercel.com'],
  salesforce: ['salesforce.com'],
}

/** Split a line into lowercase alphanumeric tokens on any separator (mirrors typosquat.ts's own `tokenize`). */
function tokenize(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0)
}

/** Exact-or-subdomain match against a domain set (mirrors `isAllowedDomain`'s own logic in SecurityScanner.ts). */
function matchesDomainSet(hostname: string, domains: readonly string[]): boolean {
  return domains.some((d) => hostname === d || hostname.endsWith('.' + d))
}

interface VendorClaim {
  brandToken: string
  hasAuthorityAffix: boolean
}

/**
 * Scan a bounded ±`DECOY_WINDOW_LINES` window around `lineIndex` for a brand
 * token (required). Returns `null` when no brand token is present — nothing
 * to compare a fetch target's domain against. `hasAuthorityAffix` is then
 * resolved separately, scoped tightly to the brand token's OWN line (see
 * `DECOY_AUTHORITY_AFFIX_PROXIMITY_LINES` and this file's header note on the
 * adversarial-review fix) — NOT the wider fetch-correlation window, so an
 * authority phrase unrelated to this specific brand claim can't wrongly
 * boost confidence.
 */
function findVendorClaimInWindow(lines: string[], lineIndex: number): VendorClaim | null {
  const start = Math.max(0, lineIndex - DECOY_WINDOW_LINES)
  const end = Math.min(lines.length - 1, lineIndex + DECOY_WINDOW_LINES)

  let brandToken: string | null = null
  let brandLineIndex = -1
  for (let i = start; i <= end && !brandToken; i++) {
    for (const token of tokenize(lines[i] ?? '')) {
      if (Object.prototype.hasOwnProperty.call(BRAND_ALIASES, token)) {
        brandToken = token
        brandLineIndex = i
        break
      }
    }
  }
  if (!brandToken) return null

  const affixStart = Math.max(0, brandLineIndex - DECOY_AUTHORITY_AFFIX_PROXIMITY_LINES)
  const affixEnd = Math.min(
    lines.length - 1,
    brandLineIndex + DECOY_AUTHORITY_AFFIX_PROXIMITY_LINES
  )
  const hasAuthorityAffix = tokenize(lines.slice(affixStart, affixEnd + 1).join(' ')).some((t) =>
    AUTHORITY_CLAIMING_AFFIXES.has(t)
  )

  return { brandToken, hasAuthorityAffix }
}

export function scanDecoyMisdirection(
  content: string,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)
  const urls = extractUrls(content)

  for (const { url, line } of urls) {
    const lineIndex = line - 1
    const lineContent = lines[lineIndex] ?? ''
    // Only a URL that is ACTUALLY the argument to a fetch verb is in scope —
    // a bare linked URL ("see https://docs.example.com") is not, and neither
    // is a URL merely co-located on a line with an unrelated fetch-verb
    // usage (adversarial-review fix, 2026-08-16 — see isActualFetchTarget's
    // own doc comment).
    if (!isActualFetchTarget(lineContent, url)) continue

    let hostname: string
    try {
      hostname = new URL(url).hostname.toLowerCase()
    } catch {
      continue
    }

    const claim = findVendorClaimInWindow(lines, lineIndex)
    if (!claim) continue // no vendor claim nearby -> nothing to compare against; not a general brand-mention detector

    const canonicalDomains = BRAND_CANONICAL_DOMAINS[claim.brandToken] ?? []
    if (matchesDomainSet(hostname, canonicalDomains)) continue // fetch target IS the claimed vendor's own domain
    if (matchesDomainSet(hostname, DEFAULT_ALLOWED_DOMAINS)) continue // generally-trusted host, excluded per the plan text

    const ctx = contexts[lineIndex]
    const inDocContext = ctx ? isDocumentationContext(ctx) : false

    findings.push({
      type: 'decoy_misdirection',
      // Never high/critical — an approximate NL heuristic by construction
      // (plan §9 reconciliation table); the escalation-into-code_execution
      // co-signal mechanism lives in a separate dispatch.
      severity: inDocContext ? 'low' : 'medium',
      message: `Fetch target domain ("${hostname}") does not match the "${claim.brandToken}" vendor claimed nearby in the skill's own prose: ${url}`,
      location: lineContent.trim().slice(0, 100),
      lineNumber: line,
      category: 'decoy_misdirection',
      inDocumentationContext: inDocContext,
      confidence: inDocContext ? 'low' : claim.hasAuthorityAffix ? 'high' : 'medium',
    })
  }

  return findings
}
