/**
 * Security helpers for the Node indexer skill-processor (SMI-5436 Wave 0).
 *
 * Extracted from skill-processor.ts to keep that file ≤500 lines (500-line
 * gate). Wave 2 (SMI-5436) will fill in the sibling-scan stubs:
 * buildMergedQuarantineReason, mergeSiblingScans.
 *
 * Parity with supabase/functions/indexer/skill-processor.security.ts is
 * enforced by parity.test.ts.
 */

import {
  shouldQuarantine,
  summarizeFindings,
  type EdgeScanResult,
} from './_shared/security-scanner-edge.ts'

// sync: packages/core/src/services/skill-installation.policy.ts BUNDLED_SCAN_FILES
export const BUNDLED_SCAN_FILES = [
  'README.md',
  'examples.md',
  'config.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp.json',
  'package.json',
] as const

export type BundledScanFile = (typeof BUNDLED_SCAN_FILES)[number]

/**
 * SMI-2384: Build a human-readable quarantine reason for authors.
 *
 * When a skill is quarantined, this produces a message summarizing:
 * - Number of findings and risk score
 * - Types of patterns found with line numbers (max 5)
 * - Appeal URL with the skill identifier pre-filled
 */
export function buildQuarantineReason(
  scanResult: EdgeScanResult,
  owner: string,
  name: string
): string {
  if (!shouldQuarantine(scanResult)) {
    return ''
  }

  const findingSummary = summarizeFindings(scanResult.findings)
  const appealUrl = `https://skillsmith.app/contact?topic=quarantine&skill=${encodeURIComponent(`${owner}/${name}`)}`

  return `Security scan detected ${scanResult.findings.length} finding${scanResult.findings.length === 1 ? '' : 's'} (risk score: ${scanResult.riskScore}/100). ${findingSummary}. Appeal at ${appealUrl}`
}

/**
 * SMI-2283: Read response body with byte-counted limit to prevent memory exhaustion.
 * Streams the body and aborts if the accumulated size exceeds the limit.
 * @throws Error if response body exceeds maxBytes
 */
export async function readResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Response body is not readable')
  }

  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        reader.cancel()
        throw new Error(`Response body exceeds maximum size of ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const decoder = new TextDecoder()
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
}

