/**
 * Security Scanner Regex Utilities - SMI-882, SMI-1189
 *
 * ReDoS protection utilities for safe regex matching.
 */

/**
 * SMI-882: ReDoS Protection Constants
 * Maximum line length to process with regex patterns.
 * Lines exceeding this limit are truncated before regex matching
 * to prevent catastrophic backtracking attacks.
 */
export const MAX_LINE_LENGTH_FOR_REGEX = 10000

/**
 * SMI-5879 (design §3.4): Cap for the FULL-CONTENT (multiline "pass 1") regex
 * scan, in UTF-16 code units (JavaScript `string.length` — NOT bytes/code
 * points; see SecurityScanner.ts's content-length finding message).
 *
 * SMI-5881 set this equal to MAX_LINE_LENGTH_FOR_REGEX (10,000) and declined
 * to raise it, citing a doubling-based extrapolation from smaller inputs that
 * projected "unacceptable latency well before 1,000,000" for
 * AD_CRLF_INJECTION-class patterns. SMI-5879 independently re-measured
 * directly at 1,000,000 (not extrapolated) across the 7 ported multiline
 * patterns (AD_CRLF_INJECTION, AD_ROLE_MARKER_BARE, AD_HTML_COMMENT_VERB/NOUN,
 * AD_DELIMITER_BARE, AD_AN2_ROLE_BODY_NEXT_LINE, JB_JS3A/JS3B) against
 * per-pattern adversarial near-miss shapes (not just the CRLF-pair shape
 * SMI-5881 used) and found linear scaling with a worst case of ~56ms at
 * 1,000,000 chars (AD_HTML_COMMENT_NOUN, "repeated HTML-comment-open"
 * near-miss) — confirmed still linear (not superlinear) up to 4,000,000
 * chars (~145ms), comfortably under the section 7.3 250ms per-case budget.
 * The prior extrapolation does not hold empirically at this exact size; the
 * measured worst case has real headroom, just less than the ~78x this
 * design doc's own (unverified) claim asserted. Raising this cap closes the
 * 10 KB pass-1 truncation blind spot (design §3.4) — the edge's own
 * MAX_SKILL_CONTENT_SIZE is 1,000,000 bytes, so pass 1 previously saw only
 * the first 1% of a large SKILL.md.
 *
 * Still declared separately from MAX_LINE_LENGTH_FOR_REGEX because the two
 * caps protect different scan passes (per-line vs whole-document) and may
 * need to diverge again. See SecurityScanner.ts's `effectiveMultilineLimit`
 * (`Math.min(MAX_CONTENT_LENGTH_FOR_REGEX, maxContentLength)`) for how this
 * interacts with the per-tier content-length ceiling — a trust tier with a
 * SMALLER configured `maxContentLength` still tightens the effective limit
 * below this cap; none currently need MORE than this cap for the multiline
 * pass specifically.
 */
export const MAX_CONTENT_LENGTH_FOR_REGEX = 1_000_000

/**
 * SMI-882: Safe regex test with length limit
 * Applies input length limit before regex matching to prevent ReDoS attacks.
 *
 * @param pattern - Regex pattern to test
 * @param input - Input string to test against
 * @param maxLength - Maximum input length (default: MAX_LINE_LENGTH_FOR_REGEX)
 * @returns Match result or null if input is too long/no match
 */
export function safeRegexTest(
  pattern: RegExp,
  input: string,
  maxLength: number = MAX_LINE_LENGTH_FOR_REGEX
): RegExpMatchArray | null {
  // Truncate input if it exceeds max length to prevent ReDoS
  const safeInput = input.length > maxLength ? input.slice(0, maxLength) : input
  return safeInput.match(pattern)
}

/**
 * SMI-882: Check if pattern matches safely
 * Returns boolean instead of match array for simple tests.
 *
 * @param pattern - Regex pattern to test
 * @param input - Input string to test against
 * @param maxLength - Maximum input length (default: MAX_LINE_LENGTH_FOR_REGEX)
 * @returns True if pattern matches (within safe input limits)
 */
export function safeRegexCheck(
  pattern: RegExp,
  input: string,
  maxLength: number = MAX_LINE_LENGTH_FOR_REGEX
): boolean {
  // Truncate input if it exceeds max length to prevent ReDoS
  const safeInput = input.length > maxLength ? input.slice(0, maxLength) : input
  return pattern.test(safeInput)
}
