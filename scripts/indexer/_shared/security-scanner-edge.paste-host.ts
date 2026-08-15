/**
 * SMI-6033 Wave 2 (Gap 4): Edge paste/snippet-host reputation + fetch-context
 * escalation detector
 * @module scripts/indexer/_shared/security-scanner-edge.paste-host (Node port)
 *
 * Port of @skillsmith/core SecurityScanner.paste-host.ts. Unlike the
 * archive_evasion/gatekeeper_bypass ports, edge has no pre-existing URL
 * extraction or allowlisted-domain detector at all (edge's category set has
 * always been narrower than core's by design — no `url`/`pii`/`ssrf`/
 * `social_engineering` categories, per the plan's Context section) — so
 * `extractUrls` below is a fresh, self-contained, exported utility (not a
 * promotion of an existing private method the way it was on the core side),
 * reusable by any future edge detector that needs URL extraction.
 *
 * For each URL extracted, check whether its hostname is in
 * `PASTE_HOST_DOMAINS` (security-scanner-edge.patterns.ts). Two outcomes:
 *
 *   - The paste-host URL is literally the TARGET of a fetch command on its
 *     own line (`FETCH_COMMAND_PATTERN`) -> standalone-critical, a NEW
 *     `paste_host_fetch` finding. Per the plan: "no normal install flow
 *     fetches executable payload from an anonymous host" — no
 *     correlation-with-a-second-signal required beyond that.
 *   - Merely linked/mentioned (no fetch verb on that line) -> NO finding at
 *     all. Edge has no `url`:medium finding to preserve here (it never had
 *     one) — this is a documented, edge-only divergence from core, where the
 *     pre-existing `scanUrls` `url`:medium finding still covers the
 *     merely-linked case.
 *
 * Known, documented residual (static scanner, no network I/O): an indirect
 * shape (`URL=https://pastebin.com/x` on one line, `curl $URL` on the next)
 * is not correlated — matched-line only, deliberately, to avoid a ±N-line
 * window falsely correlating an unrelated paste-host mention to a nearby but
 * unrelated fetch command. Redirect-chain/final-host resolution is out of
 * scope by design for the same reason (no network I/O at scan time).
 *
 * Byte-identical body across both _shared twins (parity test enforces); only
 * the @module header line above differs. Pure Deno/Web APIs, no Node deps.
 */

import type { SecurityFinding, LineContext } from './security-scanner-edge.context.ts'
import { isDocumentationContext } from './security-scanner-edge.context.ts'
import { PASTE_HOST_DOMAINS } from './security-scanner-edge.patterns.ts'
import { FETCH_COMMAND_PATTERN } from './security-scanner-edge.fetch-correlation.ts'

const PASTE_HOST_DOMAIN_SET = new Set(PASTE_HOST_DOMAINS.map((d) => d.toLowerCase()))

/** A URL found in scanned content, plus the (1-indexed) line it appeared on. */
export interface ExtractedUrl {
  url: string
  line: number
}

/**
 * Fresh, self-contained URL-extraction utility — see module header for why
 * this is not a promotion of an existing private method (edge has none).
 */
export function extractUrls(lines: string[]): ExtractedUrl[] {
  const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi
  const results: ExtractedUrl[] = []

  for (const [index, line] of lines.entries()) {
    let match
    while ((match = urlPattern.exec(line)) !== null) {
      results.push({ url: match[0], line: index + 1 })
    }
  }

  return results
}

/** Is `url`'s hostname a known paste/snippet host (exact match or subdomain)? */
function isPasteHostUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    for (const domain of PASTE_HOST_DOMAIN_SET) {
      if (hostname === domain || hostname.endsWith('.' + domain)) return true
    }
    return false
  } catch {
    return false
  }
}

export function scanPasteHostFetch(lines: string[], contexts: LineContext[]): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const urls = extractUrls(lines)

  for (const { url, line } of urls) {
    if (!isPasteHostUrl(url)) continue

    const lineIndex = line - 1
    const lineContent = lines[lineIndex] ?? ''
    // The paste-host URL is a fetch TARGET only when a fetch verb appears on
    // the SAME line — deliberately not widened to a bounded window (unlike
    // the chmod/archive compound signals); see module header.
    const isFetchTarget = FETCH_COMMAND_PATTERN.test(lineContent)
    if (!isFetchTarget) continue

    const inDocContext = isDocumentationContext(contexts[lineIndex])

    findings.push({
      type: 'paste_host_fetch',
      // Standalone-critical (no correlation-with-a-second-signal required
      // beyond "is this literally the target of a fetch command") — doc
      // context is the only downgrade, matching every other detector's
      // noise-reduction convention in this Wave.
      severity: inDocContext ? 'low' : 'critical',
      message: `Paste/snippet-host URL is the target of a fetch command: ${url}`,
      lineNumber: line,
      location: lineContent.trim().slice(0, 100),
      inDocumentationContext: inDocContext,
      confidence: inDocContext ? 'low' : 'high',
    })
  }

  return findings
}
