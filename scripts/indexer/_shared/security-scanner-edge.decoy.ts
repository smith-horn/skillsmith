/**
 * SMI-6033 Wave 4 (Gap 6): Edge decoy/misdirection URL-target detector
 * @module scripts/indexer/_shared/security-scanner-edge.decoy (Node port)
 *
 * Port of @skillsmith/core SecurityScanner.decoy.ts. Reuses this file's
 * sibling `security-scanner-edge.brand-data.ts` — `BRAND_ALIASES` (brand
 * token -> GitHub owner slug) and `AUTHORITY_CLAIMING_AFFIXES`
 * ("official"/"verified"/"authentic"/"genuine") — to catch a fetch/exec
 * instruction whose surrounding prose claims a specific vendor while the
 * fetch target's actual domain does not belong to that vendor and is not in
 * the general `DEFAULT_ALLOWED_DOMAINS` allowlist
 * (`security-scanner-edge.patterns.ts`).
 *
 * Per the plan's §9 reconciliation table: `decoy_misdirection` is "N/A —
 * never standalone... Approximate NL heuristic by construction; co-signal
 * required (medium tier), unchanged." This detector therefore NEVER emits
 * `high`/`critical` — only `medium`, or nothing. The co-signal mechanism
 * that would let this medium finding contribute toward escalating a
 * separate weak `code_execution` finding is a SEPARATE dispatch's job
 * (`security-scanner-edge.exec.ts`'s `CO_SIGNAL_MIN_SEVERITY` replacement)
 * and is NOT implemented in this file.
 *
 * Design note, NOT explicit in the plan text and flagged here for review:
 * the plan says to compare "the claimed vendor's canonical domain" against
 * the fetch target's domain, but `BRAND_ALIASES`'s values are GitHub OWNER
 * SLUGS (`anthropics`, `google-gemini`, ...), not DNS domains. A small
 * curated `BRAND_CANONICAL_DOMAINS` map below (byte-identical to core's own
 * SecurityScanner.decoy.ts) fills that gap. A bare authority-claiming affix
 * ("the official installer") never names a specific vendor and so cannot
 * resolve a canonical domain to compare against — this detector requires a
 * brand-token match to identify "the claimed vendor" at all, and treats a
 * co-occurring authority-claiming affix as a confidence booster (medium ->
 * high), not an alternate, independently-sufficient trigger.
 *
 * Reuses `extractUrls` from `security-scanner-edge.paste-host.ts` (that
 * module's own header documents it as "a fresh, self-contained, exported
 * utility... reusable by any future edge detector that needs URL
 * extraction" — exactly this reuse).
 *
 * Byte-identical body across both _shared twins (parity test enforces); only
 * the @module header line above differs. Pure Deno/Web APIs, no Node deps.
 */

import type { SecurityFinding, LineContext } from './security-scanner-edge.context.ts'
import { isDocumentationContext } from './security-scanner-edge.context.ts'
import { extractUrls } from './security-scanner-edge.paste-host.ts'
import { DEFAULT_ALLOWED_DOMAINS } from './security-scanner-edge.patterns.ts'
import { BRAND_ALIASES, AUTHORITY_CLAIMING_AFFIXES } from './security-scanner-edge.brand-data.ts'
import { FETCH_COMMAND_PATTERN } from './security-scanner-edge.fetch-correlation.ts'

// ReDoS protection: maximum line length for regex matching (mirrors scanner).
const MAX_LINE_LENGTH = 10000

function safeRegexTest(pattern: RegExp, input: string): RegExpMatchArray | null {
  const safeInput = input.length > MAX_LINE_LENGTH ? input.slice(0, MAX_LINE_LENGTH) : input
  return safeInput.match(pattern)
}

// Bounded prose window (±N lines) around a fetch/exec instruction, per the plan's Gap 6 text.
const DECOY_WINDOW_LINES = 5

// Curated canonical domain(s) per BRAND_ALIASES brand token — see this
// file's own header for why this cannot simply reuse BRAND_ALIASES' values
// directly (those are GitHub owner slugs, not DNS domains).
const BRAND_CANONICAL_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['anthropic.com', 'claude.ai'],
  claude: ['anthropic.com', 'claude.ai'],
  gemini: ['google.com', 'ai.google.dev', 'deepmind.google'],
  copilot: ['github.com', 'microsoft.com'],
  vercel: ['vercel.com'],
  salesforce: ['salesforce.com'],
}

// Split a line into lowercase alphanumeric tokens on any separator (mirrors typosquat's own tokenize).
function tokenize(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0)
}

// Exact-or-subdomain match against a domain set.
function matchesDomainSet(hostname: string, domains: readonly string[]): boolean {
  return domains.some((d) => hostname === d || hostname.endsWith('.' + d))
}

interface VendorClaim {
  brandToken: string
  hasAuthorityAffix: boolean
}

// Scan a bounded ±DECOY_WINDOW_LINES window around lineIndex for a brand
// token (required) and an authority-claiming affix (optional, boosts
// confidence). Returns null when no brand token is present.
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

export function scanDecoyMisdirection(lines: string[], contexts: LineContext[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const urls = extractUrls(lines)

  for (const { url, line } of urls) {
    const lineIndex = line - 1
    const lineContent = lines[lineIndex] ?? ''
    // Only a fetch/exec instruction with a concrete URL target is in scope —
    // a bare linked URL ("see https://docs.example.com") is not.
    if (safeRegexTest(FETCH_COMMAND_PATTERN, lineContent) === null) continue

    let hostname: string
    try {
      hostname = new URL(url).hostname.toLowerCase()
    } catch {
      continue
    }

    const claim = findVendorClaimInWindow(lines, lineIndex)
    if (!claim) continue // no vendor claim nearby -> nothing to compare against

    const canonicalDomains = BRAND_CANONICAL_DOMAINS[claim.brandToken] ?? []
    if (matchesDomainSet(hostname, canonicalDomains)) continue // fetch target IS the claimed vendor's own domain
    if (matchesDomainSet(hostname, DEFAULT_ALLOWED_DOMAINS)) continue // generally-trusted host, excluded per the plan text

    const inDocContext = isDocumentationContext(contexts[lineIndex])

    findings.push({
      type: 'decoy_misdirection',
      // Never high/critical — an approximate NL heuristic by construction
      // (plan §9 reconciliation table).
      severity: inDocContext ? 'low' : 'medium',
      message: `Fetch target domain ("${hostname}") does not match the "${claim.brandToken}" vendor claimed nearby in the skill's own prose: ${url}`,
      lineNumber: line,
      location: lineContent.trim().slice(0, 100),
      inDocumentationContext: inDocContext,
      confidence: inDocContext ? 'low' : claim.hasAuthorityAffix ? 'high' : 'medium',
    })
  }

  return findings
}
