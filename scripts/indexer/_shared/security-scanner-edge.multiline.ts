/**
 * SMI-5879: Edge scanner multiline-scan two-pass engine.
 * @module scripts/indexer/_shared/security-scanner-edge.multiline (Node port)
 *
 * Split out of security-scanner-edge.ts to stay under the 500-line limit.
 * Ported from @skillsmith/core SecurityScanner.helpers.ts
 * (scanPatternsWithMultilineSupport) — see that module's doc comment for the
 * full argument; the constants and algorithm below are byte-for-byte
 * behaviorally equivalent, adapted to edge's finding shape. Byte-identical
 * body across both _shared twins (parity test enforces); only the @module
 * header line differs.
 */

import type { SecurityFinding, LineContext, EvidenceType } from './security-scanner-edge.context.ts'
import { isDocumentationContext, isWithinInlineCode } from './security-scanner-edge.context.ts'
import {
  classifyEvidence,
  resolvePatternScope,
  resolveEvidenceSeverity,
  EVIDENCE_RANK,
  MAX_EVIDENCE_RANK,
} from './security-scanner-edge.evidence.ts'
import { safeRegexTest, MAX_CONTENT_SCAN_LENGTH } from './security-scanner-edge.regex-utils.ts'

// ============================================================================
// Multiline-scan two-pass engine
// ============================================================================

/**
 * SMI-5879 (design §3.3.4): correctness ceiling on distinct lines recorded per
 * pattern in the pass-1 full-content scan — score-neutral by proof (Lemma
 * 3.3-B, see core SecurityScanner.helpers.ts for the full derivation). Same
 * value as core's MAX_MULTILINE_LINES_PER_PATTERN.
 */
export const MAX_MULTILINE_LINES_PER_PATTERN = 64

/**
 * SMI-5879 (design §3.3.3/3.3.6): wall-clock LIVENESS bound on a single
 * pattern's pass-1 loop — NOT score-neutral (unlike the line cap above). Same
 * value as core's MAX_MULTILINE_ITERATIONS_PER_PATTERN.
 */
export const MAX_MULTILINE_ITERATIONS_PER_PATTERN = 10_000

export interface MultilineScanConfig {
  type: 'jailbreak' | 'prompt_injection'
  messagePrefix: string
  patterns: RegExp[]
}

/** Best evidence found so far for a given line, across both scan passes. */
interface EvidenceCandidate {
  tier: EvidenceType
  matchText: string
  location: string
  inDocContext: boolean
}

export interface MultilineScanResult {
  findings: SecurityFinding[]
  /**
   * SMI-5879 (design §3.3.6): true when at least one pattern's pass-1 loop
   * hit MAX_MULTILINE_ITERATIONS_PER_PATTERN before exhausting its matches.
   */
  truncated: boolean
}

/**
 * Scan content for patterns that may span multiple lines. Multi-line
 * ('content'/'both' scope) patterns are tested against full content;
 * single-line ('line'/'both' scope) patterns per-line. The STRONGEST evidence
 * tier per line wins across both passes (mirrors core's `bestByLine` merge —
 * see SecurityScanner.helpers.ts for the two hazards this closes).
 */
export function scanPatternsWithMultilineSupport(
  content: string,
  lines: string[],
  contexts: LineContext[],
  config: MultilineScanConfig
): MultilineScanResult {
  const bestByLine = new Map<number, EvidenceCandidate>()
  let truncated = false
  const rank = (t: EvidenceType): number => EVIDENCE_RANK[t]

  const scannedContent =
    content.length > MAX_CONTENT_SCAN_LENGTH ? content.slice(0, MAX_CONTENT_SCAN_LENGTH) : content

  // First pass: 'content' | 'both'-scope patterns against full content.
  for (const pattern of config.patterns) {
    if (resolvePatternScope(pattern) === 'line') continue

    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
    const g = new RegExp(pattern.source, flags)
    const seenLines = new Set<number>()
    let iterations = 0
    let m: RegExpExecArray | null

    while ((m = g.exec(scannedContent)) !== null) {
      if (m[0].length === 0) g.lastIndex++ // zero-length-match advance

      if (++iterations > MAX_MULTILINE_ITERATIONS_PER_PATTERN) {
        truncated = true
        break
      }

      // SMI-5879: skip past any leading \n before resolving line/column — a
      // captured leading (?:^|\n) anchor's m.index otherwise points at the
      // PREVIOUS line's terminating newline (see core's fix for the full
      // argument).
      const matchIndex = m.index
      let contentIndex = matchIndex
      while (scannedContent[contentIndex] === '\n') contentIndex++

      const lineNumber = scannedContent.slice(0, contentIndex).split('\n').length
      if (seenLines.has(lineNumber)) continue

      if (seenLines.size >= MAX_MULTILINE_LINES_PER_PATTERN) break // score-neutral (Lemma 3.3-B)

      seenLines.add(lineNumber)

      const ctx = contexts[lineNumber - 1]
      const matchLine = lines[lineNumber - 1] ?? ''
      const lineOffset = scannedContent.lastIndexOf('\n', contentIndex - 1) + 1
      const matchCol = contentIndex - lineOffset
      const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(matchLine, matchCol)
      const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
      const tier = classifyEvidence(pattern)

      const incumbent = bestByLine.get(lineNumber)
      if (!incumbent || rank(tier) > rank(incumbent.tier)) {
        bestByLine.set(lineNumber, {
          tier,
          matchText: m[0],
          location: m[0].trim().slice(0, 100),
          inDocContext,
        })
      }
    }
  }

  // Second pass: 'line' | 'both'-scope patterns, per-line. Seeds `best` from
  // pass 1 so a line-local directive can still beat a weaker multiline
  // mention on the same line.
  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const ctx = contexts[index]
    let best = bestByLine.get(lineNumber) ?? null

    for (const pattern of config.patterns) {
      if (resolvePatternScope(pattern) === 'content') continue
      const match = safeRegexTest(pattern, line)
      if (!match) continue

      const tier = classifyEvidence(pattern)
      if (!best || rank(tier) > rank(best.tier)) {
        const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, match.index ?? 0)
        const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false
        best = {
          tier,
          matchText: match[0],
          location: line.trim().slice(0, 100),
          inDocContext,
        }
      }
      if (rank(tier) === MAX_EVIDENCE_RANK) break
    }

    if (best) bestByLine.set(lineNumber, best)
  })

  // Emit one finding per flagged line, in ascending line-number order.
  const findings: SecurityFinding[] = []
  const orderedLines = Array.from(bestByLine.keys()).sort((a, b) => a - b)
  for (const lineNumber of orderedLines) {
    const candidate = bestByLine.get(lineNumber)
    if (!candidate) continue
    const { severity, confidence } = resolveEvidenceSeverity(candidate.tier, candidate.inDocContext)
    const truncatedText = candidate.matchText.slice(0, 50)

    findings.push({
      type: config.type,
      severity,
      message: `${config.messagePrefix}: "${truncatedText}${candidate.matchText.length > 50 ? '...' : ''}"`,
      location: candidate.location,
      lineNumber,
      inDocumentationContext: candidate.inDocContext,
      confidence,
      evidenceType: candidate.tier,
    })
  }

  return { findings, truncated }
}
