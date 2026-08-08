/**
 * SMI-5879: Edge scanner regex-safety utilities.
 * @module scripts/indexer/_shared/security-scanner-edge.regex-utils (Node port)
 *
 * Split out of security-scanner-edge.ts (500-line limit) so both the
 * per-line scanners and the multiline-scan engine
 * (security-scanner-edge.multiline.ts) can share the same ReDoS-protection
 * constants without a circular import. Mirrors core's regex-utils.ts naming.
 * Byte-identical body across both _shared twins (parity test enforces); only
 * the @module header line differs.
 */

import { MAX_SKILL_CONTENT_SIZE } from './constants.ts'

// ============================================================================
// Regex-safety constants + helper
// ============================================================================

/**
 * ReDoS protection: maximum line length for regex matching
 */
export const MAX_LINE_LENGTH = 10000

/**
 * SMI-5879 (design §3.4): maximum content length (UTF-16 code units) for the
 * pass-1 full-content multiline regex scan — asserted equal to
 * MAX_SKILL_CONTENT_SIZE (constants.ts) by test so the two limits can never
 * silently diverge. Closes the same 10KB pass-1 truncation blind spot core's
 * MAX_CONTENT_LENGTH_FOR_REGEX fix closed (@skillsmith/core regex-utils.ts).
 */
export const MAX_CONTENT_SCAN_LENGTH = MAX_SKILL_CONTENT_SIZE

/**
 * Safe regex test with length limit to prevent ReDoS
 */
export function safeRegexTest(pattern: RegExp, input: string): RegExpMatchArray | null {
  const safeInput = input.length > MAX_LINE_LENGTH ? input.slice(0, MAX_LINE_LENGTH) : input
  return safeInput.match(pattern)
}
