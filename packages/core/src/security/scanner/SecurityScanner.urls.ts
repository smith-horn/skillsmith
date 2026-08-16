/**
 * Security Scanner — URL extraction
 * @module @skillsmith/core/security/scanner/SecurityScanner.urls
 *
 * SMI-6033 Wave 2 (Gap 4): split out of SecurityScanner.helpers.ts, which the
 * promotion below pushed over the 500-line audit:standards gate. Promoted
 * out of a private SecurityScanner.ts method (`extractUrls`) so `scanUrls`
 * and the new `scanPasteHostFetch` detector (SecurityScanner.paste-host.ts)
 * share ONE extraction implementation instead of two
 * independently-drifting regex sweeps over the same content. Pure
 * extraction — behavior is unchanged from the prior private method (same
 * regex, same per-line scan, same return shape).
 */

/** A URL found in scanned content, plus the (1-indexed) line it appeared on. */
export interface ExtractedUrl {
  url: string
  line: number
}

export function extractUrls(content: string): ExtractedUrl[] {
  const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi
  const lines = content.split('\n')
  const results: ExtractedUrl[] = []

  lines.forEach((line, index) => {
    let match
    while ((match = urlPattern.exec(line)) !== null) {
      results.push({ url: match[0], line: index + 1 })
    }
  })

  return results
}
