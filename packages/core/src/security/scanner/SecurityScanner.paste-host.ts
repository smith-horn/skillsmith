/**
 * Security Scanner — paste/snippet-host reputation + fetch-context escalation
 * @module @skillsmith/core/security/scanner/SecurityScanner.paste-host
 *
 * SMI-6033 Wave 2 (Gap 4): before this file, no paste-host domain list
 * existed anywhere in the scanner — a github.com-hosted install script and a
 * glot.io-hosted payload scored identically.
 *
 * For each URL extracted by the shared `extractUrls` helper
 * (SecurityScanner.helpers.ts — promoted out of a private SecurityScanner.ts
 * method so `scanUrls` and this detector share ONE extraction implementation
 * instead of two independently-drifting regex sweeps over the same content),
 * check whether its hostname is in `PASTE_HOST_DOMAINS` (patterns.ts). Two
 * outcomes:
 *
 *   - The paste-host URL is literally the TARGET of a fetch command on its
 *     own line (`FETCH_COMMAND_PATTERN` — curl/wget/git-clone/npx-to-URL) ->
 *     standalone-critical, a NEW `paste_host_fetch` finding. Per the plan:
 *     "no normal install flow fetches executable payload from an anonymous
 *     host" — no correlation-with-a-second-signal is required beyond that.
 *   - Merely linked/mentioned (no fetch verb on that line) -> NO new finding
 *     here at all. `scanUrls()`'s existing `url`:medium finding already
 *     covers "linked to a non-allowlisted domain" (paste hosts included
 *     today, since they are absent from `DEFAULT_ALLOWED_DOMAINS`) — this
 *     detector adds a STRONGER signal on TOP of that existing medium finding
 *     only for the fetch-target case; it never replaces or suppresses it
 *     (both detectors run and both may emit for the same URL).
 *
 * Known, documented residual (static scanner, no network I/O): an indirect
 * shape (`URL=https://pastebin.com/x` on one line, `curl $URL` on the next)
 * is not correlated — matched-line only, deliberately, to avoid a ±N-line
 * window falsely correlating an unrelated paste-host mention to a nearby but
 * unrelated fetch command. Redirect-chain/final-host resolution is out of
 * scope by design for the same reason (no network I/O at scan time).
 */

import type { SecurityFinding } from './types.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import { analyzeMarkdownContext, isDocumentationContext } from './SecurityScanner.helpers.js'
import { extractUrls } from './SecurityScanner.urls.js'
import { PASTE_HOST_DOMAINS } from './patterns.js'
import { safeRegexTest } from './regex-utils.js'
import { FETCH_COMMAND_PATTERN } from './SecurityScanner.fetch-correlation.js'

const PASTE_HOST_DOMAIN_SET = new Set(PASTE_HOST_DOMAINS.map((d) => d.toLowerCase()))

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

export function scanPasteHostFetch(
  content: string,
  lineContexts?: LineContext[]
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)
  const urls = extractUrls(content)

  for (const { url, line } of urls) {
    if (!isPasteHostUrl(url)) continue

    const lineIndex = line - 1
    const lineContent = lines[lineIndex] ?? ''
    // The paste-host URL is a fetch TARGET only when a fetch verb appears on
    // the SAME line — this deliberately does not widen to a bounded window
    // (unlike the chmod/archive compound signals) since a URL literally is
    // the thing being fetched when a fetch verb shares its line; widening
    // would risk correlating an unrelated fetch command to an unrelated
    // nearby paste-host mention.
    const isFetchTarget = safeRegexTest(FETCH_COMMAND_PATTERN, lineContent) !== null
    if (!isFetchTarget) continue // merely linked -> scanUrls()'s url:medium finding already covers this

    const ctx = contexts[lineIndex]
    const inDocContext = ctx ? isDocumentationContext(ctx) : false

    findings.push({
      type: 'paste_host_fetch',
      // Standalone-critical (no correlation-with-a-second-signal required
      // beyond "is this literally the target of a fetch command") — doc
      // context is the only downgrade, matching every other detector's
      // noise-reduction convention in this Wave.
      severity: inDocContext ? 'low' : 'critical',
      message: `Paste/snippet-host URL is the target of a fetch command: ${url}`,
      location: lineContent.trim().slice(0, 100),
      lineNumber: line,
      category: 'paste_host_fetch',
      inDocumentationContext: inDocContext,
      confidence: inDocContext ? 'low' : 'high',
    })
  }

  return findings
}
