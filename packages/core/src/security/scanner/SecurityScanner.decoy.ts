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
 */

import type { SecurityFinding } from './types.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import { analyzeMarkdownContext, isDocumentationContext } from './SecurityScanner.helpers.js'
import { extractUrls } from './SecurityScanner.urls.js'
import { DEFAULT_ALLOWED_DOMAINS } from './patterns.js'
import { BRAND_ALIASES, AUTHORITY_CLAIMING_AFFIXES } from './typosquat.js'
import { FETCH_COMMAND_PATTERN } from './SecurityScanner.fetch-correlation.js'
import { safeRegexTest } from './regex-utils.js'

/** Bounded prose window (±N lines) around a fetch/exec instruction, per the plan's Gap 6 text. */
const DECOY_WINDOW_LINES = 5

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
 * token (required) and an authority-claiming affix (optional, boosts
 * confidence). Returns `null` when no brand token is present — nothing to
 * compare a fetch target's domain against.
 */
function findVendorClaimInWindow(lines: string[], lineIndex: number): VendorClaim | null {
  const start = Math.max(0, lineIndex - DECOY_WINDOW_LINES)
  const end = Math.min(lines.length - 1, lineIndex + DECOY_WINDOW_LINES)
  const windowTokens = tokenize(lines.slice(start, end + 1).join(' '))

  let brandToken: string | null = null
  let hasAuthorityAffix = false
  for (const token of windowTokens) {
    if (!brandToken && Object.prototype.hasOwnProperty.call(BRAND_ALIASES, token)) {
      brandToken = token
    }
    if (AUTHORITY_CLAIMING_AFFIXES.has(token)) {
      hasAuthorityAffix = true
    }
  }

  return brandToken ? { brandToken, hasAuthorityAffix } : null
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
    // Only a fetch/exec instruction with a concrete URL target is in scope —
    // a bare linked URL ("see https://docs.example.com") is not (mirrors
    // scanPasteHostFetch's/scanArchiveEvasion's own same-line-fetch-verb gate).
    if (safeRegexTest(FETCH_COMMAND_PATTERN, lineContent) === null) continue

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
