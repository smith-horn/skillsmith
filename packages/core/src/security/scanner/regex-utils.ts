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
