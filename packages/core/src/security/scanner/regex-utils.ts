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
 * SMI-5881: Cap for the FULL-CONTENT (multiline "pass 1") regex scan, in
 * UTF-16 code units (JavaScript `string.length` — NOT bytes/code points; see
 * SecurityScanner.ts's content-length finding message).
 *
 * Equal to MAX_LINE_LENGTH_FOR_REGEX today (both 10_000) but declared
 * separately because the two caps protect different scan passes (per-line vs
 * whole-document) and may need to diverge later. This is a ReDoS budget
 * input, not a free parameter — raising it requires first proving
 * AD_CRLF_INJECTION-class patterns stay linear at the new size. Measured
 * (SMI-5881): the fixed AD_CRLF_INJECTION pattern is already ~4x slower per
 * doubling of input size on some adversarial inputs at sizes past this cap,
 * extrapolating to unacceptable latency well before 1,000,000 — so this cap
 * is NOT raised as part of SMI-5881 even though larger trust tiers allow a
 * much bigger `maxContentLength`. See SecurityScanner.ts's
 * `effectiveMultilineLimit` (`Math.min(MAX_CONTENT_LENGTH_FOR_REGEX,
 * maxContentLength)`) for how this interacts with the per-tier content-length
 * ceiling.
 */
export const MAX_CONTENT_LENGTH_FOR_REGEX = MAX_LINE_LENGTH_FOR_REGEX

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
